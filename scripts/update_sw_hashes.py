#!/usr/bin/env python3
"""依 shell / asset 真實內容更新 sw.js cache 名稱；不使用手動 vN 版號。"""

from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SW_PATH = ROOT / "sw.js"


def section_paths(source: str, name: str) -> list[str]:
    match = re.search(
        rf"/\* {re.escape(name)}:start \*/(.*?)/\* {re.escape(name)}:end \*/",
        source,
        re.DOTALL,
    )
    if not match:
        raise SystemExit(f"sw.js 缺少 {name}:start / {name}:end 標記")
    return re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))


def file_bytes(relative: str) -> bytes:
    clean = relative.removeprefix("./")
    path = ROOT / (clean or "index.html")
    if not path.is_file():
        raise SystemExit(f"快取清單檔案不存在：{relative}")
    return path.read_bytes()


def content_hash(strategy: bytes, paths: list[str]) -> str:
    digest = hashlib.sha256()
    digest.update(b"glos-sw-strategy\0")
    digest.update(strategy)
    for path in paths:
        digest.update(b"\0path\0")
        digest.update(path.encode("utf-8"))
        digest.update(b"\0content\0")
        digest.update(file_bytes(path))
    return digest.hexdigest()[:12]


def generated_source(source: str) -> tuple[str, str, str]:
    shell_paths = section_paths(source, "shell")
    asset_paths = section_paths(source, "priority") + section_paths(source, "warm")
    normalized = re.sub(
        r"/\* cache:start.*?/\* cache:end \*/",
        "/* cache:generated */",
        source,
        flags=re.DOTALL,
    ).encode("utf-8")
    shell_hash = content_hash(normalized, shell_paths)
    asset_hash = content_hash(normalized, asset_paths)
    updated = re.sub(
        r"const SHELL_CACHE = 'glos-shell-[^']+';",
        f"const SHELL_CACHE = 'glos-shell-{shell_hash}';",
        source,
        count=1,
    )
    updated = re.sub(
        r"const ASSET_CACHE = 'glos-assets-[^']+';",
        f"const ASSET_CACHE = 'glos-assets-{asset_hash}';",
        updated,
        count=1,
    )
    return updated, shell_hash, asset_hash


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="只檢查 sw.js 是否已是最新 hash")
    args = parser.parse_args()
    source = SW_PATH.read_text("utf-8")
    updated, shell_hash, asset_hash = generated_source(source)
    if args.check:
        if updated != source:
            print(f"sw.js cache hash 過期：應為 shell={shell_hash} assets={asset_hash}")
            return 1
        print(f"sw.js cache hash 正確：shell={shell_hash} assets={asset_hash}")
        return 0
    if updated != source:
        SW_PATH.write_text(updated, "utf-8")
        print(f"已更新 sw.js：shell={shell_hash} assets={asset_hash}")
    else:
        print(f"sw.js 不需更新：shell={shell_hash} assets={asset_hash}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
