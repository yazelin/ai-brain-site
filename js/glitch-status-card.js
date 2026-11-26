/* 「我的狀態」視窗與頂部選單列的電量藥丸：讀格莉奇公開的狀態資料（不帶主人通行證，只看公開版）。
   頁面開著每 5 分鐘更新一次（資料本身也是 5 分鐘產一次），讀不到就顯示「--」。 */
import { STATES, loadStatus, fixtureFrom } from './glitch-at-work-data.js';

const $ = (id) => document.getElementById(id);
const setGauge = (el, p) => { if (el) el.style.width = (p == null ? 0 : p) + '%'; };
const pctText = (p) => (p == null ? '--' : p + '%');

export function paint(d) {
  const S = d ? STATES[d.status.state] : null;
  const state = !d ? '--' : d.status.working && d.status.state === 'online' ? '做作品中' : S.label;
  const main = d ? d.energy.fiveHour : null;
  const backup = d ? d.energy.backup.fiveHour : null;
  if ($('st-state')) $('st-state').textContent = state;
  if ($('st-energy')) $('st-energy').textContent = pctText(main);
  setGauge($('st-energy-bar'), main);
  if ($('st-backup')) $('st-backup').textContent = pctText(backup);
  setGauge($('st-backup-bar'), backup);
  if ($('st-replies')) $('st-replies').textContent = d ? String(d.today.replies ?? 0) : '--';
  if ($('cap-pct')) $('cap-pct').textContent = pctText(main);
  setGauge($('cap-bar'), main);
}

async function refresh() {
  try {
    const r = await loadStatus({ fetchImpl: fetch.bind(window), fixture: fixtureFrom(location.search) });
    paint(r.data);
  } catch (_) { paint(null); }
}

if (typeof document !== 'undefined' && $('st-state')) {
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
