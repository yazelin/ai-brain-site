#!/usr/bin/env python3
"""把 glitch-vn 的角色自介（音檔 + 逐字稿）同步過來。

自介的**唯一事實來源在 glitch-vn**（`tools/gen_intro.py` 的 INTRO），
那邊才有配音管線。這裡只是消費端，兩邊各抄一份的下場是改了一邊、
另一邊還是舊的，而且沒有人會發現——文字對不上聲音，看起來像 TTS 唸錯。

音檔要**複製一份進來**，不可以指到 /glitch-vn/：SW 的 scope 只到這個站底下，
指過去的話離線時抓不到，症狀是裝了 app 之後按鈕沒反應。

    python3 scripts/sync_intro.py

跑完記得 python3 scripts/update_sw_hashes.py。
"""
import json, pathlib, re, shutil, sys

HERE = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path.home() / "glitch-vn"
WHO = ("glitch", "blackhole")   # 這個站上只有這兩位

meta_f = SRC / "art/voice/intro.json"
if not meta_f.exists():
    sys.exit(f"找不到 {meta_f}——先在 glitch-vn 跑 tools/gen_intro.py")
meta = json.loads(meta_f.read_text(encoding="utf-8"))

(HERE / "audio").mkdir(exist_ok=True)
for k in WHO:
    src = SRC / f"docs/voice/intro-{k}.mp3"
    if not src.exists():
        sys.exit(f"找不到 {src}")
    shutil.copy2(src, HERE / f"audio/intro-{k}.mp3")
    print(f"  audio/intro-{k}.mp3  {src.stat().st_size // 1024} KB")

# **逐字稿寫進 HTML，不要放在 JS 裡等按下去才填。**
# 有些人不方便聽，那段文字本身就是內容；藏在 JS 變數裡的話，
# 不聽的人看不到、沒有 JS 的環境看不到、搜尋引擎也讀不到。
# glitch-vn 的 characters.html 早就是這樣做的，這裡跟它對齊。
p = HERE / "index.html"
s = p.read_text(encoding="utf-8")
total = 0
for k in WHO:
    esc = (meta[k]["text"].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    s, n = re.subn(rf'(<p class="said" id="said-{k}">).*?(</p>)',
                   lambda m: m.group(1) + esc + m.group(2), s, flags=re.S)
    if n != 1:
        sys.exit(f'index.html 裡找不到剛好一個 <p class="said" id="said-{k}">（找到 {n} 個）')
    total += len(esc)
p.write_text(s, encoding="utf-8")
print(f"逐字稿寫進 HTML 了（{total} 字）")
