"""讓 Larch《格莉奇日記》跟 posts.json 一致。

每個月一個 board（m-YYYY-MM）：月曆 miniGame 卡當起點，點一天翻到那天的
對話卡（一篇一張，dialogueLines 一句一行、每句換立繪），講完接回月曆。
board-main 只有一張 boardJump，讀者按「開始遊戲」就到最新的月份。

每次都把每張 board 該長怎樣整份算出來，內容雜湊寫在 board 的 description；
跟 Larch 上的雜湊不同才整張覆寫（PUT /boards/:id），所以重跑不會多出任何卡，
某天失敗了下一班會自動補上，回填三個月也是同一支程式。
背景與立繪直接用 GitHub Pages 的網址，不上傳素材。

用法：python scripts/larch_sync.py [--config larch/config.json] [--dry-run]
"""
import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import re
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import larch_pages
from scripts.larch_api import Larch

ROOT = Path(__file__).resolve().parent.parent
TZ = dt.timezone(dt.timedelta(hours=8))
log = logging.getLogger("larch_sync")
CAL_TPL = (ROOT / "larch" / "calendar.html").read_text("utf-8")
SPEAKER = "格莉奇"


def _ym(date):
    return date[:7]


def _cond(eid, source, target, value):
    return {"id": eid, "source": source, "target": target, "sourceHandle": "right",
            "data": {"condition": {"kind": "variable", "variable": "diary_go", "op": "eq", "value": value}}}


def _edge(eid, source, target):
    return {"id": eid, "source": source, "target": target, "sourceHandle": "right"}


def _actor(base, face):
    return {"actors": [{"id": "glitch", "url": f"{base}/larch/sprites/{face}.webp", "name": SPEAKER,
                        "slot": "right", "enter": "none", "scale": 1, "offsetX": 0, "offsetY": 0}]}


def calendar_data(year, month, entries, today, has_prev, has_next):
    days = {}
    for key, p in entries:
        days.setdefault(str(int(p["date"][8:])), []).append(
            {"key": key, "title": p.get("title", ""), "image": p.get("type") == "image"})
    # 今天只寫進自己那個月，舊月份的內容才不會每天都變、每天都重送。
    return {"year": year, "month": month, "today": today if _ym(today) == f"{year}-{month:02d}" else None,
            "prev": has_prev, "next": has_next, "days": days}


def _cal_html(data):
    return re.sub(r"/\*DATA\*/.*?/\*END\*/", lambda m: "/*DATA*/" + json.dumps(data, ensure_ascii=False) + "/*END*/",
                  CAL_TPL, count=1, flags=re.S)


