import type { LavalinkManager, SearchResult, Track } from 'lavalink-client';
import { isUrl } from './format.js';
import * as SC from './soundcloud.js';
import * as L from './links.js';

/**
 * Поиск (04.11.2026, ночь): основной источник — свой SoundCloud (`soundcloud.ts`: API напрямую, звук через ffmpeg).
 * Текст — поиск SoundCloud. Ссылка SoundCloud — через его API. Ссылка YouTube/Spotify — название через Lavalink
 * (метаданные работают, не работает только звук) → тот же трек на SoundCloud. Прочие ссылки (mp3, радио) — Lavalink как есть.
 * Lavalink получает http://127.0.0.1:2334/sc/<id>.ogg, а в карточке трека — нормальные название, автор, обложка и ссылка.
 */
const MAX_LIST = 25;
let ytBrokenUntil = 0;
/** Совместимость с плеером: после ошибки YouTube-трека 10 мин не пробуем YouTube. */
export function markYoutubeBroken(ms = 10 * 60_000): void { ytBrokenUntil = Date.now() + ms; }
export const youtubeBroken = () => Date.now() < ytBrokenUntil;
const isSc = (u: string) => /(^|\.)soundcloud\.com/i.test((() => { try { return new URL(u).hostname; } catch { return ''; } })());

/** SoundCloud-трек → трек Lavalink (поток через наш ffmpeg) с настоящими названием/обложкой/длиной. */
export async function scTrack(lava: LavalinkManager, t: SC.ScTrack, requester: unknown): Promise<Track | null> {
  const node = lava.nodeManager.leastUsedNodes()[0];
  if (!node) throw new Error('NO_NODE');
  const r = await node.search({ query: SC.streamUrl(t.id) }, requester)
    .catch(e => { console.warn('[soundcloud] lavalink не открыл поток', t.id, (e as Error).message); return null; });
  const track = r?.tracks?.[0];
  if (!track) {
    if (r) console.warn('[soundcloud] lavalink не открыл поток', t.id, r.loadType, JSON.stringify((r as { exception?: unknown }).exception ?? null).slice(0, 300));
    return null;
  }
  const i = SC.infoOf(t);
  Object.assign(track.info, {
    title: i.title, author: i.author, duration: i.duration, uri: i.uri, artworkUrl: i.artworkUrl,
    identifier: `sc:${i.id}`, sourceName: 'soundcloud', isStream: false, isSeekable: false,
  });
  return track;
}
async function scTracks(lava: LavalinkManager, list: SC.ScTrack[], requester: unknown): Promise<Track[]> {
  const out: Track[] = [];
  for (let k = 0; k < list.length; k += 5) {
    const part = await Promise.all(list.slice(k, k + 5).map(t => scTrack(lava, t, requester).catch(() => null)));
    for (const t of part) if (t) out.push(t);
  }
  return out;
}
const result = (tracks: Track[], playlist: string | null): SearchResult | null => tracks.length
  ? { loadType: playlist ? 'playlist' : 'track', exception: null, pluginInfo: {}, playlist: playlist ? { name: playlist, title: playlist, author: null, thumbnail: null, uri: null, selectedTrack: null, duration: 0 } as never : null, tracks }
  : null;

