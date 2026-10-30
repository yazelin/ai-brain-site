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
        self.assertEqual(pi.date_label("2026-10-29"), "2026-10-29 · 星期四")
        self.assertEqual(pi.date_label("2026-11-01"), "2026-11-01 · 星期日")

    def test_text_and_image_pages_are_1920x1080_and_deterministic(self):
        with tempfile.TemporaryDirectory() as d:
            for post, illu in ((TEXT, None), (IMG, ILLU)):
                a = pi.render_page(post, Path(d) / "a.webp", illu)
                b = pi.render_page(post, Path(d) / "b.webp", illu)
                self.assertEqual(Image.open(a).size, (1920, 1080))
                self.assertEqual(a.read_bytes(), b.read_bytes())

    def test_sprite_and_dialogue_zones_stay_plain_desktop(self):
        # 右側 35% 給立繪、下方 25% 給對話框：這兩區只有桌布，不能有視窗、插畫或字。
        long_text = {**TEXT, "title": "很長的標題" * 6, "body": ("今天看到一則很有趣的新聞。" * 8 + "\n\n") * 4}
        with tempfile.TemporaryDirectory() as d:
            blank = pi._desktop().convert("RGB")
            for post, illu in ((IMG, ILLU), (long_text, None)):
                im = Image.open(pi.render_page(post, Path(d) / "x.webp", illu)).convert("RGB")
                # 視窗陰影往外擴散約 40px，算進允許範圍；只檢查陰影外面。
                for box in ((1290, 60, 1920, 1080), (0, 860, 1920, 1080)):
                    diff = ImageChops.difference(im.crop(box), blank.crop(box)).convert("L")
                    self.assertLess(diff.getextrema()[1], 24, (post["title"], box))

    def test_text_page_shows_body(self):
        # 文字日的視窗要放內文：內文區跟只有標題的頁面要不一樣。
        with tempfile.TemporaryDirectory() as d:
            a = Image.open(pi.render_page(TEXT, Path(d) / "a.webp")).convert("L")
            b = Image.open(pi.render_page({**TEXT, "body": ""}, Path(d) / "b.webp")).convert("L")
        box = (170, 330, 1100, 420)
        self.assertGreater(ImageChops.difference(a.crop(box), b.crop(box)).getextrema()[1], 80)
