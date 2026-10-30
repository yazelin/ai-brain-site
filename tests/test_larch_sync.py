import unittest

from scripts import larch_sync as ls

BASE = "https://example.test/site"


def post(date, body="一句。", type_="text", title="標題"):
    p = {"date": date, "type": type_, "title": title, "body": body}
    if type_ == "image":
        p["image"] = f"images/posts/{date.replace('-', '')}.webp"
    return p


def lines_for(key, p):
    return [{"text": p["body"], "face": "happy"}]


def build(posts, today="2026-10-31"):
    return ls.build(posts, lines_for, today, BASE)


def remote_of(boards):
    return {bid: b["description"] for bid, b in boards.items()}


class BuildTests(unittest.TestCase):
    def test_month_board_has_calendar_pages_and_edges(self):
        boards = build([post("2026-10-28"), post("2026-10-29", type_="image")])
        b = boards["m-2026-10"]
        ids = {n["id"] for n in b["nodes"]}
        self.assertEqual(ids, {"cal-2026-10", "d-20261028-1", "d-20261029-1"})
        cal = next(n for n in b["nodes"] if n["id"] == "cal-2026-10")["data"]
        self.assertTrue(cal["start"])
        self.assertEqual(cal["miniGameWriteVars"], ["diary_go"])
        self.assertEqual(cal["miniGamePresentation"], "fullscreen")
        self.assertEqual((cal["bgm"], cal["bgmVolume"], cal["bgmLoop"]), (ls.THEME_SONG, 0.18, True))
        page = next(n for n in b["nodes"] if n["id"] == "d-20261028-1")["data"]
        self.assertEqual(page["transition"], "pageTurn")
        self.assertEqual(page["background"], BASE + "/larch/bg/2026-10-28-1.webp")
        self.assertEqual(page["dialogueLines"][0]["stage"]["actors"][0]["url"], BASE + "/larch/sprites/happy.webp")
        conds = {e["target"]: e["data"]["condition"]["value"] for e in b["edges"] if e["source"] == "cal-2026-10"}
        self.assertEqual(conds, {"d-20261028-1": "2026-10-28-1", "d-20261029-1": "2026-10-29-1"})
        backs = {e["source"] for e in b["edges"] if e["target"] == "cal-2026-10"}
        self.assertEqual(backs, {"d-20261028-1", "d-20261029-1"})

    def test_two_posts_same_day_both_added(self):
        b = build([post("2026-08-04"), post("2026-08-04", title="第二篇")])["m-2026-08"]
        self.assertEqual({n["id"] for n in b["nodes"]} - {"cal-2026-08"}, {"d-20260804-1", "d-20260804-2"})
        days = ls.calendar_data(2026, 8, [("2026-08-04-1", post("2026-08-04")), ("2026-08-04-2", post("2026-08-04", title="第二篇"))], "2026-10-31", True, False, BASE, "2026-08-01")["days"]
        self.assertEqual([d["key"] for d in days["4"]], ["2026-08-04-1", "2026-08-04-2"])

    def test_calendar_day_has_title_and_thumb(self):
        days = ls.calendar_data(2026, 10, [("2026-10-28-1", post("2026-10-28", title="文字日")),
                                           ("2026-10-29-1", post("2026-10-29", type_="image", title="插畫日"))],
                                "2026-10-31", True, False, BASE, "2026-08-01")["days"]
        self.assertEqual(days["28"], [{"key": "2026-10-28-1", "title": "文字日", "thumb": None, "excerpt": "一句。"}])
        self.assertEqual(days["29"][0]["thumb"], BASE + "/images/posts/thumbs/20261029.webp")

    def test_text_day_excerpt_is_short_single_line(self):
        long = post("2026-10-28", body="第一段" * 30 + "\n\n第二段")
        cal = ls.calendar_data(2026, 10, [("2026-10-28-1", long)], "2026-10-31", True, False, BASE, "2026-08-01")
        ex = cal["days"]["28"][0]["excerpt"]
        self.assertEqual(len(ex), 60)
        self.assertNotIn("\n", ex)

    def test_latest_post_only_in_newest_month(self):
        entries = [("2026-10-28-1", post("2026-10-28")), ("2026-10-30-1", post("2026-10-30"))]
        self.assertEqual(ls.calendar_data(2026, 10, entries, "2026-10-30", True, False, BASE, "2026-08-01")["latest"], "2026-10-30-1")
        self.assertIsNone(ls.calendar_data(2026, 10, entries, "2026-10-30", True, True, BASE, "2026-08-01")["latest"])

    def test_missing_days_between_start_and_today_are_rest(self):
        entries = [("2026-10-02-1", post("2026-10-02")), ("2026-10-04-1", post("2026-10-04"))]
        cal = ls.calendar_data(2026, 10, entries, "2026-10-06", True, False, BASE, "2026-08-02")
        self.assertEqual(cal["rest"], [1, 3, 5])  # 今天（6 號）還沒寫，不算休息
        aug = ls.calendar_data(2026, 8, [("2026-08-02-1", post("2026-08-02"))], "2026-10-06", False, True, BASE, "2026-08-02")
        self.assertEqual(aug["rest"][:2], [3, 4])  # 8/1 在開始寫之前，不算
        self.assertEqual(len(aug["rest"]), 29)

    def test_empty_body_is_skipped_with_warning(self):
        with self.assertLogs("larch_sync", "WARNING") as cm:
            b = build([post("2026-09-05", body="  "), post("2026-09-06")])["m-2026-09"]
        self.assertNotIn("d-20260905-1", {n["id"] for n in b["nodes"]})
        self.assertIn("2026-09-05", cm.output[0])

    def test_month_boundary_uses_post_date_and_links_months(self):
        boards = build([post("2026-10-31"), post("2026-11-01")], today="2026-11-01")
        self.assertIn("d-20261031-1", {n["id"] for n in boards["m-2026-10"]["nodes"]})
        self.assertIn("d-20261101-1", {n["id"] for n in boards["m-2026-11"]["nodes"]})
        oct_jumps = {n["data"]["jumpBoardId"] for n in boards["m-2026-10"]["nodes"] if n["data"]["type"] == "boardJump"}
        self.assertEqual(oct_jumps, {"m-2026-11"})
        start = boards["board-main"]["nodes"][0]["data"]
        self.assertEqual((start["type"], start["jumpBoardId"], start["start"]), ("boardJump", "m-2026-11", True))

    def test_today_only_baked_into_its_own_month(self):
        a = build([post("2026-09-30"), post("2026-10-01")], today="2026-10-01")
        b = build([post("2026-09-30"), post("2026-10-01")], today="2026-10-02")
        self.assertEqual(a["m-2026-09"]["description"], b["m-2026-09"]["description"])
        self.assertNotEqual(a["m-2026-10"]["description"], b["m-2026-10"]["description"])