/** Убрать хвосты «поделиться» (?si=, utm_…, #) у SoundCloud; у остальных — только utm/si/fbclid. */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    if (/(^|\.)soundcloud\.com$/i.test(u.hostname) && !/^on\./i.test(u.hostname)) u.search = '';
    else for (const k of [...u.searchParams.keys()]) if (/^(si|utm_|fbclid|feature|pp$)/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\?$/, '');
  } catch { return raw.trim(); }
}
/** Слова из пути ссылки для поиска: «/deathmarrried/sopranos-1» → «deathmarrried sopranos». */
export function slugWords(raw: string): string {
  try {
    const u = new URL(raw);
    if (/youtu/i.test(u.hostname)) return '';
    return u.pathname.split('/').filter(Boolean).filter(x => !/^(sets|tracks|track|album|playlist|s-[\w]+)$/i.test(x)).slice(0, 2)
      .join(' ').replace(/[-_]+/g, ' ').replace(/\b\d{1,3}\b/g, ' ').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

export async function resolve(lava: LavalinkManager, query: string, requester: unknown): Promise<SearchResult | null> {
  const node = lava.nodeManager.leastUsedNodes()[0];
  if (!node) throw new Error('NO_NODE');
  const q = query.trim();
  if (!isUrl(q)) {
    const found = await SC.searchTracks(q, 5).catch(e => { console.warn('[soundcloud] поиск', e.message); return []; });
    const t = found[0] && await scTrack(lava, found[0], requester);
    return t ? result([t], null) : null;
  }
  const url = cleanUrl(q);
  if (isSc(url)) {
    const r = await SC.resolveUrl(url, MAX_LIST).catch(e => { console.warn('[soundcloud] ссылка', e.message); return null; });
    if (r?.tracks.length) return result(await scTracks(lava, r.tracks.slice(0, r.playlist ? MAX_LIST : 1), requester), r.playlist);
    const words = slugWords(url);
    return words ? resolve(lava, words, requester) : null;
  }
  // Spotify и Яндекс Музыка: название с их страниц/API → тот же трек на SoundCloud.
  if (L.isSpotify(url) || L.isYandex(url)) {
    const list = await L.foreignTracks(url, MAX_LIST).catch(e => { console.warn('[ссылка]', e.message); return null; });
    if (!list?.tracks.length) return null;
    const out: Track[] = [];
    for (let k = 0; k < list.tracks.length; k += 5) {
      const part = await Promise.all(list.tracks.slice(k, k + 5).map(f =>
        soundcloudTwin(lava, { info: { title: f.title, author: f.author, duration: f.duration }, requester } as unknown as Track).catch(() => null)));
      for (const t of part) if (t) out.push(t);
    }
    return out.length ? result(out, list.playlist) : null;
  }
  // YouTube, Spotify и прочее: берём название у Lavalink; YouTube/Spotify-трек ищем на SoundCloud.
  const r = await node.search({ query: url }, requester).catch(() => null);
  if (!r || !r.tracks.length || r.loadType === 'error') { const words = slugWords(url); return words ? resolve(lava, words, requester) : null; }
  const foreign = r.tracks.filter(t => /youtube|spotify|applemusic|deezer|yandex|vk/i.test(t.info.sourceName ?? ''));
  if (!foreign.length) return r; // mp3, радио, bandcamp — как есть
  const src = r.loadType === 'playlist' ? r.tracks.slice(0, MAX_LIST) : r.tracks.slice(0, 1);
  const out: Track[] = [];
  for (let k = 0; k < src.length; k += 5) {
    const part = await Promise.all(src.slice(k, k + 5).map(t => soundcloudTwin(lava, t).catch(() => null)));
    for (const t of part) if (t) out.push(t);
  }
  return result(out, r.loadType === 'playlist' ? r.playlist?.name ?? 'плейлист' : null);
}

/** Подсказки: прямо из API SoundCloud (быстро, без Lavalink). value — ссылка на трек. */
const hints = new Map<string, { at: number; list: SC.ScInfo[] }>();
export async function suggestInfo(query: string): Promise<SC.ScInfo[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2 || isUrl(q)) return [];
  const hit = hints.get(q);
  if (hit && Date.now() - hit.at < 120_000) return hit.list;
  const timeout = new Promise<null>(r => setTimeout(() => r(null), 2300));
  const r = await Promise.race([SC.searchTracks(q, 10).catch(() => null), timeout]);
  const list = (r ?? []).map(SC.infoOf);
  if (r) { hints.set(q, { at: Date.now(), list }); if (hints.size > 500) hints.delete(hints.keys().next().value!); }
  return list;
}

/** Подсказки для автодополнения: кэш на минуту, не дольше 2,3 с (у Discord 3 с на ответ). */
const cache = new Map<string, { at: number; tracks: Track[] }>();
export async function suggest(lava: LavalinkManager, query: string): Promise<Track[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2 || isUrl(q)) return [];
  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < 60_000) return hit.tracks;
  const timeout = new Promise<null>(r => setTimeout(() => r(null), 2300));
  const r = await Promise.race([resolve(lava, query, null).catch(() => null), timeout]);
  const tracks = (r?.tracks ?? []).slice(0, 10);
  if (r) {
    cache.set(q, { at: Date.now(), tracks });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return tracks;
}

/**
 * Тот же трек на SoundCloud (когда YouTube не отдал звук). Сначала «исполнитель + название» со сверкой,
 * потом просто название, в крайнем случае — первый результат близкой длины. Лучше похожий трек, чем тишина.
 */
export async function soundcloudTwin(lava: LavalinkManager, t: Track): Promise<Track | null> {
  const author = (t.info.author ?? '').replace(/\s*-\s*topic$/i, '').trim();
  const title = t.info.title.replace(/\(.*?(official|video|audio|lyric|клип|премьера).*?\)|\[.*?\]/gi, '').trim();
  const words = (x: string) => x.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);
  const want = words(title), who = words(author);
  const near = (x: SC.ScInfo, k: number) => !t.info.duration || Math.abs(x.duration - t.info.duration) <= t.info.duration * k;
  const score = (x: SC.ScInfo) => {
    const have = new Set([...words(x.title), ...words(x.author)]);
    return want.filter(w => have.has(w)).length * 2 + who.filter(w => have.has(w)).length;
  };
  for (const q of [`${author} ${title}`.trim(), title]) {
    const list = await SC.searchTracks(q, 10).catch(() => [] as SC.ScTrack[]);
    const infos = list.map(x => ({ x, i: SC.infoOf(x) }));
    const best = infos.filter(({ i }) => score(i) >= Math.max(1, Math.ceil(want.length / 2)) && near(i, 0.4)).sort((a, b) => score(b.i) - score(a.i))[0]
      ?? (q === title ? infos.find(({ i }) => near(i, 0.25)) : undefined);
    if (best) return scTrack(lava, best.x, t.requester);
  }
  return null;
}
