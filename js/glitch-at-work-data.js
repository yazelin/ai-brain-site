/* 「格莉奇工作中」App 的資料層：抓資料、整理欄位、把數字翻成她的口吻。
   純函式、不碰 DOM，所以 tests/test_glitch_at_work.mjs 可以直接用 node --test 跑。
   資料格式的唯一來源是 glitch-agent 的 docs/公開狀態資料.md（version 1）；
   這裡只做「缺欄位補預設、型別不對就丟掉」，不另外發明欄位。 */

export const PUBLIC_URL = 'https://ching-tech.ddns.net/glitch/public/status.json';
export const FULL_URL = 'https://ching-tech.ddns.net/glitch/api/full.json';
export const TOKEN_NAME = 'glitch-at-work-owner-token';
export const LOGIN_URL = 'https://ching-tech.ddns.net/glitch/_glitch/token';
export const REVOKE_URL = 'https://ching-tech.ddns.net/glitch/_glitch/token/revoke';
export const REFRESH_MS = 60_000;
export const FIXTURES = {
  public: 'data/glitch-at-work-sample-public.json',
  full: 'data/glitch-at-work-sample-full.json',
  empty: 'data/glitch-at-work-sample-empty.json',
};

/* ?glitchAtWorkFixture=public|full|empty，其他值一律當沒帶 */
export function fixtureFrom(search) {
  try {
    const v = new URLSearchParams(search || '').get('glitchAtWorkFixture');
    return v && Object.hasOwn(FIXTURES, v) ? v : null;
  } catch (_) {
    return null;
  }
}

/* 外來網址只放行 http(s)，javascript:、data: 這些一律不給連 */
export function safeUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : null);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

const COUNT_KEYS = ['replies', 'plays', 'dms', 'votes', 'drawings', 'friendsAdded', 'explores'];

