/**
 * 格莉奇語音通話模組 (Glitch Voice Call)
 *
 * 音訊路徑（只有一條，不重複接線）：
 *   BufferSource -> turnGain(淡入淡出) -> masterGain(音量) -> analyser(頻譜) -> destination
 *
 * 三個會讓「有字幕卻沒聲音」的坑，這版都堵住了：
 *   1. 回音自我打斷：喇叭外放時麥克風會聽到格莉奇自己，Web Speech 一吐字就把播放停掉。
 *      → 播放期間的辨識結果一律丟棄（ALLOW_BARGE_IN=false）。戴耳機再打開。
 *   2. 同一句話被切成多個 final：每個 final 都送一次請求，後面的請求把前面的回覆作廢，
 *      音訊解碼完才發現 turn 過期被丟掉，全程無錯誤訊息。→ 用 debounce 併成一次。
 *   3. AudioContext 在 iOS 會進 'interrupted'（不是 'suspended'），舊寫法的 if 判斷不到。
 *      → 每次播放前無條件 await resume()。
 */

(function () {
  'use strict';

  // ---------- 可調參數 ----------
  const FALLBACK_TUNNEL_URL = 'https://preserve-collective-reproduced-florist.trycloudflare.com';

  // 戴耳機時可以改 true，格莉奇說到一半就能插話打斷。
  // 外放喇叭一定要 false，否則她會被自己的聲音打斷（症狀就是「完全聽不到聲音」）。
  const ALLOW_BARGE_IN = false;
  const BARGE_IN_GUARD_MS = 800;      // 播放開始後這段時間內不接受打斷
  const BARGE_IN_MIN_CHARS = 3;       // 打斷至少要聽到幾個字
  const ECHO_TAIL_MS = 400;           // 播完之後再多擋一下殘響
  const UTTERANCE_DEBOUNCE_MS = 700;  // 幾毫秒內的 final 併成同一句
  const OUTPUT_GAIN = 0.9;            // 後端目前已經滿刻度，留一點餘裕避免破音
  const FADE_MS = 0.015;              // 淡入淡出，避免 stop() 的爆音
  const REQUEST_TIMEOUT_MS = 60000;

  let serverUrl = (localStorage.getItem('glitch_server_url') || FALLBACK_TUNNEL_URL).replace(/\/+$/, '');

  // ---------- 狀態 ----------
  let isCalling = false;
  let isMuted = false;
  let callStartTime = 0;
  let callTimerInterval = null;

  let turnSeq = 0;            // 對話輪次；只會遞增，用來作廢過期的回應
  let inFlight = null;        // 進行中的 AbortController

  let rec = null;             // SpeechRecognition 實例
  let recGen = 0;             // 世代編號，讓殭屍 recognizer 的 onend 不會亂重啟
  let pendingText = '';
  let pendingTimer = null;

  let isSpeaking = false;
  let speechGateUntil = 0;    // 這個時間點之前的辨識結果一律當成回音丟掉
  let bargeReadyAt = 0;

  let visualizerAnimFrame = null;

  // ---------- Web Audio ----------
  let audioCtx = null;
  let masterGain = null;
  let analyserNode = null;
  let audioDataArray = null;
  let currentSource = null;   // 正在播的 BufferSource
  let currentGain = null;     // 對應的淡入淡出 gain
  let fallbackAudio = null;   // decodeAudioData 失敗時的 <audio> 退路
  let silentLoop = null;      // iOS：把 audio session 從鈴聲通道拉到播放通道

  // ---------- DOM ----------
  let callOverlay, callAvatar, callStatus, callTimer, userSubtitle, glitchSubtitle;
  let waveCanvas, waveCtx, micBtn, hangupBtn, configBtn;
  let settingInput, settingSaveBtn, settingStatusText;

  // 後端回傳的 emotion 對到 index.html 既有的 CSS class（CSS 裡是 .happy 不是 .laugh）
  const EMOTION_CLASS = { laugh: 'happy', sad: 'sad', count: 'count', neutral: '' };

  const hasRoundRect = typeof CanvasRenderingContext2D !== 'undefined' &&
    typeof CanvasRenderingContext2D.prototype.roundRect === 'function';

  // ==========================================================================
  // 音訊
  // ==========================================================================

  /** 產生一小段無聲 WAV 的 blob URL，給 iOS 切換 audio session 用 */
  function makeSilentWavUrl() {
    const sr = 8000, n = 800;
    const bytes = new Uint8Array(44 + n).fill(128, 44);   // 8-bit unsigned 的無聲是 128
    const dv = new DataView(bytes.buffer);
    const put = (off, s) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i); };
    put(0, 'RIFF'); dv.setUint32(4, 36 + n, true); put(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr, true);
    dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    put(36, 'data'); dv.setUint32(40, n, true);
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  }

  /** 建立音訊圖。只接一次線：turnGain -> masterGain -> analyser -> destination */
  function ensureAudioGraph() {
    if (audioCtx) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('這個瀏覽器沒有 Web Audio API');
    audioCtx = new Ctor({ latencyHint: 'interactive' });

    masterGain = audioCtx.createGain();
    masterGain.gain.value = OUTPUT_GAIN;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 128;
    analyserNode.smoothingTimeConstant = 0.75;
    audioDataArray = new Uint8Array(analyserNode.frequencyBinCount);

    masterGain.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    // 分頁切回來、iOS 中斷結束後自動恢復
    audioCtx.addEventListener('statechange', () => {
      console.debug('[GlitchVoice] AudioContext state ->', audioCtx.state);
      if (audioCtx.state !== 'running' && isCalling) audioCtx.resume().catch(() => {});
    });

    silentLoop = new Audio(makeSilentWavUrl());
    silentLoop.loop = true;
    silentLoop.playsInline = true;
    silentLoop.volume = 0.001;
  }

  /**
   * 解鎖並確保 AudioContext 真的在跑。
   * 必須在使用者手勢的同一個 task 裡「先同步建立 context」，await 之後才 resume。
   */
  async function unlockAudio() {
    ensureAudioGraph();

    // iOS：靜音實體開關會讓 Web Audio 完全沒聲音，先播一段無聲 <audio> 把 session 換成播放通道
    if (silentLoop && silentLoop.paused) silentLoop.play().catch(() => {});

    // 'suspended' 和 iOS 的 'interrupted' 都要救，所以不判斷狀態直接 resume
    if (audioCtx.state !== 'running') {
      try { await audioCtx.resume(); } catch (e) { console.warn('[GlitchVoice] resume 失敗:', e); }
    }

    // 踢一顆無聲 buffer，確保 autoplay 政策確實放行
    try {
      const src = audioCtx.createBufferSource();
      src.buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
      src.connect(masterGain);
      src.start(0);
    } catch (e) { /* 不影響後續播放 */ }

    return audioCtx.state === 'running';
  }

  /** data: URL 直接 atob 解成 ArrayBuffer；Safari 對超長 data: URL 走 fetch 會有長度上限 */
  async function toArrayBuffer(url) {
    if (!/^data:/i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`音訊下載失敗 HTTP ${res.status}`);
      return res.arrayBuffer();
    }
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error('audio_url 格式錯誤');
    const bin = atob(url.slice(comma + 1));
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    if (view.length < 44) throw new Error('音訊長度異常（少於 WAV 標頭）');
    return buf;
  }

  /** 舊版 Safari 的 decodeAudioData 只有 callback 形式，兩種都接 */
  function decodeAudio(arrayBuffer) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (b) => { if (!settled) { settled = true; b ? resolve(b) : reject(new Error('解碼結果為空')); } };
      const fail = (e) => { if (!settled) { settled = true; reject(e || new Error('decodeAudioData 失敗')); } };
      let p;
      try { p = audioCtx.decodeAudioData(arrayBuffer, ok, fail); } catch (e) { return fail(e); }
      if (p && typeof p.then === 'function') p.then(ok, fail);
    });
  }

  /** 讀目前 analyser 的最大頻譜值，0 = 沒有任何訊號送到 destination */
  function analyserPeak() {
    if (!analyserNode || !audioDataArray) return 0;
    analyserNode.getByteFrequencyData(audioDataArray);
    let peak = 0;
    for (let i = 0; i < audioDataArray.length; i++) if (audioDataArray[i] > peak) peak = audioDataArray[i];
    return peak;
  }

  /** 停止目前播放（淡出 20ms，避免 stop() 的喀噠爆音） */
  function stopSpeaking() {
    if (currentSource) {
      const src = currentSource, g = currentGain;
      src.onended = null;
      try {
        const t = audioCtx.currentTime;
        if (g) {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.linearRampToValueAtTime(0, t + 0.02);
        }
        src.stop(t + 0.03);
      } catch (e) { try { src.stop(); } catch (_) {} }
      setTimeout(() => { try { src.disconnect(); if (g) g.disconnect(); } catch (e) {} }, 80);
    }
    currentSource = null;
    currentGain = null;

    if (fallbackAudio) {
      try { fallbackAudio.onended = null; fallbackAudio.pause(); fallbackAudio.src = ''; } catch (e) {}
      fallbackAudio = null;
    }

    if (isSpeaking) {
      isSpeaking = false;
      speechGateUntil = performance.now() + ECHO_TAIL_MS;
      setAvatarEmotion(null);
    }
  }

  /** 播放後端回來的語音。turn 過期就不播。 */
  async function speak(audioUrl, turn) {
    stopSpeaking();
    const running = await unlockAudio();
    if (!running) {
      console.warn('[GlitchVoice] AudioContext 仍未 running:', audioCtx && audioCtx.state);
    }

    let buffer;
    try {
      buffer = await decodeAudio(await toArrayBuffer(audioUrl));
    } catch (e) {
      console.warn('[GlitchVoice] Web Audio 解碼失敗，改用 <audio>：', e);
      return speakViaElement(audioUrl, turn);
    }

    if (turn !== turnSeq || !isCalling) return;                 // 使用者已經講下一句了
    if (audioCtx.state !== 'running') { try { await audioCtx.resume(); } catch (e) {} }

    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    const g = audioCtx.createGain();
    src.connect(g);
    g.connect(masterGain);

    const t0 = audioCtx.currentTime;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(1, t0 + FADE_MS);

    currentSource = src;
    currentGain = g;
    isSpeaking = true;
    bargeReadyAt = performance.now() + BARGE_IN_GUARD_MS;
    speechGateUntil = performance.now() + buffer.duration * 1000 + ECHO_TAIL_MS;
    setAvatarEmotion('speaking');

    src.onended = () => {
      if (currentSource !== src) return;
      currentSource = null; currentGain = null;
      isSpeaking = false;
      speechGateUntil = performance.now() + ECHO_TAIL_MS;
      setAvatarEmotion(null);
      try { src.disconnect(); g.disconnect(); } catch (e) {}
    };

    // 先記下開播前的殘響底線：analyser 有平滑，上一段的尾巴要好幾秒才歸零，
    // 沒有底線的話「還在衰減的舊訊號」會被誤判成「這一段有聲音」。
    const baseline = analyserPeak();

    src.start();
    console.debug(`[GlitchVoice] 播放中 ${buffer.duration.toFixed(2)}s / ${buffer.sampleRate}Hz / ctx=${audioCtx.state} / gain=${masterGain.gain.value}`);

    // 真的有訊號進喇叭嗎？400ms 後量一次，沒有新增能量就是靜音，直接講出來別讓人猜
    setTimeout(() => {
      if (currentSource !== src) return;
      const peak = analyserPeak();
      if (peak <= baseline) {
        console.error(`[GlitchVoice] 音訊在跑但輸出沒有能量（peak=${peak} <= 開播前 ${baseline}），輸出被系統靜音或裝置選錯。ctx=${audioCtx.state}`);
        if (glitchSubtitle) glitchSubtitle.textContent += '（偵測不到喇叭輸出，檢查系統音量與輸出裝置）';
      } else {
        console.debug(`[GlitchVoice] 輸出電平正常 peak=${peak}（開播前 ${baseline}）`);
      }
    }, 400);
  }

  /** Web Audio 走不通時的退路（也涵蓋極舊瀏覽器） */
  async function speakViaElement(audioUrl, turn) {
    if (turn !== turnSeq || !isCalling) return;
    const el = new Audio();
    el.playsInline = true;
    el.preload = 'auto';
    el.volume = OUTPUT_GAIN;
    el.src = audioUrl;
    fallbackAudio = el;
    isSpeaking = true;
    bargeReadyAt = performance.now() + BARGE_IN_GUARD_MS;
    speechGateUntil = performance.now() + 30000;    // 不知道長度，先擋著，onended 再放行
    setAvatarEmotion('speaking');
    el.onended = el.onerror = () => {
      if (fallbackAudio !== el) return;
      fallbackAudio = null;
      isSpeaking = false;
      speechGateUntil = performance.now() + ECHO_TAIL_MS;
      setAvatarEmotion(null);
    };
    try {
      await el.play();
    } catch (e) {
      console.error('[GlitchVoice] <audio> 播放也失敗：', e);
      isSpeaking = false;
      speechGateUntil = 0;
      setAvatarEmotion('sad');
      if (glitchSubtitle) glitchSubtitle.textContent += `（播放被瀏覽器擋下：${e.name || e.message}）`;
    }
  }

  // ==========================================================================
  // 介面
  // ==========================================================================

  function init() {
    const screen = document.querySelector('.phone .screen');
    const header = document.querySelector('.phone .lh');
    if (!screen || !header) return;

    let callBtn = document.getElementById('btn-call-glitch');
    if (!callBtn) {
      callBtn = document.createElement('button');
      callBtn.id = 'btn-call-glitch';
      callBtn.className = 'ph-call-btn';
      callBtn.title = '與格莉奇語音通話';
      callBtn.setAttribute('aria-label', '語音通話');
      callBtn.textContent = '📞';
      header.insertBefore(callBtn, header.querySelector('.mi'));
    }
    callBtn.onclick = startCall;

    if (!document.getElementById('glitch-call-overlay')) {
      const el = document.createElement('div');
      el.id = 'glitch-call-overlay';
      el.className = 'call-overlay';
      el.hidden = true;
      el.innerHTML = `
        <div class="call-header">
          <div class="call-badge"><span class="pulse-dot"></span> <span id="call-status-text">連線中…</span></div>
          <div class="call-timer" id="call-timer-text">00:00</div>
          <button class="call-cfg-btn" id="call-cfg-btn" title="設定伺服器網址">⚙️</button>
        </div>

        <div class="call-body">
          <div class="call-avatar-wrap">
            <div class="call-avatar-glow"></div>
            <img id="call-avatar-img" class="call-avatar-img" src="images/avatar.webp" alt="格莉奇" onerror="this.onerror=null;this.src='images/sticker-01.png'">
          </div>

          <canvas id="call-wave-canvas" class="call-wave-canvas"></canvas>

          <div class="call-subtitles">
            <div class="sub user-sub" id="call-user-sub"></div>
            <div class="sub glitch-sub" id="call-glitch-sub">4KB 記憶體準備就緒，隨時可以開口或點擊快捷發話。</div>
          </div>

          <div class="call-chips" id="call-quick-chips">
            <button class="chip-btn" id="call-test-tone-btn" style="background:rgba(56,189,248,.2);border-color:#38bdf8;color:#38bdf8;font-weight:600">🔊 測喇叭</button>
            <button class="chip-btn" data-say="你好呀格莉奇！">👋 打招呼</button>
            <button class="chip-btn" data-say="你今天有喝黑洞拿鐵嗎？">☕ 喝拿鐵</button>
            <button class="chip-btn" data-say="你的記憶體真的只有4KB嗎？">💾 4KB記憶體</button>
            <button class="chip-btn" data-say="自我介紹一下吧！">👧 自介</button>
          </div>

          <div class="call-in-wrap">
            <input type="text" id="call-input-txt" class="call-in-txt" placeholder="文字亦可通話…" autocomplete="off">
            <button id="call-input-send" class="call-in-btn">送出</button>
          </div>
        </div>

        <div class="call-controls">
          <button class="ctrl-btn mic-btn" id="call-mic-btn" title="靜音/收音">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path fill="currentColor" d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
          </button>
          <button class="ctrl-btn hangup-btn" id="call-hangup-btn" title="結束通話">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.996.996 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.39.39.39 1.02 0 1.41l-2.48 2.48c-.18.18-.43.29-.71.29s-.52-.11-.7-.28c-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
          </button>
        </div>
      `;
      screen.appendChild(el);
    }

    // 快取放在 if 外面：即使 overlay 已經存在（熱重載、init 跑兩次）也要拿得到
    callOverlay = document.getElementById('glitch-call-overlay');
    callAvatar = document.getElementById('call-avatar-img');
    callStatus = document.getElementById('call-status-text');
    callTimer = document.getElementById('call-timer-text');
    userSubtitle = document.getElementById('call-user-sub');
    glitchSubtitle = document.getElementById('call-glitch-sub');
    waveCanvas = document.getElementById('call-wave-canvas');
    waveCtx = waveCanvas ? waveCanvas.getContext('2d') : null;
    micBtn = document.getElementById('call-mic-btn');
    hangupBtn = document.getElementById('call-hangup-btn');
    configBtn = document.getElementById('call-cfg-btn');

    hangupBtn.onclick = endCall;
    micBtn.onclick = toggleMute;
    configBtn.onclick = promptServerUrl;

    // 綁定快捷字卡與文字輸入送出
    const quickChips = document.getElementById('call-quick-chips');
    if (quickChips) {
      quickChips.querySelectorAll('.chip-btn[data-say]').forEach((btn) => {
        btn.onclick = () => {
          const txt = btn.getAttribute('data-say');
          if (txt) {
            userSubtitle.textContent = `你：「${txt}」`;
            sendToGlitch(txt);
          }
        };
      });
      const toneBtn = document.getElementById('call-test-tone-btn');
      if (toneBtn) toneBtn.onclick = testTone;
    }

    const inTxt = document.getElementById('call-input-txt');
    const inSend = document.getElementById('call-input-send');
    if (inTxt && inSend) {
      const doSend = () => {
        const val = inTxt.value.trim();
        if (val) {
          userSubtitle.textContent = `你：「${val}」`;
          inTxt.value = '';
          sendToGlitch(val);
        }
      };
      inSend.onclick = doSend;
      inTxt.onkeydown = (e) => { if (e.key === 'Enter') doSend(); };
    }

    settingInput = document.getElementById('setting-voice-server-url');
    settingSaveBtn = document.getElementById('btn-save-voice-url');
    settingStatusText = document.getElementById('voice-server-status');
    const settingTestToneBtn = document.getElementById('btn-test-voice-tone');

    if (settingTestToneBtn) settingTestToneBtn.onclick = testTone;

    if (settingInput && settingSaveBtn) {
      settingInput.value = serverUrl;
      settingSaveBtn.onclick = () => {
        const val = settingInput.value.trim().replace(/\/+$/, '');
        if (!val) return;
        serverUrl = val;
        localStorage.setItem('glitch_server_url', serverUrl);
        testServerHealth(serverUrl);
      };
      testServerHealth(serverUrl);
    }
  }

  /** AbortSignal.timeout 在 Safari 16 以前沒有，自己組一個 */
  function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { ctrl, promise: fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() => clearTimeout(timer)) };
  }

  function mixedContentWarning(url) {
    if (location.protocol !== 'https:') return '';
    if (/^https:/i.test(url)) return '';
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) return '';
    return '（這個頁面是 https，瀏覽器會擋掉 http 的後端，Tunnel 網址要用 https）';
  }

  async function testServerHealth(url) {
    if (!settingStatusText) return;
    settingStatusText.textContent = '正在連線檢測伺服器…';
    settingStatusText.style.color = '#38bdf8';
    try {
      const { promise } = fetchWithTimeout(`${url}/health`, {}, 5000);
      const res = await promise;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      settingStatusText.innerHTML = `<b>連線成功。</b>引擎：${d.tts_engine || 'F5-TTS'}｜角色：${d.character || '格莉奇'}｜記憶體：${d.memory || '4KB'}`;
      settingStatusText.style.color = '#2dd4bf';
    } catch (err) {
      const hint = err.name === 'AbortError' ? '逾時' : err.message;
      settingStatusText.innerHTML = `<b>連線失敗：</b>${hint}${mixedContentWarning(url)}`;
      settingStatusText.style.color = '#f43f5e';
    }
  }

  function promptServerUrl() {
    const input = prompt('請輸入 glitch-server 伺服器網址：', serverUrl);
    if (!input || !input.trim()) return;
    serverUrl = input.trim().replace(/\/+$/, '');
    localStorage.setItem('glitch_server_url', serverUrl);
    if (settingInput) settingInput.value = serverUrl;
    testServerHealth(serverUrl);
  }

  // ==========================================================================
  // 通話流程
  // ==========================================================================

  async function startCall() {
    if (isCalling) return;
    if (!callOverlay) init();
    isCalling = true;
    turnSeq++;

    callOverlay.hidden = false;
    callOverlay.classList.add('active');
    setAvatarEmotion(null);
    userSubtitle.textContent = '';
    glitchSubtitle.textContent = '連線中…';
    callStatus.textContent = '連線中…';

    // 必須在點擊手勢的同一個 task 裡「同步」建立 AudioContext，之後 await 才有效
    ensureAudioGraph();
    const running = await unlockAudio();
    console.debug('[GlitchVoice] 解鎖後 AudioContext state =', audioCtx.state);
    if (!running) callStatus.textContent = '音訊未解鎖，請再點一次';

    callStartTime = Date.now();
    updateTimer();
    callTimerInterval = setInterval(updateTimer, 1000);
    startVisualizer();

    try {
      const { promise } = fetchWithTimeout(`${serverUrl}/health`, {}, 6000);
      const res = await promise;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
      callStatus.textContent = '通話中 · 4KB 連線';
      glitchSubtitle.textContent = '連線成功，想聊什麼？';
    } catch (err) {
      callStatus.textContent = '連線異常';
      const hint = err.name === 'AbortError' ? '逾時' : err.message;
      glitchSubtitle.textContent = `無法連線到伺服器（${hint}）${mixedContentWarning(serverUrl)}，點右上角齒輪確認網址。`;
    }

    startRecognition();
  }

  function endCall() {
    if (!isCalling) return;
    isCalling = false;
    turnSeq++;                       // 讓所有在途回應失效

    if (inFlight) { try { inFlight.abort(); } catch (e) {} inFlight = null; }
    clearTimeout(pendingTimer);
    pendingText = '';

    stopSpeaking();
    stopRecognition();

    clearInterval(callTimerInterval);
    callTimerInterval = null;
    if (visualizerAnimFrame) { cancelAnimationFrame(visualizerAnimFrame); visualizerAnimFrame = null; }

    if (silentLoop) { try { silentLoop.pause(); } catch (e) {} }
    if (audioCtx && audioCtx.state === 'running') audioCtx.suspend().catch(() => {});

    callOverlay.classList.remove('active');
    callOverlay.hidden = true;
  }

  function toggleMute() {
    isMuted = !isMuted;
    micBtn.classList.toggle('muted', isMuted);
    if (isMuted) {
      callStatus.textContent = '麥克風已靜音';
      stopRecognition();
    } else {
      callStatus.textContent = '通話中 · 4KB 連線';
      startRecognition();            // 內部會先把舊的收乾淨，不會留殭屍
    }
  }

  function updateTimer() {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    callTimer.textContent =
      `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  }

  function setAvatarEmotion(cls) {
    if (!callAvatar) return;
    callAvatar.className = 'call-avatar-img' + (cls ? ' ' + cls : '');
  }

  // ==========================================================================
  // 語音辨識
  // ==========================================================================

  function stopRecognition() {
    recGen++;                        // 舊實例的 callback 從此全部作廢
    if (!rec) return;
    rec.onresult = null; rec.onend = null; rec.onerror = null;
    try { rec.abort(); } catch (e) { try { rec.stop(); } catch (_) {} }
    rec = null;
  }

  function startRecognition() {
    stopRecognition();
    if (!isCalling || isMuted) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      userSubtitle.textContent = '（這個瀏覽器不支援 Web Speech，請用 Chrome 或 Edge）';
      return;
    }

    const gen = ++recGen;
    const r = new SR();
    r.lang = 'zh-TW';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      if (gen !== recGen || !isCalling || isMuted) return;

      let interim = '', final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const item = event.results[i];
        if (item.isFinal) final += item[0].transcript; else interim += item[0].transcript;
      }
      const heard = (final || interim).trim();
      if (!heard) return;

      // 回音閘門：播放中（含殘響）聽到的東西，預設當成格莉奇自己的聲音丟掉
      if (isSpeaking || performance.now() < speechGateUntil) {
        if (!ALLOW_BARGE_IN) return;
        if (!final.trim() || final.trim().length < BARGE_IN_MIN_CHARS) return;
        if (performance.now() < bargeReadyAt) return;
        stopSpeaking();
      }

      userSubtitle.textContent = `你：「${heard}」`;
      if (final.trim()) queueUtterance(final.trim());
    };

    r.onerror = (e) => {
      console.debug('[GlitchVoice] 辨識錯誤：', e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        userSubtitle.textContent = '（麥克風權限被拒絕，請在網址列左邊放行）';
        isMuted = true;
        micBtn.classList.add('muted');
        stopRecognition();
      } else if (e.error === 'network') {
        userSubtitle.textContent = '（💡 提示：開源 Chromium 缺少 Google 語音辨識服務，請使用 Google Chrome / Edge，或使用下方輸入框／快捷發話！）';
      }
    };

    r.onend = () => {
      if (gen !== recGen || !isCalling || isMuted) return;   // 已被換掉的實例不重啟
      setTimeout(() => {
        if (gen !== recGen || !isCalling || isMuted) return;
        try { r.start(); } catch (e) { /* 已經在跑就忽略 */ }
      }, 250);
    };

    try {
      r.start();
      rec = r;
      console.debug('[GlitchVoice] 開始收音');
    } catch (e) {
      console.warn('[GlitchVoice] 收音啟動失敗：', e);
    }
  }

  /** 同一句話常被切成好幾個 final，先併起來再送，避免自己的請求互相作廢 */
  function queueUtterance(text) {
    pendingText += text;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      const t = pendingText.trim();
      pendingText = '';
      if (t) sendToGlitch(t);
    }, UTTERANCE_DEBOUNCE_MS);
  }

  // ==========================================================================
  // 後端
  // ==========================================================================

  async function sendToGlitch(userText) {
    const turn = ++turnSeq;
    if (inFlight) { try { inFlight.abort(); } catch (e) {} }

    stopSpeaking();
    setAvatarEmotion('count');
    glitchSubtitle.textContent = '思考中…';

    const chatHist = Array.isArray(window.chatHistory) ? window.chatHistory : [];
    const historyPayload = chatHist.slice(-6).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || ''
    }));

    try {
      const { ctrl, promise } = fetchWithTimeout(`${serverUrl}/api/glitch-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userText,
          history: historyPayload,
          request_id: String(turn),
          speed: 1.08,
          nfe: 12
        })
      }, REQUEST_TIMEOUT_MS);
      inFlight = ctrl;

      const res = await promise;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (turn !== turnSeq || !isCalling) {
        console.debug('[GlitchVoice] 回應已過期，丟棄');
        return;
      }

      const replyText = (data.reply_text || '').trim() || '（沒有收到回覆文字）';
      glitchSubtitle.textContent = replyText;
      setAvatarEmotion(EMOTION_CLASS[data.emotion] || '');

      if (Array.isArray(window.chatHistory)) {
        window.chatHistory.push({ role: 'user', content: userText, ts: Date.now() });
        window.chatHistory.push({ role: 'assistant', content: replyText, ts: Date.now() });
        if (typeof window.dbSet === 'function') window.dbSet('chat', window.chatHistory);
      }

      if (data.audio_url) {
        await speak(data.audio_url, turn);
      } else {
        console.warn('[GlitchVoice] 後端沒有回 audio_url');
        glitchSubtitle.textContent = replyText + '（後端沒有回音訊）';
      }
    } catch (err) {
      if (err.name === 'AbortError') return;        // 被下一輪取代，不是錯誤
      console.error('[GlitchVoice] 通話失敗：', err);
      if (turn === turnSeq && isCalling) {
        glitchSubtitle.textContent = `逼——嗶，無法連線到伺服器（${err.message}）`;
        setAvatarEmotion('sad');
      }
    } finally {
      if (turn === turnSeq) inFlight = null;
    }
  }

  // ==========================================================================
  // 波形
  // ==========================================================================

  function bar(x, y, w, h, r) {
    if (hasRoundRect) { waveCtx.beginPath(); waveCtx.roundRect(x, y, w, h, r); waveCtx.fill(); }
    else waveCtx.fillRect(x, y, w, h);       // Safari 16.4 以前沒有 roundRect，別讓整個迴圈 throw
  }

  function startVisualizer() {
    if (!waveCanvas || !waveCtx || visualizerAnimFrame) return;

    let phase = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function draw() {
      if (!isCalling) { visualizerAnimFrame = null; return; }

      const cssW = waveCanvas.offsetWidth, cssH = waveCanvas.offsetHeight;
      if (waveCanvas.width !== Math.round(cssW * dpr) || waveCanvas.height !== Math.round(cssH * dpr)) {
        waveCanvas.width = Math.round(cssW * dpr);          // 只在尺寸真的變了才重設，每幀重設會掉幀
        waveCanvas.height = Math.round(cssH * dpr);
        waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      waveCtx.clearRect(0, 0, cssW, cssH);

      const count = 18;
      const barWidth = cssW / (count * 2);

      if (isSpeaking && analyserNode) {
        analyserNode.getByteFrequencyData(audioDataArray);
        waveCtx.fillStyle = '#2dd4bf';
        for (let i = 0; i < count; i++) {
          const v = audioDataArray[Math.floor(i * audioDataArray.length / count)] / 255;
          const h = Math.max(6, v * cssH * 0.95);
          bar(i * barWidth * 2 + barWidth / 2, (cssH - h) / 2, barWidth, h, 4);
        }
      } else {
        // 待機動畫，純裝飾（沒有讀真的麥克風，那需要另一個 getUserMedia 權限）
        phase += 0.08;
        const amp = isMuted ? 0.05 : 0.35;
        waveCtx.fillStyle = '#38bdf8';
        for (let i = 0; i < count; i++) {
          const h = Math.max(4, Math.abs(Math.sin(phase + i * 0.4)) * cssH * 0.6 * amp);
          bar(i * barWidth * 2 + barWidth / 2, (cssH - h) / 2, barWidth, h, 4);
        }
      }

      visualizerAnimFrame = requestAnimationFrame(draw);
    }
    draw();
  }

  // ==========================================================================

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.GlitchCall = {
    start: startCall,
    end: endCall,
    testHealth: testServerHealth,
    setServerUrl: (url) => {
      serverUrl = String(url).replace(/\/+$/, '');
      localStorage.setItem('glitch_server_url', serverUrl);
      testServerHealth(serverUrl);
    },
    setVolume: (v) => { if (masterGain) masterGain.gain.value = Math.max(0, Math.min(2, v)); },
    /** 在 console 打 GlitchCall.diagnose() 就知道音訊卡在哪一段 */
    diagnose: () => {
      const info = {
        serverUrl,
        audioCtx: audioCtx ? audioCtx.state : '尚未建立',
        sampleRate: audioCtx ? audioCtx.sampleRate : null,
        masterGain: masterGain ? masterGain.gain.value : null,
        isCalling, isMuted, isSpeaking,
        turnSeq,
        bargeIn: ALLOW_BARGE_IN,
        recognition: rec ? '運作中' : '停止',
      };
      info.analyserPeak = analyserPeak();
      console.table(info);
      return info;
    },
    testTone: testTone
  };

  /** 不經過後端，直接播一聲 523Hz (C5) 確認喇叭這條路通不通 */
  async function testTone() {
    await unlockAudio();
    if (audioCtx && audioCtx.state !== 'running') { try { await audioCtx.resume(); } catch (e) {} }
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    g.gain.value = 0.35;
    osc.frequency.value = 523.25; // C5 音符
    osc.connect(g);
    g.connect(masterGain);
    const t0 = audioCtx.currentTime;
    osc.start(t0);
    g.gain.setValueAtTime(0.35, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
    osc.stop(t0 + 0.65);
    console.log('[GlitchVoice] 🔊 測試音已播放 (ctx state:', audioCtx ? audioCtx.state : 'null', ')');
    return `ctx=${audioCtx ? audioCtx.state : 'null'}, 應該聽到 0.6 秒嗶聲`;
  }

})();
