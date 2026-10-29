import json
import tempfile
import unittest
from pathlib import Path

from scripts import larch_pages as lp

BODY = "逼——嗶！今天看到新聞。\n\n真的好好吃。這不是 Bug，是 Feature！"
GOOD = [{"text": "逼——嗶！今天看到新聞。", "face": "happy"},
        {"text": "真的好好吃。", "face": "snack"},
        {"text": "這不是 Bug，是 Feature！", "face": "feature"}]


def asker(*replies):
    calls = []

    def ask(prompt):
        calls.append(prompt)
        return json.dumps(replies[min(len(calls), len(replies)) - 1], ensure_ascii=False)
    ask.calls = calls
    return ask


class PostKeyTests(unittest.TestCase):
    def test_two_posts_same_day_get_distinct_keys(self):
        keys = [k for k, _ in lp.post_key([{"date": "2026-08-04"}, {"date": "2026-08-04"},
                                           {"date": "2026-08-05"}])]
        self.assertEqual(keys, ["2026-08-04-1", "2026-08-04-2", "2026-08-05-1"])


class SplitTests(unittest.TestCase):
    def test_split_keeps_text_exact(self):
        lines = lp.split_post({"body": BODY}, asker(GOOD))
        self.assertEqual("".join(l["text"] for l in lines).replace(" ", ""),
                         BODY.replace("\n", "").replace(" ", ""))
        self.assertTrue(all(l["face"] in lp.FACES for l in lines))

    def test_split_rejects_rewording(self):
        bad = [{"text": "今天看到一則新聞。", "face": "happy"}]
        ask = asker(bad, bad)
        with self.assertRaises(ValueError):
            lp.split_post({"body": BODY}, ask)
        self.assertEqual(len(ask.calls), 2)

    def test_unknown_face_becomes_plain(self):
        lines = lp.split_post({"body": "你好。"}, asker([{"text": "你好。", "face": "angry"}]))
        self.assertEqual(lines, [{"text": "你好。", "face": "plain"}])

    def test_fallback_split_is_exact(self):
        lines = lp.fallback_split(BODY)
        self.assertEqual([l["text"] for l in lines],
                         ["逼——嗶！今天看到新聞。", "真的好好吃。這不是 Bug，是 Feature！"])
        self.assertTrue(all(l["face"] == "plain" for l in lines))

    def test_fallback_packs_long_paragraph_at_sentence_ends(self):
        para = "這是第一句話，寫得有一點長長的。" * 4
        lines = lp.fallback_split(para)
        self.assertGreater(len(lines), 1)
        self.assertEqual("".join(l["text"] for l in lines), para)
        self.assertTrue(all(len(l["text"]) <= lp.MAX_LINE for l in lines))


class FallbackEdgeTests(unittest.TestCase):
    def test_fallback_keeps_leading_punctuation(self):
        for body in ("……逼——嗶。今天好累。", "好！\n\n！！什麼", "……"):
            lines = lp.fallback_split(body)
            self.assertTrue(lines, body)
            self.assertEqual(lp._squash("".join(l["text"] for l in lines)), lp._squash(body), body)


class CacheTests(unittest.TestCase):
    def test_cache_hit_skips_ask_and_body_change_resplits(self):
        with tempfile.TemporaryDirectory() as d:
            ask = asker(GOOD)
            post = {"body": BODY}
            self.assertEqual(lp.load_or_split("2026-10-29-1", post, ask, Path(d)), GOOD)
            self.assertEqual(lp.load_or_split("2026-10-29-1", post, ask, Path(d)), GOOD)
            self.assertEqual(len(ask.calls), 1)
            cached = json.loads((Path(d) / "2026-10-29-1.json").read_text())
            self.assertEqual(cached["lines"], GOOD)
            post2 = {"body": "新的一句。"}
            ask2 = asker([{"text": "新的一句。", "face": "curious"}])
            self.assertEqual(lp.load_or_split("2026-10-29-1", post2, ask2, Path(d))[0]["face"], "curious")
            self.assertEqual(len(ask2.calls), 1)

    def test_model_failure_falls_back_and_is_not_cached_as_final(self):
        with tempfile.TemporaryDirectory() as d:
            bad = [{"text": "改寫", "face": "plain"}]
            lines = lp.load_or_split("k", {"body": "一。二。"}, asker(bad, bad), Path(d))
            self.assertEqual([l["text"] for l in lines], ["一。二。"])
            self.assertFalse((Path(d) / "k.json").exists())
