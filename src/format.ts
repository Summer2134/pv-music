/** Время трека: 3:07, 1:02:45. */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
/** «1:23», «83», «1:02:03», «+10», «-15» → мс (относительно текущей позиции для ±). null — не понял. */
export function parseTime(text: string, position = 0): number | null {
  const t = text.trim().replace(',', '.');
  const rel = /^([+-])\s*(.+)$/.exec(t);
  if (rel) {
    const v = parseTime(rel[2]);
    return v === null ? null : Math.max(0, position + (rel[1] === '+' ? v : -v));
  }
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const parts = t.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d{1,2}$/.test(p))) return null;
  const n = parts.map(Number);
  const [h, m, s] = n.length === 3 ? n : [0, n[0], n[1]];
  if (m > 59 && n.length === 3 || s > 59) return null;
  return ((h * 60 + m) * 60 + s) * 1000;
}
/** Полоска прогресса для эмбеда. */
export function progress(pos: number, total: number, len = 16): string {
  if (!total || total <= 0) return '🔴 эфир';
  const k = Math.max(0, Math.min(len - 1, Math.round((pos / total) * (len - 1))));
  return '▬'.repeat(k) + '🔘' + '▬'.repeat(len - 1 - k);
}
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** Убрать markdown, чтобы название трека не ломало вёрстку. */
export const plain = (s: string) => s.replace(/([*_`~|\\[\]>])/g, '\\$1');
export const num = (n: number) => Number(n).toLocaleString('ru-RU');
export function hours(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
}
/** День МСК (YYYY-MM-DD). */
export const mskDay = (t = Date.now()) => new Date(t + 3 * 3_600_000).toISOString().slice(0, 10);
export const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());