/* 整理成畫面可以直接用的形狀。不是物件就回 null（呼叫端當「格式看不懂」）。 */
export function normalize(raw, { allowFull = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const status = obj(raw.status);
  const energy = obj(raw.energy);
  const today = obj(raw.today);
  const memory = obj(raw.memory);
  const health = obj(raw.health);
  // 公開網址回來的資料就算帶了 full:true，也只照公開版整理，私人欄位一律不收
  const full = allowFull && raw.full === true;
  const out = {
    version: int(raw.version) || 1,
    full,
    generatedAt: iso(raw.generatedAt),
    status: {
      state: pick(status.state, ['online', 'paused', 'sleeping', 'offline'], 'offline'),
      lastActivityAt: iso(status.lastActivityAt),
      working: status.working === true,
    },
    energy: {
      weekly: pct(energy.weekly),
      fiveHour: pct(energy.fiveHour),
      weeklyResetAt: iso(energy.weeklyResetAt),
      fiveHourResetAt: iso(energy.fiveHourResetAt),
      claudeWeekly: full ? pct(energy.claudeWeekly) : null,
      // 第二條電量：Claude 備援（亞澤另一個 Pro 帳號），兩條都沒電她才休眠
      backup: { weekly: pct(obj(energy.backup).weekly), fiveHour: pct(obj(energy.backup).fiveHour),
        weeklyResetAt: iso(obj(energy.backup).weeklyResetAt), fiveHourResetAt: iso(obj(energy.backup).fiveHourResetAt) },
      // 主人才有：agy 裡 Claude／GPT 共用額度（做作品寫程式用）
      agyClaude: full && energy.agyClaude ? { weekly: pct(obj(energy.agyClaude).weekly), fiveHour: pct(obj(energy.agyClaude).fiveHour),
        weeklyResetAt: iso(obj(energy.agyClaude).weeklyResetAt), fiveHourResetAt: iso(obj(energy.agyClaude).fiveHourResetAt) } : null,
    },
    today: { date: str(today.date, 10) },
    week: arr(raw.week).slice(-7).map((d) => ({ date: str(obj(d).date, 10), replies: int(obj(d).replies), plays: int(obj(d).plays) })),
    friends: int(raw.friends),
    played: arr(raw.played).slice(0, full ? 30 : 10).map((p) => {
      p = obj(p);
      return {
        at: iso(p.at), title: str(p.title, 120) || '（沒有名字的作品）', author: str(p.author, 60),
        url: safeUrl(p.url), comment: str(p.comment, full ? 2000 : 140), self: p.self === true,
        dm: full && p.dm === true, where: full ? str(p.where, 40) : '',
      };
    }),
    works: arr(raw.works).map((w) => {
      w = obj(w);
      return {
        code: str(w.code, 80), title: str(w.title, 120) || '（還沒取名）',
        state: pick(w.state, ['making', 'review', 'published'], 'making'),
        // 完整版的 stage 是進度.md 原文（可能很長、多行），公開版是一句話
        stage: str(w.stage, full ? 4000 : 120),
        startedAt: iso(w.startedAt), updatedAt: iso(w.updatedAt),
        steps: arr(w.steps).slice(0, 12).map((s) => ({ name: str(obj(s).name, 30), done: obj(s).done === true })),
        log: full ? str(w.log, 2000) : '',
        preview: full ? safeUrl(w.preview) : null,
      };
    }),
    memory: {
      capacity: str(memory.capacity, 10) || '4KB',
      notes: int(memory.notes),
      people: arr(memory.people).map((p) => {
        p = obj(p);
        return {
          // 亞澤 11-26：公開版不放紙條內文，就算來源帶了 latest 也不收
          who: str(p.who, 40) || '某位朋友', count: int(p.count), latest: full ? str(p.latest, 400) : '',
          notes: full ? arr(p.notes).map(noteItem).filter((n) => n.text) : [],
        };
      }),
      recentSaid: arr(memory.recentSaid).slice(0, full ? 50 : 5).map((s) => {
        s = obj(s);
        const dm = s.dm === true || s.where === 'dm' || s.where === '私訊';
        return { at: iso(s.at), where: str(s.where, 30), text: str(s.text, full ? 1000 : 100), dm: full && dm };
      }).filter((s) => s.text && (full || !s.dm)),
    },
    health: { larchApi: pick(health.larchApi, ['ok', 'changed', 'unknown'], 'unknown'), checkedAt: iso(health.checkedAt) },
    runs: full ? arr(raw.runs).slice(0, 30).map((r) => {
      r = obj(r);
      return { at: iso(r.at), kind: str(r.kind, 40), ok: r.ok !== false, who: str(r.who, 60), summary: str(r.summary, 400), detailUrl: safeUrl(r.detailUrl) };
    }) : [],
    errors: full ? errorsOf(raw.errors) : null,
  };
  for (const k of COUNT_KEYS) out.today[k] = int(today[k]);
  out.today.dmBy = full ? dmByOf(today.dmBy) : [];
  return out;
}

/* 完整版 today.dmBy：每個私訊對象的次數。收 {名字: 次數} 或 [{who, count}]，多到少排 */
export function dmByOf(v) {
  let list = [];
  if (Array.isArray(v)) list = v.map((x) => ({ who: str(obj(x).who ?? obj(x).name, 40), count: int(obj(x).count) }));
  else if (v && typeof v === 'object') list = Object.entries(v).map(([who, count]) => ({ who: str(who, 40), count: int(count) }));
  return list.filter((x) => x.who && x.count).sort((a, b) => b.count - a.count);
}

/* 完整小紙條：文件只說「完整小紙條」，字串或 {at,text} 都收 */
function noteItem(n) {
  if (typeof n === 'string') return { at: null, text: n.slice(0, 400) };
  n = obj(n);
  return { at: iso(n.at), text: str(n.text ?? n.note ?? n.content, 400) };
}

/* errors：今天失敗的則數與原因摘要。正式形狀是 {count, items}（11-26 定），
   舊的寫法也收：數字、{count, reasons|summary}、陣列；項目可以是字串或 {reason|summary|text, count}。 */
export function errorsOf(e) {
  if (e == null) return { count: 0, reasons: [] };
  if (typeof e === 'number') return { count: int(e), reasons: [] };
  const reasonOf = (r) => (typeof r === 'string' ? { text: r.slice(0, 200), count: 1 }
    : { text: str(obj(r).reason ?? obj(r).summary ?? obj(r).text ?? obj(r).message, 200), count: int(obj(r).count) || 1 });
  if (Array.isArray(e)) {
    const reasons = e.map(reasonOf).filter((r) => r.text);
    return { count: reasons.reduce((a, r) => a + r.count, 0), reasons };
  }
  const o = obj(e);
  let reasons = arr(o.items ?? o.reasons).map(reasonOf).filter((r) => r.text);
  if (!reasons.length && typeof o.summary === 'string' && o.summary) reasons = [{ text: o.summary.slice(0, 200), count: int(o.count) || 1 }];
  return { count: int(o.count) || reasons.reduce((a, r) => a + r.count, 0), reasons };
}

/* ---------- 她的口吻 ---------- */

export const STATES = {
  online: { label: '上線中', line: '我在線上！有人找我，我就去看。', sticker: 'images/sticker-03.webp' },
  sleeping: { label: '休眠中', line: '電量太低，我先休眠一下，充好電就回來。', sticker: 'images/sticker-07.webp' },
  paused: { label: '暫停中', line: '我被按了暫停，等亞澤叫我再繼續。', sticker: 'images/sticker-05.webp' },
  offline: { label: '離線', line: '我現在不在線上……主機可能在休息。', sticker: 'images/sticker-01.webp' },
};

export function battery(value) {
  const p = pct(value);
  if (p == null) return { pct: null, level: 'unknown', text: '電量讀不到…（過久）' };
  if (p < 10) return { pct: p, level: 'empty', text: `電量 ${p}%，快沒電了，先休眠` };
  if (p < 30) return { pct: p, level: 'low', text: `電量 ${p}%，有點累了` };
  if (p < 60) return { pct: p, level: 'mid', text: `電量 ${p}%` };
  return { pct: p, level: 'high', text: `電量 ${p}%，精神很好！` };
}

export const WORK_STATES = { making: '製作中', review: '等亞澤試玩', published: '已上架' };
export const HEALTH = {
  ok: { label: '正常', line: 'Larch 的門我都打得開。' },
  changed: { label: '有變動', line: 'Larch 的 API 好像改過了，我先小心一點用。' },
  unknown: { label: '還沒檢查', line: '還沒巡過 Larch，等一下再看。' },
};

/* 相對時間：「剛剛」「3 分鐘前」「2 小時前」「昨天」「5 天前」；未來時間給「3 小時後」 */
export function relTime(when, now = Date.now()) {
  const t = Date.parse(when);
  if (Number.isNaN(t)) return '';
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const tail = diff >= 0 ? '前' : '後';
  if (abs < 45) return diff >= 0 ? '剛剛' : '馬上';
  if (abs < 3600) return `${Math.round(abs / 60)} 分鐘${tail}`;
  if (abs < 86400) return `${Math.round(abs / 3600)} 小時${tail}`;
  const days = Math.round(abs / 86400);
  if (days === 1) return diff >= 0 ? '昨天' : '明天';
  return `${days} 天${tail}`;
}

/* 台北時間的「11/26 10:30」 */
export function clockText(when) {
  const t = Date.parse(when);
  if (Number.isNaN(t)) return '';
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(t));
  const g = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
/* 七天長條：補齊到 7 天（舊到新），算出各自高度比例 */
export function weekBars(week) {
  const days = arr(week).slice(-7);
  const max = Math.max(1, ...days.flatMap((d) => [int(d.replies), int(d.plays)]));
  return {
    max,
    days: days.map((d) => {
      const t = Date.parse(`${d.date}T12:00:00+08:00`);
      const label = Number.isNaN(t) ? str(d.date, 5) : `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))}`;
      return {
        date: d.date, label, weekday: Number.isNaN(t) ? '' : WEEKDAY[new Date(t).getUTCDay()],
        replies: int(d.replies), plays: int(d.plays),
        rH: int(d.replies) / max, pH: int(d.plays) / max,
      };
    }),
  };
}

export function stepProgress(steps) {
  const s = arr(steps);
  const done = s.filter((x) => x && x.done).length;
  return { done, total: s.length, ratio: s.length ? done / s.length : 0 };
}

/* 記憶體使用量：每個人佔小紙條的比例（像活動監視器的「誰在吃記憶體」） */
export function memoryShares(memory) {
  const people = arr(memory?.people);
  const counted = people.reduce((a, p) => a + int(p.count), 0);
  const total = Math.max(int(memory?.notes), counted);
  const shares = people.map((p) => ({ who: p.who, count: int(p.count), ratio: total ? int(p.count) / total : 0 }));
  const other = total - counted;
  if (other > 0) shares.push({ who: '其他', count: other, ratio: other / total, other: true });
  return { total, shares };
}

/* ---------- 主人登入 ----------
   localStorage 裡只放 {token, expiresAt}（通行證），密碼從來不存。 */

/* 讀出來的字串轉成可用的 token；壞掉、過期、沒有都回 null */
export function parseStoredToken(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.token !== 'string' || !v.token) return null;
    const exp = Date.parse(v.expiresAt);
    if (Number.isNaN(exp) || exp <= now) return null;
    return { token: v.token, expiresAt: v.expiresAt };
  } catch (_) {
    return null;
  }
}

