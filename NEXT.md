# Next

- [ ] 真機驗收背景播放:Android 關螢幕續播必驗;iOS 加入主畫面 standalone 鎖屏是否續播(glitch-music 站,Playwright 驗不了)
- [ ] 桌寵的表情還差兩張畫出來的眼睛差分，參數已經調到底了。量法是同一個視窗、同一塊臉、跟 neutral 比平均像素差：舊靜態圖 happy 31.5、thinking 20.8、sleep 30.1、error 42.0；現在的骨架 happy 22.2、thinking 23.4、sleep 24.1、error 30.9。thinking 已經超過舊圖，sleep 接近，**happy 與 error 還差一截，缺的都是畫出來的眼睛**：
  - happy 的笑眼（兩道 ^^ 弧線）。現在只能把 eyeOpen 壓到 0.3 瞇起來，形狀不對。
  - error 的螺旋眼。現在是閉眼加張嘴加 CSS 抖動色偏，螺旋是參數生不出來的。
  兩張都要在 glitch-2d 的臉部圖集加虹膜／眼線差分，rig.json 加對應部件（可以沿用 `closed-eye` 那種依參數切透明度的做法），再跑 `scripts/sync_glitch2d.py --write`。**這是改角色素材，要 yazelin 先看過。**
- [ ] 桌寵的揮手是手臂擺動（骨架內建的 `wave()`），不是 `pet-plain.webp` 那種舉手張掌。那個要另產一張「舉起來的袖子＋張開手掌」素材，加成可切換部件，屬於 glitch-2d 那邊的工作。
- [ ] 站上其他地方（大頭照、貼圖、日記配圖）還是舊畫風，桌寵換成新骨架之後兩種畫風並存。
