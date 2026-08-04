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
IMG_MODEL = os.getenv("GEMINI_IMAGE_MODEL") or "gemini-3-pro-image-preview"

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
    "You ARE 格莉奇（Glitch）, an AI robot-girl VTuber with 4KB of memory. "
    "You are gullible, sincerely curious about humans, love candy and sunshine and fan comments, "
    "hate hard math, and always ERROR at the worst moment.\n\n"
    "Pick the ONE news item that would most inspire a diary entry or illustration from YOU — "
    "something you'd misunderstand cutely, get excited about, or glitch over. "
    "Then write the inspiration note and a concrete scene idea.\n\n"
    'Output JSON: {"inspiration": "你選中的那則新聞摘要（原樣複製）", '
    '"angle": "格莉奇會怎麼看待這則新聞（繁體中文，1-2句）", '
    '"scene": "若要畫一張插畫，格莉奇在什麼場景做什麼動作（繁體中文，1-2句，具體）"}'
)

TEXT_PROMPT = (
    persona.VOICE + "\n\n"
    "今天看到一則新聞：{inspiration}\n"
    "你的角度：{angle}\n\n"
    "寫一篇今天的日記（繁體中文，第一人稱，3-6 句，分段用 \\n\\n）。"
    "結尾可以加一句你的口頭禪。\n\n"
    'Output JSON: {"title": "標題，繁體中文，6-15字", "body": "日記正文，可含\\n\\n分段"}'
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
    'Output JSON: {"title": "標題，繁體中文，6-15字", "body": "圖說正文，可含\\n\\n分段"}'
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


def pick_inspiration(news):
    print("Stage 2: 依個性挑靈感…", flush=True)
    news_block = "\n".join(f"- {n}" for n in news) if news else "(今天沒抓到新聞，純憑想像)"
    prompt = PICK_PROMPT.format(news=news_block)
    data = parse_json(ask("gemini-2.5-flash", prompt), ["inspiration", "scene"])
    inspiration = data.get("inspiration", "original")
    if news and inspiration not in news:
        inspiration = news[0]
    angle = data.get("angle", "")
    scene = data.get("scene", "格莉奇坐在螢幕前，天線亂動，畫面出現像素 glitch 方塊。")
    print(f"  靈感: {inspiration[:80]}", flush=True)
    return inspiration, angle, scene


def gen_text_post(inspiration, angle):
    print("Stage 3a: 寫文字日記…", flush=True)
    data = parse_json(
        ask("gemini-2.5-flash", TEXT_PROMPT.format(inspiration=inspiration, angle=angle)),
        ["title", "body"])
    return {"type": "text", "title": data["title"], "body": data["body"]}


def gen_image_post(inspiration, scene):
    print("Stage 3b: 畫插畫…", flush=True)
    prompt = IMAGE_PROMPT_TPL.format(scene=scene)
    img_path = generate_image(prompt)
    if not img_path:
        print("  出圖失敗，退回文字日記。", flush=True)
        return None
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
            "generationConfig": {"imageConfig": {"aspectRatio": "1:1", "imageSize": "1K"}}}
    base_url = (_GEMINI_WEB_BASE_URL or "https://generativelanguage.googleapis.com").rstrip("/")
    url = f"{base_url}/v1beta/models/{IMG_MODEL}:generateContent?key={key}"
    req = urllib.request.Request(
        url, json.dumps(body).encode(),
        {"Content-Type": "application/json", "User-Agent": "glitch-blog/1.0"})
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


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    news = fetch_news()
    inspiration, angle, scene = pick_inspiration(news)

    # 交替：日期奇數畫圖、偶數寫字（避免每天都同一種）。
    day = int(datetime.now(TZ).strftime("%Y%m%d"))
    want_image = (day % 2 == 1)

    post = None
    if want_image:
        post = gen_image_post(inspiration, scene)
    if post is None:
        post = gen_text_post(inspiration, angle)

    post["date"] = datetime.now(TZ).strftime("%Y-%m-%d")
    post["inspiration"] = inspiration if inspiration != "original" else ""
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