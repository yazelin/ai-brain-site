/* 直播頁的舞台：連上中繼收事件，套進 state.js 的歸約後重畫，聲音依序播。
   事件協定與 state 形狀見 state.js（從 glitch-vtuber 複製）。
   頂層只放純函式與常數，DOM 的部分在 startStage() 裡，node 測試才能直接 import。 */
import { applyEvent, emptyState, validateEvent } from './state.js';

export const DEFAULT_RELAY = 'ws://127.0.0.1:8787';
/* 公開站要連的正式中繼。還沒有，所以是 null：公開站不開任何連線，只顯示等待畫面。 */
export const PROD_RELAY = null;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/* 決定要連哪個中繼。公開站上的 ?relay= 一律不理（不然一條連結就能讓別人的中繼
   在格莉奇的頁面上冒用她的字幕與聲音），只用 PROD_RELAY；頁面開在本機時才看
   ?relay=，而且只放行本機的 ws:／wss:，其他退回 DEFAULT_RELAY。 */
export function resolveRelay(pageHref, relayParam) {
  let page;
  try { page = new URL(pageHref); } catch { return PROD_RELAY; }
  if (!LOCAL_HOSTS.has(page.hostname)) return PROD_RELAY;
  if (!relayParam) return DEFAULT_RELAY;
  try {
    const r = new URL(relayParam);
    if ((r.protocol === 'ws:' || r.protocol === 'wss:') && LOCAL_HOSTS.has(r.hostname)) return relayParam;
  } catch {}
  return DEFAULT_RELAY;
}
export const WAITING_TEXT = '格莉奇還沒開播';
/* 還沒有直播錄影。第一場會帶大家看這部，先連到 Larch 市集的作品頁；
   第一場錄影上了 YouTube 就換成錄影網址。 */
export const LAST_SHOW = Object.freeze({
  label: '她要帶大家看的作品：《格莉奇與黑洞先生》',
  url: 'https://larch.ink/play/market/a2a10427-7326-4a86-b806-c2476fc1c22a',
});

/* 把 state 換算成畫面要的資料。now 是 epoch 毫秒，用來算選項還剩幾秒。 */
export function viewModel(state, now) {
  const c = state.choices;
  let choices = null;
  if (c) {
    const counts = c.counts || {};
    const options = c.options.map((o) => ({ n: o.n, text: o.text, votes: Number(counts[o.n]) || 0 }));
    const total = options.reduce((sum, o) => sum + o.votes, 0);
    const secondsLeft = Number.isFinite(c.endsAt) ? Math.max(0, Math.ceil((c.endsAt - now) / 1000)) : null;
    choices = { id: c.id, options, total, secondsLeft };
  }
  return {
    waiting: !state.live,
    layout: state.layout || 'vn',
    vn: state.vn,
    choices,
    chat: state.chat || [],
    emote: state.emote ?? null,
  };
}

/* 背景圖只放行 http(s)、站內相對路徑與 data:image。 */
export function safeImageUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  if (/^data:image\//i.test(url)) return url;
  try {
    const u = new URL(url, 'https://example.invalid/');
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : null;
  } catch { return null; }
}

/* 作品區要不要顯示播放器的真實畫面：大腦宣告 screen on、連線還在、而且這次連線已經畫出一幀。
   任何一項不成立（大腦還沒開、擷取失敗、斷線重連中）就退回自己重畫背景、講者與台詞。 */
export function useRealScreen({ state, connected, hasFrame }) {
  return !!(connected && state && state.screen && hasFrame);
}

/* 收畫面幀：一次只畫一幀，畫的時候又來的幀只留最新一張，被蓋掉的立刻回 ack（丟舊幀，不排隊）。
   show(frame) 回 promise，畫完（或失敗）才回這幀的 ack，hub 收到 ack 才送下一幀，這樣頁面忙不過來時
   上游也會跟著少送。 */
export function createFrameSink({ show, ack }) {
  let busy = false;
  let pending = null;
  let dropped = 0;
  async function run(frame) {
    busy = true;
    try { await show(frame); } catch {}
    ack(frame.id);
    busy = false;
    if (pending) {
      const next = pending;
      pending = null;
      run(next);
    }
  }
  return {
    push(frame) {
      if (!busy) { run(frame); return; }
      if (pending) { dropped += 1; ack(pending.id); }
      pending = frame;
    },
    /* 斷線或 screen off：待畫的那幀不畫了 */
    reset() {
      if (pending) { ack(pending.id); pending = null; }
    },
    get busy() { return busy; },
    get pending() { return pending; },
    get dropped() { return dropped; },
  };
}

/* ───────────── 以下是瀏覽器端 ───────────── */

