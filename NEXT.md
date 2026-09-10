# Next

- [ ] 真機驗收背景播放:Android 關螢幕續播必驗;iOS 加入主畫面 standalone 鎖屏是否續播(glitch-music 站,Playwright 驗不了)
- [ ] 桌寵的當機表情還沒有螺旋眼。現在是眼睛半閉加嘴張開，抖動與色偏用 CSS 撐著。要做得像原本那張 `pet-error.webp`，得在 glitch-2d 的臉部圖集加一組螺旋虹膜差分，rig.json 加兩個部件，`glitch2d/pet.js` 進入 error 時切 `part.visible`，再跑 `scripts/sync_glitch2d.py --write`。
- [ ] 桌寵的揮手是手臂擺動（骨架內建的 `wave()`），不是 `pet-plain.webp` 那種舉手張掌。那個要另產一張「舉起來的袖子＋張開手掌」素材，加成可切換部件，屬於 glitch-2d 那邊的工作。
- [ ] 站上其他地方（大頭照、貼圖、日記配圖）還是舊畫風，桌寵換成新骨架之後兩種畫風並存。
