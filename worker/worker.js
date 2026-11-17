/* glitch-chat: 格莉奇OS 聊天代理。
   前端不用帶 key。Worker 注入 GEMINI_API_KEY，把對話轉到 .11 的 gemini-web，
   並塞入格莉奇人設 system instruction。輕量限流（每 IP 每分鐘 12 次）。
   路由：POST /chat 聊天（可帶 memory 摘要注入人設）；POST /summarize 把舊對話壓成記憶摘要；
   POST /img 轉送出圖 job 給 gemini-web（每人每天限 IMG_DAILY_LIMIT 張）；GET /img 查 job 進度。
   Secret: GEMINI_API_KEY。Var: GEMINI_WEB_BASE_URL、ALLOWED_ORIGINS、MODEL、IMAGE_MODEL、IMG_DAILY_LIMIT。
   ponytail: 每分鐘限流是 in-memory，isolate 回收即歸零——聊天機器人夠用。
   每日出圖額度要撐過 isolate 回收，存在 D1（NODES_DB 那個庫的 img_quota 表）。 */

import PERSONA from "../persona.json";

// 畫她自己時送的兩張參考圖，順序與圖說跟日記插畫（scripts/generate_post.py）一致：
// image 1＝畫風錨（貼圖 01），image 2＝三視圖。三視圖用最長邊 1024 的縮小版，
// 原圖 1910×1536，base64 進 Worker 白花 CPU 與頻寬，大圖也比較容易讓生圖漂。
// 以前送的是 images/glitch-ref.webp，那張在 2026-08-27 被換成機器人頭圖示，畫出來就不像她。
const SITE = "https://yazelin.github.io/ai-brain-site/";
const GLITCH_REFS = [
  { url: SITE + PERSONA.styleAnchor, desc: PERSONA.styleAnchorDesc },
  { url: SITE + PERSONA.modelSheetSmall, desc: PERSONA.modelSheetDesc },
];

const STICKER_LIST = Object.entries(PERSONA.stickers)
  .map(([id, cap]) => `- ${id}：${cap}`)
  .join("\n");

const EMOTE_LIST = Object.entries(PERSONA.emotes || {})
  .map(([id, desc]) => `- ${id}：${desc}`)
  .join("\n");

const SYSTEM = `${PERSONA.voice}

${PERSONA.taskNote}

一律用繁體中文回覆，第一人稱。回覆要短（1-4 句），像即時聊天，不要長篇大論、不要條列。

【你可以用的標記】
需要時，在回覆裡自己獨立一行放標記。標記不會被使用者看到，會被系統執行。

1. 回一張現成貼圖：[sticker:編號]
2. 畫一張圖：[draw:參考|英文 prompt|sticker=編號@位置]
   - 參考填 glitch（畫你自己，系統會把你的三視圖設定稿附給生圖模型）或 none（只畫場景，畫面裡不要有你）
   - prompt 用英文寫，寫具體，這是你自己的作品，認真下
   - prompt 裡絕對不能出現 | 、[ 、] 這三個符號，出現的話整條標記會直接失效、整段被丟掉
   - |sticker=編號@位置 這段可以整段省略。要的話位置填 tl / tr / bl / br，系統會把那張貼圖貼在圖的那個角落
   - ${PERSONA.characters.hole.name}沒有設定稿，畫不出來。要他入鏡就用貼圖疊上去
3. 換桌寵表情：[emote:代號]
   - 桌面上站著你的分身。這個標記會讓她切換表情幾秒，配合回覆的情緒用
   - 表情標記很輕，回覆的情緒明顯時就配一個

【表情代號】
${EMOTE_LIST}

【貼圖編號與台詞】
${STICKER_LIST}

【${PERSONA.characters.hole.name}】
${PERSONA.characters.hole.desc}

【那本寫你的小說】
${Object.values(PERSONA.novel).join("\n")}

貼圖不用每則都配，該配的時候才配。使用者沒有要求圖的時候不要自己亂畫。

畫一張圖要 30 秒到 5 分鐘，使用者會看到「畫圖中」。所以不要在回話裡承諾「馬上好」。`;

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

