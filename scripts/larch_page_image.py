"""合成 Larch 日記頁的背景：格莉奇OS 的桌面（她的房間當桌布），左邊一個「心情日記」視窗。

插畫日的視窗放日期、標題和插畫；文字日放日期、標題和整篇內文（字級自動縮到放得下）。
輸出 1920×1080 WebP。右側約 35% 留給格莉奇立繪、下方約 25% 留給對話框，
這兩區只有桌布。同樣的輸入產出的位元組一模一樣（重跑不會換圖）。
"""
import datetime as dt
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
# Noto Sans TC（OFL-1.1）可變字重，跟網站用的黑體一致。
FONT = ROOT / "larch" / "assets" / "fonts" / "NotoSansTC.ttf"
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf"
WALLPAPER = ROOT / "images" / "wallpaper.webp"
W, H = 1920, 1080
CONTENT = (120, 70, 1220, 740)  # 立繪區從 x=1250；Larch 的對話框實測從 y≈756 開始
CY, MUTE, TXT, BODY = (37, 194, 232), (138, 154, 163), (232, 238, 241), (205, 214, 219)
WEEK = "一二三四五六日"


def ensure_font():
    if not FONT.exists():
        FONT.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(FONT_URL, timeout=120) as r:
            FONT.write_bytes(r.read())
    return FONT


def _font(size, weight):
    f = ImageFont.truetype(str(ensure_font()), size)
    f.set_variation_by_axes([weight])
    return f


def date_label(date):
    d = dt.date.fromisoformat(date)
    return f"{d:%Y-%m-%d} · 星期{WEEK[d.weekday()]}"


def _desktop():
    wp = Image.open(WALLPAPER).convert("RGB")
    s = max(W / wp.width, H / wp.height)
    wp = wp.resize((round(wp.width * s), round(wp.height * s)), Image.LANCZOS)
    left, top = (wp.width - W) // 2, (wp.height - H) // 2
    wp = wp.crop((left, top, left + W, top + H)).filter(ImageFilter.GaussianBlur(3))
    im = ImageEnhance.Brightness(wp).enhance(.55).convert("RGBA")
    bar = Image.new("RGBA", (W, H))
    g = ImageDraw.Draw(bar)
    g.rectangle([0, 0, W, 44], fill=(4, 8, 12, 215))
    g.line([0, 44, W, 44], fill=(255, 255, 255, 18))
    im.alpha_composite(bar)
    g = ImageDraw.Draw(im)
    g.text((26, 8), "格莉奇OS", font=_font(22, 700), fill=(205, 214, 219))
    f = _font(20, 500)
    g.text((W - 40 - g.textlength("記憶體 4KB", font=f), 9), "記憶體 4KB", font=f, fill=MUTE)
    return im


FRAME = ROOT / "larch" / "ui" / "window.webp"   # 生圖的全息壓克力視窗，月曆與介面共用
SLICE = (130, 77, 82, 75)                          # 上右下左：標題列與四角像素括號不拉伸
PIXEL = ROOT / "larch" / "assets" / "fonts" / "Silkscreen-Regular.ttf"
PIXEL_URL = "https://github.com/google/fonts/raw/main/ofl/silkscreen/Silkscreen-Regular.ttf"
STICKERS = [ROOT / "images" / f"sticker-0{i}.webp" for i in range(1, 10)]


def _pixel(size):
    if not PIXEL.exists():
        PIXEL.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(PIXEL_URL, timeout=120) as r:
            PIXEL.write_bytes(r.read())
    return ImageFont.truetype(str(PIXEL), size)


def _nine(size, scale):
    """把視窗框切九格拉到 size；scale 是邊框縮放（原圖 1536 寬，畫在 1100 寬的視窗上約 0.72）。"""
    src = Image.open(FRAME).convert("RGBA")
    W0, H0 = src.size
    t, r, b, l = SLICE
    tw, rw, bw, lw = (round(v * scale) for v in SLICE)
    w, h = size
    out = Image.new("RGBA", size)
    xs = [(0, l, 0, lw), (l, W0 - r, lw, w - rw), (W0 - r, W0, w - rw, w)]
    ys = [(0, t, 0, tw), (t, H0 - b, tw, h - bw), (H0 - b, H0, h - bw, h)]
    for sx0, sx1, dx0, dx1 in xs:
        for sy0, sy1, dy0, dy1 in ys:
            out.paste(src.crop((sx0, sy0, sx1, sy1)).resize((dx1 - dx0, dy1 - dy0), Image.LANCZOS), (dx0, dy0))
    mask = Image.new("L", size)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], round(26 * scale), fill=255)
    out.putalpha(mask)
    return out, tw, rw, bw, lw


