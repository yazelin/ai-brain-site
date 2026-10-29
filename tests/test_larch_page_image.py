import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageChops

from scripts import larch_page_image as pi

ILLU = Path(__file__).resolve().parent.parent / "images" / "posts" / "20261029.webp"
TEXT = {"date": "2026-10-28", "type": "text", "title": "運河裡的泡泡",
        "body": "今天看到阿姆斯特丹的運河裝了氣泡屏障。\n\n好酷。"}
IMG = {"date": "2026-10-29", "type": "image", "title": "黑洞先生來作客", "body": "畫了一張圖。"}


@unittest.skipUnless(pi.FONT.exists(), "沒有字型檔（執行 ensure_font() 下載）")
class RenderPageTests(unittest.TestCase):
    def test_weekday_label(self):
        self.assertEqual(pi.date_label("2026-10-29"), "2026 年 10 月 29 日・星期四")
        self.assertEqual(pi.date_label("2026-11-01"), "2026 年 11 月 1 日・星期日")

    def test_text_and_image_pages_are_1920x1080_and_deterministic(self):
        with tempfile.TemporaryDirectory() as d:
            for post, illu in ((TEXT, None), (IMG, ILLU)):
                a = pi.render_page(post, Path(d) / "a.webp", illu)
                b = pi.render_page(post, Path(d) / "b.webp", illu)
                self.assertEqual(Image.open(a).size, (1920, 1080))
                self.assertEqual(a.read_bytes(), b.read_bytes())

    def test_sprite_and_dialogue_zones_stay_plain_paper(self):
        # 右側 35% 給立繪、下方 25% 給對話框：這兩區不能有插畫或字。
        with tempfile.TemporaryDirectory() as d:
            im = Image.open(pi.render_page(IMG, Path(d) / "x.webp", ILLU)).convert("RGB")
            blank = Image.open(pi.render_page({**IMG, "title": "", "date": "2026-10-29"},
                                              Path(d) / "y.webp", None)).convert("RGB")
        for box in ((1250, 0, 1920, 1080), (0, 820, 1920, 1080)):
            # WebP 有損壓縮會讓邊界附近差幾個色階，大於 24 才算畫到東西。
            diff = ImageChops.difference(im.crop(box), blank.crop(box)).convert("L")
            self.assertLess(diff.getextrema()[1], 24, box)
