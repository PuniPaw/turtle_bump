export function formatMinutes(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes));
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분`;
}

export function formatSeconds(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return `${m}분 ${s % 60}초`;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');

export function formatDateTime(d) {
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} (${WEEKDAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatClock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
