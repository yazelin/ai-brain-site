#!/usr/bin/env python3
"""用 codex-image-service 生格莉奇的高品質方形大頭貼（LINE 聊天頭像 / PWA 圖示用）。

日系動漫風、頭部特寫、置中、臉落在圓形安全區內（圓角裁切不切到五官）。
輸出 images/avatar.webp（正方 1024x1024）。金鑰：CODEX_IMAGE_KEY / CODEX_IMAGE_BASE_URL。
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import persona

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "images" / "sticker-01.png"
OUT = ROOT / "images" / "avatar.webp"
BASE_URL = os.environ.get("CODEX_IMAGE_BASE_URL", "").rstrip("/")
KEY = os.environ.get("CODEX_IMAGE_KEY", "")
UA = "glitch-blog/1.0"

PROMPT = f"""Same character as the reference image: a cute Japanese-anime-style AI robot-girl VTuber named Glitch, head-and-shoulders portrait, centered, looking at viewer.
{persona.IDENTITY}
STYLE: modern Japanese anime key-visual, clean cel shading, soft glow, high detail, friendly slightly sleepy expression. Plain soft dark teal-navy gradient background (#0b1a22) with faint neon-mint bokeh so it sits in a circle cleanly.
COMPOSITION: face centered, head and antennas well inside the frame with margin (safe for circular crop), symmetrical, no text, no watermark, no signature. Square 1:1."""


def main():
    if not BASE_URL or not KEY:
        print("::error::缺 CODEX_IMAGE_BASE_URL 或 CODEX_IMAGE_KEY", file=sys.stderr)
        sys.exit(1)
    refs = [base64.b64encode(REF.read_bytes()).decode()] if REF.exists() else []
    body = json.dumps({"prompt": PROMPT, "size": "1024x1024", "quality": "high",
                       "count": 1, "reference_images_base64": refs}).encode()
    req = urllib.request.Request(f"{BASE_URL}/v1/images/jobs", body,
        {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
         "User-Agent": UA}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as f:
        job = json.load(f)
    jid = job.get("id") or _fail(f"建 job 失敗: {json.dumps(job)[:300]}")
    print(f"job {jid} 排隊中…", flush=True)
    auth = {"Authorization": f"Bearer {KEY}", "User-Agent": UA}
    t0 = time.time()
    while True:
        time.sleep(15)
        with urllib.request.urlopen(urllib.request.Request(
                f"{BASE_URL}/v1/images/jobs/{jid}", headers=auth), timeout=60) as f:
            st = json.load(f)
        if st.get("status") in ("succeeded", "failed", "error"):
            break
        if time.time() - t0 > 2400:
            _fail("出圖逾時")
    if st.get("status") != "succeeded":
        _fail(f"出圖失敗: {str(st.get('error'))[:200]}")
    imgs = st.get("images") or []
    if not imgs or not imgs[0].get("url"):
        _fail(f"沒有 images: {json.dumps(st)[:300]}")
    url = imgs[0]["url"]
    if url.startswith("/"):
        url = BASE_URL + url
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=300) as r:
        raw = r.read()
    # 服務端回的通常是 PNG。這個站的圖一律存 webp:全部圖檔都會進 PWA 的
    # precache,同一張 png 2 MB、webp 0.13 MB,回訪讀者的差別是實質的。
    # 直接 write_bytes 會產出一個「叫 .webp 的 PNG」,瀏覽器認得但完全沒省到。
    import io
    from PIL import Image
    Image.open(io.BytesIO(raw)).convert("RGB").save(OUT, "WEBP", quality=88, method=6)
    print(f"-> {OUT} ok {int(time.time()-t0)}s {OUT.stat().st_size/1e6:.2f}MB", flush=True)
    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(["git", "config", "user.email",
                    "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "update_sw_hashes.py")], check=True)
    subprocess.run(["git", "add", str(OUT), str(ROOT / "sw.js")], check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode != 0:
        subprocess.run(["git", "commit", "-m", "avatar: 格莉奇高品質方形頭像"], check=True)
        subprocess.run(["git", "pull", "--rebase"], check=True)
        subprocess.run(["git", "push"], check=True)
        print("已 commit & push。", flush=True)


def _fail(msg):
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
