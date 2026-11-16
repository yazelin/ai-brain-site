// 格莉奇手機（larch/hud/glitch-phone.html）畫圖的端到端測試。全部在本機跑，不碰 .11 的 gemini-web。
//
//   cd worker && npx wrangler --version   # 需要 wrangler（部署本來就要）
//   node tests/hud_draw_e2e.mjs
//
// 需要 playwright-core 與 Chrome：PLAYWRIGHT_CORE 指到 playwright-core 的 index.mjs（預設試 ~/larch-preview 那份），
// CHROME 指到瀏覽器（預設 /usr/bin/google-chrome）。
//
// 架構：
//   假 gemini-web（/api/jobs）  ← wrangler dev 跑真的 worker/worker.js，本機 D1（暫存資料夾），IMG_DAILY_LIMIT=3
//   假轉接站（phone-chat-relay） ← HUD 聊天；讀者訊息有「畫」就回一個 [draw:none|...] 標記
//   假 Larch 播放器              ← 照 Larch 播放器建 HUD 的方式：srcdoc＋sandbox="allow-scripts"＋no-referrer，
//                                  回 larch:hud:init、收 larch:set 存變數；「重新整理」＝把框整個拆掉重建、用存著的變數 init
// 負控制：E2E_ALLOWED_ORIGINS=https://yazelin.github.io node tests/hud_draw_e2e.mjs（白名單拿掉 null），畫圖相關項目應該全部失敗。
// 不在 CI 跑（CI 沒有 wrangler 與 Chrome），改 worker.js 的 /img 或 HUD 的畫圖之前之後手動跑一次。

import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW = process.env.PLAYWRIGHT_CORE || path.join(homedir(), "larch-preview/node_modules/playwright-core/index.mjs");
const { chromium } = await import(PW);
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const LIMIT = 3;

function listen(handler) {
  return new Promise((res) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => res(s)); });
}
const port = (s) => s.address().port;
const body = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });

// ---- 假 gemini-web ----
// prompt 裡帶 OK：查第一次 running、第二次 succeeded；FAIL：第一次就 failed；SLOW：一直 running，直到 /ctl/release；
// DOWN：送單就回 500（上游掛掉）
const jobs = new Map();
let created = 0;
const upstream = await listen(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/ctl/release") { for (const j of jobs.values()) j.released = true; return send(200, { ok: 1 }); }
  if (req.method === "POST" && u.pathname === "/api/jobs") {
    const b = JSON.parse(await body(req));
    const text = b.contents[0].parts.map((p) => p.text || "").join("");
    if (/DOWN/.test(text)) return send(500, { detail: "stub down" });
    const mode = /FAIL/.test(text) ? "FAIL" : /SLOW/.test(text) ? "SLOW" : "OK";
    const id = `job${++created}${Math.random().toString(16).slice(2, 10)}`;
    jobs.set(id, { mode, polls: 0, released: false });
    return send(202, { id, status: "queued" });
  }
  const m = /^\/api\/jobs\/(.+)$/.exec(u.pathname);
  if (req.method === "GET" && m) {
    const j = jobs.get(decodeURIComponent(m[1]));
    if (!j) return send(404, { detail: "job not found" });
    j.polls++;
    const done = { status: "succeeded", response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }] } };
    if (j.mode === "FAIL") return send(200, { status: "failed", error: "stub failure" });
    if (j.mode === "SLOW") return send(200, j.released ? done : { status: "running" });
    return send(200, j.polls >= 2 ? done : { status: "running" });
  }
  send(404, {});
});

// ---- 假轉接站 ----
const systems = [];
const relay = await listen(async (req, res) => {
  const h = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "content-type": "application/json" };
  if (req.method === "OPTIONS") { res.writeHead(204, h); return res.end(); }
  const b = JSON.parse(await body(req));
  systems.push(b.system);
  const last = b.messages[b.messages.length - 1].content;
  const tag = (/(OK|FAIL|SLOW|DOWN)/.exec(last) || [])[1];
  const reply = /畫/.test(last) && tag ? `好，我來畫！\n[draw:none|a small test picture ${tag}]` : "逼——嗶！收到。";
  res.writeHead(200, h); res.end(JSON.stringify({ reply }));
});

// ---- wrangler dev（真的 worker.js）----
const WDIR = path.join(ROOT, "worker");
const persist = mkdtempSync(path.join(tmpdir(), "glitch-d1-"));
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "glitch-nodes", "--local", "--persist-to", persist],
  { cwd: WDIR, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, CI: "1" } });
