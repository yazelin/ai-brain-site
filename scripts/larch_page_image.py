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
PAD, BAR = 50, 56  # 視窗內距、標題列高


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


def _window(im, box, title):
    x0, y0, x1, y1 = box
    shadow = Image.new("RGBA", im.size)
    ImageDraw.Draw(shadow).rounded_rectangle([x0, y0 + 16, x1, y1 + 16], 18, fill=(0, 0, 0, 150))
    im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(24)))
    grad = Image.new("RGBA", (x1 - x0, y1 - y0))
    gg = ImageDraw.Draw(grad)
    for y in range(y1 - y0):  # 跟網站 .win 一樣，淺上深下的深灰
        t = y / (y1 - y0)
        gg.line([0, y, x1 - x0, y], fill=tuple(round(a + (b - a) * t) for a, b in zip((39, 42, 47), (25, 28, 32))) + (250,))
    mask = Image.new("L", grad.size)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, x1 - x0 - 1, y1 - y0 - 1], 18, fill=255)
    im.paste(grad, (x0, y0), mask)
    lines = Image.new("RGBA", im.size)
    lg = ImageDraw.Draw(lines)
    lg.rounded_rectangle([x0, y0, x1, y1], 18, outline=(255, 255, 255, 26), width=2)
    lg.rectangle([x0 + 2, y0 + 2, x1 - 2, y0 + BAR - 1], fill=(255, 255, 255, 8))
    lg.line([x0, y0 + BAR, x1, y0 + BAR], fill=(255, 255, 255, 20), width=2)
    im.alpha_composite(lines)
    g = ImageDraw.Draw(im)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        g.ellipse([x0 + 22 + i * 30, y0 + 20, x0 + 38 + i * 30, y0 + 36], fill=c)
    f = _font(22, 500)
    g.text(((x0 + x1) / 2 - g.textlength(title, font=f) / 2, y0 + 13), title, font=f, fill=(185, 196, 203))
    return g


def _wrap(g, text, font, width):
    lines, cur = [], ""
    for ch in text.replace("\n", ""):
        if g.textlength(cur + ch, font=font) > width:
            lines.append(cur)
            cur = ""
        cur += ch
    return lines + ([cur] if cur else [])


def _paragraphs(g, body, font, width):
    """內文照段落換行，段落之間空半行。回傳 [(行, 段落開頭?)]。"""
    out = []
    for para in [p.strip() for p in body.split("\n") if p.strip()]:
        out += [(l, i == 0 and bool(out)) for i, l in enumerate(_wrap(g, para, font, width))]
    return out


def _fit_body(g, body, width, height):
    for size in range(32, 19, -2):
        f = _font(size, 400)
        lines = _paragraphs(g, body, f, width)
        lh = round(size * 1.6)
        need = len(lines) * lh + sum(gap for _, gap in lines) * lh // 2
        if need <= height:
            return f, lines, lh
    return f, lines[: height // lh], lh  # ponytail: 32→20 號都塞不下就截斷，目前最長的內文遠低於這個量


def render_page(post, out, illustration=None):
    im = _desktop()
    g = ImageDraw.Draw(im)
    x0, y0, x1, y1 = CONTENT
    inner = x1 - x0 - 2 * PAD
    title_font = _font(56, 700)
    title = _wrap(g, post.get("title", ""), title_font, inner)[:2]
    top = y0 + BAR + 36
    head = 46 + len(title) * 74  # 日期列＋標題
    room = y1 - 40 - (top + head + 20)
    if illustration:
        side = min(room, 560)
        right = min(x1, x0 + 2 * PAD + max([round(g.textlength(l, font=title_font)) for l in title] + [side, 520]))
        bottom, body = y1, None
    else:
        bf, body, lh = _fit_body(g, post.get("body", ""), inner, room)
        right = x1
        bottom = min(y1, top + head + 20 + len(body) * lh + sum(gap for _, gap in body) * lh // 2 + 40) if body else top + head + 30
    g = _window(im, (x0, y0, right, bottom), f"心情日記 — {post['date']}.txt")
    y = top
    label = date_label(post["date"])
    g.text((x0 + PAD, y), label, font=_font(26, 500), fill=CY)
    tx = x0 + PAD + g.textlength(label, font=_font(26, 500)) + 20
    g.rounded_rectangle([tx, y + 2, tx + 70, y + 36], 8, outline=(70, 78, 86), width=2)
    g.text((tx + 13, y + 3), "插畫" if illustration else "文字", font=_font(22, 500), fill=MUTE)
    y += 46
    for line in title:
        g.text((x0 + PAD, y), line, font=title_font, fill=TXT)
        y += 74
    y += 20
    if illustration:
        pic = Image.open(illustration).convert("RGB").resize((side, side), Image.LANCZOS)
        mask = Image.new("L", (side, side))
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, side - 1, side - 1], 14, fill=255)
        im.paste(pic, (x0 + PAD, y), mask)
    else:
        for line, gap in body:
            y += lh // 2 if gap else 0
            g.text((x0 + PAD, y), line, font=bf, fill=BODY)
            y += lh
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.convert("RGB").save(out, "WEBP", quality=82, method=6)
    return out
