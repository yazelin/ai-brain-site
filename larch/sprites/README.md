# 格莉奇日記（Larch）立繪

九張，給 `scripts/larch_pages.py` 的表情鍵用：`plain` `crash` `feature` `happy` `snack` `curious` `panic` `sleepy` `lonely`。
2026-10-30 產，作者在確認頁逐張確認後才上線。

## 怎麼產的

- 產線：跟網站桌寵同一條（.11 的 codex-image 服務，`CODEX_IMAGE_KEY`），參考圖 `images/pet-plain.webp`，造型用 `persona.sheet("B")`。
- 提示詞：每張都是「同一角色、同畫風同服裝同比例，只換臉、手和天線」加上該表情的一段描述，再加 FRAMING（全身、站在同一點、手不高過頭頂）與黃色 chroma 底。
- 去背：`scripts/remove_chroma_key.py --auto-key border --soft-matte --despill`。
- 對齊：用胸前 ERROR 牌（樣板比對）到腳底的距離當尺，整張等比縮放；腳底對齊、ERROR 牌水平置中；九張用同一個裁切框，所以疊起來換表情不會跳。頭頂會被天線姿勢騙、腿長會被站姿騙，所以不用那兩個量。
- 輸出 581×1565 RGBA WebP。

## 各張的表情描述

| 鍵 | 用在 | 描述重點 |
|---|---|---|
| plain | 平常說話 | 跟參考圖一樣，看著讀者，雙手自然垂下 |
| crash | 當機 | 螺旋眼、頭頂冒煙、ERROR 紅燈、雙手抱頭 |
| feature | 「這不是 Bug，是 Feature」 | 一手叉腰、一手食指朝上、眨眼笑 |
| happy | 開心、感動 | 閉眼大笑、天線翹起發光、雙手合在胸前 |
| snack | 嘴饞 | 雙手捧一顆糖、眼睛發亮 |
| curious | 好奇 | 歪頭、食指抵下巴、旁邊一個像素問號 |
| panic | 驚訝慌張 | 睜大眼、冒汗、雙手舉在肩膀高度 |
| sleepy | 想睡 | 打哈欠、一手揉眼、天線垂下、Zzz |
| lonely | 寂寞 | 眼睛往下看、天線垂下、雙手在裙前交握 |