/* POST 帳密換通行證。回 { ok:true, token, expiresAt } 或 { ok:false, error }，
   error：'bad-credentials'（401/403）｜'too-many'（429）｜'unreachable'｜'bad-data' */
export async function login({ fetchImpl, user, password }) {
  let res;
  try {
    res = await fetchImpl(LOGIN_URL, {
      method: 'POST', cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: String(user ?? ''), password: String(password ?? '') }),
    });
  } catch (_) {
    return { ok: false, error: 'unreachable' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'bad-credentials' };
  if (res.status === 429) return { ok: false, error: 'too-many' };
  if (!res.ok) return { ok: false, error: 'unreachable' };
  try {
    const v = await res.json();
    const tok = parseStoredToken(JSON.stringify({ token: v?.token, expiresAt: v?.expiresAt }));
    return tok ? { ok: true, ...tok } : { ok: false, error: 'bad-data' };
  } catch (_) {
    return { ok: false, error: 'bad-data' };
  }
}

/* 登出時順手作廢伺服器上的通行證；失敗不影響本機登出，所以永遠不 throw */
export async function revoke({ fetchImpl, token }) {
  if (!token) return false;
  try {
    const res = await fetchImpl(REVOKE_URL, {
      method: 'POST', cache: 'no-store', credentials: 'omit', headers: { Authorization: `Bearer ${token}` },
    });
    return !!res.ok;
  } catch (_) {
    return false;
  }
}