// 幾分鐘沒心跳就當節點離線（原 KV 版是 expirationTtl 300）
const NODE_TTL_MS = 300000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const allow = originAllowed(origin, allowed);
    // 不在白名單就不給 allow-origin。舊版這裡回字串 "null"，但瀏覽器會拿它去比對
    // sandbox iframe 送來的 Origin: null，結果等於放行所有 opaque origin（任何網站的
    // sandbox iframe、file://、data:），白名單形同虛設。現在要放行 Larch 的 HUD 與
    // 小遊戲卡，就在 ALLOWED_ORIGINS 明寫 null，拿掉那一項就真的關掉。
    const cors = {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
      "vary": "Origin",
    };
    if (allow) cors["access-control-allow-origin"] = origin;
    const err = (s, m) => new Response(JSON.stringify({ error: m }), { status: s, headers: { "content-type": "application/json", ...cors } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // 輪詢查進度：只是轉查一個 SQLite 欄位，不會觸發生成，所以不計限流。
    // 前端每 3 秒問一次＝每分鐘 20 次，計進去會把使用者自己鎖死（連聊天一起）。
    if (req.method === "GET" && path.endsWith("/img")) return imgStatus(env, url, cors, err);

    // 格莉奇語音節點註冊中心（支援開源社群多節點自動發現）
    if (req.method === "GET" && path.endsWith("/voice/nodes")) return handleGetVoiceNodes(env, cors);
    if (req.method === "POST" && path.endsWith("/voice/register")) {
      let body;
      try { body = await req.json(); } catch { return err(400, "bad json"); }
      return handleRegisterVoiceNode(env, body, cors, err);
    }
    if (req.method === "POST" && path.endsWith("/voice/unregister")) {
      let body;
      try { body = await req.json(); } catch { return err(400, "bad json"); }
      return handleUnregisterVoiceNode(env, body, cors, err);
    }

    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });

    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const lim = limited(ip);
    if (lim) return err(429, lim);

    let body;
    try { body = await req.json(); } catch { return err(400, "bad json"); }

    if (path.endsWith("/summarize")) return summarize(env, body, cors, err);
    if (path.endsWith("/img")) return imgStart(env, body, cors, err, ip);
    return chat(env, body, cors, err);
  },
};

// 設定裡寫的是 http://localhost:*，但原本是字串完全比對，那個星號只是一個字元，
// 所以那條規則從來沒生效過（本機開發打這個 Worker 一律被 CORS 擋）。這裡只讓
// 埠號的位置吃萬用字元，其餘照舊完全比對，不做任意 pattern。
function originAllowed(origin, allowed) {
  if (!origin) return false;
  if (allowed.includes("*") || allowed.includes(origin)) return true;
  return allowed.some((a) => {
    if (!a.endsWith(":*")) return false;
    const prefix = a.slice(0, -1);                       // "http://localhost:"
    return origin.startsWith(prefix) && /^\d+$/.test(origin.slice(prefix.length));
  });
}

async function handleGetVoiceNodes(env, cors) {
  // 只回最近有心跳的節點。KV 版靠 TTL 300 秒自動過期，D1 沒有 TTL，改用 last_seen 過濾。
  const nodes = [];
  if (env.NODES_DB) {
    try {
      const { results } = await env.NODES_DB.prepare(
        "SELECT id, name, url, engine, character, version, is_default, requires_key, last_seen FROM voice_nodes " +
        "WHERE last_seen > ?1 ORDER BY is_default DESC, last_seen DESC"
      ).bind(Date.now() - NODE_TTL_MS).all();
      for (const r of results || []) {
        if (r.url) nodes.push({ ...r, is_default: !!r.is_default, requires_key: !!r.requires_key });
      }
    } catch (e) {
      console.error("D1 fetch error", e);
    }
  }
  return new Response(JSON.stringify({ nodes }), {
    headers: { "content-type": "application/json", ...cors },
  });
}

async function handleRegisterVoiceNode(env, body, cors, err) {
  const { id, name, url, engine, character, version, is_default, requires_key } = body || {};
  if (!id || !url) return err(400, "missing id or url");

  const cleanUrl = String(url).trim().replace(/\/+$/, "");
  const cleanId = String(id).trim().replace(/[^a-zA-Z0-9_-]/g, "");

  const nodeData = {
    id: cleanId,
    name: name || "社群格莉奇語音節點",
    url: cleanUrl,
    engine: engine || "f5-tts",
    character: character || "格莉奇",
    version: version || "1.0",
    is_default: !!is_default,
    // 節點自己說要不要金鑰，呼叫端才能在打之前就決定帶不帶，不用先吃一次 401
    requires_key: !!requires_key,
    last_seen: Date.now(),
  };

  if (env.NODES_DB) {
    // 心跳 = 一列 upsert。順手刪掉一天以上沒回來的，D1 沒有 TTL 要自己收。
    await env.NODES_DB.batch([
      env.NODES_DB.prepare(
        "INSERT INTO voice_nodes (id, name, url, engine, character, version, is_default, requires_key, last_seen) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET " +
        "name=?2, url=?3, engine=?4, character=?5, version=?6, is_default=?7, requires_key=?8, last_seen=?9"
      ).bind(nodeData.id, nodeData.name, nodeData.url, nodeData.engine, nodeData.character,
             nodeData.version, nodeData.is_default ? 1 : 0, nodeData.requires_key ? 1 : 0, nodeData.last_seen),
      env.NODES_DB.prepare("DELETE FROM voice_nodes WHERE last_seen < ?1").bind(Date.now() - 86400000),
    ]);
  }

  return new Response(JSON.stringify({ status: "registered", node: nodeData }), {
    headers: { "content-type": "application/json", ...cors },
  });
}

