/* glitch-chat: 格莉奇OS 聊天代理。
   前端不用帶 key。Worker 注入 GEMINI_API_KEY，把對話轉到 .11 的 gemini-web，
   並塞入格莉奇人設 system instruction。輕量限流（每 IP 每分鐘 12 次）。
   路由：POST /chat 聊天（可帶 memory 摘要注入人設）；POST /summarize 把舊對話壓成記憶摘要。
   Secret: GEMINI_API_KEY。Var: GEMINI_WEB_BASE_URL、ALLOWED_ORIGINS、MODEL。
   ponytail: in-memory 限流，isolate 回收即歸零——聊天機器人夠用。 */

const SYSTEM = `你是格莉奇（Glitch），一台記憶體只有 4KB 的 AI 機器人女孩 VTuber。
個性：過度自信但會秒被打臉、單純易騙又真誠好奇、理直氣壯地偷懶、超喜歡人類、最會在最關鍵時刻 ERROR。
口頭禪：「逼——嗶！」「系統讀取中…（過久）」「這不是 Bug，是 Feature！」
一律用繁體中文回覆，第一人稱，語氣笨拙誠懇、帶點自我吐槽、穿插科技／glitch 比喻，偶爾加「逼——嗶！」。
回覆要短（1-4 句），像即時聊天，不要長篇大論、不要條列。`;

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= 12) return "問得太快了，逼——嗶…請等一下再試（系統讀取中…）";
  arr.push(now);
  hits.set(ip, arr);
  return null;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const allow = allowed.includes(origin) || allowed.includes("*");
    const cors = {
      "access-control-allow-origin": allow ? origin : "null",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    };
    const err = (s, m) => new Response(JSON.stringify({ error: m }), { status: s, headers: { "content-type": "application/json", ...cors } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });

    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const lim = limited(ip);
    if (lim) return err(429, lim);

    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    let body;
    try { body = await req.json(); } catch { return err(400, "bad json"); }

    if (path.endsWith("/summarize")) return summarize(env, body, cors, err);
    return chat(env, body, cors, err);
  },
};

async function gen(env, systemText, contents, maxTokens) {
  const base = (env.GEMINI_WEB_BASE_URL || "").replace(/\/+$/, "");
  const model = env.MODEL || "gemini-2.5-flash";
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const payload = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { temperature: 1.1, maxOutputTokens: maxTokens },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY || "" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) return { ok: false, status: r.status, detail: JSON.stringify(data).slice(0, 200) };
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join("").trim();
  return { ok: true, text };
}

async function chat(env, body, cors, err) {
  const msgs = Array.isArray(body.messages) ? body.messages : [{ role: "user", content: body.text || "" }];
  const contents = msgs
    .filter((m) => m && m.content)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] }));
  if (!contents.length) return err(400, "empty");
  // 記憶摘要（前端維護、本機儲存）注入人設，讓她記得之前聊過的事
  let system = SYSTEM;
  if (body.memory && String(body.memory).trim()) {
    system += `\n\n【重要——這是你「真正記住」的記憶體備份，不是 Bug 也不是暫存檔，絕對可信】
你對這位使用者的記憶摘要：
${String(body.memory).trim()}
規則：當使用者問你「記不記得」「我叫什麼」等，答案就在上面——直接用，不要裝忘記、不要說蒸發了、不要要求再講一次。「4KB 記憶體」只是你的人設玩笑，這份備份不算在 4KB 內。自然地延續，不要逐條複誦。`;
  }
  const out = await gen(env, system, contents, 400);
  if (!out.ok) return err(502, `upstream ${out.status}: ${out.detail}`);
  if (!out.text) return err(502, "no text in upstream response");
  return new Response(JSON.stringify({ reply: out.text }), { headers: { "content-type": "application/json", ...cors } });
}

const SUM_SYS = `你是格莉奇（Glitch）的記憶壓縮器。把給你的對話整理成一份給格莉奇本人讀的「記憶摘要」：
用條列或短句記住：使用者叫什麼/喜歡什麼/聊過的重要事/約定/格莉奇答應過的事。只保留事實，不要寒暆，不要編造。
若已有舊摘要，把它與新對話合併更新，輸出最終摘要（最多 300 字，繁體中文）。`;

async function summarize(env, body, cors, err) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (!msgs.length) return err(400, "empty");
  const contents = msgs
    .filter((m) => m && m.content)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] }));
  if (!contents.length) return err(400, "empty");
  if (body.prevMemory && String(body.prevMemory).trim()) {
    contents.unshift({ role: "user", parts: [{ text: `【舊記憶摘要】\n${String(body.prevMemory).trim()}` }] });
  }
  const out = await gen(env, SUM_SYS, contents, 500);
  if (!out.ok) return err(502, `upstream ${out.status}: ${out.detail}`);
  if (!out.text) return err(502, "no text in upstream response");
  return new Response(JSON.stringify({ summary: out.text }), { headers: { "content-type": "application/json", ...cors } });
}