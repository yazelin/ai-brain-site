#!/usr/bin/env python3
"""每日自動產出一篇格莉奇部落格文章。GitHub Action 跑。

流程：看今日新聞 → 依格莉奇的個性挑一則找靈感 → 決定寫文字日記或畫一張插畫
→ 產內容 → append 進 posts.json → commit & push。

相依：google-genai（文字 + 出圖）。其余一律 stdlib。
金鑰：GEMINI_API_KEY（必填）。可選 GEMINI_WEB_BASE_URL 走自架代理。
圖像模型：GEMINI_IMAGE_MODEL（預設 gemini-3-pro-image-preview）。
"""
import base64
import json
import mimetypes
import os
import random
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import persona  # noqa: E402

ROOT = persona.ROOT
POSTS_JSON = ROOT / "posts.json"
IMG_DIR = ROOT / "images" / "posts"

TZ = timezone(timedelta(hours=8))
_GEMINI_WEB_BASE_URL = os.getenv("GEMINI_WEB_BASE_URL")
IMG_MODEL = os.getenv("GEMINI_IMAGE_MODEL") or "gemini-2.5-flash-image"

NEWS_PROMPT = (
    "Search for today's interesting world news and current events.\n\n"
    "Pick 4-6 news items that are:\n"
    "- Fun, heartwarming, quirky, cultural, scientific, sports, weather, travel, tourism, food, animal, or lifestyle related\n"
    "- From DIFFERENT regions of the world\n"
    "- AVOID: war, terrorism, political controversy, violent crime, disasters with casualties\n\n"
    "For each item, write a 1-sentence summary in 繁體中文. MUST include the city/country.\n\n"
    'Output JSON: {"news": ["繁體中文摘要 1", "繁體中文摘要 2", ...]}'
)

PICK_PROMPT = (
    "Here are today's news summaries:\n{news}\n\n"
    "Recent fan comments on your blog (Giscus):\n{comments}\n\n"
    "You ARE 格莉奇（Glitch）, an AI robot-girl VTuber with 4KB of memory. "
    "You are gullible, sincerely curious about humans, love candy and sunshine and fan comments, "
    "hate hard math, and always ERROR at the worst moment.\n\n"
    "Pick the ONE thing that would most inspire a diary entry or illustration from YOU — "
    "it can be a news item OR a fan comment. Something you'd misunderstand cutely, "
    "get excited about, or glitch over. You MAY also weave in a fan comment alongside the news.\n\n"
    "Your LINE stickers (pick 1-2 that match the mood of the scene):\n"
    "1=欸？搞錯了嗎？ 2=今天也超開心！ 3=大家加油喵！ 4=這個太難了吧... "
    "5=我沒有卡住！ 6=要吃好吃的喔 7=先去睡個覺... 8=這樣也可以！？ 9=謝謝大家的禮物！\n\n"
    'Output JSON: {{"inspiration": "你選中的那則新聞摘要或粉絲留言（原樣複製）", '
    '"source_type": "news 或 giscus（主要靈感來自哪）", '
    '"comment_source": "若引用了粉絲留言，列出原文；無則空字串", '
    '"angle": "格莉奇會怎麼看待這件事（繁體中文，1-2句）", '
    '"scene": "若要畫一張插畫，格莉奇在什麼場景做什麼動作（繁體中文，1-2句，具體）", '
    '"stickers": [1, 2]}}'
)

TEXT_PROMPT = (
    persona.VOICE + "\n\n"
    "今天看到一則新聞：{inspiration}\n"
    "你的角度：{angle}\n"
    "最近粉絲留言：{comments}\n\n"
    "寫一篇今天的日記（繁體中文，第一人稱，3-6 句，分段用 \\n\\n）。"
    "可以順便回應粉絲留言，但不要硬塞。"
    "結尾可以加一句你的口頭禪。\n\n"
    'Output JSON: {{"title": "標題，繁體中文，6-15字", "body": "日記正文，可含\\n\\n分段"}}'
)

