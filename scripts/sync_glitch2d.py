#!/usr/bin/env python3
"""把 glitch-2d 的骨架執行期同步進本站，並檢查同步結果。

桌寵的活體版本跑的是 glitch-2d（https://github.com/yazelin/glitch-2d）那套原生
2D 骨架。照慣例把相依打包進本 repo，離線第一次進站也要能動，所以 engine 與
rig.json 是抄過來的副本，貼圖另外轉成 WebP：

    glitch2d/engine/*.js        原樣抄，只把模組網址的 ?v= 版本查詢字串拿掉
    glitch2d/rig.json           貼圖路徑改指向 ../images/glitch2d/*.webp
    images/glitch2d/*.webp      8 張執行期貼圖，PNG 共 8.2 MB，WebP 共 0.7 MB

用法：
    python3 scripts/sync_glitch2d.py            # 只檢查有沒有漂掉
    python3 scripts/sync_glitch2d.py --write    # 從 ../glitch-2d 重新同步
    python3 scripts/sync_glitch2d.py --source ~/glitch-2d --write

檢查通過回 0；有差異回 1；找不到來源或缺檔回 2。--write 之後記得跑
scripts/update_sw_hashes.py，離線快取的名字要跟著內容換。
"""
import argparse
import io
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODULES = ("motion.js", "geometry.js", "renderer.js", "audio.js")
QUALITY = 92


def strip_version(text: str) -> str:
    """抄過來的副本是固定版本，模組網址的 ?v= 查詢字串沒有意義，拿掉。"""
    return re.sub(r"\?v=\d+\.\d+\.\d+", "", text)


def rig_for_site(source_rig: dict) -> dict:
    rig = json.loads(json.dumps(source_rig))
    for spec in rig["textures"].values():
        spec["src"] = "../images/glitch2d/" + spec["src"].replace(".png", ".webp")
    rig["sourceRepo"] = "https://github.com/yazelin/glitch-2d"
    return rig


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(ROOT.parent / "glitch-2d"))
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    source = pathlib.Path(args.source).expanduser()
    rig_path = source / "character" / "glitch" / "rig.json"
    if not rig_path.is_file():
        print(f"找不到來源 repo：{source}", file=sys.stderr)
        return 2
    source_rig = json.loads(rig_path.read_text(encoding="utf-8"))
    wanted_rig = json.dumps(rig_for_site(source_rig), ensure_ascii=False, separators=(",", ":")) + "\n"

    drift = []
    if args.write:
        (ROOT / "glitch2d" / "engine").mkdir(parents=True, exist_ok=True)
        (ROOT / "images" / "glitch2d").mkdir(parents=True, exist_ok=True)

    for name in MODULES:
        want = strip_version((source / "engine" / name).read_text(encoding="utf-8"))
        target = ROOT / "glitch2d" / "engine" / name
        if args.write:
            target.write_text(want, encoding="utf-8")
        elif not target.is_file() or target.read_text(encoding="utf-8") != want:
            drift.append(f"glitch2d/engine/{name}")

    target = ROOT / "glitch2d" / "rig.json"
    if args.write:
        target.write_text(wanted_rig, encoding="utf-8")
    elif not target.is_file() or target.read_text(encoding="utf-8") != wanted_rig:
        drift.append("glitch2d/rig.json")

    from PIL import Image
    for spec in source_rig["textures"].values():
        png = source / "character" / "glitch" / spec["src"]
        webp = ROOT / "images" / "glitch2d" / spec["src"].replace(".png", ".webp")
        if args.write:
            Image.open(png).convert("RGB").save(webp, "WEBP", quality=QUALITY, method=6)
        elif not webp.is_file():
            drift.append(f"images/glitch2d/{webp.name}（缺檔）")
        else:
            # 內容比對用重壓一次的結果，避免每次都因為編碼器版本差異報警。
            buffer = io.BytesIO()
            Image.open(png).convert("RGB").save(buffer, "WEBP", quality=QUALITY, method=6)
            if buffer.getvalue() != webp.read_bytes():
                drift.append(f"images/glitch2d/{webp.name}")

    if args.write:
        print(f"已從 {source} 同步骨架執行期；記得跑 scripts/update_sw_hashes.py")
        return 0
    if drift:
        print("桌寵骨架與 glitch-2d 不同步：")
        for item in drift:
            print(f"  - {item}")
        print("跑 python3 scripts/sync_glitch2d.py --write 重新同步。")
        return 1
    print("桌寵骨架與 glitch-2d 同步。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
