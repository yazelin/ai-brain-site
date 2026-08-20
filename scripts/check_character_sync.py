#!/usr/bin/env python3
"""比對兩個 repo 的格莉奇 identity 段是否逐字相同。

造型的正典只有一份（三視圖設定稿），但描述它的文字必須同時存在兩個 repo：

  ai-brain-site   persona.json          日記配圖、頭像、桌寵、聊天自畫像
  ai-comic-starter story/cast.json      漫畫分格

這兩份曾經各寫各的，結果是網站的立繪跟漫畫成品穿的不是同一套衣服，而且兩邊
都有對不上三視圖的句子。identity 是不隨服裝變的那段，兩邊必須逐字相同；
outfit 各自宣告用哪一套，可以不同。

用法：
    python3 scripts/check_character_sync.py [--comic ../ai-comic-starter]

相同回 0；不同印出 unified diff 回 1；找不到檔案回 2。
"""
import argparse
import difflib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def identity_of(path, dig):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"::error::找不到 {path}", file=sys.stderr)
        sys.exit(2)
    for k in dig:
        data = data[k]
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--comic", default=str(ROOT.parent / "ai-comic-starter"),
                    help="ai-comic-starter 的路徑")
    args = ap.parse_args()

    a = identity_of(ROOT / "persona.json",
                    ["characters", "glitch", "identity"])
    b = identity_of(pathlib.Path(args.comic) / "story" / "cast.json",
                    ["cast", "glitch", "identity"])
    if a == b:
        print(f"identity 一致（{len(a)} 字元）")
        return 0
    print("identity 不一致：", file=sys.stderr)
    sys.stderr.writelines(difflib.unified_diff(
        a.splitlines(keepends=True), b.splitlines(keepends=True),
        fromfile="ai-brain-site/persona.json", tofile="ai-comic-starter/story/cast.json"))
    return 1


if __name__ == "__main__":
    sys.exit(main())
