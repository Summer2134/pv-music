/**
 * Тексты песен (04.11.2026, просьба владельца: «на lrclib не все тексты, на Genius есть все»).
 * Цепочка: lrclib.net (открытая база, без ключа) → mogtext.com (русский рэп, свежие релизы) → Genius (поиск: API с GENIUS_TOKEN или открытый поиск сайта;
 * сам текст — со страницы песни, в API Genius его нет) → lyrics.ovh (английские). Первый нашедший — ответ.
 * Если Genius не пускает сервер (403/капча), просто идём дальше.
 */
export type Lyrics = { title: string; text: string; source: string };
/** Отчёт по шагам для !!!текст: что спросили и что ответил каждый источник. */
export type Trace = string[];
type Fetch = typeof fetch;
let http: Fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(7000) });
export function _setLyricsFetch(f: Fetch): void { http = f; }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export const cleanTitle = (s: string) => s.replace(/\(.*?\)|\[.*?\]|official.*|lyrics?.*|video.*|клип.*|премьера.*|sped ?up.*|slowed.*/gi, '').replace(/\s+/g, ' ').trim();
const words = (s: string) => s.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);

// ===== lrclib =====
/** Исполнитель подходит: хотя бы одно слово из известных исполнителей (пусто — проверять не по чему). */
const artistOk = (artist: string, known: Set<string>) => !known.size || words(artist).some(w => known.has(w));
async function lrclib(title: string, author: string, duration?: number, tr?: Trace, known: Set<string> = new Set()): Promise<Lyrics | null> {
  const urls = [
    author ? `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(author)}${duration ? `&duration=${Math.round(duration / 1000)}` : ''}` : '',
    `https://lrclib.net/api/search?q=${encodeURIComponent(`${author} ${title}`.trim())}`,
  ].filter(Boolean);
  for (const url of urls) {
    const res = await http(url, { headers: { 'User-Agent': 'PV Music Discord bot' } }).catch(e => { tr?.push(`lrclib: сеть — ${(e as Error).message}`); return null; });
    if (!res?.ok) { if (res) tr?.push(`lrclib: ${res.status}`); continue; }
    const data = await res.json().catch(() => null) as any;
    const list = (Array.isArray(data) ? data : data ? [data] : []).filter((x: any) => x.plainLyrics);
    const item = list.find((x: any) => artistOk(x.artistName ?? '', known));
    if (!item) tr?.push(list.length ? `lrclib: есть только у других исполнителей (${list.slice(0, 2).map((x: any) => x.artistName).join(', ')})` : 'lrclib: пусто');
    if (item?.plainLyrics) return { title: `${item.artistName} — ${item.trackName}`, text: item.plainLyrics, source: 'lrclib.net' };
  }
  return null;
}

