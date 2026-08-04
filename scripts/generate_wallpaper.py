#!/usr/bin/env python3
"""用 codex-image-service 生一張格莉奇OS 桌面桌布。手動 workflow 跑一次。

桌布是她「房間／OS」的視覺門面：賽博粉綠＋霓虹紫、glitch 像素塊、
AI 機器人女孩的桌面感。輸出 16:9 橫式，存 images/wallpaper.png。
相依：純 stdlib。金鑰：CODEX_IMAGE_KEY、CODEX_IMAGE_BASE_URL。
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
REF_IMAGE = ROOT / "images" / "sticker-01.png"
OUT = ROOT / "images" / "wallpaper.png"

BASE_URL = os.environ.get("CODEX_IMAGE_BASE_URL", "").rstrip("/")
KEY = os.environ.get("CODEX_IMAGE_KEY", "")
UA = "glitch-blog/1.0"

PROMPT = """A Japanese anime (日系動漫) style wallpaper for an AI robot-girl VTuber named Glitch, depicting her cozy cyber bedroom / WebOS homescreen.
Clear modern Japanese anime illustration aesthetic — think contemporary anime key-visual / light-novel cover art: clean cel-shading, soft gradient shading, expressive atmospheric lighting, anime painterly backgrounds (Kyoto Animation / Makoto Shinkai film background quality). Distinctly 2D anime look, NOT photoreal, NOT 3D render.
Scene: a small cyber bedroom at dusk seen as an anime background painting. A glowing translucent WebOS homescreen floats over a desk; through a window, distant neon city lights and bokeh at golden-hour. Deep teal-navy gradient base, glowing neon cyber-mint (#7cf3c0) and neon-purple (#b78bff) accents, soft pixel-block glitch artifacts and faint scanlines, floating UI motes, a few translucent app-window silhouettes drifting in the background. Lived-in anime-prop details: a cable, a mug, scattered sticky notes — unobtrusive so desktop icons sit cleanly on top.
Mood: cute, warm, slightly melancholic, cinematic soft glow. No characters in frame, no text, no watermark, no signature. Wide 16:9 landscape."""


def main():
    if not BASE_URL or not KEY:
        print("::error::缺 CODEX_IMAGE_BASE_URL 或 CODEX_IMAGE_KEY", file=sys.stderr)
        sys.exit(1)
    refs = []
    if REF_IMAGE.exists():
        refs.append(base64.b64encode(REF_IMAGE.read_bytes()).decode())
    body = json.dumps({
        "prompt": PROMPT, "size": "1536x1024", "quality": "high",
        "count": 1, "reference_images_base64": refs,
    }).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/v1/images/jobs", body,
        {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
         "User-Agent": UA}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as f:
        job = json.load(f)
    job_id = job.get("id")
    if not job_id:
        print(f"::error::建 job 失敗: {json.dumps(job, ensure_ascii=False)[:300]}",
              file=sys.stderr)
        sys.exit(1)
    print(f"job {job_id} 排隊中…", flush=True)

    t0 = time.time()
    auth = {"Authorization": f"Bearer {KEY}", "User-Agent": UA}
    while True:
        time.sleep(15)
        q = urllib.request.Request(f"{BASE_URL}/v1/images/jobs/{job_id}",
                                  headers=auth)
        with urllib.request.urlopen(q, timeout=60) as f:
            st = json.load(f)
        if st.get("status") in ("succeeded", "failed", "error"):
            break
        if time.time() - t0 > 2400:
            print("::error::出圖逾時", file=sys.stderr)
            sys.exit(1)
    if st.get("status") != "succeeded":
        print(f"::error::出圖失敗: {str(st.get('error'))[:200]}", file=sys.stderr)
        sys.exit(1)

    images = st.get("images") or []
    if not images or not images[0].get("url"):
        print(f"::error::succeeded 但沒有 images: {json.dumps(st, ensure_ascii=False)[:300]}",
              file=sys.stderr)
        sys.exit(1)
    url = images[0]["url"]
    if url.startswith("/"):
        url = BASE_URL + url
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=300) as r:
        OUT.write_bytes(r.read())
    print(f"-> {OUT} ok {int(time.time()-t0)}s {OUT.stat().st_size/1e6:.2f}MB", flush=True)

    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(["git", "config", "user.email",
                    "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
    subprocess.run(["git", "add", str(OUT)], check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode != 0:
        # ponytail: pull --rebase before push，避免期間有其他 commit 導致 push 被拒
        subprocess.run(["git", "pull", "--rebase"], check=True)
        subprocess.run(["git", "commit", "-m", "wallpaper: 更新格莉奇OS 桌布"], check=True)
        subprocess.run(["git", "push"], check=True)
        print("已 commit & push。", flush=True)
    else:
        print("桌布沒變，不 commit。", flush=True)


if __name__ == "__main__":
    main()