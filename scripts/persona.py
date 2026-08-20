"""格莉奇（Glitch）的單一人設來源。

真正的內容在 repo 根的 persona.json，Python（日記、頭像、桌寵）與 Cloudflare
Worker（聊天）共用同一份。這裡只負責載入並維持既有的常數名稱。

造型描述拆成兩段：IDENTITY 是不隨服裝變的特徵，OUTFITS 是她的兩套衣服。
IDENTITY 那段跟 ai-comic-starter 的 story/cast.json cast.glitch.identity
**逐字相同**，由 scripts/check_character_sync.py 把關。要改造型先改 persona.json，
再跑那支檢查，不要在各個 generate_*.py 裡各寫一份——那正是造型漂掉的原因。
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
_P = json.loads((ROOT / "persona.json").read_text(encoding="utf-8"))

# 畫風錨點：用貼圖成品當 image 1，鎖賽博粉綠／霓虹紫配色與像素 glitch 質感。
# 注意這不是 characters.glitch.ref（那張三視圖是聊天畫自畫像用的）。
REF_IMAGE = _P["styleAnchor"]
REF_DESC = "the official character art / style anchor for Glitch"

_G = _P["characters"]["glitch"]
IDENTITY = _G["identity"]
OUTFITS = _G["outfits"]
DEFAULT_OUTFIT = _G["defaultOutfit"]


def sheet(outfit=None):
    """組出送給生圖模型的角色表：IDENTITY 加上指定的那套衣服。

    outfit=None 用 persona.json 的 defaultOutfit（目前是 A，三視圖那套）。
    """
    return f"{IDENTITY}\n\n{OUTFITS[outfit or DEFAULT_OUTFIT]}"


SHEET = sheet()
BASE = _P["imageBase"]
RULES = _P["imageRules"]
VOICE = _P["voice"]
