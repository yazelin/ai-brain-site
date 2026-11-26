/* 直播頁的舞台：連上中繼收事件，套進 state.js 的歸約後重畫，聲音依序播。
   事件協定與 state 形狀見 state.js（從 glitch-vtuber 複製）。
   頂層只放純函式與常數，DOM 的部分在 startStage() 裡，node 測試才能直接 import。 */
import { applyEvent, emptyState, validateEvent } from './state.js';

export const DEFAULT_RELAY = 'ws://127.0.0.1:8787';
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

/* ───────────── 以下是瀏覽器端 ───────────── */

export function startStage({ doc = document, params = new URLSearchParams(location.search), mountPet } = {}) {
  const $ = (id) => doc.getElementById(id);
  const root = doc.documentElement;
  const broadcast = params.get('broadcast') === '1';
  const relay = params.get('relay') || DEFAULT_RELAY;
  root.classList.toggle('broadcast', broadcast);

  let state = emptyState();
  let audioOn = broadcast;         // 錄影的 Chrome 開了 autoplay，觀眾要先按「進場」
  let pet = null;
  let wasLive = false;

  // ── 形象 ──
  const petBox = $('pet');
  // 寬版放全身，手機格子矮就放半身；跟 index.html 的 @media (max-width:760px) 同一條線。
  const narrow = broadcast ? null : matchMedia('(max-width:760px)');
  const petView = () => (narrow && narrow.matches ? 'bust' : 'full');
  if (mountPet) {
    mountPet($('pet-canvas'), { view: petView(), onError: (e) => console.warn('直播頁：形象載入失敗', e) })
      .then((handle) => {
        if (!handle) return;
        pet = handle;
        window.petRig = handle;    // 主控台可以直接 petRig.gaze(-0.6, 0.2) 試
        handle.onemote = (id) => petBox.classList.toggle('glitching', id === 'error');
        handle.canvas.hidden = false;
        petBox.classList.add('rigged');
        narrow?.addEventListener('change', () => handle.setView(petView()));
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

  // ── 畫面 ──
  let countdown = 0;
  function render() {
    const v = viewModel(state, Date.now());
    root.dataset.layout = v.layout;
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
    chat.replaceChildren(...v.chat.map((m) => {
      const li = doc.createElement('li');
      const a = doc.createElement('b'); a.textContent = m.author;
      const t = doc.createElement('span'); t.textContent = m.text;
      li.append(a, t);
      return li;
    }));
    chat.scrollTop = chat.scrollHeight;
    $('chat-empty').hidden = v.chat.length > 0;
  }

  function handle(ev) {
    if (!validateEvent(ev).ok) return console.warn('直播頁：略過看不懂的事件', ev);
    state = applyEvent(state, ev);
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
    $('conn').textContent = { connecting: '連線中', open: '已連上', retry: '重新連線中' }[s];
  };
  function connect() {
    setConn(delay > 1000 ? 'retry' : 'connecting');
    let ws;
    try { ws = new WebSocket(relay); } catch { return retry(); }
    ws.onopen = () => { delay = 1000; setConn('open'); };
    ws.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      handle(ev);
    };
    ws.onclose = () => retry();
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
  connect();
  return { get state() { return state; }, handle, stopAll };
}
