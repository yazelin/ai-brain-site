#!/usr/bin/env python3
"""用 codex-image-service 生格莉奇全身桌面寵物 sprite。透明背景、站姿。

放在桌面右側當 desktop pet。輸出 images/pet.webp（直式 1024x1536）。
參考圖用 sticker-01 鎖角色外觀。金鑰：CODEX_IMAGE_KEY / CODEX_IMAGE_BASE_URL。
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "images" / "sticker-01.png"
OUT = ROOT / "images" / "pet.png"
BASE_URL = os.environ.get("CODEX_IMAGE_BASE_URL", "").rstrip("/")
KEY = os.environ.get("CODEX_IMAGE_KEY", "")
UA = "glitch-blog/1.0"

PROMPT = """Same character as reference image 1: a cute anime-style AI robot-girl VTuber named Glitch, full-body, head to toe, standing in a relaxed idle pose suitable for a desktop pet.
CHARACTER (copy every feature): short anime robot GIRL, ~155cm; two high-tech CAT-EAR ANTENNAS on her head (mechanical headpieces, NOT real cat ears) glowing softly; short hair with cyber-mint (#7cf3c0) and neon-purple (#b78bff) accents; subtle neon pixel-block GLITCH artifacts flickering around her cheeks and shoulders; wearing an ERROR HOODIE with a pixel cat and a bright red "ERROR" wordmark on the chest; semi-transparent tactical shoulder strap with a rainbow buckle; a smart wristband. She is a humanoid robot girl, NOT a literal cat.
STYLE: soft cel shading, neon cyber palette, gentle glow, scanlines, pixel-noise glitch. Friendly, slightly sleepy expression, one hand waving.
BACKGROUND FOR CHROMA KEY: create the subject on a perfectly flat solid #ffff00 (bright pure yellow) chroma-key background for background removal. The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation. Keep the subject fully separated from the background with crisp edges and generous padding. Do NOT use #ffff00 anywhere in the subject. No cast shadow, no contact shadow, no reflection, no watermark, no text. Vertical portrait 2:3."""


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
    raw_path = OUT.with_suffix(".raw.png")
    raw_path.write_bytes(raw)
    # codex image_gen 不支援真透明，故生在純色 chroma-key 底上，再用 codex 官方
    # remove_chroma_key.py 去背（soft-matte + despill，比 flood-fill 乾淨）。
    helper = str(Path(__file__).parent / "remove_chroma_key.py")
    rc = subprocess.run([
        sys.executable, helper, "--input", str(raw_path), "--out", str(OUT),
        "--auto-key", "border", "--soft-matte", "--force",
        "--transparent-threshold", "12", "--opaque-threshold", "220", "--despill",
    ], capture_output=True, text=True)
    print(rc.stdout)
    if rc.returncode != 0:
        print(f"::error::remove_chroma_key 失敗:\n{rc.stderr}", file=sys.stderr)
        OUT.write_bytes(raw)
    else:
        trim_alpha_bbox(OUT)
    raw_path.unlink(missing_ok=True)
    print(f"-> {OUT} ok {int(time.time()-t0)}s {OUT.stat().st_size/1e6:.2f}MB", flush=True)
    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(["git", "config", "user.email",
                    "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "update_sw_hashes.py")], check=True)
    subprocess.run(["git", "add", str(OUT), str(ROOT / "sw.js")], check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode != 0:
        subprocess.run(["git", "commit", "-m", "pet: 格莉奇全身桌面寵物 sprite"], check=True)
        subprocess.run(["git", "push"], check=True)
        print("已 commit & push。", flush=True)


def _fail(msg):
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def trim_alpha_bbox(path):
    """裁掉透明外框，讓寵物元素緊貼角色（對話框才能錨在頭旁邊）。"""
    from PIL import Image
    im = Image.open(path)
    if im.mode != "RGBA":
        return
    bbox = im.split()[3].getbbox()
    if bbox:
        im.crop(bbox).save(path)
        print(f"  裁切到角色邊框 {im.crop(bbox).size}", flush=True)


if __name__ == "__main__":
    main()