/* ---------- 抓資料 ----------
   回傳 { data, mode, notice, problem }：
   - mode：'fixture' | 'full' | 'public'
   - notice：要放在頂部的提示（'expired' 登入過期、'full-unreachable' 完整版連不到），沒有就 null
   - dropToken：true＝通行證被拒（401/403），呼叫端要把本機 token 清掉
   - problem：整份都拿不到時的原因 'not-started' | 'unreachable' | 'bad-data'，data 為 null
   fetchImpl 由呼叫端傳進來，測試可以換成假的。 */
export async function loadStatus({ fetchImpl, fixture = null, token = '' } = {}) {
  const get = async (url, headers, allowFull = false) => {
    let res;
    try {
      res = await fetchImpl(url, { cache: 'no-store', headers: headers || {}, credentials: 'omit' });
    } catch (_) {
      return { kind: 'network' };
    }
    if (!res.ok) return { kind: 'http', status: res.status };
    try {
      const data = normalize(await res.json(), { allowFull });
      return data ? { kind: 'ok', data } : { kind: 'bad' };
    } catch (_) {
      return { kind: 'bad' };
    }
  };
  const fail = (r) => ({
    data: null, mode: null, notice: null,
    problem: r.kind === 'http' && r.status === 404 ? 'not-started' : r.kind === 'bad' ? 'bad-data' : 'unreachable',
  });

  if (fixture && FIXTURES[fixture]) {
    const r = await get(FIXTURES[fixture], null, true);
    return r.kind === 'ok' ? { data: r.data, mode: 'fixture', notice: null, problem: null } : fail(r);
  }

  let notice = null, dropToken = false;
  const k = typeof token === 'string' ? token.trim() : '';
  if (k) {
    const r = await get(FULL_URL, { Authorization: `Bearer ${k}` }, true);
    if (r.kind === 'ok') return { data: r.data, mode: 'full', notice: null, problem: null, dropToken: false };
    if (r.kind === 'http' && (r.status === 401 || r.status === 403)) { notice = 'expired'; dropToken = true; }
    else notice = 'full-unreachable';
  }
  const r = await get(PUBLIC_URL);
  if (r.kind === 'ok') {
    return { data: r.data, mode: 'public', notice, problem: null, dropToken };
  }
  return { ...fail(r), notice, dropToken };
}
