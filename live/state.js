/* 直播頁的事件協定與狀態歸約。
   來源：glitch-vtuber 的 src/events.mjs（https://github.com/yazelin/glitch-vtuber），
   從 const LAYOUTS 那行起原樣複製，只換掉這段檔頭。跟 glitch2d/ 一樣把相依打包進
   repo，直播頁不必另外載 glitch-vtuber。
   同步方式：events.mjs 改了就把 const LAYOUTS 以下整段重新貼過來；本機有
   ../glitch-vtuber 時，node --test tests/test_live_state.mjs 會比對兩邊，
   漂掉就失敗。 */
const LAYOUTS = ['vn', 'choice', 'talk'];
const CHAT_MAX = 20;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const checks = {
  snapshot: (e) => isObj(e.state),
  say: (e) => isStr(e.id) && isStr(e.text),
  owner_audio: (e) => isStr(e.id) && isStr(e.audio),
  vn_line: (e) => isStr(e.id) && isStr(e.text),
  vn_choices: (e) => isStr(e.id) && Array.isArray(e.options) && e.options.every((o) => isObj(o) && isNum(o.n) && isStr(o.text)),
  vn_votes: (e) => isStr(e.id) && isObj(e.counts),
  chat: (e) => isStr(e.id) && isStr(e.author) && isStr(e.text),
  layout: (e) => LAYOUTS.includes(e.mode),
  stop: () => true,
  status: (e) => typeof e.live === 'boolean',
};

export function validateEvent(ev) {
  if (!isObj(ev)) return { ok: false, error: 'event must be an object' };
  const check = Object.prototype.hasOwnProperty.call(checks, ev.type) ? checks[ev.type] : null;
  if (!check) return { ok: false, error: `unknown event type: ${String(ev.type)}` };
  if (!check(ev)) return { ok: false, error: `invalid ${ev.type} event` };
  return { ok: true };
}

export function emptyState() {
  return { live: false, layout: 'vn', vn: null, choices: null, chat: [], emote: null };
}

export function applyEvent(state, ev) {
  switch (ev.type) {
    case 'snapshot':
      return { ...emptyState(), ...ev.state };
    case 'status':
      return { ...state, live: ev.live };
    case 'layout':
      return { ...state, layout: ev.mode };
    case 'say':
      return { ...state, emote: ev.emote ?? null };
    case 'vn_line':
      return { ...state, vn: { speaker: ev.speaker, text: ev.text, bg: ev.bg ?? null } };
    case 'vn_choices':
      // options 是空陣列表示投票結束、清掉選項框
      if (!ev.options.length) return { ...state, choices: null };
      return { ...state, choices: { id: ev.id, options: ev.options, endsAt: ev.endsAt, counts: {} } };
    case 'vn_votes':
      if (!state.choices || state.choices.id !== ev.id) return state;
      return { ...state, choices: { ...state.choices, counts: { ...ev.counts } } };
    case 'chat':
      return { ...state, chat: [...state.chat, { id: ev.id, author: ev.author, text: ev.text }].slice(-CHAT_MAX) };
    default:
      return state;
  }
}