// ===== Genius =====
type Hit = { title: string; artist: string; url: string };
async function geniusSearch(q: string, tr?: Trace): Promise<Hit[]> {
  const token = process.env.GENIUS_TOKEN;
  const res = token
    ? await http(`https://api.genius.com/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA } }).catch(() => null)
    : await http(`https://genius.com/api/search/song?per_page=5&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } }).catch(() => null);
  if (!res?.ok) { tr?.push(`Genius поиск «${q}»: ${res ? `ответ ${res.status}${res.status === 403 ? ' (не пускает сервер)' : ''}` : 'нет связи'}`); if (res) console.warn('[текст] genius поиск', res.status); return []; }
  const data = await res.json().catch(() => null) as any;
  const hits = data?.response?.hits ?? data?.response?.sections?.flatMap((s: any) => s.hits ?? []) ?? [];
  tr?.push(`Genius поиск «${q}»: ${hits.length ? hits.slice(0, 3).map((h: any) => `${h.result?.primary_artist?.name ?? '?'} — ${h.result?.title ?? '?'}`).join('; ') : 'ничего'}`);
  return hits.map((h: any) => h.result).filter((r: any) => r?.url && r?.title)
    .map((r: any) => ({ title: r.title, artist: r.primary_artist?.name ?? r.artist_names ?? '', url: r.url }));
}
const decode = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
/** Блок <div …> целиком (с вложенными div) начиная с позиции открывающего тега. */
function divAt(html: string, start: number): { inner: string; end: number } | null {
  const open = html.indexOf('>', start);
  if (open < 0) return null;
  let depth = 1, i = open + 1;
  const re = /<div\b|<\/div>/gi;
  re.lastIndex = i;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].toLowerCase() === '</div>' ? -1 : 1;
    if (depth === 0) return { inner: html.slice(open + 1, m.index), end: m.index + 6 };
  }
  return null;
}
/** Текст со страницы Genius: все блоки data-lyrics-container, без служебных вставок (шапка «N Contributors…», переводы). */
export function geniusText(html: string): string | null {
  const parts: string[] = [];
  const re = /<div[^>]*data-lyrics-container="true"[^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const block = divAt(html, m.index);
    if (!block) continue;
    let inner = block.inner;
    // Служебные куски внутри контейнера помечены data-exclude-from-selection — вырезаем целиком.
    for (let x = inner.search(/<div[^>]*data-exclude-from-selection="true"/i); x >= 0; x = inner.search(/<div[^>]*data-exclude-from-selection="true"/i)) {
      const ex = divAt(inner, x);
      inner = ex ? inner.slice(0, x) + inner.slice(ex.end) : inner.slice(0, x);
    }
    parts.push(inner);
    re.lastIndex = block.end;
  }
  if (!parts.length) return null;
  const text = decode(parts.join('\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 20 ? text : null;
}
async function genius(title: string, author: string, tr?: Trace, known: Set<string> = new Set()): Promise<Lyrics | null> {
  const hits = await geniusSearch(`${author} ${title}`.trim(), tr);
  const want = words(title), who = words(author);
  const score = (h: Hit) => {
    const t = new Set(words(h.title)), a = new Set(words(h.artist));
    return want.filter(w => t.has(w)).length * 2 + who.filter(w => a.has(w)).length;
  };
  // Не берём первую попавшуюся: название должно совпасть хотя бы наполовину.
  const best = hits.filter(h => artistOk(h.artist, known) && want.filter(w => new Set(words(h.title)).has(w)).length >= Math.max(1, Math.ceil(want.length / 2)))
    .sort((a, b) => score(b) - score(a))[0];
  if (!best) { if (hits.length) tr?.push('Genius: название не совпало ни с одним результатом'); return null; }
  const res = await http(best.url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' } }).catch(() => null);
  if (!res?.ok) { tr?.push(`Genius страница: ${res ? `ответ ${res.status}${res.status === 403 ? ' (не пускает сервер)' : ''}` : 'нет связи'}`); if (res) console.warn('[текст] genius страница', res.status); return null; }
  const text = geniusText(await res.text());
  if (!text) tr?.push('Genius: страница открылась, но текста на ней нет (не выпущен или сменилась вёрстка)');
  return text ? { title: `${best.artist} — ${best.title}`, text, source: 'Genius' } : null;
}

// ===== mogtext.com (русский рэп и свежие релизы; сервер пускает, проверено !!!сайт 04.11.2026) =====
const TR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
/** Как mogtext строит адрес: «Общество Мёртвых Поэтов» → obschestvo-mertvyh-poetov. */
export const slugify = (s: string) => [...s.toLowerCase()].map(c => TR[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** Текст со страницы mogtext: блоки <pre class="lyrics-text"> (реклама делит текст на части). */
export function mogtextText(html: string): { text: string; artist: string; title: string } | null {
  const parts = [...html.matchAll(/<pre[^>]*class="lyrics-text"[^>]*>([\s\S]*?)<\/pre>/gi)].map(m => m[1]);
  if (!parts.length) return null;
  const text = decode(parts.join('\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
  const og = decode(/<meta property="og:title" content="([^"]*)"/i.exec(html)?.[1] ?? '').replace(/\s*\|\s*Текст песни.*$/i, '');
  const [artist, title] = og.split(/\s+[–—-]\s+/);
  return text.length > 20 ? { text, artist: artist ?? '', title: title ?? '' } : null;
}
async function mogtext(title: string, author: string, tr?: Trace, known: Set<string> = new Set()): Promise<Lyrics | null> {
  const base = 'https://mogtext.com';
  const want = slugify(title).split('-').filter(Boolean);
  const urls = new Set<string>();
  // 1) поиск сайта: берём ссылки /song/…, где в адресе есть все слова названия
  const q = `${author} ${title}`.trim();
  const res = await http(`${base}/search/?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' } }).catch(() => null);
  if (res?.ok) {
    const page = await res.text();
    for (const m of page.matchAll(/href="(\/song\/[a-z0-9-]+\/?)"/g)) {
      const slug = m[1].split('/')[2] ?? '';
      if (want.every(w => slug.split('-').includes(w))) urls.add(base + m[1]);
    }
    tr?.push(`mogtext поиск «${q}»: ${urls.size ? `${urls.size} подходящих` : 'ничего подходящего'}`);
  } else tr?.push(`mogtext поиск: ${res ? `ответ ${res.status}` : 'нет связи'}`);
  // 2) адрес напрямую: исполнитель-название
  if (author) urls.add(`${base}/song/${slugify(`${author} ${title}`)}/`);
  for (const url of [...urls].slice(0, 4)) {
    const r = await http(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' } }).catch(() => null);
    if (!r?.ok) continue;
    const got = mogtextText(await r.text());
    if (!got) continue;
    if (!artistOk(got.artist, known)) { tr?.push(`mogtext: ${got.artist} — ${got.title} — другой исполнитель`); continue; }
    return { title: `${got.artist} — ${got.title}`, text: got.text, source: 'mogtext.com' };
  }
  return null;
}

// ===== lyrics.ovh =====
async function lyricsOvh(title: string, author: string): Promise<Lyrics | null> {
  if (!author) return null;
  const res = await http(`https://api.lyrics.ovh/v1/${encodeURIComponent(author)}/${encodeURIComponent(title)}`).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) as { lyrics?: string } | null : null;
  return data?.lyrics?.trim() ? { title: `${author} — ${title}`, text: data.lyrics.trim(), source: 'lyrics.ovh' } : null;
}

/**
 * Варианты «исполнитель + название». На SoundCloud исполнитель часто — ник залившего, а настоящий стоит в названии:
 * «OG Buda, Villian — 101 причина». Поэтому пробуем: как есть → из названия с тире → только название.
 */
export function variants(rawTitle: string, rawAuthor = ''): Array<{ title: string; author: string }> {
  const title = cleanTitle(rawTitle), author = cleanTitle(rawAuthor.replace(/\s*-\s*topic$/i, ''));
  const out = [{ title, author }];
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
  if (dash) out.push({ title: dash[2].trim(), author: dash[1].replace(/\s*(feat\.?|ft\.?|x|&)\s.*$/i, '').split(',')[0].trim() });
  out.push({ title: dash ? dash[2].trim() : title, author: '' });
  return out.filter((v, k) => v.title && out.findIndex(o => o.title === v.title && o.author === v.author) === k);
}
/**
 * Разметка куплетов/припевов, если её нет (mogtext отдаёт сплошной список строк, просьба владельца 04.11.2026).
 * Припев — самый длинный кусок из 3+ строк, который повторяется; между повторами — куплеты, хвост — аутро.
 * Текст с готовой разметкой ([Припев], пустые строки между блоками) не трогаем.
 */
export function structure(text: string): string {
  const raw = text.split('\n');
  if (/^\s*\[[^\]]+\]\s*$/m.test(text) || raw.filter(l => !l.trim()).length >= 3) return text;
  const lines = raw.map(l => l.trim()).filter(Boolean);
  const key = (l: string) => l.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const k = lines.map(key);
  let best: { at: number[]; len: number } | null = null;
  for (let i = 0; i < k.length; i++) for (let j = i + 3; j < k.length; j++) {
    let len = 0;
    while (j + len < k.length && i + len < j && k[i + len] === k[j + len]) len++;
    if (len >= 3 && (!best || len > best.len)) {
      // все неперекрывающиеся повторы этого куска
      const at: number[] = [];
      for (let x = 0; x + len <= k.length; x++) if (k.slice(x, x + len).join('\n') === k.slice(i, i + len).join('\n') && (!at.length || x >= at.at(-1)! + len)) at.push(x);
      best = { at, len };
    }
  }
  if (!best) return text;
  const out: string[] = [];
  let pos = 0, verse = 0;
  const push = (from: number, to: number, last: boolean) => {
    if (to <= from) return;
    const label = to - from < 4 && from === 0 ? 'Интро' : last ? 'Аутро' : `Куплет ${++verse}`; // хвост после последнего припева — аутро
    out.push(`[${label}]`, ...lines.slice(from, to), '');
  };
  for (const at of best.at) { push(pos, at, false); out.push('[Припев]', ...lines.slice(at, at + best.len), ''); pos = at + best.len; }
  push(pos, lines.length, true);
  return out.join('\n').trim();
}

export async function findLyrics(query: { title: string; author?: string; duration?: number }, tr?: Trace): Promise<Lyrics | null> {
  const vs = variants(query.title, query.author);
  // Известные исполнители (из поля и из названия): песню с тем же названием, но другого артиста не берём
  // (было: «101 причина» Villian → нашёлся Kai Angel). Сначала варианты с исполнителем, потом только название.
  const known = new Set(vs.flatMap(v => words(v.author)));
  const withAuthor = vs.filter(v => v.author), titleOnly = vs.filter(v => !v.author);
  const steps: Array<() => Promise<Lyrics | null>> = [
    ...withAuthor.flatMap(v => [() => lrclib(v.title, v.author, query.duration, tr, known), () => mogtext(v.title, v.author, tr, known), () => genius(v.title, v.author, tr, known)]),
    ...titleOnly.flatMap(v => [() => lrclib(v.title, '', undefined, tr, known), () => mogtext(v.title, '', tr, known), () => genius(v.title, '', tr, known)]),
    ...withAuthor.map(v => () => lyricsOvh(v.title, v.author)),
  ];
  for (const step of steps) {
    const r = await step().catch(e => { tr?.push(`ошибка: ${(e as Error).message}`); return null; });
    if (r) { tr?.push(`✅ нашёл: ${r.source} — ${r.title}`); return { ...r, text: structure(r.text) }; }
  }
  tr?.push('❌ нигде не нашёл');
  return null;
}
