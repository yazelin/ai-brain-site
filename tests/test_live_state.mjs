// 直播頁（live/）的單元測試：事件歸約、等待畫面、pet.js 的視線。
// 執行：node --test tests/test_live_state.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyEvent, emptyState, validateEvent } from "../live/state.js";
import { viewModel, WAITING_TEXT, LAST_SHOW } from "../live/stage.js";
import { createFace } from "../glitch2d/pet.js";

// ── 與 glitch-vtuber test/events.test.mjs 同一組案例 ──

test("vn_line 更新 state.vn", () => {
  const s = applyEvent(emptyState(), { type: "vn_line", id: "1", speaker: "黑洞先生", text: "早", bg: null, audio: null, duration: 0 });
  assert.deepEqual(s.vn, { speaker: "黑洞先生", text: "早", bg: null });
});

test("vn_choices 後 vn_votes 累積到 choices.counts", () => {
  let s = applyEvent(emptyState(), { type: "vn_choices", id: "c1", options: [{ n: 1, text: "a" }, { n: 2, text: "b" }], endsAt: 123 });
  assert.deepEqual(s.choices.counts, {});
  s = applyEvent(s, { type: "vn_votes", id: "c1", counts: { 1: 2, 2: 1 } });
  assert.deepEqual(s.choices.counts, { 1: 2, 2: 1 });
  assert.equal(s.choices.endsAt, 123);
});

test("vn_choices 的 options 是空陣列表示清掉選項", () => {
  let s = applyEvent(emptyState(), { type: "vn_choices", id: "c1", options: [{ n: 1, text: "a" }], endsAt: 1 });
  s = applyEvent(s, { type: "vn_votes", id: "c1", counts: { 1: 3 } });
  assert.equal(validateEvent({ type: "vn_choices", id: "c1", options: [], endsAt: 2 }).ok, true);
  s = applyEvent(s, { type: "vn_choices", id: "c1", options: [], endsAt: 2 });
  assert.equal(s.choices, null);
  s = applyEvent(s, { type: "vn_votes", id: "c1", counts: { 1: 4 } });
  assert.equal(s.choices, null, "清掉之後晚到的票數不會把選項帶回來");
});

test("投票結束清掉選項後，畫面不再顯示選項框", () => {
  let s = applyEvent(emptyState(), { type: "vn_choices", id: "c1", options: [{ n: 1, text: "a" }], endsAt: 1 });
  s = applyEvent(s, { type: "vn_choices", id: "c1", options: [], endsAt: 2 });
  s = applyEvent(s, { type: "layout", mode: "vn" });
  assert.equal(viewModel(s, 3).choices, null);
});

test("chat 只留最近 20 則", () => {
  let s = emptyState();
  for (let i = 1; i <= 25; i++) s = applyEvent(s, { type: "chat", id: String(i), author: "a", text: "t" + i });
  assert.equal(s.chat.length, 20);
  assert.equal(s.chat[0].id, "6");
});

test("未知 type 驗證失敗", () => {
  assert.equal(validateEvent({ type: "x" }).ok, false);
});

test("layout 只接受 vn、choice、talk", () => {
  for (const mode of ["vn", "choice", "talk"]) assert.equal(validateEvent({ type: "layout", mode }).ok, true);
  assert.equal(validateEvent({ type: "layout", mode: "other" }).ok, false);
});

test("applyEvent 回新物件不改原 state", () => {
  const s0 = emptyState();
  const s1 = applyEvent(s0, { type: "status", live: true });
  assert.equal(s0.live, false);
  assert.equal(s1.live, true);
});

// ── 直播頁自己的案例 ──

test("snapshot 事件直接取代整個 state", () => {
  let s = emptyState();
  s = applyEvent(s, { type: "status", live: true });
  s = applyEvent(s, { type: "chat", id: "1", author: "舊", text: "舊留言" });
  s = applyEvent(s, { type: "vn_choices", id: "c0", options: [{ n: 1, text: "舊" }], endsAt: 1 });
  const snap = {
    live: true, layout: "choice",
    vn: { speaker: null, text: "旁白", bg: "https://example.com/bg.webp" },
    choices: null,
    chat: [{ id: "9", author: "新", text: "新留言" }],
    emote: "happy",
  };
  const r = applyEvent(s, { type: "snapshot", state: snap });
  assert.deepEqual(r, snap);
  assert.notEqual(r, snap, "要是新物件，不能直接拿事件裡那份");
});

