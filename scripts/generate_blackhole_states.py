#!/usr/bin/env python3
"""產黑洞先生的餓版與飽版立繪（腳的數量不同，用來把飽足度變成看得見的）。

參考圖用現有的 pet-blackhole.webp 鎖造型，只換腿數與姿態。
生在純色 chroma key 底上，再用 remove_chroma_key.py 去背。

**chroma key 用洋紅 #ff00ff，不要用黃色。** 桌寵那支（generate_pet.py）用的是黃色
#ffff00，對格莉奇沒問題，但黑洞先生戴的是卡其／駝色禮帽，那是暖黃棕，會被黃色底的
despill 一起吃掉——出來的圖帽子整片變透明，貼在白底上看起來像「模型把帽子畫成灰色」。
連生四輪、把顏色寫成 hex、寫 NEVER grey 都沒用，因為問題不在生圖在去背。
判斷方法：把去背結果貼到洋紅底上看，透明的地方會現形。

用法：CODEX_IMAGE_BASE_URL / CODEX_IMAGE_KEY 設好，直接跑。
"""
import base64, io, json, os, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path.home() / "ai-brain-site"
REF = ROOT / "images" / "pet-blackhole.webp"
BASE_URL = os.environ["CODEX_IMAGE_BASE_URL"].rstrip("/")
KEY = os.environ["CODEX_IMAGE_KEY"]

IDENTITY = """MR BLACK HOLE - copy every feature from reference image 1 exactly:
- His head is a smooth dark navy-black sphere with a luminous spiral galaxy and white star specks painted across it. NO neck; the head sits straight on the shoulders.
- His face carries exactly THREE white marks and nothing else: TWO large white almond eyes with heavy upper lids (calm, half-lidded), and ONE closed smile drawn as a thick WHITE curved line. The smile must stay clearly visible. No nose, no eyebrows, no teeth.
- A TAN / CAMEL felt fedora, warm light brown around #C89B5A, with a dark brown grosgrain band. The hat is NEVER grey, NEVER white, NEVER black — it is the one warm-coloured thing on him.
- A charcoal navy single-breasted suit jacket with notch lapels, over a crisp white collared shirt BUTTONED ALL THE WAY UP TO THE TOP BUTTON at the throat — the collar is closed, no open V of bare chest, no tie.
- Full-length navy suit TROUSERS that cover the two centre tentacle legs down past the knee. He never wears shorts.
- Exactly TWO boneless tentacle arms in the same galaxy starfield texture, coming out of the sleeves past white shirt cuffs, tapering to rounded tips with NO hands and NO fingers.
- He stands on tapering tentacle legs in the same galaxy texture, each with a row of small round suckers down its inner side, and each ending in its own black leather Chelsea ankle boot."""

CHROMA = """BACKGROUND FOR CHROMA KEY: place the subject on a perfectly flat solid #ff00ff (bright pure magenta) chroma-key background. One uniform colour, no shadows, no gradient, no floor, no reflection. Crisp edges, generous padding. Do NOT use #ff00ff or any magenta/pink anywhere on the subject. No text, no watermark. Vertical portrait 2:3, full body head to boots."""

VARIANTS = {
    "hungry": ("Draw him HUNGRY and thinned out. He has only FIVE tentacle legs left, each wearing one black Chelsea boot. "
               "The suit hangs loose on him, the trousers sag because there is less underneath to fill them. "
               "He stands slightly unsteady, weight leaning to one side, one tentacle arm out for balance. "
               "His shoulders are a little lower than usual. Same calm half-lidded eyes, same white smile."),
    "full":   ("Draw him WELL FED. He has EIGHT tentacle legs, each wearing one black Chelsea boot, spread in a wide stable stance. "
               "The suit is filled out and sits taut across the shoulders. He stands square and solid, both tentacle arms relaxed at his sides. "
               "Same calm half-lidded eyes, same white smile."),
}

def ref_b64(path):
    from PIL import Image
    im = Image.open(path); im.thumbnail((1024, 1024))
    buf = io.BytesIO(); im.convert("RGBA").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()

def gen(tag, extra):
    prompt = (f"Reference image 1 is the official full-body art of this character. Redraw the SAME character in the SAME "
              f"flat cel-shaded anime style, full body head to boots, front view, neutral standing pose.\n{IDENTITY}\n\n"
              f"WHAT CHANGES:\n{extra}\n\n{CHROMA}")
    body = json.dumps({"prompt": prompt, "size": "1024x1536", "quality": "high", "count": 1,
                       "reference_images_base64": [ref_b64(REF)]}).encode()
    req = urllib.request.Request(f"{BASE_URL}/v1/images/jobs", body,
        {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}, method="POST")
    jid = json.load(urllib.request.urlopen(req, timeout=180))["id"]
    print(f"{tag}: job {jid}", flush=True)
    auth = {"Authorization": f"Bearer {KEY}"}
    t0 = time.time()
    while True:
        time.sleep(15)
        st = json.load(urllib.request.urlopen(urllib.request.Request(
            f"{BASE_URL}/v1/images/jobs/{jid}", headers=auth), timeout=60))
        if st.get("status") in ("succeeded", "failed", "error"): break
        if time.time() - t0 > 1800: sys.exit(f"{tag} 逾時")
    if st.get("status") != "succeeded": sys.exit(f"{tag} 失敗: {str(st.get('error'))[:300]}")
    url = st["images"][0]["url"]
    if url.startswith("/"): url = BASE_URL + url
    raw = ROOT / "images" / f"hole-{tag}.raw.png"
    raw.write_bytes(urllib.request.urlopen(url, timeout=300).read())
    out = ROOT / "images" / f"pet-blackhole-{tag}.webp"
    rc = subprocess.run([sys.executable, str(ROOT / "scripts" / "remove_chroma_key.py"),
        "--input", str(raw), "--out", str(out), "--auto-key", "border", "--soft-matte", "--force",
        "--transparent-threshold", "12", "--opaque-threshold", "220", "--despill"],
        capture_output=True, text=True)
    if rc.returncode != 0:
        print(f"::error:: 去背失敗 {rc.stderr[:300]}", file=sys.stderr); out.write_bytes(raw.read_bytes())
    from PIL import Image as I
    I.open(out).convert("RGBA").save(out, "WEBP", quality=90, method=6)
    raw.unlink(missing_ok=True)
    print(f"{tag} -> {out.name} {int(time.time()-t0)}s {out.stat().st_size/1e6:.2f}MB", flush=True)

for tag, extra in VARIANTS.items():
    gen(tag, extra)
