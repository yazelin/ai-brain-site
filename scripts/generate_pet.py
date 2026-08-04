#!/usr/bin/env python3
"""用 codex-image-service 生格莉奇全身桌面寵物 sprite。透明背景、站姿。

放在桌面右側當 desktop pet。輸出 images/pet.png（直式 1024x1536）。
參考圖用 sticker-01 鎖角色外觀。金鑰：CODEX_IMAGE_KEY / CODEX_IMAGE_BASE_URL。
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "images" / "sticker-01.png"
OUT = ROOT / "images" / "pet.png"
BASE_URL = os.environ.get("CODEX_IMAGE_BASE_URL", "").rstrip("/")
KEY = os.environ.get("CODEX_IMAGE_KEY", "")
UA = "glitch-blog/1.0"

PROMPT = """Same character as reference image 1: a cute anime-style AI robot-girl VTuber named Glitch, full-body, head to toe, standing in a relaxed idle pose suitable for a desktop pet.
CHARACTER (copy every feature): short anime robot GIRL, ~155cm; two high-tech CAT-EAR ANTENNAS on her head (mechanical headpieces, NOT real cat ears) glowing softly; short hair with cyber-mint (#7cf3c0) and neon-purple (#b78bff) accents; subtle neon pixel-block GLITCH artifacts flickering around her cheeks and shoulders; wearing an ERROR HOODIE with a pixel cat and a bright red "ERROR" wordmark on the chest; semi-transparent tactical shoulder strap with a rainbow buckle; a smart wristband. She is a humanoid robot girl, NOT a literal cat.
STYLE: soft cel shading, neon cyber palette on a deep teal/navy base, gentle glow, scanlines, pixel-noise glitch. Friendly, slightly sleepy expression, one hand waving.
OUTPUT: a clean full-body character sprite, ISOLATED on a FULLY TRANSPARENT background (alpha). No ground shadow, no scenery, no text, no watermark, no signature. Vertical portrait 2:3."""


def main():
    if not BASE_URL or not KEY:
        print("::error::缺 CODEX_IMAGE_BASE_URL 或 CODEX_IMAGE_KEY", file=sys.stderr)
        sys.exit(1)
    refs = [base64.b64encode(REF.read_bytes()).decode()] if REF.exists() else []
    body = json.dumps({"prompt": PROMPT, "size": "1024x1536", "quality": "high",
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
    # codex 回的是不透明的近白底；從四邊 flood-fill 去白底，轉透明 PNG。
    try:
        transparent_bg(raw, OUT)
    except Exception as e:
        print(f"  去背失敗({e})，直接存原檔。", flush=True)
        OUT.write_bytes(raw)
    print(f"-> {OUT} ok {int(time.time()-t0)}s {OUT.stat().st_size/1e6:.2f}MB", flush=True)
    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(["git", "config", "user.email",
                    "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
    subprocess.run(["git", "add", str(OUT)], check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode != 0:
        subprocess.run(["git", "commit", "-m", "pet: 格莉奇全身桌面寵物 sprite"], check=True)
        subprocess.run(["git", "push"], check=True)
        print("已 commit & push。", flush=True)


def _fail(msg):
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def transparent_bg(raw_bytes, out_path):
    """codex 出圖是不透明的近白底；從四邊 flood-fill 去白，存透明 PNG。"""
    from PIL import Image
    im = Image.open(__import__("io").BytesIO(raw_bytes)).convert("RGB")
    w, h = im.size
    px = im.load()
    thr = 238
    bg = [[False] * w for _ in range(h)]
    q = deque()
    def near(i, j):
        r, g, b = px[i, j]; return r > thr and g > thr and b > thr
    for x in range(w):
        for y in (0, h - 1):
            if near(x, y): bg[y][x] = True; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if near(x, y): bg[y][x] = True; q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not bg[ny][nx] and near(nx, ny):
                bg[ny][nx] = True; q.append((nx, ny))
    alpha = Image.new("L", (w, h), 0)
    al = alpha.load()
    kept = 0
    for y in range(h):
        for x in range(w):
            if not bg[y][x]:
                al[x, y] = 255; kept += 1
    out = im.convert("RGBA"); out.putalpha(alpha)
    # 截掉透明外框，讓寵物元素緊貼角色（對話框才能錨在頭旁邊）
    bbox = out.split()[3].getbbox()
    if bbox:
        out = out.crop(bbox)
    out.save(out_path)
    print(f"  去背完成：保留 {100*kept/(w*h):.1f}% 像素，裁切後 {out.size}", flush=True)


if __name__ == "__main__":
    main()