IMAGE_PROMPT_TPL = (
    persona.BASE + "\n\n"
    "REFERENCE IMAGES:\n- image 1: " + persona.REF_DESC + "\n\n"
    + persona.SHEET + "\n\n"
    "SCENE (turn this into a single vivid 1:1 illustration):\n{scene}\n\n"
    "Captions/text in the image (if any) MUST be Traditional Chinese or English only.\n\n"
    + persona.RULES
)

CAPTION_PROMPT = (
    persona.VOICE + "\n\n"
    "你剛畫了一張插畫，場景是：{scene}\n"
    "靈感來自這則新聞：{inspiration}\n\n"
    "給這張插畫寫一段圖說／短日記（繁體中文，第一人稱，2-4 句）。\n\n"
    'Output JSON: {{"title": "標題，繁體中文，6-15字", "body": "圖說正文，可含\\n\\n分段"}}'
)


# ── helpers ──────────────────────────────────────────────────────────────────
def _client():
    from google import genai
    if _GEMINI_WEB_BASE_URL:
        return genai.Client(
            api_key=os.getenv("GEMINI_API_KEY", ""),
            http_options={"api_version": "v1beta", "base_url": _GEMINI_WEB_BASE_URL,
                          "timeout": 240_000})
    return genai.Client()


def parse_json(raw, required_keys):
    """從 LLM 回應裡抓 JSON 物件。容錯：去掉 markdown 圍欄、抓第一個 {…}。"""
    if not raw:
        return {}
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    if not raw.startswith("{"):
        m = re.search(r"\{.*\}", raw, re.S)
        if m:
            raw = m.group(0)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if required_keys and not all(k in data for k in required_keys):
        return {}
    return data


def ask(model, prompt, json_mode=True, search=False):
    """文字呼叫。search=True 加 Google Search grounding（看新聞用）。"""
    from google.genai import types
    cfg = None
    if search:
        cfg = types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())])
    elif json_mode:
        cfg = types.GenerateContentConfig(response_mime_type="application/json")
    client = _client()
    r = client.models.generate_content(model=model, contents=prompt, config=cfg)
    return r.text or ""


def fetch_news():
    print("Stage 1: 看今日新聞…", flush=True)
    for attempt in range(2):
        try:
            raw = ask("gemini-2.5-flash", NEWS_PROMPT, json_mode=False, search=True)
            data = parse_json(raw, ["news"])
            if isinstance(data.get("news"), list) and data["news"]:
                for i, n in enumerate(data["news"][:6], 1):
                    print(f"  新聞 {i}: {n[:80]}", flush=True)
                return data["news"][:6]
        except Exception as e:
            print(f"  新聞抓取失敗({e})，重試…", flush=True)
            time.sleep(3)
    print("  新聞抓不到，走「original」靈感。", flush=True)
    return []


# Giscus 留言：用 gh api graphql 抓 GitHub Discussions（分類 General）最近留言。
# 參考 neko-tensei 的 fetch_wishes 模式：giscus 要等第一則留言才會建 discussion，
# 空的就是正常，不擋 pipeline。
COMMENTS_QUERY = """
{ repository(owner:"yazelin", name:"ai-brain-site") {
    discussions(first:20, orderBy:{field:UPDATED_AT, direction:DESC}) {
      nodes { title category { name }
        comments(first:100) { nodes { body author { login } createdAt } } } } } }
"""


def parse_comments(payload, category="General", limit=12):
    """從 GraphQL 回應挑出指定分類的留言，依時間倒序取最近 limit 則。純函式。"""
    try:
        nodes = payload["data"]["repository"]["discussions"]["nodes"]
    except (KeyError, TypeError):
        return []
    out = []
    for d in nodes or []:
        if (d.get("category") or {}).get("name") != category:
            continue
        for c in ((d.get("comments") or {}).get("nodes") or []):
            body = (c.get("body") or "").strip()
            if not body:
                continue
            who = ((c.get("author") or {}).get("login") or "匿名")
            ts = c.get("createdAt") or ""
            out.append((ts, f"@{who}: {body[:200]}"))
    # 依 createdAt 倒序（最新在前），取前 limit 則
    out.sort(key=lambda x: x[0], reverse=True)
    return [s for _, s in out[:limit]]


