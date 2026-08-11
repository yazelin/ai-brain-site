"""格莉奇（Glitch）的單一人設來源。

真正的內容在 repo 根的 persona.json，Python（日記）與 Cloudflare Worker（聊天）
共用同一份。這裡只負責載入並維持既有的常數名稱，讓 generate_post.py 不用改。
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
_P = json.loads((ROOT / "persona.json").read_text(encoding="utf-8"))

# 畫風錨點：用貼圖成品當 image 1，鎖賽博粉綠／霓虹紫配色與像素 glitch 質感。
# 注意這不是 characters.glitch.ref（那張三視圖是聊天畫自畫像用的）。
REF_IMAGE = _P["styleAnchor"]
REF_DESC = "the official character art / style anchor for Glitch"

SHEET = _P["characters"]["glitch"]["sheet"]
BASE = _P["imageBase"]
RULES = _P["imageRules"]
VOICE = _P["voice"]