export function startStage({ doc = document, href = location.href, mountPet } = {}) {
  const params = new URL(href).searchParams;
  const $ = (id) => doc.getElementById(id);
  const root = doc.documentElement;
  const broadcast = params.get('broadcast') === '1';
  const relay = resolveRelay(href, params.get('relay'));
  root.classList.toggle('broadcast', broadcast);

  let state = emptyState();
  let connected = false;
  let socket = null;
  let hasFrame = false;            // 這次連線畫出過播放器畫面沒有
  let audioOn = broadcast;         // 錄影的 Chrome 開了 autoplay，觀眾要先按「進場」
  let pet = null;
  let wasLive = false;

  // ── 形象 ──
  const petBox = $('pet');
  // 直播頁一律用半身 bust 取景：右下角的格子只放頭到腰，裁切與放大交給 index.html 的 CSS。
  const petView = 'bust';
  if (mountPet) {
    mountPet($('pet-canvas'), { view: petView, onError: (e) => console.warn('直播頁：形象載入失敗', e) })
      .then((handle) => {
        if (!handle) return;
        pet = handle;
        window.petRig = handle;    // 主控台可以直接 petRig.gaze(-0.6, 0.2) 試
        handle.onemote = (id) => petBox.classList.toggle('glitching', id === 'error');
        handle.canvas.hidden = false;
        petBox.classList.add('rigged');
        if (state.emote) handle.emote(state.emote);
      })
      .catch((e) => console.warn('直播頁：形象載入失敗', e));
  }

  // ── 聲音：照收到的順序一則一則播；stop 全清 ──
  const queue = [];
  let generation = 0;
  let running = false;
  let current = null;              // 正在播的 <audio>
  let subtitleTimer = 0;

  const showSubtitle = (text) => {
    clearTimeout(subtitleTimer);
    $('subtitle-text').textContent = text;
    $('subtitle').classList.toggle('on', !!text);
  };
  const fadeSubtitle = (ms) => {
    clearTimeout(subtitleTimer);
    subtitleTimer = setTimeout(() => showSubtitle(''), ms);
  };

  const playPlain = (url, duration, gen) => new Promise((resolve) => {
    if (!url || !audioOn || gen !== generation) return resolve();
    const a = new Audio(url);
    current = a;
    const done = () => { clearTimeout(guard); if (current === a) current = null; resolve(); };
    const guard = setTimeout(() => { a.pause(); done(); }, (Number(duration) || 10) * 1000 + 4000);
    a.addEventListener('ended', done);
    a.addEventListener('error', done);
    a.addEventListener('pause', done);
    a.play().catch(done);
  });

  // say 走 pet.speak() 才有嘴型。handle 沒有「播完」的 promise，用 onvoice 等它停。
  const playSay = (url, duration, gen) => {
    if (!pet) return playPlain(url, duration, gen);
    if (!url || !audioOn || gen !== generation) return Promise.resolve();
    return new Promise((resolve) => {
      let started = false;
      const done = () => { clearTimeout(guard); pet.onvoice = null; resolve(); };
      const guard = setTimeout(() => { pet.stopSpeaking(); done(); }, (Number(duration) || 10) * 1000 + 4000);
      pet.onvoice = (s) => {
        if (s === 'playing') started = true;
        else if (started || s === 'error') done();
      };
      pet.speak(url).catch(done);
    });
  };

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const gen = generation;
      const job = queue.shift();
      if (job.type === 'say') {
        showSubtitle(job.text);
        if (pet) {
          pet.emote(job.emote ?? null);
          // 大腦送的 gaze 是 {x, y}；亞澤的回覆不帶 gaze，就看鏡頭。
          if (job.gaze && Number.isFinite(job.gaze.x)) pet.gaze(job.gaze.x, job.gaze.y);
          else pet.gaze(0, 0);
        }
        await playSay(job.audio, job.duration, gen);
        if (gen === generation) fadeSubtitle(audioOn && job.audio ? 1500 : Math.max(1500, (job.duration || 3) * 1000));
      } else {
        await playPlain(job.audio, job.duration, gen);
      }
    }
    running = false;
  }

  function stopAll() {
    generation++;
    queue.length = 0;
    if (current) { current.pause(); current = null; }
    if (pet) pet.stopSpeaking();
    showSubtitle('');
  }

  // ── 播放器的真實畫面：先在畫面外解碼，再一次畫到 canvas，換幀不會閃 ──
  const screenCanvas = $('vn-screen');
  const screenCtx = screenCanvas && screenCanvas.getContext('2d');
  const sink = createFrameSink({
    async show(f) {
      if (!state.screen || !screenCtx) return;
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + f.data;
      await img.decode();
      if (!state.screen) return;   // 解碼途中畫面被關掉
      if (screenCanvas.width !== f.w || screenCanvas.height !== f.h) {
        screenCanvas.width = f.w;
        screenCanvas.height = f.h;
      }
      screenCtx.drawImage(img, 0, 0, f.w, f.h);
      if (!hasFrame) { hasFrame = true; render(); }
    },
    ack: (id) => ackFrame(id),
  });
  function ackFrame(id) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: 'frame_ack', id }));
  }
  const dropScreen = () => {
    sink.reset();
    hasFrame = false;
  };

  // ── 畫面 ──
  let countdown = 0;
  function render() {
    const v = viewModel(state, Date.now());
    root.dataset.layout = v.layout;
    root.classList.toggle('real-screen', useRealScreen({ state, connected, hasFrame }));
    root.classList.toggle('waiting', v.waiting);
    $('waiting').hidden = !v.waiting;

    const vn = v.vn;
    const bg = safeImageUrl(vn && vn.bg);
    $('vn-bg').style.backgroundImage = bg ? `url(${JSON.stringify(bg)})` : '';
    $('vn-bg').classList.toggle('empty', !bg);
    $('vn-box').hidden = !vn;
    $('vn-speaker').textContent = vn && vn.speaker ? vn.speaker : '';
    $('vn-speaker').hidden = !(vn && vn.speaker);
    $('vn-box').classList.toggle('narration', !!vn && !vn.speaker);
    $('vn-text').textContent = vn ? vn.text : '';

    const box = $('choices');
    box.hidden = !v.choices;
    clearInterval(countdown);
    if (v.choices) {
      const list = $('choice-list');
      list.replaceChildren(...v.choices.options.map((o) => {
        const li = doc.createElement('li');
        const share = v.choices.total ? o.votes / v.choices.total : 0;
        li.style.setProperty('--share', String(share));
        const n = doc.createElement('b'); n.className = 'n'; n.textContent = String(o.n);
        const t = doc.createElement('span'); t.className = 't'; t.textContent = o.text;
        const c = doc.createElement('span'); c.className = 'c'; c.textContent = `${o.votes} 票`;
        li.append(n, t, c);
        return li;
      }));
      const tick = () => {
        const left = viewModel(state, Date.now()).choices?.secondsLeft;
        $('choice-timer').textContent = left == null ? '' : left > 0 ? `剩 ${left} 秒` : '投票結束';
      };
      tick();
      countdown = setInterval(tick, 500);
    }

    const chat = $('chat-list');
    // 最新的在最上面：格莉奇的頭蓋在留言框下段，被蓋住的是最舊的留言（亞澤 11-27）。
    chat.replaceChildren(...[...v.chat].reverse().map((m) => {
      const li = doc.createElement('li');
      const a = doc.createElement('b'); a.textContent = m.author;
      const t = doc.createElement('span'); t.textContent = m.text;
      li.append(a, t);
      return li;
    }));
    chat.scrollTop = 0;
    $('chat-empty').hidden = v.chat.length > 0;
  }

  function handle(ev) {
    if (!validateEvent(ev).ok) return console.warn('直播頁：略過看不懂的事件', ev);
    if (ev.type === 'vn_frame') {
      // 幀不進 state、也不用整頁重畫；screen 還沒開（或已經關掉）時直接回 ack 丟掉
      if (state.screen) sink.push(ev); else ackFrame(ev.id);
      return;
    }
    state = applyEvent(state, ev);
    if (!state.screen) dropScreen();
    switch (ev.type) {
      case 'snapshot':
        // 剛連上或重連：畫面照快照，不補播之前的聲音。
        if (pet) pet.emote(state.emote ?? null);
        break;
      case 'say':
        queue.push({ type: 'say', text: ev.text, audio: ev.audio || null, duration: ev.duration, emote: ev.emote, gaze: ev.gaze });
        pump();
        break;
      case 'vn_line':
      case 'owner_audio':
        if (ev.audio) { queue.push({ type: ev.type, audio: ev.audio, duration: ev.duration }); pump(); }
        break;
      case 'stop':
        stopAll();
        break;
    }
    if (state.live && !wasLive && pet) pet.wave();
    wasLive = state.live;
    render();
  }

  // ── 連線：斷了就退避重連，重連時中繼會先送快照 ──
  let delay = 1000;
  const setConn = (s) => {
    $('conn').dataset.state = s;
    const host = relay ? new URL(relay).host : '';
    $('conn').textContent = { connecting: '連線中', open: `已連上 ${host}`, retry: '重新連線中', off: '沒有連線' }[s];
  };
  function connect() {
    setConn(delay > 1000 ? 'retry' : 'connecting');
    let ws;
    try { ws = new WebSocket(relay); } catch { return retry(); }
    socket = ws;
    ws.onopen = () => { delay = 1000; connected = true; setConn('open'); };
    ws.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      handle(ev);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      connected = false;
      dropScreen();
      render();
      retry();
    };
  }
  function retry() {
    setConn('retry');
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 15000);
  }

  // ── 進場 ──
  const gate = $('gate');
  gate.hidden = broadcast;
  $('enter').addEventListener('click', () => {
    audioOn = true;
    gate.hidden = true;
  });

  render();
  // 沒有中繼可連（公開站、正式中繼還沒上）就不開連線，停在等待畫面。
  if (relay) connect(); else setConn('off');
  return { get state() { return state; }, handle, stopAll };
}