def _board(name, nodes, edges):
    body = {"name": name, "nodes": nodes, "edges": edges}
    sha = hashlib.sha1(json.dumps(body, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return {**body, "description": f"sync:{sha}"}


def build(posts, lines_for, today, base):
    """posts → {board_id: board body}。lines_for(key, post) 回傳 [{text, face}]。純函式。"""
    months = {}
    for key, p in larch_pages.post_key(posts):
        if not str(p.get("body", "")).strip():
            log.warning("%s 這篇內文是空的，先跳過", key)
            continue
        months.setdefault(_ym(p["date"]), []).append((key, p))
    order = sorted(months)
    boards = {}
    for i, ym in enumerate(order):
        y, m = int(ym[:4]), int(ym[5:])
        cal_id, entries = f"cal-{ym}", months[ym]
        prev_ym = order[i - 1] if i else None
        next_ym = order[i + 1] if i + 1 < len(order) else None
        nodes = [{"id": cal_id, "type": "story", "position": {"x": 0, "y": 0}, "data": {
            "type": "miniGame", "title": f"{y} 年 {m} 月", "text": "", "start": True,
            "miniGameHtml": _cal_html(calendar_data(y, m, entries, today, bool(prev_ym), bool(next_ym))),
            "miniGameReadVars": [], "miniGameWriteVars": ["diary_go"], "miniGamePresentation": "fullscreen",
            "miniGameFrame": {"showButton": False, "showTitle": False},
            "transition": "pageTurn", "transitionMs": 700, "stage": {"actors": []}, "characterLayers": []}}]
        edges = []
        for j, (key, p) in enumerate(entries):
            nid = "d-" + key[:10].replace("-", "") + key[10:]
            lines = lines_for(key, p)
            nodes.append({"id": nid, "type": "story", "position": {"x": 500 + (j % 6) * 360, "y": (j // 6) * 260},
                          "data": {"type": "dialogue", "title": f"{p['date']} {p.get('title', '')}", "speaker": SPEAKER,
                                   "text": lines[0]["text"], "background": f"{base}/larch/bg/{key}.webp",
                                   "transition": "pageTurn", "transitionMs": 700, "stage": _actor(base, lines[0]["face"]),
                                   "dialogueLines": [{"id": f"l{k}", "speaker": SPEAKER, "text": l["text"],
                                                      "stage": _actor(base, l["face"])} for k, l in enumerate(lines)]}})
            edges.append(_cond(f"e-{cal_id}-{nid}", cal_id, nid, key))
            edges.append(_edge(f"e-{nid}-back", nid, cal_id))
        for word, other in (("prev", prev_ym), ("next", next_ym)):
            if other:
                jid = f"jump-{ym}-{word}"
                nodes.append({"id": jid, "type": "story", "position": {"x": 0, "y": -300 if word == "prev" else 300},
                              "data": {"type": "boardJump", "title": "上個月" if word == "prev" else "下個月",
                                       "jumpBoardId": f"m-{other}", "jumpNodeId": f"cal-{other}", "stage": {"actors": []}}})
                edges.append(_cond(f"e-{cal_id}-{jid}", cal_id, jid, word))
        boards[f"m-{ym}"] = _board(f"{y} 年 {m} 月", nodes, edges)
    if order:
        latest = order[-1]
        boards["board-main"] = _board("開始", [{"id": "start-latest", "type": "story", "position": {"x": 0, "y": 0},
                                              "data": {"type": "boardJump", "title": "最新的月份", "start": True,
                                                       "jumpBoardId": f"m-{latest}", "jumpNodeId": f"cal-{latest}",
                                                       "stage": {"actors": []}}}], [])
    return boards


def plan(boards, remote):
    """要覆寫的 board，依序：新的月份先建、舊月份更新、board-main 最後（它指向的月份要先存在）。"""
    todo = [bid for bid, b in boards.items() if remote.get(bid) != b["description"]]
    return sorted(todo, key=lambda bid: (bid == "board-main", bid in remote, bid))


def apply(todo, boards, api, project_id, share):
    """逐張覆寫；中途失敗時已寫好的留著，下次 plan 會看到它們已經一致。"""
    for bid in todo:
        etag = api.get(f"/projects/{project_id}")["_etag"]
        api.put_board(project_id, bid, {**boards[bid], "summary": f"同步日記：{boards[bid]['name']}"}, etag)
        log.info("已更新 %s", bid)
    if todo and share:
        return api.refresh_share_link(project_id)
    return None


def remote_descriptions(api, project_id):
    proj = api.get(f"/projects/{project_id}")
    return {b["id"]: b.get("description") or "" for b in proj.get("boards", [])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "larch" / "config.json"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    cfg = json.loads(Path(args.config).read_text("utf-8"))
    posts = json.loads((ROOT / "posts.json").read_text("utf-8"))

    from scripts import generate_post, larch_page_image
    ask = lambda prompt: generate_post.ask("gemini-2.5-flash", prompt, json_mode=True)
    pages_dir, bg_dir = ROOT / "larch" / "pages", ROOT / "larch" / "bg"

    def lines_for(key, p):
        return larch_pages.load_or_split(key, p, ask, pages_dir)

    for key, p in larch_pages.post_key(posts):
        if str(p.get("body", "")).strip():
            illu = ROOT / p["image"] if p.get("type") == "image" and p.get("image") else None
            larch_page_image.render_page(p, bg_dir / f"{key}.webp", illu)

    boards = build(posts, lines_for, dt.datetime.now(TZ).date().isoformat(), cfg["base_url"])
    api = Larch(os.environ["LARCH_AGENT_KEY"])
    todo = plan(boards, remote_descriptions(api, cfg["project_id"]))
    print(f"要更新 {len(todo)} 張 board：{', '.join(todo) or '（沒有）'}", flush=True)
    if args.dry_run:
        return
    url = apply(todo, boards, api, cfg["project_id"], cfg.get("share", False))
    if url:
        print(f"分享連結：{url}", flush=True)


if __name__ == "__main__":
    main()
