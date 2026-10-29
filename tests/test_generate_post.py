import json
import unittest
from unittest import mock

from scripts import generate_post


def discussion_payload(comments, category="General"):
    return {
        "data": {
            "repository": {
                "discussions": {
                    "nodes": [{
                        "category": {"name": category},
                        "comments": {"nodes": comments},
                    }]
                }
            }
        }
    }


def comment(comment_id, body, created_at, login="fan"):
    return {
        "id": comment_id,
        "body": body,
        "createdAt": created_at,
        "author": {"login": login},
    }


class CommentDeduplicationTests(unittest.TestCase):
    def test_filters_used_comments_before_applying_limit(self):
        payload = discussion_payload([
            comment("old", "已經畫過", "2026-08-05T03:00:00Z"),
            comment("new-1", "新的第一則", "2026-08-05T02:00:00Z"),
            comment("new-2", "新的第二則", "2026-08-05T01:00:00Z"),
        ])

        result = generate_post.parse_comments(payload, limit=2, used_ids={"old"})

        self.assertEqual([item["id"] for item in result], ["new-1", "new-2"])

    def test_legacy_comment_source_text_is_also_filtered(self):
        payload = discussion_payload([
            comment("legacy-id", "  跨行\n留言  ", "2026-08-05T03:00:00Z", "yazelin"),
            comment("fresh-id", "全新留言", "2026-08-05T02:00:00Z"),
        ])

        result = generate_post.parse_comments(
            payload, used_texts={"@yazelin: 跨行 留言"})

        self.assertEqual([item["id"] for item in result], ["fresh-id"])

    def test_collects_new_ids_and_legacy_text_markers(self):
        posts = [
            {"comment_id": "node-1", "comment_source": "@fan: 用過的留言"},
            {"comment_source": "@legacy: 沒有 ID 的舊留言"},
            {"inspiration": "@oldfan: 更早期的留言"},
            {"inspiration": "一般新聞，不是留言"},
        ]

        used_ids, used_texts = generate_post.used_comment_markers(posts)

        self.assertEqual(used_ids, {"node-1"})
        self.assertNotIn("@fan: 用過的留言", used_texts)
        self.assertIn("@legacy: 沒有 id 的舊留言", used_texts)
        self.assertIn("@oldfan: 更早期的留言", used_texts)
        self.assertNotIn("一般新聞，不是留言", used_texts)

    def test_selected_comment_key_resolves_to_stable_github_id(self):
        comments = [
            {"id": "node-1", "text": "@fan: 第一則", "created_at": "2026-08-05T02:00:00Z"},
            {"id": "node-2", "text": "@fan: 第二則", "created_at": "2026-08-05T01:00:00Z"},
        ]
        response = json.dumps({
            "inspiration": "第二則留言",
            "source_type": "giscus",
            "comment_key": "C2",
            "comment_source": "第二則留言",
            "angle": "想畫出來",
            "scene": "格莉奇開心畫畫",
            "stickers": [2],
        }, ensure_ascii=False)

        with mock.patch.object(generate_post, "ask", return_value=response) as ask:
            result = generate_post.pick_inspiration(["今日新聞"], comments, ["昨日新聞"])

        self.assertEqual(result[0], "@fan: 第二則")
        self.assertEqual(result[4], "@fan: 第二則")
        self.assertEqual(result[5], "node-2")
        prompt = ask.call_args.args[1]
        self.assertIn("[C1] @fan: 第一則", prompt)
        self.assertIn("昨日新聞", prompt)

    def test_invalid_giscus_key_falls_back_to_newest_unused_comment(self):
        comments = [
            {"id": "newest", "text": "@fan: 最新留言", "created_at": "2026-08-05T02:00:00Z"},
            {"id": "older", "text": "@fan: 較舊留言", "created_at": "2026-08-05T01:00:00Z"},
        ]
        response = json.dumps({
            "inspiration": "模型改寫過的留言",
            "source_type": "giscus",
            "comment_key": "C99",
            "comment_source": "模型改寫過的留言",
            "angle": "想畫出來",
            "scene": "格莉奇開心畫畫",
            "stickers": [],
        }, ensure_ascii=False)

        with mock.patch.object(generate_post, "ask", return_value=response):
            result = generate_post.pick_inspiration([], comments)

        self.assertEqual(result[0], "@fan: 最新留言")
        self.assertEqual(result[4], "@fan: 最新留言")
        self.assertEqual(result[5], "newest")

    def test_unanswered_comment_wins_even_if_model_picks_news(self):
        comments = [
            {"id": "newest", "text": "@fan: 最新留言", "created_at": "2026-08-05T02:00:00Z"},
        ]
        response = json.dumps({
            "inspiration": "今日新聞",
            "source_type": "news",
            "comment_key": "",
            "comment_source": "",
            "angle": "好有趣",
            "scene": "格莉奇看新聞",
            "stickers": [],
        }, ensure_ascii=False)

        with mock.patch.object(generate_post, "ask", return_value=response) as ask:
            result = generate_post.pick_inspiration(["今日新聞"], comments)

        self.assertEqual(result[0], "@fan: 最新留言")
        self.assertEqual(result[5], "newest")
        self.assertIn("MANDATORY OVERRIDE", ask.call_args.args[1])

    def test_text_generation_only_receives_selected_tracked_comment(self):
        response = json.dumps({"title": "測試文章", "body": "測試正文"}, ensure_ascii=False)

        with mock.patch.object(generate_post, "ask", return_value=response) as ask:
            generate_post.gen_text_post("新聞", "角度", "@fan: 已選定留言")

        prompt = ask.call_args.args[1]
        self.assertIn("@fan: 已選定留言", prompt)
        self.assertNotIn("[C", prompt)