let wport = 0, wproc = null;
async function startWorker() {
  wport = wport || 20000 + Math.floor(Math.random() * 20000);
  wproc = spawn("npx", ["wrangler", "dev", "--local", "--port", String(wport), "--persist-to", persist,
    "--var", `GEMINI_WEB_BASE_URL:http://127.0.0.1:${port(upstream)}`, "--var", `IMG_DAILY_LIMIT:${LIMIT}`,
    ...(process.env.E2E_ALLOWED_ORIGINS ? ["--var", `ALLOWED_ORIGINS:${process.env.E2E_ALLOWED_ORIGINS}`] : []),
    "--show-interactive-dev-session=false"], { cwd: WDIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  let log = ""; wproc.stdout.on("data", (c) => (log += c)); wproc.stderr.on("data", (c) => (log += c));
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${wport}/voice/nodes`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev 沒起來：\n" + log.slice(-2000));
}
async function stopWorker() {
  if (!wproc) return;
  const p = wproc; wproc = null;
  await new Promise((r) => { p.on("exit", r); p.kill("SIGINT"); setTimeout(() => { p.kill("SIGKILL"); r(); }, 5000); });
}
await startWorker();
const WORKER = `http://127.0.0.1:${wport}`;

// ---- 假 Larch 播放器 ----
const hudSrc = readFileSync(path.join(ROOT, "larch/hud/glitch-phone.html"), "utf8");
const posts = JSON.parse(readFileSync(path.join(ROOT, "posts.json"), "utf8"));
const host = await listen((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/hud.html") {
    const html = hudSrc
      .replace("https://phone-chat-relay.yazelinj303.workers.dev/chat", `http://127.0.0.1:${port(relay)}/chat`)
      .replace("https://glitch-chat.yazelinj303.workers.dev/img", `${WORKER}/img`)
      .replace("https://yazelin.github.io/ai-brain-site/", `http://127.0.0.1:${port(host)}/site/`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html);
  }
  if (u.pathname.startsWith("/site/")) {   // 日記與頭像改從 repo 讀，不打 GitHub Pages
    try {
      const f = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname.slice(6))));
      res.writeHead(200, { "access-control-allow-origin": "*", "content-type": u.pathname.endsWith(".json") ? "application/json" : "image/webp" });
      return res.end(f);
    } catch { res.writeHead(404); return res.end(); }
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><body style="margin:0;background:#333">
<iframe id="hud" style="position:absolute;right:0;top:0;border:0;width:88px;height:88px"></iframe>
<script>
var store = {glitch_reader_name: '', glitch_chat: '[]'}, html = '', card = '';
fetch('/hud.html').then(function (r) { return r.text(); }).then(function (t) { html = t; mount(true); });
// 照 Larch 播放器：srcdoc、sandbox 只有 allow-scripts、referrerpolicy=no-referrer（larch-preview vendor 的 inGameLanguage 模組）
function mount(sandboxed) {
  var old = document.getElementById('hud'), f = document.createElement('iframe');
  f.id = 'hud'; f.style.cssText = old.style.cssText; f.style.width = f.style.height = '88px';
  if (sandboxed) f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('referrerpolicy', 'no-referrer');
  old.replaceWith(f); f.srcdoc = html; window.ready = false;
}
addEventListener('message', function (e) {
  var f = document.getElementById('hud'), d = e.data;
  if (e.source !== f.contentWindow || !d) return;
  if (d.type === 'larch:ready') { window.ready = true; f.contentWindow.postMessage({type: 'larch:hud:init', variables: Object.assign({}, store), values: {}, cardId: card, boardId: '', active: true}, '*'); }
  if (d.type === 'larch:hud:resize') { f.style.width = d.width + 'px'; f.style.height = d.height + 'px'; }
  if (d.type === 'larch:set') store[d.name] = d.value;
});
</script></body>`);
});
// 非 sandbox 的對照組要走 localhost:*（白名單有這條），sandbox 版不管從哪裡開 Origin 都是 null
const HOST = `http://localhost:${port(host)}/`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
const hud = () => page.frameLocator("#hud");
const store = () => page.evaluate(() => JSON.parse(window.store.glitch_chat || "[]"));
const jobMsgs = async () => (await store()).filter((m) => m.job);
async function remount(sandboxed = true) {
  await page.evaluate((s) => window.mount(s), sandboxed);
  await page.waitForFunction(() => window.ready);
}
// 打開手機。偶爾第一下點在框剛建好的那一刻沒反應（負控制第一輪碰過一次），沒展開就再點一次。
async function openHud() {
  if (await hud().locator("#win").isVisible()) return;
  for (let i = 0; i < 3; i++) {
    await hud().locator("#fab").click();
    try { await hud().locator("#win").waitFor({ state: "visible", timeout: 3000 }); return; } catch {}
  }
  throw new Error("手機打不開");
}
async function say(text) {
  await hud().locator("#in").fill(text);
  await hud().locator("#in").press("Enter");
}
async function waitFor(fn, ms = 30000, what = "") {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("等不到：" + what);
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(["通過", name]); console.log("通過", name); }
  catch (e) {
    results.push(["失敗", name]); console.log("失敗", name, "\n  ", e.message.split("\n")[0]);
    const shot = path.join(tmpdir(), `hud-e2e-fail-${results.length}.png`);
    await page.screenshot({ path: shot }).then(() => console.log("   截圖", shot), () => {});
  }
}

try {
  await page.goto(HOST);
  await page.waitForFunction(() => window.ready);

  await step("CORS：Origin null 放行、白名單外的網域不給 allow-origin", async () => {
    const pre = (o) => fetch(`${WORKER}/img`, { method: "OPTIONS", headers: { Origin: o, "Access-Control-Request-Method": "POST" } });
    assert.equal((await pre("null")).headers.get("access-control-allow-origin"), "null");
    assert.equal((await pre("https://yazelin.github.io")).headers.get("access-control-allow-origin"), "https://yazelin.github.io");
    assert.equal((await pre("https://evil.example")).headers.get("access-control-allow-origin"), null);
  });

  await step("聊天照舊走轉接站：第一次打開問名字、回覆顯示", async () => {
    await openHud();
    await say("小測");
    await hud().locator(".m.her", { hasText: "收到" }).first().waitFor({ timeout: 15000 });
  });

  await step("送出→輪詢→完成顯示：回覆裡的 [draw:] 標記不顯示，圖出現在泡泡裡", async () => {
    await say("請畫 OK");
    await hud().locator(".drawing").first().waitFor({ timeout: 15000 });
    await hud().locator("img.pic").first().waitFor({ timeout: 30000 });
    const txt = await hud().locator("#log").innerText();
    assert.ok(!/\[draw:/.test(txt), "標記漏到畫面上：" + txt);
    assert.ok(txt.includes("好，我來畫！"));
    const raw = await page.evaluate(() => window.store.glitch_chat);
    assert.ok(!raw.includes("data:image"), "圖的 data URL 不該存進 Larch 變數");
    const j = await jobMsgs();
    assert.equal(j.length, 1); assert.equal(j[0].st, "done"); assert.equal(j[0].left, LIMIT - 1);
  });

  await step("燈箱：點圖把框撐到 640、圖保持比例放大、有另存提示；點圖本身不關，點背景或 Esc 關回原尺寸", async () => {
    const size = () => page.evaluate(() => { const f = document.getElementById("hud"); return [f.style.width, f.style.height]; });
    const open = await size();
    await hud().locator("img.pic").first().click();
    await hud().locator("#zoom").waitFor({ state: "visible" });
    assert.deepEqual(await size(), ["640px", "640px"]);
    assert.ok((await hud().locator("#zoom").innerText()).includes("按右鍵或長按可以另存"));
    assert.equal(await hud().locator("button.dl").count(), 0, "下載鈕應該已經拿掉");
    const fit = await hud().locator("#zoomImg").evaluate((i) => getComputedStyle(i).objectFit);
    assert.equal(fit, "contain");
    await hud().locator("#zoomImg").click();
    assert.ok(await hud().locator("#zoom").isVisible(), "點圖本身不該關掉（右鍵另存要能用）");
    await hud().locator("#zoom").click({ position: { x: 5, y: 5 } });
    await hud().locator("#zoom").waitFor({ state: "hidden" });
    assert.deepEqual(await size(), open);
    await hud().locator("img.pic").first().click();
    await hud().locator("#zoom").waitFor({ state: "visible" });
    await hud().locator("#zoom").press("Escape");
    await hud().locator("#zoom").waitFor({ state: "hidden" });
    assert.deepEqual(await size(), open);
    assert.equal((await fetch(`${WORKER}/img/file?job=x`)).status, 405, "/img/file 已拿掉，GET 落到 POST only");
  });

  await step("重建框之後，畫好的圖用 jobId 重新載入", async () => {
    await remount(true);
    await openHud();
    await hud().locator("img.pic").first().waitFor({ timeout: 15000 });
  });

  await step("失敗訊息：上游回 failed，泡泡顯示原因，而且那張還回額度", async () => {
    await openHud();
    await say("請畫 FAIL");
    await hud().locator(".m.her", { hasText: "這張沒畫成" }).first().waitFor({ timeout: 20000 });
    assert.ok((await hud().locator("#log").innerText()).includes("stub failure"));
    const f = (await jobMsgs()).find((m) => m.st === "error");
    assert.ok(f && f.err === "stub failure");
  });

  await step("上游掛掉：送單回 500，格莉奇說這張沒畫成，額度也還回去", async () => {
    await say("請畫 DOWN");
    await hud().locator(".m.her", { hasText: "upstream 500" }).first().waitFor({ timeout: 20000 });
  });

  await step("重新整理接得上：畫到一半把框拆掉重建，用存著的 jobId 接著等到圖出來", async () => {
    await say("請畫 SLOW");
    await waitFor(async () => (await jobMsgs()).some((m) => m.st === "pending"), 15000, "pending job 存進變數");
    assert.equal((await jobMsgs()).find((m) => m.st === "pending").left, LIMIT - 2, "失敗與上游掛掉那兩張應該都已經還回來");
    await remount(true);                       // ＝讀者按了重新整理：記憶體全沒了，只剩 Larch 變數
    await fetch(`http://127.0.0.1:${port(upstream)}/ctl/release`);
    await openHud();
    await waitFor(async () => (await hud().locator("img.pic").count()) === 2, 30000, "兩張圖都顯示");
    assert.ok((await jobMsgs()).every((m) => m.st !== "pending"));
  });

  await step("關掉 HUD 還在畫：收起手機後圖畫好、狀態寫回變數，再打開就看得到", async () => {
    for (const j of jobs.values()) j.released = false;
    await say("請畫 SLOW");
    await waitFor(async () => (await jobMsgs()).some((m) => m.st === "pending"), 15000, "第二張 pending");
    await hud().locator("#close").click();
    await fetch(`http://127.0.0.1:${port(upstream)}/ctl/release`);
    await waitFor(async () => (await jobMsgs()).every((m) => m.st !== "pending"), 20000, "收起來時也輪詢到完成");
    await openHud();
    await waitFor(async () => (await hud().locator("img.pic").count()) === 3, 15000, "三張圖");
  });

  await step(`額度用完：第 ${LIMIT + 1} 張回 429，格莉奇說明今天畫完了，請求沒有送到上游`, async () => {
    const before = created;
    await say("請畫 OK");
    await hud().locator(".m.her", { hasText: `今天的 ${LIMIT} 張圖已經畫完了` }).first().waitFor({ timeout: 15000 });
    assert.equal(created, before, "額度滿了還送到上游");
    assert.equal(created, LIMIT + 1, "OK、FAIL、SLOW、SLOW 共四次送單");
  });

  await step("isolate 回收不歸零：wrangler dev 整個重開（同一份本機 D1），還是 429", async () => {
    await stopWorker(); await startWorker();
    const r = await fetch(`${WORKER}/img`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x OK", ref: "none" }) });
    assert.equal(r.status, 429);
    assert.equal((await r.json()).left, 0);
  });

  await step("人設＋畫圖規則＋最長的一篇日記，系統提示仍在轉接站的 4000 字內", async () => {
    let best = null, n = {};
    for (const p of posts) { n[p.date] = (n[p.date] || 0) + 1; if (!best || String(p.body).length > String(best.p.body).length) best = { p, k: n[p.date] }; }
    const card = `d-${best.p.date.replace(/-/g, "")}-${best.k}`;
    await page.evaluate((c) => { window.card = c; }, card);
    await remount(true);
    await page.evaluate(() => { window.store.glitch_reader_name = "一二三四五六七八九十一二三四五六七八九十"; });
    await remount(true);
    await openHud();
    const before = systems.length;
    await say("你好");
    await waitFor(async () => systems.length > before, 15000, "轉接站收到");
    const sys = systems[systems.length - 1];
    assert.ok(sys.includes(best.p.date), "日記沒帶進去");
    assert.ok(sys.includes("[draw:glitch|"), "畫圖規則沒帶進去");
    console.log("   最長系統提示", sys.length, "字");
    assert.ok(sys.length <= 4000, `系統提示 ${sys.length} 字，會被轉接站截掉`);
  });
} finally {
  await browser.close();
  await stopWorker();
  for (const s of [upstream, relay, host]) s.close();
  rmSync(persist, { recursive: true, force: true });
}

const bad = results.filter((r) => r[0] !== "通過");
console.log(`\n${results.length - bad.length}/${results.length} 通過`);
process.exit(bad.length ? 1 : 0);
