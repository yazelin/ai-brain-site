/**
 * 格莉奇全雙工語音通話模組 (Glitch Voice Call & Barge-In Engine)
 * 支援：WebSpeech 多層收音、F5-TTS 聲學連動、Barge-In 即時插話打斷、表情切換、設定介面連動
 */

(function () {
  'use strict';

  // 預設後端伺服器端點 (優先讀取 localStorage，次選 Cloudflare Tunnel，備選 Localhost)
  const FALLBACK_TUNNEL_URL = 'https://preserve-collective-reproduced-florist.trycloudflare.com';
  let serverUrl = localStorage.getItem('glitch_server_url') || FALLBACK_TUNNEL_URL;

  // 狀態變數
  let isCalling = false;
  let isMuted = false;
  let callStartTime = 0;
  let callTimerInterval = null;
  let currentAudio = null;
  let currentRequestId = 0;
  let speechRecognition = null;
  let isSpeaking = false;
  let visualizerAnimFrame = null;
  let audioContext = null;

  // DOM 元素快取
  let callOverlay, callAvatar, callStatus, callTimer, userSubtitle, glitchSubtitle;
  let waveCanvas, waveCtx, micBtn, hangupBtn, configBtn;
  let settingInput, settingSaveBtn, settingStatusText;

  // 表情對應
  const EMOTIONS = {
    neutral: 'images/pet-plain.webp',
    laugh: 'images/pet-happy.webp',
    sad: 'images/pet-error.webp',
    count: 'images/pet-thinking.webp',
  };

  /**
   * 初始化通話介面與事件綁定
   */
  function init() {
    const screen = document.querySelector('.phone .screen');
    const header = document.querySelector('.phone .lh');
    if (!screen || !header) return;

    // 1. 綁定聊天視窗頂部的 📞 通話按鈕
    let callBtn = document.getElementById('btn-call-glitch');
    if (!callBtn) {
      callBtn = document.createElement('button');
      callBtn.id = 'btn-call-glitch';
      callBtn.className = 'ph-call-btn';
      callBtn.title = '與格莉奇語音通話';
      callBtn.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor">
          <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-2.2 2.2a15.053 15.053 0 0 1-6.59-6.59l2.2-2.21a.96.96 0 0 0 .25-1.01A11.36 11.36 0 0 1 8.57 3.9c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1 0 9.39 7.61 17 17 17 .55 0 1-.45 1-1v-3.52c0-.55-.45-1-.99-1z"/>
        </svg>
      `;
      header.insertBefore(callBtn, header.querySelector('.mi'));
    }
    callBtn.onclick = startCall;

    // 2. 建立通話全螢幕 Overlay (覆蓋在手機容器內部)
    if (!document.getElementById('glitch-call-overlay')) {
      callOverlay = document.createElement('div');
      callOverlay.id = 'glitch-call-overlay';
      callOverlay.className = 'call-overlay';
      callOverlay.hidden = true;
      callOverlay.innerHTML = `
        <div class="call-header">
          <div class="call-badge"><span class="pulse-dot"></span> <span id="call-status-text">連線中…</span></div>
          <div class="call-timer" id="call-timer-text">00:00</div>
          <button class="call-cfg-btn" id="call-cfg-btn" title="設定伺服器網址">⚙️</button>
        </div>

        <div class="call-body">
          <div class="call-avatar-wrap">
            <div class="call-avatar-glow"></div>
            <img id="call-avatar-img" class="call-avatar-img" src="images/pet-plain.webp" alt="格莉奇">
          </div>

          <canvas id="call-wave-canvas" class="call-wave-canvas"></canvas>

          <div class="call-subtitles">
            <div class="sub user-sub" id="call-user-sub"></div>
            <div class="sub glitch-sub" id="call-glitch-sub">4KB 記憶體準備就緒！隨時可以開口喔～</div>
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
      screen.appendChild(callOverlay);

      // 快取元素
      callAvatar = document.getElementById('call-avatar-img');
      callStatus = document.getElementById('call-status-text');
      callTimer = document.getElementById('call-timer-text');
      userSubtitle = document.getElementById('call-user-sub');
      glitchSubtitle = document.getElementById('call-glitch-sub');
      waveCanvas = document.getElementById('call-wave-canvas');
      waveCtx = waveCanvas.getContext('2d');
      micBtn = document.getElementById('call-mic-btn');
      hangupBtn = document.getElementById('call-hangup-btn');
      configBtn = document.getElementById('call-cfg-btn');

      // 監聽控制按鈕
      hangupBtn.addEventListener('click', endCall);
      micBtn.addEventListener('click', toggleMute);
      configBtn.addEventListener('click', promptServerUrl);
    }

    // 3. 綁定「設定」視窗內的語音伺服器設定卡片
    settingInput = document.getElementById('setting-voice-server-url');
    settingSaveBtn = document.getElementById('btn-save-voice-url');
    settingStatusText = document.getElementById('voice-server-status');

    if (settingInput && settingSaveBtn) {
      settingInput.value = serverUrl;
      settingSaveBtn.addEventListener('click', async () => {
        const val = settingInput.value.trim().replace(/\/+$/, '');
        if (val) {
          serverUrl = val;
          localStorage.setItem('glitch_server_url', serverUrl);
          await testServerHealth(serverUrl);
        }
      });
      // 頁面載入時自動做一次健康檢查
      testServerHealth(serverUrl);
    }
  }

  /**
   * 測試語音伺服器健康狀態
   */
  async function testServerHealth(url) {
    if (!settingStatusText) return;
    settingStatusText.innerHTML = '⏳ 正在連線檢測伺服器…';
    settingStatusText.style.color = '#38bdf8';
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      settingStatusText.innerHTML = `✅ <b>連線成功！</b> 引擎：${d.tts_engine || 'F5-TTS'} ｜ 角色：${d.character || '格莉奇'} ｜ 記憶體：${d.memory || '4KB'}`;
      settingStatusText.style.color = '#2dd4bf';
    } catch (err) {
      settingStatusText.innerHTML = `❌ <b>連線失敗：</b>${err.message}（請確認 glitch-server 與 Cloudflare Tunnel 是否啟動）`;
      settingStatusText.style.color = '#f43f5e';
    }
  }

  /**
   * 快速設定伺服器端點
   */
  function promptServerUrl() {
    const input = prompt('請輸入 glitch-server 伺服器網址（例如 Cloudflare Tunnel 的 https://*.trycloudflare.com）：', serverUrl);
    if (input && input.trim()) {
      serverUrl = input.trim().replace(/\/+$/, '');
      localStorage.setItem('glitch_server_url', serverUrl);
      if (settingInput) settingInput.value = serverUrl;
      testServerHealth(serverUrl);
      alert(`伺服器網址已更新為：\n${serverUrl}`);
    }
  }

  /**
   * 開始語音通話
   */
  async function startCall() {
    if (isCalling) return;
    isCalling = true;
    currentRequestId = Date.now();
    callOverlay.hidden = false;
    callOverlay.classList.add('active');
    setAvatarEmotion('neutral');
    userSubtitle.textContent = '';
    glitchSubtitle.textContent = '連線中… 正在呼叫格莉奇…';
    callStatus.textContent = '連線中…';

    // 解鎖 Web AudioContext
    try {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
    } catch (e) {
      console.debug('[GlitchVoice] AudioContext unlock:', e);
    }

    // 啟動通話計時器
    callStartTime = Date.now();
    updateTimer();
    callTimerInterval = setInterval(updateTimer, 1000);

    // 啟動波形視覺化
    startVisualizer();

    // 檢查後端健康狀態
    try {
      const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      callStatus.textContent = '通話中 · 4KB 連線';
      glitchSubtitle.textContent = '好耶！連線成功！想和我聊什麼呢？';
    } catch (err) {
      callStatus.textContent = '連線異常';
      glitchSubtitle.textContent = `無法連線到伺服器 (${err.message})，請點 ⚙️ 確認 Tunnel 網址。`;
    }

    // 啟動語音辨識 (全雙工收音)
    initSpeechRecognition();
  }

  /**
   * 結束通話
   */
  function endCall() {
    if (!isCalling) return;
    isCalling = false;
    currentRequestId = Date.now();

    // 停止音訊與打斷
    bargeInInterrupt();

    // 停止語音收音
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch (e) {}
      speechRecognition = null;
    }

    // 停止計時與動畫
    clearInterval(callTimerInterval);
    if (visualizerAnimFrame) cancelAnimationFrame(visualizerAnimFrame);

    callOverlay.classList.remove('active');
    callOverlay.hidden = true;
  }

  /**
   * 靜音切換
   */
  function toggleMute() {
    isMuted = !isMuted;
    micBtn.classList.toggle('muted', isMuted);
    if (isMuted) {
      callStatus.textContent = '麥克風已靜音';
      if (speechRecognition) {
        try { speechRecognition.stop(); } catch (e) {}
      }
    } else {
      callStatus.textContent = '通話中 · 4KB 連線';
      initSpeechRecognition();
    }
  }

  /**
   * 更新通話時間
   */
  function updateTimer() {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    callTimer.textContent = `${mm}:${ss}`;
  }

  /**
   * 切換格莉奇立繪表情
   */
  function setAvatarEmotion(emotion) {
    const src = EMOTIONS[emotion] || EMOTIONS.neutral;
    callAvatar.src = src;
  }

  /**
   * 全雙工即時插話打斷 (Barge-In Interrupt)
   */
  function bargeInInterrupt() {
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      } catch (e) {}
      currentAudio = null;
    }
    isSpeaking = false;
    setAvatarEmotion('neutral');
  }

  /**
   * 初始化語音辨識（Web Speech API 優先）
   */
  function initSpeechRecognition() {
    if (isMuted || !isCalling) return;

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      userSubtitle.textContent = '（瀏覽器不支援 Web Speech，請使用 Chrome/Edge）';
      return;
    }

    const rec = new SpeechRec();
    rec.lang = 'zh-TW';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      if (!isCalling || isMuted) return;

      let interim = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const item = event.results[i];
        if (item.isFinal) {
          finalTranscript += item[0].transcript;
        } else {
          interim += item[0].transcript;
        }
      }

      // 當使用者開口講話時，立即觸發「即時插話打斷」
      if (interim || finalTranscript) {
        if (isSpeaking) {
          bargeInInterrupt();
        }
        userSubtitle.textContent = `👤 你：「${interim || finalTranscript}」`;
      }

      // 一旦收到完整最終斷句，發送給格莉奇後端
      if (finalTranscript.trim()) {
        const textToSend = finalTranscript.trim();
        console.debug('[GlitchVoice] Final speech transcript:', textToSend);
        userSubtitle.textContent = `👤 你：「${textToSend}」`;
        sendToGlitch(textToSend);
      }
    };

    rec.onerror = (e) => {
      console.debug('[GlitchVoice] Speech onerror:', e.error);
    };

    rec.onend = () => {
      // 若仍在通話中且未靜音，自動維持收音循環
      if (isCalling && !isMuted) {
        setTimeout(() => {
          if (isCalling && !isMuted) {
            try { rec.start(); } catch (e) {}
          }
        }, 150);
      }
    };

    try {
      rec.start();
      speechRecognition = rec;
      console.debug('[GlitchVoice] Speech recognition listening...');
    } catch (e) {
      console.debug('[GlitchVoice] Start recognition failed:', e);
    }
  }

  /**
   * 發送文字至格莉奇後端，並取得 F5-TTS 語音回應
   */
  async function sendToGlitch(userText) {
    const reqId = ++currentRequestId;
    setAvatarEmotion('count');
    glitchSubtitle.textContent = '思考中（4KB 記憶體運算中…）';

    // 安全取得最近 6 輪聊天紀錄
    const chatHist = Array.isArray(window.chatHistory) ? window.chatHistory : [];
    const historyPayload = chatHist.slice(-6).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || ''
    }));

    console.debug('[GlitchVoice] Sending prompt to glitch-server:', { userText, historyPayload, serverUrl });

    try {
      const res = await fetch(`${serverUrl}/api/glitch-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userText,
          history: historyPayload,
          request_id: String(reqId),
          speed: 1.05,
          nfe: 16
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.debug('[GlitchVoice] Received server response:', data);

      // 如果在此期間使用者又插話了（RequestId 已過期），直接捨棄此回應
      if (reqId !== currentRequestId || !isCalling) {
        console.debug('[GlitchVoice] 請求已過期 (Barge-in)，捨棄舊音訊');
        return;
      }

      // 顯示字幕與切換表情
      glitchSubtitle.textContent = data.reply_text;
      setAvatarEmotion(data.emotion || 'laugh');

      // 同步寫入全域聊天歷史
      if (Array.isArray(window.chatHistory) && typeof window.dbSet === 'function') {
        window.chatHistory.push({ role: 'user', content: userText, ts: Date.now() });
        window.chatHistory.push({ role: 'assistant', content: data.reply_text, ts: Date.now() });
        window.dbSet('chat', window.chatHistory);
      }

      // 播放 F5-TTS 音訊
      if (data.audio_url) {
        playGlitchAudio(data.audio_url, reqId);
      }
    } catch (err) {
      console.error('[GlitchVoice] Call error:', err);
      if (reqId === currentRequestId && isCalling) {
        glitchSubtitle.textContent = `逼——嗶！無法連線到伺服器（${err.message}）`;
        setAvatarEmotion('sad');
      }
    }
  }

  /**
   * 播放語音與結束回調
   */
  function playGlitchAudio(audioUrl, reqId) {
    bargeInInterrupt();
    console.debug('[GlitchVoice] Playing audio for request:', reqId);
    const audio = new Audio(audioUrl);
    currentAudio = audio;
    isSpeaking = true;

    audio.onended = () => {
      if (reqId === currentRequestId) {
        isSpeaking = false;
        currentAudio = null;
        setAvatarEmotion('neutral');
      }
    };

    audio.onerror = (e) => {
      console.error('[GlitchVoice] Audio playback error:', e);
      isSpeaking = false;
      currentAudio = null;
      setAvatarEmotion('neutral');
    };

    audio.play().then(() => {
      console.debug('[GlitchVoice] Audio playback started successfully!');
    }).catch(e => {
      console.warn('[GlitchVoice] Autoplay blocked or interrupted:', e);
      isSpeaking = false;
    });
  }

  /**
   * 繪製音波動畫
   */
  function startVisualizer() {
    if (!waveCanvas || !waveCtx) return;

    let phase = 0;
    function draw() {
      if (!isCalling) return;

      const w = waveCanvas.width = waveCanvas.offsetWidth;
      const h = waveCanvas.height = waveCanvas.offsetHeight;
      waveCtx.clearRect(0, 0, w, h);

      const count = 16;
      const barWidth = w / (count * 2);
      const active = isSpeaking || (!isMuted && isCalling);
      const amp = isSpeaking ? 1.0 : (isMuted ? 0.05 : 0.4);

      phase += 0.08;
      for (let i = 0; i < count; i++) {
        const x = i * (barWidth * 2) + barWidth / 2;
        const norm = Math.sin(phase + i * 0.4);
        const barHeight = Math.max(4, Math.abs(norm) * (h * 0.7) * amp);

        waveCtx.fillStyle = isSpeaking ? '#2dd4bf' : '#38bdf8';
        waveCtx.beginPath();
        waveCtx.roundRect(x, (h - barHeight) / 2, barWidth, barHeight, 4);
        waveCtx.fill();
      }

      visualizerAnimFrame = requestAnimationFrame(draw);
    }
    draw();
  }

  // 當 DOM Ready 時初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 匯出到 window 方便外部呼叫
  window.GlitchCall = {
    start: startCall,
    end: endCall,
    testHealth: testServerHealth,
    setServerUrl: (url) => {
      serverUrl = url;
      localStorage.setItem('glitch_server_url', url);
      testServerHealth(url);
    }
  };

})();
