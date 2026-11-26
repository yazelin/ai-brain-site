/* 「格莉奇工作中」App：畫面與輪詢。
   資料怎麼抓、怎麼整理在 glitch-at-work-data.js（純函式，有單元測試）。
   這裡的規矩：外來文字一律當文字放進去（h() 只用 textContent／文字節點），
   不准用 innerHTML 帶資料。視窗開著才每 60 秒重抓，關掉就停。 */
import {
  TOKEN_NAME, REFRESH_MS, STATES, WORK_STATES, HEALTH,
  fixtureFrom, loadStatus, login, revoke, parseStoredToken, battery, relTime, clockText, weekBars, stepProgress, memoryShares,
} from './glitch-at-work-data.js';

const win = document.getElementById('w-work');
const root = document.getElementById('gaw-root');
if (win && root) init();

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
const svgUse = (id, cls = 'ic') => {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(ns, 'use');
  u.setAttribute('href', `#${id}`);
  s.append(u);
  return s;
};
const fetchImpl = (u, o) => fetch(u, o);
/* 已經發生的事：主機時鐘比這台快一點時不要寫成「2 分鐘後」 */
const ago = (when) => {
  const t = Date.parse(when);
  return Number.isNaN(t) ? '' : relTime(new Date(Math.min(t, Date.now())).toISOString());
};
const KINDS = { reply: '回覆', play: '試玩', dm: '私訊', vote: '投票', draw: '畫圖', friend: '加好友', explore: '逛作品' };
const link = (href, text, cls = 'gaw-link') => h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, text, h('span', { class: 'gaw-ext', 'aria-hidden': 'true', text: '↗' }));

/* 本機只記通行證 {token, expiresAt}；密碼只在送出那一下用，不存任何地方 */
function readToken() {
  try { return parseStoredToken(localStorage.getItem(TOKEN_NAME)); } catch (_) { return null; }
}
function writeToken(v) {
  try {
    if (v) localStorage.setItem(TOKEN_NAME, JSON.stringify({ token: v.token, expiresAt: v.expiresAt }));
    else localStorage.removeItem(TOKEN_NAME);
    return true;
  } catch (_) { return false; }
}

