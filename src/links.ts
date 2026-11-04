/**
 * Ссылки Spotify и Яндекс Музыки (04.11.2026, просьба владельца: «чтобы все ссылки можно было кидать»).
 * Звук ни Spotify, ни Яндекс сторонним ботам не отдают — берём название, исполнителя и длину,
 * а играем тот же трек с SoundCloud (soundcloudTwin в search.ts). Плейлисты и альбомы — до max треков.
 *  Spotify: встраиваемый плеер open.spotify.com/embed/... (без ключей), запасной путь — og-теги страницы.
 *  Яндекс: открытое API api.music.yandex.net (YANDEX_MUSIC_TOKEN необязателен — помогает, если API не пускает), запасной — og-теги.
 */
export type ForeignTrack = { title: string; author: string; duration: number };
export type ForeignList = { tracks: ForeignTrack[]; playlist: string | null };

type Fetch = typeof fetch;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
let http: Fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
export function _setLinksFetch(f: Fetch): void { http = f; }

const host = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
export const isSpotify = (u: string) => /(^|\.)spotify\.(com|link)$/.test(host(u)) || /^spotify\.link$/.test(host(u));
export const isYandex = (u: string) => /^music\.yandex\.(ru|com|by|kz|uz)$/.test(host(u));

const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const meta = (html: string, prop: string) => {
  const m = new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i').exec(html)
    ?? new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, 'i').exec(html);
  return m ? unescape(m[1]).trim() : '';
};
async function page(url: string): Promise<string> {
  const r = await http(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ===== Spotify =====
type SpEntity = { name?: string; title?: string; artists?: Array<{ name: string }>; subtitle?: string; duration?: number;
  trackList?: Array<{ title: string; subtitle?: string; duration?: number }> };
export async function spotifyTracks(raw: string, max = 25): Promise<ForeignList | null> {
  let url = raw;
  if (/spotify\.link$/.test(host(url))) { // короткая ссылка из приложения
    const r = await http(url, { redirect: 'manual', headers: { 'User-Agent': UA } }).catch(() => null);
    const loc = r?.headers.get('location');
    if (loc) url = loc;
  }
  const m = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i.exec(url);
  if (!m) return null;
  const [, kind, id] = m;
  try {
    const html = await page(`https://open.spotify.com/embed/${kind}/${id}`);
    const json = /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
    const e = json ? (JSON.parse(json)?.props?.pageProps?.state?.data?.entity as SpEntity | undefined) : undefined;
    if (e) {
      if (kind === 'track') {
        const author = e.artists?.map(a => a.name).join(', ') || e.subtitle || '';
        return { tracks: [{ title: e.name ?? e.title ?? '', author, duration: e.duration ?? 0 }].filter(t => t.title), playlist: null };
      }
      const tracks = (e.trackList ?? []).slice(0, max).map(t => ({ title: t.title, author: t.subtitle ?? '', duration: t.duration ?? 0 })).filter(t => t.title);
      if (tracks.length) return { tracks, playlist: e.name ?? e.title ?? 'плейлист Spotify' };
    }
  } catch (err) { console.warn('[spotify] embed', (err as Error).message); }
  // Запасной путь — og-теги обычной страницы (только для трека: «Артист · Альбом · Песня · Год»).
  if (kind !== 'track') return null;
  const html = await page(`https://open.spotify.com/track/${id}`).catch(() => '');
  const title = meta(html, 'og:title'), desc = meta(html, 'og:description');
  return title ? { tracks: [{ title, author: desc.split('·')[0]?.trim() ?? '', duration: 0 }], playlist: null } : null;
}

// ===== Яндекс Музыка =====
type YaTrack = { title: string; version?: string; artists?: Array<{ name: string }>; durationMs?: number; available?: boolean };
const yaTrack = (t: YaTrack): ForeignTrack => ({
  title: t.version ? `${t.title} (${t.version})` : t.title, author: (t.artists ?? []).map(a => a.name).join(', '), duration: t.durationMs ?? 0 });
async function yaApi<T>(path: string): Promise<T> {
  const token = process.env.YANDEX_MUSIC_TOKEN;
  const r = await http(`https://api.music.yandex.net${path}`, { headers: { 'User-Agent': UA, ...(token ? { Authorization: `OAuth ${token}` } : {}) } });
  if (!r.ok) throw new Error(`Яндекс ${r.status}`);
  return ((await r.json()) as { result: T }).result;
}
export async function yandexTracks(url: string, max = 25): Promise<ForeignList | null> {
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  const track = /\/track\/(\d+)/.exec(path)?.[1];
  const album = /\/album\/(\d+)/.exec(path)?.[1];
  const userPl = /\/users\/([^/]+)\/playlists\/(\d+)/.exec(path);
  const uuidPl = /\/playlists\/((?:lk\.)?[0-9a-f-]{20,})/i.exec(path)?.[1];
  try {
    if (track) {
      const [t] = await yaApi<YaTrack[]>(`/tracks/${track}`);
      return t ? { tracks: [yaTrack(t)], playlist: null } : null;
    }
    if (album) {
      const a = await yaApi<{ title: string; volumes?: YaTrack[][] }>(`/albums/${album}/with-tracks`);
      return { tracks: (a.volumes ?? []).flat().slice(0, max).map(yaTrack), playlist: a.title };
    }
    if (userPl || uuidPl) {
      const pl = await yaApi<{ title: string; tracks?: Array<{ track?: YaTrack }> }>(userPl ? `/users/${userPl[1]}/playlists/${userPl[2]}` : `/playlist/${uuidPl}`);
      return { tracks: (pl.tracks ?? []).map(x => x.track).filter((x): x is YaTrack => Boolean(x?.title)).slice(0, max).map(yaTrack), playlist: pl.title };
    }
  } catch (err) { console.warn('[яндекс] api', (err as Error).message); }
  // Запасной путь — заголовок страницы: «Песня — Артист. Слушать онлайн на Яндекс Музыке».
  if (!track) return null;
  const html = await page(url).catch(() => '');
  const og = meta(html, 'og:title') || (/<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '');
  const [title, author] = unescape(og).replace(/\.?\s*(Слушать онлайн|Listen online).*$/i, '').split(/\s+[—–-]\s+/);
  return title && !/яндекс/i.test(title) ? { tracks: [{ title: title.trim(), author: (author ?? '').trim(), duration: 0 }], playlist: null } : null;
}

export async function foreignTracks(url: string, max = 25): Promise<ForeignList | null> {
  if (isSpotify(url)) return spotifyTracks(url, max);
  if (isYandex(url)) return yandexTracks(url, max);
  return null;
}
