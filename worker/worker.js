/* glitch-chat: 格莉奇OS 聊天代理。
   前端不用帶 key。Worker 注入 GEMINI_API_KEY，把對話轉到 .11 的 gemini-web，
   並塞入格莉奇人設 system instruction。輕量限流（每 IP 每分鐘 12 次）。
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

    let body;
    try { body = await req.json(); } catch { return err(400, "bad json"); }
    const msgs = Array.isArray(body.messages) ? body.messages : [{ role: "user", content: body.text || "" }];
    const contents = msgs
      .filter((m) => m && m.content)
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] }));
    if (!contents.length) return err(400, "empty");

    const base = (env.GEMINI_WEB_BASE_URL || "").replace(/\/+$/, "");
    const model = env.MODEL || "gemini-2.5-flash";
    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      generationConfig: { temperature: 1.1, maxOutputTokens: 400 },
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY || "" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return err(502, `upstream ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join("").trim();
    if (!text) return err(502, "no text in upstream response");
    return new Response(JSON.stringify({ reply: text }), { headers: { "content-type": "application/json", ...cors } });
  },
};