"""合成 Larch 日記頁的背景：橫線日記紙、日期、標題，插畫日用膠帶貼上插畫。

輸出 1920×1080 WebP。右側約 35% 留給格莉奇立繪、下方約 25% 留給對話框，
這兩區只畫紙，不放字或圖。同樣的輸入產出的位元組一模一樣（重跑不會換圖）。
"""
import datetime as dt
import io
import zipfile
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
# 芫荽（OFL-1.1），Larch 2.6.1 起對話框也有這套字，背景和對話框的字才會一致。
FONT = ROOT / "larch" / "assets" / "fonts" / "Iansui-Regular.ttf"
FONT_URL = "https://github.com/ButTaiwan/iansui/releases/download/v1.020/iansui.zip"
W, H = 1920, 1080
CONTENT = (130, 60, 1230, 800)  # 立繪區從 x=1250、對話框從 y=820 開始
PAPER, LINE, MARGIN, INK, INK2 = (247, 241, 226), (214, 205, 182), (226, 160, 160), (58, 52, 70), (120, 108, 128)
WEEK = "一二三四五六日"


def ensure_font():
    if not FONT.exists():
        FONT.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(FONT_URL, timeout=120) as r:
            zipfile.ZipFile(io.BytesIO(r.read())).extract(FONT.name, FONT.parent)
    return FONT


def date_label(date):
    d = dt.date.fromisoformat(date)
    return f"{d.year} 年 {d.month} 月 {d.day} 日・星期{WEEK[d.weekday()]}"


def _paper():
    im = Image.new("RGB", (W, H), PAPER)
    g = ImageDraw.Draw(im)
    for y in range(150, H, 54):
        g.line([(0, y), (W, y)], fill=LINE, width=2)
    g.line([(100, 0), (100, H)], fill=MARGIN, width=3)
    return im


def _wrap(g, text, font, width):
    lines, cur = [], ""
    for ch in text.replace("\n", ""):
        if g.textlength(cur + ch, font=font) > width:
            lines.append(cur)
            cur = ""
        cur += ch
    return lines + ([cur] if cur else [])


def _tape(g, cx, cy):
    g.polygon([(cx - 70, cy - 22), (cx + 70, cy - 30), (cx + 74, cy + 16), (cx - 66, cy + 24)],
              fill=(236, 214, 150))


def render_page(post, out, illustration=None):
    font = str(ensure_font())
    im = _paper()
    g = ImageDraw.Draw(im)
    x0, y0, x1, y1 = CONTENT
    g.text((x0, y0 + 20), date_label(post["date"]), font=ImageFont.truetype(font, 40), fill=INK2)
    title_font = ImageFont.truetype(font, 64)
    title = _wrap(g, post.get("title", ""), title_font, x1 - x0)[:2]
    y = y0 + 90
    for line in title:
        g.text((x0, y), line, font=title_font, fill=INK)
        y += 80
    if illustration:
        # 旋轉 2.5 度後外框會變大約 5%，先扣掉，插畫下緣才不會跑進對話框區。
        side = min(int((y1 - y - 30) / 1.05) - 24, 600)
        pic = Image.open(illustration).convert("RGB").resize((side, side), Image.LANCZOS)
        framed = Image.new("RGB", (side + 24, side + 24), (255, 255, 255))
        framed.paste(pic, (12, 12))
        framed = framed.rotate(-2.5, resample=Image.BICUBIC, expand=True, fillcolor=PAPER)
        assert y + 30 + framed.height <= y1, "插畫超出內容區"
        px = x0 + 40
        im.paste(framed, (px, y + 30))
        g = ImageDraw.Draw(im)
        _tape(g, px + 60, y + 40)
        _tape(g, px + framed.width - 60, y + 40)
    else:
        body_font = ImageFont.truetype(font, 42)
        for line in _wrap(g, post.get("body", ""), body_font, x1 - x0)[:4]:  # 一兩句手寫小字就好，全文交給對話框
            y += 54
            g.text((x0, y), line, font=body_font, fill=INK2)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, "WEBP", quality=82, method=6)
    return out