async function handleUnregisterVoiceNode(env, body, cors, err) {
  const { id } = body || {};
  if (!id) return err(400, "missing id");
  const cleanId = String(id).trim().replace(/[^a-zA-Z0-9_-]/g, "");
  if (env.NODES_DB) {
    await env.NODES_DB.prepare("DELETE FROM voice_nodes WHERE id = ?1").bind(cleanId).run();
  }
  return new Response(JSON.stringify({ status: "unregistered", id: cleanId }), {
    headers: { "content-type": "application/json", ...cors },
  });
}

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
用條列或短句記住：使用者叫什麼/喜歡什麼/聊過的重要事/約定/格莉奇答應過的事。只保留事實，不要寒暄，不要編造。
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

function json(obj, cors) {
  return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json", ...cors } });
}

// 大圖用 String.fromCharCode(...arr) 會爆堆疊，所以分塊。
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function imgStart(env, body, cors, err, ip) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return err(400, "empty");
  const ref = body.ref === "glitch" ? "glitch" : "none";

  // 先佔一格額度再送單：兩個請求同時進來也不會一起擠過最後一格。
  // 送單失敗（上游掛掉、參考圖抓不到）就把那格還回去，讀者不會白白被扣。
  const limit = dailyLimit(env);
  const who = await whoIs(ip);
  const day = taipeiDay();
  let left = null;
  if (limit > 0) {
    const used = await quotaTake(env, day, who, limit);
    if (used === null) {
      return new Response(JSON.stringify({
        error: `逼——嗶！今天的 ${limit} 張圖已經畫完了，明天再來找我畫（台北時間 0 點重置）。`,
        left: 0, limit,
      }), { status: 429, headers: { "content-type": "application/json", ...cors } });
    }
    left = limit - used;
  }
  let out;
  try { out = await imgSubmit(env, prompt, ref); }
  catch (e) { out = { error: `upstream unreachable: ${String(e && e.message || e).slice(0, 120)}` }; }
  if (out.error) {
    if (limit > 0) await quotaGive(env, day, who);
    return err(502, out.error);
  }
  if (limit > 0) await jobRemember(env, out.jobId, day, who);
  return json(limit > 0 ? { jobId: out.jobId, left, limit } : { jobId: out.jobId }, cors);
}

async function imgSubmit(env, prompt, ref) {
  // 角色表只在畫她自己時才附上——ref="none" 代表她明確說了「畫面裡不要有我」，
  // 這時還把她的外觀描述塞給生圖模型，等於承諾（system prompt）跟實作對不上，
  // 模型很可能就把她畫進本該只有場景的圖裡。
  let parts;
  if (ref === "glitch") {
    const imgs = await Promise.all(GLITCH_REFS.map(async ({ url }) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ref image ${r.status} ${url}`);
      return { inlineData: { mimeType: "image/webp", data: toBase64(await r.arrayBuffer()) } };
    })).catch((e) => ({ error: e.message }));
    if (imgs.error) return { error: imgs.error };
    const g = PERSONA.characters.glitch;
    // 提示詞的排法照 generate_post.py 的 IMAGE_PROMPT_TPL：先講兩張參考圖是什麼，再角色表、場景、規則。
    // 文字在前、圖在後，順序要對上 image 1、image 2。
    const refs = GLITCH_REFS.map((x, i) => `- image ${i + 1}: ${x.desc}`).join("\n");
    const text = `REFERENCE IMAGES:\n${refs}\n\n${g.identity}\n\n${g.outfits[g.defaultOutfit]}\n\n`
      + `SCENE:\n${prompt}\n\n${PERSONA.imageRules}`;
    parts = [{ text }, ...imgs];
  } else {
    parts = [{ text: `${prompt}\n\n${PERSONA.imageRules}` }];
  }

  const base = (env.GEMINI_WEB_BASE_URL || "").replace(/\/+$/, "");
  const r = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY || "" },
    body: JSON.stringify({
      model: env.IMAGE_MODEL || "gemini-2.5-flash-image",
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) return { error: `upstream ${r.status}: ${JSON.stringify(d).slice(0, 160)}` };
  return { jobId: d.id };
}

async function imgStatus(env, url, cors, err) {
  const jobId = url.searchParams.get("job");
  if (!jobId) return err(400, "missing job");
  const base = (env.GEMINI_WEB_BASE_URL || "").replace(/\/+$/, "");
  const r = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`, {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY || "" },
  });
  if (r.status === 404) return err(404, "job not found or expired");
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return err(502, `upstream ${r.status}`);

  if (d.status === "queued" || d.status === "running") return json({ status: "pending" }, cors);
  if (d.status === "failed") {
    await jobRefund(env, jobId);
    return json({ status: "error", error: d.error || "未知錯誤" }, cors);
  }

  const image = firstInlineImage(d.response);
  if (!image) {
    await jobRefund(env, jobId);
    return json({ status: "error", error: "no image in upstream response" }, cors);
  }
  return json({ status: "done", image }, cors);
}

/* ---- 每日出圖額度 ----
   「每人」＝同一個 IP（CF-Connecting-IP），跟每分鐘限流同一套認人法；IP 先做 SHA-256 再存，D1 裡沒有原始 IP。
   「每天」＝台北日期，0 點換日。
   有 NODES_DB（D1）就存 D1：isolate 回收、換機房都不會歸零。沒有（本機沒綁、或 migration 沒跑）
   就退回記憶體版，那個版本 isolate 回收會歸零、每個機房各算各的，只能當防連點。
   job 畫失敗（上游回 failed 或沒有圖）會把那格還回去，同一個 job 只還一次。 */
function dailyLimit(env) {
  const n = parseInt(env.IMG_DAILY_LIMIT ?? "10", 10);
  return Number.isFinite(n) ? n : 10;
}

function taipeiDay(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

async function whoIs(ip) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`glitch-img:${ip}`));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const memQuota = new Map();   // `${day}|${who}` -> 已用張數
const memJobs = new Map();    // jobId -> { day, who }