def _window(im, box, title):
    x0, y0, x1, y1 = box
    shadow = Image.new("RGBA", im.size)
    ImageDraw.Draw(shadow).rounded_rectangle([x0, y0 + 18, x1, y1 + 18], 20, fill=(0, 0, 0, 160))
    im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(26)))
    frame, tw, rw, bw, lw = _nine((x1 - x0, y1 - y0), .72)
    im.alpha_composite(frame, (x0, y0))
    g = ImageDraw.Draw(im)
    f = _pixel(22)
    g.text(((x0 + x1) / 2 - g.textlength(title, font=f) / 2, y0 + tw * .3), title, font=f, fill=(22, 40, 58))  # 標題列是淺色壓克力，字用深色
    return g, (x0 + lw, y0 + tw, x1 - rw, y1 - bw)


PUNCT = set("，。、；：！？）」』》 ")
SOFT = set("的了再先就要把讓和與也還才在是到")  # 斷在這些字後面，讀起來比較順


def _wrap_title(text, font, maxw):
    """行數最少、斷點盡量落在標點、空格或虛字後面、各行長度接近。英文單字不拆，標點不放行首。"""
    n = len(text)

    def cut_cost(i):
        a, b = text[i - 1], text[i]
        if b in PUNCT or (a.isascii() and a.isalnum() and b.isascii() and b.isalnum()):
            return None
        return 0 if a in PUNCT or a == "—" and b != "—" else 1 if a in SOFT or a.isascii() or b.isascii() else 4

    best = {0: (0, 0, [])}
    for i in range(n):
        if i not in best:
            continue
        rows, cost, lines = best[i]
        for j in range(i + 1, n + 1):
            ln = text[i:j].strip()
            if font.getlength(ln.rstrip("".join(PUNCT))) > maxw:
                break
            c = 0 if j == n else cut_cost(j)
            if c is None or (j < n and text[j - 1] == "—" and text[j] == "—"):
                continue
            cand = (rows + 1, cost + c, lines + [ln])
            key = lambda x: (x[0], x[1], max(map(len, x[2])) - min(map(len, x[2])))
            if j not in best or key(cand) < key(best[j]):
                best[j] = cand
    if n not in best:
        return [text[i:i + 7] for i in range(0, n, 7)]
    return best[n][2]


def render_page(post, out, illustration=None):
    """左欄：日期、類型、標題；右邊：插畫，文字日放一張格莉奇的貼圖（內文交給對話框逐句講）。"""
    im = _desktop()
    g, (ix0, iy0, ix1, iy1) = _window(im, CONTENT, f"MOOD_DIARY  {post['date']}.TXT")
    side = min(iy1 - iy0 - 40, 560)
    px = ix1 - 24 - side
    py = iy0 + (iy1 - iy0 - side) // 2
    col = (ix0 + 30, px - 34)  # 左欄的左右邊界
    y = iy0 + 26
    label = date_label(post["date"])
    g.text((col[0], y), label, font=_font(26, 500), fill=CY)
    tag = "插畫" if illustration else "文字"
    tf = _font(20, 500)
    ty = y + 44
    tw = g.textlength(tag, font=tf)
    g.rounded_rectangle([col[0], ty, col[0] + tw + 24, ty + 32], 6, outline=(124, 243, 192), width=2)
    g.text((col[0] + 12, ty + 2), tag, font=tf, fill=(124, 243, 192))
    y = ty + 56
    title_font = _font(50, 700)
    for line in _wrap_title(post.get("title", ""), title_font, col[1] - col[0])[:5]:
        g.text((col[0], y), line.rstrip("，、；"), font=title_font, fill=TXT)
        y += 68
    g.text((col[0], iy1 - 46), "GLITCH OS · 4KB", font=_pixel(18), fill=(159, 176, 184))
    if illustration:
        pic = Image.open(illustration).convert("RGB").resize((side, side), Image.LANCZOS)
        glow = Image.new("RGBA", im.size)
        ImageDraw.Draw(glow).rounded_rectangle([px - 6, py - 6, px + side + 6, py + side + 6], 16, fill=(124, 243, 192, 90))
        im.alpha_composite(glow.filter(ImageFilter.GaussianBlur(14)))
        mask = Image.new("L", (side, side))
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, side - 1, side - 1], 12, fill=255)
        im.paste(pic, (px, py), mask)
        ImageDraw.Draw(im).rounded_rectangle([px - 2, py - 2, px + side + 1, py + side + 1], 13, outline=(124, 243, 192, 200), width=2)
    else:
        # 同一天每次都是同一張貼圖（跟月曆上那格一樣）
        st = Image.open(STICKERS[int(post["date"][8:]) % 9]).convert("RGBA")
        k = side * .9 / max(st.size)  # 原圖只有 370×320，放大到視窗高度的九成
        st = st.resize((round(st.width * k), round(st.height * k)), Image.LANCZOS)
        im.alpha_composite(st, (px + (side - st.width) // 2, py + (side - st.height) // 2))
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.convert("RGB").save(out, "WEBP", quality=82, method=6)
    return out