class PersonaTests(unittest.TestCase):
    def test_persona_loads_from_json(self):
        from scripts import persona

        self.assertEqual(persona.REF_IMAGE, "images/sticker-01.webp")
        # 三視圖畫的是條狀天線裝置。舊斷言鎖的是 "CAT-EAR ANTENNAS",
        # 那句跟設定稿對不上,等於用測試把錯誤釘住。
        self.assertIn("ANTENNA DEVICES", persona.SHEET)
        self.assertNotIn("CAT-EAR", persona.SHEET)
        # SHEET 預設帶 Outfit A(三視圖那套):沒有裙子、沒有包。
        self.assertIn("There is NO skirt", persona.SHEET)
        self.assertIn("NEVER Simplified Chinese", persona.RULES)
        self.assertIn("4KB", persona.VOICE)
        self.assertTrue(
            persona.BASE.startswith("Same art style as reference image 1"))


class CharacterSyncTests(unittest.TestCase):
    """identity 段必須跟 ai-comic-starter 的 cast.json 逐字相同。

    兩個 repo 都在本機才驗得到；CI 上沒有另一個 repo，直接 skip。
    """

    def test_identity_跟漫畫_repo_一致(self):
        import pathlib
        import subprocess
        import sys

        root = pathlib.Path(__file__).resolve().parent.parent
        comic = root.parent / "ai-comic-starter" / "story" / "cast.json"
        if not comic.exists():
            self.skipTest("本機沒有 ai-comic-starter，跳過跨 repo 比對")
        r = subprocess.run(
            [sys.executable, str(root / "scripts" / "check_character_sync.py")],
            capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()


class DiaryPromptTests(unittest.TestCase):
    def test_text_prompt_asks_for_longer_and_less_formula(self):
        p = generate_post.TEXT_PROMPT
        self.assertIn("250", p)
        self.assertIn("400", p)
        self.assertNotIn("3-6 句", p)
        self.assertNotIn("結尾可以加一句你的口頭禪", p)

    def test_image_post_with_empty_caption_falls_back(self):
        empty = json.dumps({"title": "今日插畫", "body": ""})
        with mock.patch.object(generate_post, "generate_image", return_value="images/posts/x.webp"), \
             mock.patch.object(generate_post, "ask", return_value=empty) as ask, \
             mock.patch.object(generate_post, "ROOT") as root:
            self.assertIsNone(generate_post.gen_image_post("新聞", "場景"))
        self.assertEqual(ask.call_count, 2)
        root.__truediv__.return_value.unlink.assert_called_once_with(missing_ok=True)

    def test_image_post_retry_succeeds(self):
        replies = [json.dumps({"title": "x", "body": " "}),
                   json.dumps({"title": "黑洞好可愛", "body": "今天畫了黑洞。"})]
        with mock.patch.object(generate_post, "generate_image", return_value="images/posts/x.webp"), \
             mock.patch.object(generate_post, "ask", side_effect=replies):
            post = generate_post.gen_image_post("新聞", "場景")
        self.assertEqual(post["body"], "今天畫了黑洞。")
        self.assertEqual(post["title"], "黑洞好可愛")