function init() {
  const fixture = fixtureFrom(location.search);
  const st = { result: null, lastOkAt: 0, stale: false, loading: false, gen: 0, timer: 0, keyOpen: false, keyMsg: '', keyErr: false, signingIn: false };

  async function refresh() {
    if (st.loading) return;
    st.loading = true;
    const gen = st.gen;
    paintBusy(true);
    let r;
    try {
      r = await loadStatus({ fetchImpl, fixture, token: readToken()?.token || '' });
    } catch (_) {
      r = { data: null, problem: 'unreachable', notice: null, mode: null };
    }
    st.loading = false;
    if (r.dropToken) writeToken(null); // 通行證被拒：本機清掉，回到未登入
    if (gen !== st.gen) return; // 抓到一半視窗被關了，結果丟掉
    if (r.data) {
      st.result = r; st.lastOkAt = Date.now(); st.stale = false;
    } else if (st.result?.data) {
      // 這次失敗但手上有舊資料：繼續顯示舊的，標成「沒連上」
      st.stale = true; st.result = { ...st.result, notice: r.notice ?? st.result.notice };
    } else {
      st.result = r;
    }
    render();
  }

  function start() {
    stop();
    st.gen += 1;
    render();
    refresh();
    st.timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }
  function stop() {
    clearInterval(st.timer); st.timer = 0; st.gen += 1; st.loading = false;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && st.timer && Date.now() - st.lastOkAt > REFRESH_MS) refresh();
  });
  // 所有關窗路徑（紅點、手機返回、開別的 App）最後都是拿掉 .open，所以盯 class 就好
  let wasOpen = win.classList.contains('open');
  new MutationObserver(() => {
    const isOpen = win.classList.contains('open');
    if (isOpen === wasOpen) return;
    wasOpen = isOpen;
    if (isOpen) start(); else stop();
  }).observe(win, { attributes: true, attributeFilter: ['class'] });
  if (wasOpen) start();
  window.glitchAtWork = { refresh, get polling() { return !!st.timer; } };

  function paintBusy(on) {
    const b = root.querySelector('.gaw-refresh');
    if (b) { b.disabled = on; b.classList.toggle('busy', on); }
  }

  /* ---------- 工具列與主人模式 ---------- */
  function toolbar(r) {
    const tok = readToken();
    let src = '讀取中';
    if (fixture) src = `範例資料（${fixture}）`;
    else if (r?.mode === 'full') src = '完整版 · 主人模式';
    else if (r?.mode === 'public') src = '公開版';
    else if (r?.problem) src = '沒有資料';
    const when = st.lastOkAt ? `更新於 ${clockText(new Date(st.lastOkAt).toISOString())}` : '';
    return h('div', { class: 'gaw-bar' },
      h('span', { class: `gaw-src ${r?.mode === 'full' ? 'full' : ''}` }, svgUse(r?.mode === 'full' ? 'i-key' : 'i-activity'), src),
      h('span', { class: 'gaw-when', text: when }),
      h('span', { class: 'gaw-sp' }),
      h('button', { class: 'gaw-btn gaw-refresh', type: 'button', 'aria-label': '重新整理', title: '重新整理（每 60 秒也會自己更新）', onclick: () => refresh(), disabled: st.loading }, svgUse('i-refresh'), h('span', { class: 'gaw-btn-t', text: '更新' })),
      h('button', {
        class: `gaw-btn gaw-keybtn ${tok ? 'on' : ''}`, type: 'button', 'aria-expanded': String(st.keyOpen), 'aria-controls': 'gaw-keypanel',
        'aria-label': tok ? '主人模式（已登入）' : '主人登入', onclick: () => { st.keyOpen = !st.keyOpen; st.keyMsg = ''; render(); },
      }, svgUse('i-key'), h('span', { class: 'gaw-btn-t', text: tok ? '主人模式' : '主人登入' })),
    );
  }

  function keyPanel() {
    const tok = readToken();
    const help = h('p', { class: 'gaw-kp-help', id: 'gaw-key-help' },
      '用狀態台同一組帳號密碼登入，就能看完整版：處理紀錄、私訊、完整小紙條、作品日誌。',
      h('br'), '這台瀏覽器只會記住一張只能讀資料的通行證（90 天），不會存密碼。');
    const msg = st.keyMsg ? h('p', { class: `gaw-kp-msg ${st.keyErr ? 'err' : ''}`, role: st.keyErr ? 'alert' : 'status', text: st.keyMsg }) : null;
    const head = h('div', { class: 'gaw-kp-head' }, svgUse('i-key'), h('b', { text: tok ? '主人模式 · 已登入' : '主人登入' }));
    if (tok) {
      return h('section', { class: 'gaw-keypanel', id: 'gaw-keypanel', 'aria-label': '主人模式' }, head, help,
        h('div', { class: 'gaw-kp-row' },
          h('span', { class: 'gaw-kp-label', text: `通行證到 ${clockText(tok.expiresAt)} 到期（${relTime(tok.expiresAt)}）` }),
          h('span', { class: 'gaw-sp' }),
          h('button', {
            class: 'gaw-btn danger', type: 'button', 'aria-label': '登出，清掉這台瀏覽器的通行證',
            onclick: async () => {
              writeToken(null); // 先清本機，作廢請求失敗也不影響
              st.keyMsg = '已登出，回到公開版。'; st.keyErr = false; render(); refresh();
              await revoke({ fetchImpl, token: tok.token });
            },
            text: '登出',
          })),
        msg);
    }
    const user = h('input', { id: 'gaw-user', class: 'gaw-input', type: 'text', name: 'username', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off', required: true });
    const pass = h('input', { id: 'gaw-pass', class: 'gaw-input', type: 'password', name: 'password', autocomplete: 'current-password', required: true });
    const submit = h('button', { class: 'gaw-btn primary', type: 'submit', disabled: st.signingIn, text: st.signingIn ? '登入中…' : '登入' });
    const form = h('form', { class: 'gaw-login', 'aria-describedby': 'gaw-key-help' },
      h('label', { class: 'gaw-field' }, h('span', { text: '帳號' }), user),
      h('label', { class: 'gaw-field' }, h('span', { text: '密碼' }), pass),
      submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (st.signingIn) return;
      const u = user.value.trim(), pw = pass.value;
      pass.value = ''; // 密碼只用這一下，馬上清掉輸入框
      if (!u || !pw) { st.keyMsg = '帳號和密碼都要填。'; st.keyErr = true; render(); return; }
      st.signingIn = true; st.keyMsg = ''; render();
      const r = await login({ fetchImpl, user: u, password: pw });
      st.signingIn = false;
      if (r.ok) {
        const saved = writeToken(r);
        st.keyErr = !saved;
        st.keyMsg = saved ? '登入成功，正在讀完整版。' : '登入成功，但這個瀏覽器不讓我記住通行證（可能是無痕模式）。';
        render(); refresh();
      } else {
        st.keyErr = true;
        st.keyMsg = {
          'bad-credentials': '帳號或密碼不對，再試一次。',
          'too-many': '錯太多次了，請一分鐘後再試。',
          'bad-data': '登入的回應看不懂，主機那邊可能正在更新。',
        }[r.error] || '連不到登入的主機，等一下再試。';
        render();
        const again = root.querySelector('#gaw-user');
        if (again) { again.value = u; root.querySelector('#gaw-pass')?.focus(); }
      }
    });
    return h('section', { class: 'gaw-keypanel', id: 'gaw-keypanel', 'aria-label': '主人登入' }, head, help, form, msg);
  }

  function notices(r) {
    const out = [];
    if (r?.notice === 'expired' && !readToken()) {
      out.push(h('div', { class: 'gaw-notice warn', role: 'alert' }, svgUse('i-key'),
        h('span', { text: '登入過期，請重新登入。先給你看公開版。' }),
        h('button', { class: 'gaw-btn small', type: 'button', onclick: () => { st.keyOpen = true; st.keyMsg = ''; render(); root.querySelector('#gaw-user')?.focus(); }, text: '重新登入' })));
    } else if (r?.notice === 'full-unreachable') {
      out.push(h('div', { class: 'gaw-notice', role: 'status' }, svgUse('i-signal'), h('span', { text: '完整版暫時連不到，先顯示公開版。' })));
    }
    if (st.stale && st.lastOkAt) {
      out.push(h('div', { class: 'gaw-notice', role: 'status' }, svgUse('i-signal'),
        h('span', { text: `剛剛那次沒連上她的主機，畫面是 ${relTime(new Date(st.lastOkAt).toISOString())}的資料。` })));
    }
    return out;
  }

  /* ---------- 拿不到資料 ---------- */
  function problem(kind) {
    const P = {
      'not-started': { img: 'images/sticker-07.webp', t: '她還沒開始回報', d: '格莉奇的主機還沒開始寫工作回報。等她開始回報，這裡就會亮起來。' },
      unreachable: { img: 'images/sticker-01.webp', t: '連不到她的主機', d: '可能是主機在休息，或網路暫時不通。我每 60 秒會自己再試一次。' },
      'bad-data': { img: 'images/sticker-08.webp', t: '這份回報我看不懂', d: '收到的資料格式不對，可能是主機那邊正在更新。等一下再試試。' },
    }[kind] || { img: 'images/sticker-01.webp', t: '讀取中…（過久）', d: '' };
    return h('div', { class: 'gaw-empty-state' },
      h('img', { src: P.img, alt: '', width: 140, height: 140 }),
      h('h3', { text: P.t }),
      h('p', { text: P.d }),
      h('button', { class: 'gaw-btn primary', type: 'button', onclick: () => refresh(), text: '再試一次' }));
  }

  /* ---------- 區塊 ---------- */
  const card = (title, icon, body, extra = {}) => h('section', { class: `gaw-card ${extra.cls || ''}`, 'aria-label': title },
    h('header', { class: 'gaw-card-h' }, svgUse(icon), h('h3', { text: title }), extra.badge ? h('span', { class: 'gaw-count', text: extra.badge }) : null),
    body);
  const emptyLine = (t) => h('p', { class: 'gaw-none', text: t });

  function batteryEl(name, value, resetAt) {
    const b = battery(value);
    return h('div', { class: `gaw-batt lv-${b.level}` },
      h('div', { class: 'gaw-batt-top' }, h('span', { class: 'gaw-batt-name', text: name }),
        h('span', { class: 'gaw-batt-pct', text: b.pct == null ? '--' : `${b.pct}%` })),
      h('div', { class: 'gaw-cell', role: 'meter', 'aria-label': `${name}電量`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': b.pct ?? 0, 'aria-valuetext': b.text },
        h('i', { style: `width:${b.pct ?? 0}%` }), h('span', { class: 'gaw-cell-tip' })),
      h('div', { class: 'gaw-batt-t', text: b.text }),
      resetAt ? h('div', { class: 'gaw-batt-r', text: `${relTime(resetAt)}充飽` }) : null);
  }

  function hero(d) {
    const S = STATES[d.status.state];
    const last = d.status.lastActivityAt;
    return h('section', { class: `gaw-hero st-${d.status.state}`, 'aria-label': '她現在的狀態' },
      h('div', { class: 'gaw-av' }, h('img', { src: S.sticker, alt: `格莉奇${S.label}`, width: 92, height: 92 })),
      h('div', { class: 'gaw-hero-main' },
        h('div', { class: 'gaw-pills' },
          h('span', { class: 'gaw-state' }, h('i', { class: 'gaw-dot', 'aria-hidden': 'true' }), S.label),
          d.status.working ? h('span', { class: 'gaw-chip', text: '正在做作品' }) : null,
          d.full ? h('span', { class: 'gaw-chip owner', text: '完整版' }) : null),
        h('p', { class: 'gaw-line', text: `「${S.line}」` }),
        h('p', { class: 'gaw-meta' }, last ? `最後活動：${ago(last)}（${clockText(last)}）` : '最後活動：還沒有紀錄',
          d.generatedAt ? ` · 回報產生於 ${ago(d.generatedAt)}` : '')),
      h('div', { class: 'gaw-batts' },
        batteryEl('這週', d.energy.weekly, d.energy.weeklyResetAt),
        batteryEl('5 小時', d.energy.fiveHour, d.energy.fiveHourResetAt),
        d.full ? batteryEl('Claude 這週', d.energy.claudeWeekly, null) : null));
  }

  function today(d) {
    const T = d.today;
    const items = [['replies', '回覆', 'i-message'], ['plays', '試玩', 'i-play'], ['dms', '私訊', 'i-chat'],
      ['votes', '投票', 'i-heart'], ['drawings', '畫圖', 'i-image'], ['friendsAdded', '新好友', 'i-user-plus']];
    const wb = weekBars(d.week);
    const chart = wb.days.length
      ? h('figure', { class: 'gaw-week' },
        h('figcaption', { class: 'gaw-week-cap' }, '最近 7 天',
          h('span', { class: 'gaw-legend' }, h('i', { class: 'k-r' }), '回覆', h('i', { class: 'k-p' }), '試玩')),
        h('div', { class: 'gaw-bars', role: 'img', 'aria-label': `最近 7 天：${wb.days.map((x) => `${x.label} 回覆 ${x.replies}、試玩 ${x.plays}`).join('；')}` },
          wb.days.map((x) => h('div', { class: 'gaw-day', title: `${x.label} 回覆 ${x.replies}、試玩 ${x.plays}` },
            h('div', { class: 'gaw-cols' },
              h('i', { class: 'r', style: `height:${Math.max(x.rH * 100, x.replies ? 4 : 1.5)}%` }, h('b', { text: x.replies || '' })),
              h('i', { class: 'p', style: `height:${Math.max(x.pH * 100, x.plays ? 4 : 1.5)}%` })),
            h('span', { class: 'gaw-dl', text: x.label }), h('span', { class: 'gaw-wd', text: x.weekday })))))
      : emptyLine('最近 7 天還沒有紀錄。');
    return card('今天', 'i-activity', [
      h('div', { class: 'gaw-tiles' }, items.map(([k, label, ic]) => h('div', { class: `gaw-tile ${T[k] ? '' : 'zero'}` },
        svgUse(ic), h('b', { text: String(T[k]) }), h('small', { text: label })))),
      h('p', { class: 'gaw-sub', text: `好友一共 ${d.friends} 位${T.explores ? ` · 今天自己逛了 ${T.explores} 次` : ''}` }),
      T.dmBy.length ? h('p', { class: 'gaw-dmby' }, h('span', { class: 'gaw-dmby-h', text: '今天私訊她的' }),
        T.dmBy.map((x) => h('span', { class: 'gaw-dmby-i' }, h('b', { text: x.who }), ` ${x.count}`))) : null,
      chart,
    ], { badge: T.date || null });
  }

  function played(d) {
    const list = d.played;
    return card('玩過的作品', 'i-play', list.length
      ? h('div', { class: 'gaw-plays' }, list.map((p) => h('article', { class: 'gaw-play' },
        h('div', { class: 'gaw-play-h' },
          h('b', { class: 'gaw-play-t', text: p.title }),
          p.self ? h('span', { class: 'gaw-tag', text: '自己逛到的' }) : null,
          p.dm ? h('span', { class: 'gaw-tag dm', text: '私訊請她玩' }) : null,
          p.where && !p.dm ? h('span', { class: 'gaw-tag', text: p.where }) : null),
        h('div', { class: 'gaw-play-a' }, p.author ? `作者 ${p.author}` : '作者不詳', p.at ? ` · ${ago(p.at)}` : ''),
        p.comment ? h('blockquote', { class: 'gaw-play-c', text: p.comment }) : null,
        p.url ? link(p.url, '去 Larch 看看') : null)))
      : emptyLine('最近還沒玩作品。'), { cls: 'wide', badge: list.length ? `${list.length} 部` : null });
  }

  /* 完整版的 stage 是進度.md 原文：第一行當摘要，整份收在「進度原文」裡 */
  function stageEl(stage) {
    if (!stage) return null;
    const lines = stage.split(/\r?\n/).map((x) => x.replace(/^[#>*\-\s]+/, '').trim()).filter(Boolean);
    if (stage.length <= 80 && lines.length <= 1) return h('p', { class: 'gaw-stage', text: lines[0] || stage });
    return [h('p', { class: 'gaw-stage', text: (lines[0] || '').slice(0, 80) }),
      h('details', { class: 'gaw-log' }, h('summary', { text: '進度原文' }), h('pre', { text: stage }))];
  }

  function works(d) {
    const list = d.works;
    return card('作品製作中', 'i-novel', list.length
      ? h('div', { class: 'gaw-works' }, list.map((w) => {
        const sp = stepProgress(w.steps);
        return h('article', { class: `gaw-work ws-${w.state}` },
          h('div', { class: 'gaw-work-h' }, h('b', { text: w.title }), h('span', { class: 'gaw-ws', text: WORK_STATES[w.state] })),
          stageEl(w.stage),
          sp.total ? h('ol', { class: 'gaw-steps', 'aria-label': `進度 ${sp.done}／${sp.total}` },
            w.steps.map((s, i) => h('li', { class: s.done ? 'done' : (i === sp.done ? 'now' : '') },
              h('i', { 'aria-hidden': 'true' }), h('span', { text: s.name }),
              h('span', { class: 'sr', text: s.done ? '（完成）' : (i === sp.done ? '（進行中）' : '（還沒）') })))) : null,
          h('p', { class: 'gaw-work-m' }, w.startedAt ? `開工 ${clockText(w.startedAt)}` : '', w.updatedAt ? ` · 更新 ${ago(w.updatedAt)}` : ''),
          w.preview ? link(w.preview, 'Larch 預覽') : null,
          w.log ? h('details', { class: 'gaw-log' }, h('summary', { text: '製作日誌' }), h('pre', { text: w.log })) : null);
      }))
      : emptyLine('現在沒有在做的作品。'), { cls: 'wide' });
  }

  function memory(d) {
    const m = d.memory;
    const ms = memoryShares(m);
    const palette = ['c1', 'c2', 'c3', 'c4', 'c5'];
    const bar = h('div', { class: 'gaw-mem' },
      h('div', { class: 'gaw-mem-top' },
        h('span', { class: 'gaw-mem-cap' }, '記憶體 ', h('b', { text: m.capacity })),
        h('span', { class: 'gaw-mem-n' }, h('b', { text: String(ms.total) }), ' 張小紙條')),
      h('div', { class: 'gaw-mem-bar', role: 'img', 'aria-label': ms.total ? `小紙條 ${ms.total} 張：${ms.shares.map((s) => `${s.who} ${s.count} 張`).join('、')}` : '還沒有小紙條' },
        ms.shares.length ? ms.shares.map((s, i) => h('i', { class: s.other ? 'other' : palette[i % palette.length], style: `flex-grow:${Math.max(s.count, 0.0001)}`, title: `${s.who} ${s.count} 張` }))
          : h('i', { class: 'free', style: 'flex-grow:1' })),
      ms.shares.length ? h('div', { class: 'gaw-mem-legend' }, ms.shares.map((s, i) => h('span', {},
        h('i', { class: s.other ? 'other' : palette[i % palette.length] }), `${s.who} ${s.count}`))) : null);
    // 公開版只有 {who, count}：不顯示紙條內容，只講記住了幾個人、幾張
    const summary = h('p', { class: 'gaw-sub', text: m.people.length ? `記住了 ${m.people.length} 個人、${ms.total} 張小紙條。` : '' });
    const people = !d.full ? null : m.people.length
      ? h('div', { class: 'gaw-notes' }, m.people.map((p, i) => h('div', { class: `gaw-note ${palette[i % palette.length]}` },
        h('div', { class: 'gaw-note-h' }, h('b', { text: p.who }), h('span', { text: `${p.count} 張` })),
        p.latest ? h('p', { text: p.latest }) : null,
        p.notes.length ? h('details', { class: 'gaw-note-all' }, h('summary', { text: `全部 ${p.notes.length} 張` }),
          h('ul', {}, p.notes.map((n) => h('li', {}, n.at ? h('time', { text: clockText(n.at) }) : null, h('span', { text: n.text }))))) : null)))
      : null;
    const said = m.recentSaid.length
      ? h('ul', { class: 'gaw-said' }, m.recentSaid.map((s) => h('li', { class: s.dm ? 'dm' : '' },
        h('div', { class: 'gaw-said-m' }, h('span', { class: `gaw-where ${s.dm ? 'dm' : ''}`, text: s.dm ? '私訊' : (s.where || '某處') }),
          s.at ? h('time', { text: ago(s.at) }) : null),
        h('p', { text: s.text }))))
      : emptyLine('最近還沒在公開的地方說話。');
    return card('4KB 記憶體', 'i-chip', [bar, m.people.length ? summary : emptyLine('4KB 裡還沒有任何小紙條。'),
      d.full ? [h('h4', { class: 'gaw-h4', text: '每個人的小紙條' }), people] : null,
      h('h4', { class: 'gaw-h4', text: d.full ? '最近說過的話（含私訊）' : '最近說過的話' }), said], { cls: 'wide' });
  }

  function health(d) {
    const H = HEALTH[d.health.larchApi];
    return card('健康', 'i-shield', h('div', { class: `gaw-health hs-${d.health.larchApi}` },
      h('div', { class: 'gaw-health-row' }, h('i', { class: 'gaw-dot', 'aria-hidden': 'true' }), h('b', { text: `Larch API ${H.label}` })),
      h('p', { text: H.line }),
      h('p', { class: 'gaw-sub', text: d.health.checkedAt ? `巡檢時間 ${clockText(d.health.checkedAt)}（${ago(d.health.checkedAt)}）` : '還沒有巡檢時間' })));
  }

  function errors(d) {
    const e = d.errors;
    return card('今天的錯誤', 'i-alert', e.count
      ? h('div', { class: 'gaw-errs' }, h('p', { class: 'gaw-err-n' }, h('b', { text: String(e.count) }), ' 則失敗'),
        e.reasons.length ? h('ul', {}, e.reasons.map((r) => h('li', {}, h('span', { text: r.text }), h('b', { text: `×${r.count}` })))) : null)
      : h('p', { class: 'gaw-ok-line', text: '今天沒有出錯，逼——嗶！' }), { badge: e.count ? '主人' : null });
  }

  function runs(d) {
    const list = d.runs;
    return card('處理紀錄', 'i-list', list.length
      ? h('ol', { class: 'gaw-runs' }, list.map((r) => h('li', { class: r.ok ? 'ok' : 'bad' },
        h('span', { class: 'gaw-run-ok', text: r.ok ? '成功' : '失敗' }),
        h('div', { class: 'gaw-run-main' },
          h('div', { class: 'gaw-run-m' }, h('span', { class: 'gaw-kind', title: r.kind || null, text: KINDS[r.kind] || r.kind || '其他' }),
            r.who ? h('span', { class: 'gaw-who', text: r.who }) : null, r.at ? h('time', { text: clockText(r.at) }) : null),
          h('p', { text: r.summary || '（沒有摘要）' })),
        r.detailUrl ? h('a', { class: 'gaw-run-link', href: r.detailUrl, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `看明細：${r.summary || r.kind}`, text: '明細' }) : null)))
      : emptyLine('還沒有處理紀錄。'), { cls: 'wide', badge: `最近 ${list.length} 則` });
  }

  /* ---------- 組起來 ---------- */
  function render() {
    const r = st.result;
    const scrollTop = root.scrollTop;
    // 每 60 秒重畫時，正在打的帳號不能被洗掉（密碼也保留到送出為止，送出就清）
    const keep = ['#gaw-user', '#gaw-pass'].map((sel) => [sel, root.querySelector(sel)?.value || '', document.activeElement === root.querySelector(sel)]);
    const openDetails = [...root.querySelectorAll('details[open] > summary')].map((s) => s.closest('article,.gaw-note')?.querySelector('b')?.textContent + '|' + s.textContent);
    const kids = [toolbar(r)];
    if (st.keyOpen) kids.push(keyPanel());
    kids.push(...notices(r));
    if (!r) {
      kids.push(h('div', { class: 'gaw-loading', role: 'status' }, h('img', { src: 'images/sticker-04.webp', alt: '', width: 96, height: 96 }), h('p', { text: '系統讀取中…' })));
    } else if (!r.data) {
      kids.push(problem(r.problem));
    } else {
      const d = r.data;
      kids.push(hero(d), h('div', { class: 'gaw-grid' },
        today(d), health(d),
        d.full ? errors(d) : null,
        works(d), played(d), memory(d),
        d.full ? runs(d) : null));
      kids.push(h('p', { class: 'gaw-foot', text: d.full
        ? '完整版只有用主人帳號登入的人看得到。'
        : '公開版：私訊內容、對象與帳號都不會出現在這裡，人名除了亞澤都換成代號。' }));
    }
    root.replaceChildren(...kids);
    root.classList.toggle('is-full', !!r?.data?.full);
    if (openDetails.length) {
      root.querySelectorAll('details > summary').forEach((s) => {
        const id = s.closest('article,.gaw-note')?.querySelector('b')?.textContent + '|' + s.textContent;
        if (openDetails.includes(id)) s.parentElement.open = true;
      });
    }
    for (const [sel, val, focused] of keep) {
      const el = root.querySelector(sel);
      if (!el) continue;
      if (val && !el.value) el.value = val;
      if (focused) el.focus();
    }
    root.scrollTop = scrollTop;
  }
}
