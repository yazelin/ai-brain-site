import io
import json
import unittest
import urllib.error

from scripts.larch_api import Larch, LarchError


class FakeResp(io.BytesIO):
    def __init__(self, body, headers=None):
        super().__init__(json.dumps(body).encode())
        self.headers = headers or {}
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code, headers=None, body=b"{}"):
    return urllib.error.HTTPError("u", code, "x", headers or {}, io.BytesIO(body))


class LarchApiTests(unittest.TestCase):
    def test_retries_after_429(self):
        seq = [http_error(429, {"retry-after": "2"}), FakeResp({"ok": True})]
        calls = []

        def fake(req, timeout=None):
            calls.append(req)
            r = seq.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        slept = []
        api = Larch("k", sleep=slept.append, opener=fake)
        self.assertEqual(api.post("/projects/p/nodes", {}), {"ok": True})
        self.assertEqual(slept, [2])
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer k")

    def test_refuses_publish_and_project_put(self):
        def never(req, timeout=None):
            raise AssertionError("不該送出")
        api = Larch("k", opener=never)
        with self.assertRaises(LarchError):
            api.post("/projects/p/publish", {})
        with self.assertRaises(LarchError):
            api.delete("/projects/p/publish")
        with self.assertRaises(LarchError):
            api.request("PUT", "/projects/p", {})

    def test_board_put_is_allowed(self):
        api = Larch("k", opener=lambda req, timeout=None: FakeResp({"ok": 1}))
        self.assertEqual(api.request("PUT", "/projects/p/boards/b", {}), {"ok": 1})

    def test_gives_up_after_5_429s(self):
        def fake(req, timeout=None):
            raise http_error(429, {"retry-after": "1"})
        api = Larch("k", sleep=lambda s: None, opener=fake)
        with self.assertRaises(LarchError) as cm:
            api.get("/projects/p")
        self.assertEqual(cm.exception.status, 429)

    def test_other_http_error_raises_with_body(self):
        def fake(req, timeout=None):
            raise http_error(403, body=b'{"error":"no scope"}')
        api = Larch("k", sleep=lambda s: None, opener=fake)
        with self.assertRaises(LarchError) as cm:
            api.get("/projects/p")
        self.assertEqual(cm.exception.status, 403)
        self.assertIn("no scope", cm.exception.body)

    def test_etag_is_returned_and_sent(self):
        seen = []

        def fake(req, timeout=None):
            seen.append(req.get_header("If-match"))
            return FakeResp({"a": 1}, {"ETag": '"r5"'})
        api = Larch("k", opener=fake)
        self.assertEqual(api.get("/projects/p/boards/b")["_etag"], '"r5"')
        api.put_board("p", "b", {"nodes": []}, '"r5"')
        self.assertEqual(seen[-1], '"r5"')