def fetch_comments():
    """抓 Giscus 留言。回 (留言清單, 失敗原因)。"""
    try:
        r = subprocess.run(["gh", "api", "graphql", "-f", f"query={COMMENTS_QUERY}"],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return [], f"gh api graphql 失敗: {r.stderr.strip()[:200]}"
        return parse_comments(json.loads(r.stdout)), None
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"


def pick_inspiration(news, comments=None):
    print("Stage 2: 依個性挑靈感…", flush=True)
    news_block = "\n".join(f"- {n}" for n in news) if news else "(今天沒抓到新聞，純憑想像)"
    cmt_block = "\n".join(f"- {c}" for c in comments) if comments else "(還沒有粉絲留言)"
    prompt = PICK_PROMPT.format(news=news_block, comments=cmt_block)
    data = parse_json(ask("gemini-2.5-flash", prompt), ["inspiration", "scene"])
    inspiration = data.get("inspiration", "original")
    source_type = data.get("source_type", "news")
    comment_source = data.get("comment_source", "")
    if news and inspiration not in news and source_type == "news":
        inspiration = news[0]
    angle = data.get("angle", "")
    scene = data.get("scene", "格莉奇坐在螢幕前，天線亂動，畫面出現像素 glitch 方塊。")
    stickers = data.get("stickers", [])
    if isinstance(stickers, list):
        stickers = [s for s in stickers if isinstance(s, int) and 1 <= s <= 9][:2]
    else:
        stickers = []
    print(f"  靈感({source_type}): {inspiration[:80]}", flush=True)
    if comment_source:
        print(f"  留言啟發: {comment_source[:80]}", flush=True)
    print(f"  貼圖: {stickers}", flush=True)
    return inspiration, angle, scene, stickers, comment_source


def gen_text_post(inspiration, angle, comments=None):
    print("Stage 3a: 寫文字日記…", flush=True)
    cmt_block = "\n".join(f"- {c}" for c in comments) if comments else "(還沒有粉絲留言)"
    data = parse_json(
        ask("gemini-2.5-flash", TEXT_PROMPT.format(
            inspiration=inspiration, angle=angle, comments=cmt_block)),
        ["title", "body"])
    return {"type": "text", "title": data["title"], "body": data["body"]}


def gen_image_post(inspiration, scene, stickers=None):
    print("Stage 3b: 畫插畫…", flush=True)
    prompt = IMAGE_PROMPT_TPL.format(scene=scene)
    img_path = generate_image(prompt)
    if not img_path:
        print("  出圖失敗，退回文字日記。", flush=True)
        return None
    if stickers:
        stamp_image(img_path, stickers)
    cap = parse_json(
        ask("gemini-2.5-flash", CAPTION_PROMPT.format(scene=scene, inspiration=inspiration)),
        ["title", "body"])
    return {"type": "image", "title": cap.get("title", "今日插畫"),
            "body": cap.get("body", ""), "image": img_path}


def generate_image(prompt):
    """Gemini 影像模型 + 一張參考圖（inline_data）。回傳相對路徑或 None。"""
    key = os.getenv("GEMINI_API_KEY", "")
    if not key:
        print("  沒有 GEMINI_API_KEY，跳過出圖。", flush=True)
        return None
    ref = ROOT / persona.REF_IMAGE
    if not ref.exists():
        print(f"  找不到參考圖 {ref}，跳過出圖。", flush=True)
        return None
    today = datetime.now(TZ).strftime("%Y%m%d")
    out = IMG_DIR / f"{today}.png"

    parts = [{"text": prompt}]
    parts.append({"inline_data": {
        "mime_type": mimetypes.guess_type(ref.name)[0] or "image/png",
        "data": base64.b64encode(ref.read_bytes()).decode()}})
    body = {"contents": [{"parts": parts}],
            "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]}}
    base_url = (_GEMINI_WEB_BASE_URL or "https://generativelanguage.googleapis.com").rstrip("/")
    url = f"{base_url}/v1beta/models/{IMG_MODEL}:generateContent"
    req = urllib.request.Request(
        url, json.dumps(body).encode(),
        {"Content-Type": "application/json", "x-goog-api-key": key,
         "User-Agent": "glitch-blog/1.0"})
    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=600) as f:
            payload = json.load(f)
    except Exception as e:
        print(f"  出圖請求失敗: {e}", flush=True)
        return None
    raw = _image_bytes(payload)
    if not raw:
        print("  回應裡沒有圖片。", flush=True)
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(raw)
    print(f"  -> {out.name} ok {int(time.time()-t0)}s {out.stat().st_size/1e6:.2f}MB", flush=True)
    return f"images/posts/{today}.png"


def _image_bytes(payload):
    cands = payload.get("candidates") if isinstance(payload, dict) else None
    for part in ((cands[0].get("content") or {}).get("parts") or []) if cands else []:
        d = (part.get("inlineData") or part.get("inline_data") or {}).get("data")
        if d:
            return base64.b64decode(d)
    return None


def stamp_image(img_path, stickers):
    """把選中的貼圖當簽名章貼到生成圖右下角。PIL 合成，保證一定出現。"""
    try:
        from PIL import Image
    except ImportError:
        print("  沒裝 Pillow，跳過貼圖印章。", flush=True)
        return
    abs_path = ROOT / img_path
    base = Image.open(abs_path).convert("RGBA")
    bw, bh = base.size
    margin = max(12, bw // 30)
    x_cursor = bw - margin
    for num in stickers:
        sp = ROOT / "images" / f"sticker-0{num}.png"
        if not sp.exists():
            continue
        st = Image.open(sp).convert("RGBA")
        sw = int(bw * 0.18)
        sh = int(st.size[1] * sw / st.size[0])
        st = st.resize((sw, sh), Image.LANCZOS)
        y = bh - sh - margin
        base.alpha_composite(st, (x_cursor - sw, y))
        x_cursor -= sw + 6
    base.convert("RGB").save(abs_path, "PNG")
    print(f"  貼上 {len(stickers)} 張貼圖簽名", flush=True)


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    news = fetch_news()
    comments, cmt_err = fetch_comments()
    if cmt_err:
        print(f"  Giscus 留言抓取失敗（不擋 pipeline）: {cmt_err}", flush=True)
    elif comments:
        print(f"  抓到 {len(comments)} 則 Giscus 留言", flush=True)
    else:
        print("  Giscus 還沒有留言（正常，giscus 要等第一則才建 discussion）", flush=True)
    inspiration, angle, scene, stickers, comment_source = pick_inspiration(news, comments)

    # 交替：日期奇數畫圖、偶數寫字（避免每天都同一種）。FORCE_IMAGE 可覆寫。
    import os
    day = int(datetime.now(TZ).strftime("%Y%m%d"))
    want_image = os.getenv("FORCE_IMAGE") == "1" or (day % 2 == 1)

    post = None
    if want_image:
        post = gen_image_post(inspiration, scene, stickers)
    if post is None:
        post = gen_text_post(inspiration, angle, comments)

    post["date"] = datetime.now(TZ).strftime("%Y-%m-%d")
    post["inspiration"] = inspiration if inspiration != "original" else ""
    if comment_source:
        post["comment_source"] = comment_source
    # 同一天已有則覆蓋最新那篇，避免重跑堆疊。
    posts = json.loads(POSTS_JSON.read_text("utf-8")) if POSTS_JSON.exists() else []
    posts = [p for p in posts if p.get("date") != post["date"]]
    posts.append(post)
    POSTS_JSON.write_text(json.dumps(posts, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(f"Stage 4: 寫入 posts.json（共 {len(posts)} 篇）", flush=True)

    commit_push(post["date"])


def commit_push(date):
    print("Stage 5: commit & push…", flush=True)
    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(["git", "config", "user.email",
                    "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
    subprocess.run(["git", "add", "posts.json", "images/posts"], check=True)
    r = subprocess.run(["git", "diff", "--cached", "--quiet"])
    if r.returncode == 0:
        print("  沒有變更，不 commit。", flush=True)
        return
    subprocess.run(["git", "commit", "-m", f"post: {date} 格莉奇日記"], check=True)
    subprocess.run(["git", "push"], check=True)
    print("  推送完成。", flush=True)


if __name__ == "__main__":
    main()