class PlanTests(unittest.TestCase):
    def test_nothing_to_do_when_remote_matches(self):
        boards = build([post("2026-10-28"), post("2026-10-29")])
        self.assertEqual(ls.plan(boards, remote_of(boards)), [])

    def test_missing_day_changes_only_its_month(self):
        old = build([post("2026-09-30"), post("2026-10-28")])
        new = build([post("2026-09-30"), post("2026-10-28"), post("2026-10-29")])
        self.assertEqual(ls.plan(new, remote_of(old)), ["m-2026-10"])

    def test_new_month_is_created_before_links_to_it(self):
        old = build([post("2026-10-31")], today="2026-10-31")
        new = build([post("2026-10-31"), post("2026-11-01")], today="2026-11-01")
        order = ls.plan(new, remote_of(old))
        self.assertEqual(order[0], "m-2026-11")
        self.assertEqual(set(order), {"m-2026-11", "m-2026-10", "board-main"})
        self.assertEqual(order[-1], "board-main")


class RenderTests(unittest.TestCase):
    def test_existing_background_is_not_rerendered_and_missing_illustration_is_tolerated(self):
        import tempfile
        from pathlib import Path
        calls = []

        def fake_render(p, out, illu):
            calls.append((p["date"], illu))
            if illu is not None and not Path(illu).exists():
                raise FileNotFoundError(illu)
            Path(out).write_bytes(b"x")
        with tempfile.TemporaryDirectory() as d:
            bg = Path(d)
            (bg / "2026-10-28-1.webp").write_bytes(b"old")
            posts = [post("2026-10-28"), post("2026-10-29", type_="image"), post("2026-10-30", body=" ")]
            with self.assertLogs("larch_sync", "WARNING"):
                ls.render_backgrounds(posts, bg, Path(d) / "nope", fake_render)
            self.assertEqual((bg / "2026-10-28-1.webp").read_bytes(), b"old")
            self.assertTrue((bg / "2026-10-29-1.webp").exists())
        self.assertEqual([c[0] for c in calls], ["2026-10-29", "2026-10-29"])
        self.assertIsNone(calls[-1][1])


class FakeApi:
    def __init__(self, fail_on=None):
        self.puts, self.shares, self.fail_on = [], 0, fail_on

    def get(self, path):
        return {"_etag": '"r1"'}

    def put_board(self, pid, bid, body, etag):
        if bid == self.fail_on:
            raise RuntimeError("網路斷了")
        self.puts.append(bid)

    def refresh_share_link(self, pid):
        self.shares += 1
        return "https://larch.ink/play/x"


class ApplyTests(unittest.TestCase):
    def test_share_refreshes_every_run_even_with_nothing_to_put(self):
        # 上一班 board 都寫好了、只有刷新分享連結失敗：同一天重跑也要補刷。
        boards = build([post("2026-10-28")])
        api = FakeApi()
        self.assertEqual(ls.apply([], boards, api, "p", share=True), "https://larch.ink/play/x")
        self.assertEqual((api.puts, api.shares), ([], 1))

    def test_no_share_link_while_share_disabled(self):
        api = FakeApi()
        ls.apply(["m-2026-10"], build([post("2026-10-28")]), api, "p", share=False)
        self.assertEqual(api.shares, 0)

    def test_failure_midway_keeps_done_boards_and_rerun_resumes(self):
        old = build([post("2026-10-31")], today="2026-10-31")
        new = build([post("2026-10-31"), post("2026-11-01")], today="2026-11-01")
        remote = remote_of(old)
        api = FakeApi(fail_on="m-2026-10")
        with self.assertRaises(RuntimeError):
            ls.apply(ls.plan(new, remote), new, api, "p", share=False)
        self.assertEqual(api.puts, ["m-2026-11"])
        remote["m-2026-11"] = new["m-2026-11"]["description"]  # Larch 上已經有了
        self.assertNotIn("m-2026-11", ls.plan(new, remote))