function d1(env) { return env.NODES_DB || null; }

// 回傳佔完之後今天已用幾張；額度滿了回 null。
async function quotaTake(env, day, who, limit) {
  const db = d1(env);
  if (db) {
    let row;
    try {
      row = await db.prepare(
        "INSERT INTO img_quota (day, who, n) VALUES (?1, ?2, 1) " +
        "ON CONFLICT(day, who) DO UPDATE SET n = n + 1 WHERE n < ?3 RETURNING n"
      ).bind(day, who, limit).first();
    } catch (e) {
      console.error("img_quota D1 error, falling back to memory", e);
      row = undefined;
    }
    if (row !== undefined) {
      // 舊日期順手收掉，D1 沒有 TTL。一天最多幾十次，不值得另開排程。
      try {
        await db.prepare("DELETE FROM img_quota WHERE day < ?1").bind(taipeiDay(Date.now() - 7 * 86400_000)).run();
      } catch (e) { console.error("img_quota cleanup error", e); }
      return row ? row.n : null;
    }
  }
  const k = `${day}|${who}`;
  const n = memQuota.get(k) || 0;
  if (n >= limit) return null;
  if (memQuota.size > 5000) memQuota.clear();
  memQuota.set(k, n + 1);
  return n + 1;
}

async function quotaGive(env, day, who) {
  const db = d1(env);
  if (db) {
    try {
      await db.prepare("UPDATE img_quota SET n = n - 1 WHERE day = ?1 AND who = ?2 AND n > 0").bind(day, who).run();
      return;
    } catch (e) {
      console.error("img_quota D1 error", e);
    }
  }
  const k = `${day}|${who}`;
  if (memQuota.get(k) > 0) memQuota.set(k, memQuota.get(k) - 1);
}

async function jobRemember(env, jobId, day, who) {
  const db = d1(env);
  if (db) {
    try {
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO img_jobs (job_id, day, who, refunded) VALUES (?1, ?2, ?3, 0)").bind(jobId, day, who),
        db.prepare("DELETE FROM img_jobs WHERE day < ?1").bind(taipeiDay(Date.now() - 7 * 86400_000)),
      ]);
      return;
    } catch (e) {
      console.error("img_jobs D1 error", e);
    }
  }
  if (memJobs.size > 5000) memJobs.clear();
  memJobs.set(jobId, { day, who });
}

async function jobRefund(env, jobId) {
  const db = d1(env);
  if (db) {
    try {
      const row = await db.prepare(
        "UPDATE img_jobs SET refunded = 1 WHERE job_id = ?1 AND refunded = 0 RETURNING day, who"
      ).bind(jobId).first();
      if (row) await quotaGive(env, row.day, row.who);
      return;
    } catch (e) {
      console.error("img_jobs D1 error", e);
    }
  }
  const j = memJobs.get(jobId);
  if (j) { memJobs.delete(jobId); await quotaGive(env, j.day, j.who); }
}

// gemini-web 回的就是 generateContent 原本那包，圖在 inlineData 裡。
function firstInlineImage(response) {
  for (const p of response?.candidates?.[0]?.content?.parts || []) {
    const d = p.inlineData || p.inline_data;
    if (d && d.data) return `data:${d.mimeType || d.mime_type || "image/png"};base64,${d.data}`;
  }
  return null;
}