test("沒開播時 state.live 為 false，頁面顯示等待畫面", () => {
  const s = emptyState();
  assert.equal(s.live, false);
  const v = viewModel(s, 0);
  assert.equal(v.waiting, true);
  assert.equal(WAITING_TEXT, "格莉奇還沒開播");
  assert.match(LAST_SHOW.url, /^https:\/\//);
  assert.ok(LAST_SHOW.label.length > 0);
  const live = viewModel(applyEvent(s, { type: "status", live: true }), 0);
  assert.equal(live.waiting, false);
});

test("viewModel 算出選項剩餘秒數與票數", () => {
  let s = applyEvent(emptyState(), { type: "status", live: true });
  s = applyEvent(s, { type: "vn_choices", id: "c1", options: [{ n: 1, text: "留下" }, { n: 2, text: "離開" }], endsAt: 20_000 });
  s = applyEvent(s, { type: "vn_votes", id: "c1", counts: { 1: 3 } });
  const v = viewModel(s, 12_500);
  assert.equal(v.choices.secondsLeft, 8);
  assert.deepEqual(v.choices.options.map((o) => [o.n, o.text, o.votes]), [[1, "留下", 3], [2, "離開", 0]]);
  assert.equal(viewModel(s, 30_000).choices.secondsLeft, 0);
});

test("state.js 與 glitch-vtuber 的 src/events.mjs 程式本體相同", (t) => {
  const here = fileURLToPath(new URL("../live/state.js", import.meta.url));
  const source = fileURLToPath(new URL("../../glitch-vtuber/src/events.mjs", import.meta.url));
  if (!existsSync(source)) return t.skip("本機沒有 ../glitch-vtuber，略過同步檢查");
  const body = (text) => text.slice(text.search(/^const LAYOUTS/m));
  assert.equal(body(readFileSync(here, "utf8")), body(readFileSync(source, "utf8")));
});

// ── pet.js：視線不被表情蓋掉 ──

function fakeMotion() {
  const calls = [];
  return { calls, setParameters(v) { calls.push({ ...v }); }, setSlots() {} };
}

test("gaze 不被表情蓋掉", () => {
  const motion = fakeMotion();
  const face = createFace(motion);
  face.gaze(1, 0);
  face.emote("happy");
  const last = motion.calls.at(-1);
  assert.equal(last.gazeX, 1);
  assert.equal(last.gazeY, 0);
  face.dispose();
});

test("gaze 在 neutral() 之後也還在", () => {
  const motion = fakeMotion();
  const face = createFace(motion);
  face.gaze(-0.6, 0.2);
  face.neutral();
  const last = motion.calls.at(-1);
  assert.equal(last.gazeX, -0.6);
  assert.equal(last.gazeY, 0.2);
  face.dispose();
});

test("沒設過視線時表情自己的視線照舊", () => {
  const motion = fakeMotion();
  const face = createFace(motion);
  face.emote("thinking");
  const merged = Object.assign({}, ...motion.calls);
  assert.equal(merged.gazeX, -1);
  assert.equal(merged.gazeY, -0.85);
  face.dispose();
});

test("gaze 的值夾在 -1 到 1，emote 未知名稱回到平常臉", () => {
  const motion = fakeMotion();
  const face = createFace(motion);
  face.gaze(5, -5);
  assert.deepEqual(motion.calls.at(-1), { gazeX: 1, gazeY: -1 });
  assert.equal(face.emote("nope"), false);
  assert.equal(motion.calls.at(-1).gazeX, 1);
  face.dispose();
});

// ── 中繼網址：公開站不吃 ?relay=，本機只放行本機中繼 ──
import { resolveRelay, PROD_RELAY, DEFAULT_RELAY } from "../live/stage.js";

test("本機頁面＋本機中繼：照用", () => {
  assert.equal(resolveRelay("http://127.0.0.1:8080/live/", "ws://127.0.0.1:9000"), "ws://127.0.0.1:9000");
  assert.equal(resolveRelay("http://localhost:8080/live/", "ws://localhost:8787"), "ws://localhost:8787");
});

test("本機頁面沒帶 relay：用本機預設", () => {
  assert.equal(resolveRelay("http://127.0.0.1:8080/live/", null), DEFAULT_RELAY);
});

test("本機頁面＋外部中繼：拒絕，退回本機預設", () => {
  assert.equal(resolveRelay("http://127.0.0.1:8080/live/", "wss://attacker.example"), DEFAULT_RELAY);
  assert.equal(resolveRelay("http://localhost:8080/live/", "ws://127.0.0.1.attacker.example"), DEFAULT_RELAY);
  assert.equal(resolveRelay("http://localhost:8080/live/", "javascript:alert(1)"), DEFAULT_RELAY);
});

test("公開站：不管 relay 參數，一律用 PROD_RELAY（目前 null）", () => {
  assert.equal(PROD_RELAY, null);
  assert.equal(resolveRelay("https://yazelin.github.io/ai-brain-site/live/", "wss://attacker.example"), PROD_RELAY);
  assert.equal(resolveRelay("https://yazelin.github.io/ai-brain-site/live/", "ws://127.0.0.1:8787"), PROD_RELAY);
  assert.equal(resolveRelay("https://yazelin.github.io/ai-brain-site/live/", null), PROD_RELAY);
});
