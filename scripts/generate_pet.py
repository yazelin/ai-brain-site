#!/usr/bin/env python3
"""用 codex-image-service 生格莉奇全身桌面寵物 sprite。透明背景、站姿。

放在桌面右側當 desktop pet。輸出 images/pet.webp（直式 1024x1536）。
參考圖用 sticker-01 鎖角色外觀。金鑰：CODEX_IMAGE_KEY / CODEX_IMAGE_BASE_URL。

表情差分：--emote happy|thinking|error|sleep 以現有 pet.webp 當參考圖鎖住
姿勢與畫風，只換表情，輸出 images/pet-<emote>.webp。--no-git 跳過
commit/push（本機跑用，CI 才讓它自己 commit）。
"""
import argparse
import base64
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import persona

ROOT = Path(__file__).resolve().parent.parent
# Outfit B 的正典就是現有的 idle 立繪本身(persona.json 的 refB)。舊版用
# sticker-01.png 當參考圖,那張只有上半身,下半身既沒參考也沒寫進 prompt,
# 模型就自由發揮。重生 idle 時拿現有 idle 當參考,服裝才不會漂掉。
REF = ROOT / "images" / "pet.webp"
OUT = ROOT / "images" / "pet.webp"
BASE_URL = os.environ.get("CODEX_IMAGE_BASE_URL", "").rstrip("/")
KEY = os.environ.get("CODEX_IMAGE_KEY", "")
UA = "glitch-blog/1.0"

# 表情差分：key = [emote:xxx] 標記代號（persona.json 的 emotes 要同步）。
# 值是換掉基準 prompt 裡表情句的那一行。
EMOTES = {
    "happy": "Expression: overjoyed — eyes closed in a big beaming smile, open mouth, cheeks glowing, both antenna devices perked UP and glowing brightly, tiny sparkles around her head.",
    "thinking": "Expression: spaced-out loading — blank half-lidded eyes looking up and to the side, small open mouth, a faint floating '…' glitch pixel cluster beside her head. BOTH antenna devices stay on her head like the reference, tilted slightly outward, both clearly visible.",
    "error": "Expression: crashed ERROR state — swirly @ spiral eyes, wobbly open mouth, both antennas bent down and flickering, red glitch pixel blocks and a small red 'ERROR' glitch fragment near her head.",
    "sleep": "Expression: sleep mode — both eyes gently closed, calm sleeping face, BOTH antennas folded down and dimmed but still clearly present, a small floating 'Zzz' in soft mint pixels beside her head.",
}

CHARACTER = persona.sheet("B")

CHROMA = """BACKGROUND FOR CHROMA KEY: create the subject on a perfectly flat solid #ffff00 (bright pure yellow) chroma-key background for background removal. The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation. Keep the subject fully separated from the background with crisp edges and generous padding. Do NOT use #ffff00 anywhere in the subject. No cast shadow, no contact shadow, no reflection, no watermark, no text. Vertical portrait 2:3."""

PROMPT = f"""Same character as reference image 1: a cute anime-style AI robot-girl VTuber named Glitch, full-body, head to toe, standing in a relaxed idle pose suitable for a desktop pet.
{CHARACTER}
STYLE: soft cel shading, neon cyber palette, gentle glow, scanlines, pixel-noise glitch. Friendly, slightly sleepy expression, one hand waving.
{CHROMA}"""


def emote_prompt(emote):
    return f"""Reference image 1 is the EXACT same character in her idle sprite. Redraw her IDENTICALLY — same standing pose, same body proportions, same outfit, same colours, same framing (full body, head to toe) — changing ONLY the facial expression and antenna pose as described below. This is an expression variant of the same sprite for cross-fading, so anything except the face/antennas must stay put. She always has exactly TWO antenna devices; never remove or hide either of them.
{EMOTES[emote]}
{CHARACTER}
STYLE: soft cel shading, neon cyber palette, gentle glow, scanlines, pixel-noise glitch.
{CHROMA}"""


def ref_b64(path):
    """參考圖縮到最長邊 1024 再送。大圖會讓生圖服務更容易漂,也是白花頻寬。"""
    from PIL import Image
    im = Image.open(path)
    im.thumbnail((1024, 1024))
    buf = io.BytesIO()
    im.convert("RGBA").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--emote", choices=sorted(EMOTES))
    ap.add_argument("--no-git", action="store_true")
    args = ap.parse_args()
    if not BASE_URL or not KEY:
        print("::error::缺 CODEX_IMAGE_BASE_URL 或 CODEX_IMAGE_KEY", file=sys.stderr)
        sys.exit(1)
    if args.emote:
        # 差分用現有 idle sprite 當參考圖,鎖姿勢與畫風,只換表情。
        if not OUT.exists():
            _fail("差分要先有 images/pet.webp（idle sprite）當參考圖")
        ref_path, prompt = OUT, emote_prompt(args.emote)
        out = OUT.with_name(f"pet-{args.emote}.webp")
    else:
        ref_path, prompt, out = REF, PROMPT, OUT
    if not ref_path.exists():
        _fail(f"缺參考圖 {ref_path}。沒有參考圖生出來的立繪一定會漂,先產 Outfit B 三視圖")
    refs = [ref_b64(ref_path)]
    body = json.dumps({"prompt": prompt, "size": "1024x1536", "quality": "high",
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
    out.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=300) as r:
        raw = r.read()
    raw_path = out.with_suffix(".raw.png")
    raw_path.write_bytes(raw)
    # codex image_gen 不支援真透明，故生在純色 chroma-key 底上，再用 codex 官方
    # remove_chroma_key.py 去背（soft-matte + despill，比 flood-fill 乾淨）。
    helper = str(Path(__file__).parent / "remove_chroma_key.py")
    rc = subprocess.run([
        sys.executable, helper, "--input", str(raw_path), "--out", str(out),
        "--auto-key", "border", "--soft-matte", "--force",
        "--transparent-threshold", "12", "--opaque-threshold", "220", "--despill",
    ], capture_output=True, text=True)
    print(rc.stdout)
    if rc.returncode != 0:
        print(f"::error::remove_chroma_key 失敗:\n{rc.stderr}", file=sys.stderr)
        out.write_bytes(raw)
    else:
        trim_alpha_bbox(out)
    raw_path.unlink(missing_ok=True)
    # 去背工具寫出來的是 PNG。這個站的圖一律存 webp:全部圖檔都會進 PWA 的
    # precache,同一張 png 0.8 MB、webp 0.11 MB。桌寵要保留透明度,所以是 RGBA。
    from PIL import Image as _Im
    _Im.open(out).convert("RGBA").save(out, "WEBP", quality=88, method=6)
    print(f"-> {out} ok {int(time.time()-t0)}s {out.stat().st_size/1e6:.2f}MB", flush=True)
    if args.no_git:
        return
    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(["git", "config", "user.email",
                    "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "update_sw_hashes.py")], check=True)
    subprocess.run(["git", "add", str(out), str(ROOT / "sw.js")], check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode != 0:
        msg = f"pet: 格莉奇桌寵表情差分 {args.emote}" if args.emote else "pet: 格莉奇全身桌面寵物 sprite"
        subprocess.run(["git", "commit", "-m", msg], check=True)
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
