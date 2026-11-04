import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { ROOT } from './config.js';

/**
 * Карточка «сейчас играет» картинкой (04.11.2026, просьба владельца: «как у eara, но круче»).
 * Фон — размытая обложка + ночной градиент (серая гамма PV Music), слева обложка, справа название,
 * исполнитель, кто заказал, толстая полоска времени. Размытый фон рисуется один раз на трек (кэш), дальше —
 * только лёгкий слой с текстом и полоской: обновление раз в 15 с почти бесплатное.
 */
export const W = 1100, H = 400;
const FONTS = ['Montserrat_600SemiBold.ttf', 'Montserrat_700Bold.ttf', 'Montserrat_800ExtraBold.ttf', 'Unbounded_800ExtraBold.ttf']
  // Шрифты: свои (assets/fonts — отдельный репозиторий) или общие PV Bot (../assets/fonts).
  .map(f => [join(ROOT, 'assets', 'fonts', f), join(ROOT, '..', 'assets', 'fonts', f)].find(existsSync)).filter((x): x is string => Boolean(x));
// Серая гамма под аватар и баннер PV Music (04.11.2026, просьба владельца).
const LABEL = '#FFFFFF', SOFT = '#B5BAC1', NIGHT = '#1E1F22';

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Грубая ширина строки (без измерения шрифта): Unbounded шире Montserrat. */
const widthOf = (s: string, size: number, wide = false) => [...s].reduce((w, ch) => w + size * (/[\s.,'·-]/.test(ch) ? 0.32 : /[A-ZА-ЯЁШЩЖМЫЮ]/.test(ch) ? (wide ? 0.95 : 0.7) : /[шщжмыюфд]/.test(ch) ? (wide ? 0.9 : 0.66) : (wide ? 0.74 : 0.56)), 0);
export function fit(text: string, maxW: number, size: number, min: number, wide = false): { text: string; size: number } {
  let s = size;
  while (s > min && widthOf(text, s, wide) > maxW) s -= 2;
  if (widthOf(text, s, wide) <= maxW) return { text, size: s };
  let t = [...text];
  while (t.length > 1 && widthOf(t.join('') + '…', s, wide) > maxW) t = t.slice(0, -1);
  return { text: t.join('').trimEnd() + '…', size: s };
}
const time = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

// ===== Обложка и размытый фон (кэш) =====
const art = new Map<string, string | null>();
export async function artwork(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  if (art.has(url)) return art.get(url)!;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) }).catch(() => null);
  const type = res?.headers.get('content-type') ?? '';
  const data = res?.ok && /^image\//.test(type) ? `data:${type.split(';')[0]};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` : null;
  art.set(url, data);
  if (art.size > 60) art.delete(art.keys().next().value!);
  return data;
}
const backgrounds = new Map<string, string>();
function background(cover: string | null, key: string): string {
  const hit = backgrounds.get(key);
  if (hit) return hit;
  // Размытие считаем на маленьком холсте (275×100) — в 16 раз дешевле, при растяжении всё равно мягко.
  const w = W / 4, h = H / 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter></defs>
    <rect width="${w}" height="${h}" fill="${NIGHT}"/>
    ${cover ? `<image href="${cover}" x="-20" y="${-w / 2 + h / 2 - 20}" width="${w + 40}" height="${w + 40}" preserveAspectRatio="xMidYMid slice" filter="url(#b)"/>` : ''}
  </svg>`;
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: w }, font: { loadSystemFonts: false } }).render().asPng();
  const uri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  backgrounds.set(key, uri);
  if (backgrounds.size > 30) backgrounds.delete(backgrounds.keys().next().value!);
  return uri;
}

export type CardData = {
  title: string; author: string; requester?: string | null; cover: string | null; coverKey: string;
  position: number; duration: number; isStream: boolean; paused: boolean;
  next?: string | null; source?: string | null; label?: string | null;
};

export function nowCardSvg(d: CardData): string {
  const bg = background(d.cover, d.coverKey);
  const ax = 40, ay = 40, as = H - 80;           // обложка 320×320
  const tx = ax + as + 44, tw = W - tx - 48;      // правая колонка
  const label = d.paused ? 'НА ПАУЗЕ' : d.isStream ? 'ПРЯМОЙ ЭФИР' : d.label ?? 'СЕЙЧАС ИГРАЕТ';
  const title = fit(d.title, tw, 50, 28, true);
  const author = fit(d.author, tw, 32, 20);
  const who = d.requester ? fit(`заказал ${d.requester}`, tw, 22, 16) : null;
  const k = d.isStream || !d.duration ? 1 : Math.max(0, Math.min(1, d.position / d.duration));
  const by = 290, bw = tw, bh = 12;
  const next = d.next ? fit(`Дальше: ${d.next}`, tw, 20, 14) : null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="28"/></clipPath>
    <clipPath id="cover"><rect x="${ax}" y="${ay}" width="${as}" height="${as}" rx="22"/></clipPath>
    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${NIGHT}" stop-opacity="0.55"/><stop offset="0.45" stop-color="${NIGHT}" stop-opacity="0.8"/><stop offset="1" stop-color="#111214" stop-opacity="0.92"/>
    </linearGradient>
    <linearGradient id="fill" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8E9297"/><stop offset="1" stop-color="#F2F3F5"/></linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  <g clip-path="url(#card)">
    <image href="${bg}" width="${W}" height="${H}" preserveAspectRatio="none"/>
    <rect width="${W}" height="${H}" fill="url(#shade)"/>
    <rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="27" fill="none" stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="3"/>
  </g>
  <rect x="${ax + 6}" y="${ay + 12}" width="${as}" height="${as}" rx="22" fill="#000" opacity="0.35" filter="url(#glow)"/>
  ${d.cover ? `<image href="${d.cover}" x="${ax}" y="${ay}" width="${as}" height="${as}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cover)"/>`
    : `<rect x="${ax}" y="${ay}" width="${as}" height="${as}" rx="22" fill="#2B2D31"/><g transform="translate(${ax + as / 2 - 60} ${ay + as / 2 - 80}) scale(5)" fill="${SOFT}" fill-opacity="0.45"><path d="M9 3v10.55A4 4 0 1 0 11 17V7h4V3z"/></g>`}
  <rect x="${ax}" y="${ay}" width="${as}" height="${as}" rx="22" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="2"/>
  <text x="${tx}" y="84" font-family="Montserrat" font-weight="800" font-size="20" letter-spacing="4" fill="${d.paused ? SOFT : LABEL}" fill-opacity="${d.paused ? 0.8 : 0.92}">${label}</text>
  <text x="${tx}" y="${84 + 20 + title.size}" font-family="Unbounded" font-weight="800" font-size="${title.size}" fill="#F4F5F8">${esc(title.text)}</text>
  <text x="${tx}" y="${84 + 32 + title.size + author.size + 6}" font-family="Montserrat" font-weight="700" font-size="${author.size}" fill="${SOFT}">${esc(author.text)}</text>
  ${who ? `<text x="${tx}" y="${84 + 44 + title.size + author.size + who.size + 14}" font-family="Montserrat" font-weight="600" font-size="${who.size}" fill="#949BA4">${esc(who.text)}</text>` : ''}
  <rect x="${tx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="#FFFFFF" fill-opacity="0.16"/>
  ${d.isStream ? '' : `<rect x="${tx}" y="${by}" width="${Math.max(bh, bw * k)}" height="${bh}" rx="${bh / 2}" fill="url(#fill)"/>
  <circle cx="${tx + Math.max(bh / 2, bw * k)}" cy="${by + bh / 2}" r="12" fill="#FFFFFF"/>`}
  <text x="${tx}" y="${by + 46}" font-family="Montserrat" font-weight="700" font-size="24" fill="#DBDEE1">${d.isStream ? '● эфир' : time(d.position)}</text>
  <text x="${tx + bw}" y="${by + 46}" font-family="Montserrat" font-weight="700" font-size="24" fill="#949BA4" text-anchor="end">${d.isStream ? '' : time(d.duration)}</text>
  ${next ? `<text x="${tx}" y="${H - 22}" font-family="Montserrat" font-weight="600" font-size="${next.size}" fill="#80848E">${esc(next.text)}</text>` : ''}
  ${d.source ? `<text x="${W - 48}" y="84" font-family="Montserrat" font-weight="700" font-size="18" letter-spacing="2" fill="#80848E" text-anchor="end">${esc(d.source.toUpperCase())}</text>` : ''}
</svg>`;
}

export function nowCardPng(d: CardData): Buffer {
  return Buffer.from(new Resvg(nowCardSvg(d), {
    fitTo: { mode: 'width', value: W },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Montserrat' },
  }).render().asPng());
}
