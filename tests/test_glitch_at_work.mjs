import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalize, loadStatus, login, revoke, parseStoredToken, battery, relTime, weekBars, stepProgress,
  memoryShares, safeUrl, fixtureFrom, errorsOf, PUBLIC_URL, FULL_URL, LOGIN_URL, REVOKE_URL, FIXTURES,
} from "../js/glitch-at-work-data.js";

const sample = (name) => JSON.parse(readFileSync(new URL(`../${FIXTURES[name]}`, import.meta.url), "utf8"));

/* 假的 fetch：依網址回固定結果，並記下每次呼叫 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = routes[url];
    if (r === undefined || r === "network") throw new TypeError("Failed to fetch");
    if (typeof r === "number") return { ok: r >= 200 && r < 300, status: r, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  fn.calls = calls;
  return fn;
}

test("三份範例資料都整理得出來", () => {
  for (const name of ["public", "full", "empty"]) assert.ok(normalize(sample(name)), name);
  assert.equal(normalize(sample("full")).full, true);
  assert.equal(normalize(sample("public")).full, false);
});

test("不是物件就當格式看不懂", () => {
  for (const bad of [null, "x", 3, [1]]) assert.equal(normalize(bad), null);
});

test("公開網址帶 full:true 也不收私人欄位", () => {
  const raw = { ...sample("full") };
  const d = normalize(raw, { allowFull: false });
  assert.equal(d.full, false);
  assert.deepEqual(d.runs, []);
  assert.equal(d.errors, null);
  assert.equal(d.energy.claudeWeekly, null);
  assert.ok(d.works.every((w) => !w.log && !w.preview));
  assert.ok(d.memory.people.every((p) => p.notes.length === 0));
  assert.ok(d.memory.recentSaid.every((s) => !s.dm), "公開版不能出現私訊");
});

test("壞欄位補預設、未知狀態當離線、數字夾在範圍內", () => {
  const d = normalize({ status: { state: "dancing" }, energy: { weekly: 140, fiveHour: -3 }, today: { replies: "7" }, played: [{ url: "javascript:alert(1)" }] });
  assert.equal(d.status.state, "offline");
  assert.equal(d.energy.weekly, 100);
  assert.equal(d.energy.fiveHour, 0);
  assert.equal(d.today.replies, 0);
  assert.equal(d.played[0].url, null);
});

test("safeUrl 只放行 http(s)", () => {
  assert.equal(safeUrl("https://larch.ink/x"), "https://larch.ink/x");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,hi"), null);
  assert.equal(safeUrl(""), null);
});

test("fixture 參數只認三個值", () => {
  assert.equal(fixtureFrom("?glitchAtWorkFixture=full"), "full");
  assert.equal(fixtureFrom("?glitchAtWorkFixture=../../etc"), null);
  assert.equal(fixtureFrom(""), null);
});

test("電量口吻", () => {
  assert.equal(battery(51).text, "電量 51%");
  assert.equal(battery(5).level, "empty");
  assert.match(battery(5).text, /快沒電了，先休眠/);
  assert.equal(battery(null).level, "unknown");
  assert.equal(battery(80).level, "high");
});

test("相對時間", () => {
  const now = Date.parse("2026-11-26T03:00:00Z");
  assert.equal(relTime("2026-11-26T02:59:50Z", now), "剛剛");
  assert.equal(relTime("2026-11-26T02:57:00Z", now), "3 分鐘前");
  assert.equal(relTime("2026-11-26T05:00:00Z", now), "2 小時後");
  assert.equal(relTime("nope", now), "");
});

test("七天長條與進度、記憶體佔比", () => {
  const wb = weekBars(sample("public").week);
  assert.equal(wb.days.length, 7);
  assert.equal(wb.max, 11);
  assert.equal(wb.days[5].rH, 1);
  assert.equal(wb.days[0].label, "11/20");
  assert.equal(wb.days[0].weekday, "五");
  assert.deepEqual(stepProgress([{ done: true }, { done: false }]), { done: 1, total: 2, ratio: 0.5 });
  const ms = memoryShares(sample("public").memory);
  assert.equal(ms.total, 20);
  assert.equal(ms.shares.at(-1).who, "其他"); // 10+6+3=19，剩 1 張歸其他
});

test("公開版不收紙條內文、私訊對象、作品來源", () => {
  const raw = { ...sample("full"), full: true };
  const d = normalize(raw, { allowFull: false });
  assert.ok(d.memory.people.every((p) => p.latest === "" && p.notes.length === 0));
  assert.deepEqual(d.today.dmBy, []);
  assert.ok(d.played.every((p) => !p.dm && !p.where));
});

test("完整版 dmBy 兩種形狀、多到少排", () => {
  const f = normalize(sample("full"));
  assert.deepEqual(f.today.dmBy, [{ who: "範例好友甲", count: 2 }, { who: "範例作者丁", count: 1 }]);
  const g = normalize({ full: true, today: { dmBy: [{ who: "甲", count: 1 }, { who: "乙", count: 4 }] } });
  assert.equal(g.today.dmBy[0].who, "乙");
});

test("errors 正式形狀 {count, items}", () => {
  const e = normalize(sample("full")).errors;
  assert.equal(e.count, 3);
  assert.deepEqual(e.reasons.map((r) => r.text), ["畫圖逾時", "Larch 回應 502"]);
  assert.equal(errorsOf({ count: 1, items: ["逾時"] }).reasons[0].text, "逾時");
});

test("errors 舊形狀也收", () => {
  assert.deepEqual(errorsOf(2), { count: 2, reasons: [] });
  assert.equal(errorsOf(["a", "b"]).count, 2);
  assert.equal(errorsOf({ count: 3, reasons: [{ reason: "逾時", count: 2 }] }).reasons[0].text, "逾時");
  assert.equal(errorsOf({ summary: "Larch 502" }).count, 1);
});

test("通行證：過期或壞掉都當沒登入", () => {
  const now = Date.parse("2026-11-26T00:00:00Z");
  assert.deepEqual(parseStoredToken(JSON.stringify({ token: "t", expiresAt: "2026-12-01T00:00:00Z" }), now), { token: "t", expiresAt: "2026-12-01T00:00:00Z" });
  assert.equal(parseStoredToken(JSON.stringify({ token: "t", expiresAt: "2026-11-01T00:00:00Z" }), now), null);
  assert.equal(parseStoredToken("{壞掉", now), null);
  assert.equal(parseStoredToken(null, now), null);
});

test("登入：成功、帳密錯、錯太多次、連不到", async () => {
  const good = async () => ({ ok: true, status: 200, json: async () => ({ token: "abc", expiresAt: "2099-01-01T00:00:00Z" }) });
  const ok = await login({ fetchImpl: good, user: "u", password: "p" });
  assert.deepEqual(ok, { ok: true, token: "abc", expiresAt: "2099-01-01T00:00:00Z" });
  const f = fakeFetch({ [LOGIN_URL]: 401 });
  assert.equal((await login({ fetchImpl: f, user: "u", password: "p" })).error, "bad-credentials");
  assert.equal(f.calls[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), { user: "u", password: "p" });
  assert.equal((await login({ fetchImpl: fakeFetch({ [LOGIN_URL]: 429 }), user: "u", password: "p" })).error, "too-many");
  assert.equal((await login({ fetchImpl: fakeFetch({}), user: "u", password: "p" })).error, "unreachable");
});

test("登出作廢：帶同一個 Bearer，失敗不 throw", async () => {
  const f = fakeFetch({ [REVOKE_URL]: 200 });
  assert.equal(await revoke({ fetchImpl: f, token: "abc" }), true);
  assert.equal(f.calls[0].opts.headers.Authorization, "Bearer abc");
  assert.equal(await revoke({ fetchImpl: fakeFetch({}), token: "abc" }), false);
});

test("沒登入抓公開版；公開版 404 是「還沒開始回報」、連不到是 unreachable", async () => {
  const pub = sample("public");
  let r = await loadStatus({ fetchImpl: fakeFetch({ [PUBLIC_URL]: pub }) });
  assert.equal(r.mode, "public");
  r = await loadStatus({ fetchImpl: fakeFetch({ [PUBLIC_URL]: 404 }) });
  assert.equal(r.problem, "not-started");
  r = await loadStatus({ fetchImpl: fakeFetch({}) });
  assert.equal(r.problem, "unreachable");
});

test("有通行證抓完整版並帶 Bearer", async () => {
  const f = fakeFetch({ [FULL_URL]: sample("full") });
  const r = await loadStatus({ fetchImpl: f, token: "abc" });
  assert.equal(r.mode, "full");
  assert.equal(r.data.full, true);
  assert.equal(f.calls[0].opts.headers.Authorization, "Bearer abc");
});

test("完整版 401/403：要求清 token、提示過期、退回公開版", async () => {
  for (const code of [401, 403]) {
    const r = await loadStatus({ fetchImpl: fakeFetch({ [FULL_URL]: code, [PUBLIC_URL]: sample("public") }), token: "old" });
    assert.equal(r.mode, "public");
    assert.equal(r.notice, "expired");
    assert.equal(r.dropToken, true);
  }
});

test("完整版連不到：退回公開版並標示，token 不清", async () => {
  const r = await loadStatus({ fetchImpl: fakeFetch({ [FULL_URL]: "network", [PUBLIC_URL]: sample("public") }), token: "abc" });
  assert.equal(r.mode, "public");
  assert.equal(r.notice, "full-unreachable");
  assert.equal(r.dropToken, false);
});
