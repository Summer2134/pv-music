import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';

/**
 * Свой SoundCloud (04.11.2026): встроенный в Lavalink SoundCloud сломан — SoundCloud перешёл на AAC HLS,
 * а lavaplayer 2.2.6 его не понимает («Did not detect any supported formats»). YouTube режет IP сервера.
 * Поэтому: поиск и ссылки — напрямую через api-v2.soundcloud.com (client_id берём со страницы сайта, как браузер),
 * звук — ffmpeg (понимает любой HLS) → Ogg Opus → наш локальный HTTP 127.0.0.1:STREAM_PORT → Lavalink играет
 * его как обычную http-ссылку. Плеер, очередь и статистика работают как раньше.
 */
export const STREAM_PORT = Number(process.env.MUSIC_STREAM_PORT ?? 2334);
const API = 'https://api-v2.soundcloud.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export type ScTranscoding = { url: string; preset?: string; format: { protocol: string; mime_type: string }; snipped?: boolean };
export type ScTrack = {
  id: number; title: string; duration: number; full_duration?: number; permalink_url: string; artwork_url: string | null;
  user?: { username: string; avatar_url?: string }; streamable?: boolean; policy?: string; kind?: string;
  media?: { transcodings: ScTranscoding[] }; track_authorization?: string; publisher_metadata?: { artist?: string } | null;
  genre?: string | null; tag_list?: string; playback_count?: number; likes_count?: number;
};
export type ScInfo = { id: number; title: string; author: string; duration: number; uri: string; artworkUrl: string | null };

type Fetch = typeof fetch;
let http: Fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
export function _setFetch(f: Fetch): void { http = f; clientId = ''; }

// ===== client_id: тот же, что у веб-версии; меняется раз в несколько дней — обновляем по 401/403 =====
let clientId = '';
let clientIdAt = 0;
let clientIdPending: Promise<string> | null = null;
export async function getClientId(force = false): Promise<string> {
  if (process.env.SOUNDCLOUD_CLIENT_ID) return process.env.SOUNDCLOUD_CLIENT_ID;
  if (!force && clientId && Date.now() - clientIdAt < 6 * 3_600_000) return clientId;
  clientIdPending ??= (async () => {
    const page = await (await http('https://soundcloud.com/', { headers: { 'User-Agent': UA } })).text();
    const scripts = [...page.matchAll(/<script[^>]+src="(https:\/\/[^"]+\.js)"/g)].map(m => m[1]).filter(u => /sndcdn\.com/.test(u)).reverse();
    for (const src of scripts.slice(0, 8)) {
      const js = await (await http(src, { headers: { 'User-Agent': UA } })).text().catch(() => '');
      const m = /client_id\s*[:=]\s*"([A-Za-z0-9]{32})"/.exec(js) ?? /[?&]client_id=([A-Za-z0-9]{32})/.exec(js);
      if (m) { clientId = m[1]; clientIdAt = Date.now(); return clientId; }
    }
    throw new Error('SoundCloud: не нашёл client_id на странице');
  })().finally(() => { clientIdPending = null; });
  return clientIdPending;
}

async function api<T>(path: string, params: Record<string, string | number> = {}, retry = true): Promise<T> {
  const id = await getClientId();
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), client_id: id });
  const res = await http(`${path.startsWith('http') ? path : API + path}${path.includes('?') ? '&' : '?'}${qs}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if ((res.status === 401 || res.status === 403) && retry) { await getClientId(true); return api<T>(path, params, false); }
  if (!res.ok) throw new Error(`SoundCloud ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Форматы по порядку попыток. HLS первым: progressive mp3 SoundCloud ещё показывает в списке, но отдаёт 404
 * (проверено на сервере 04.11.2026: «SoundCloud 404» на каждом треке). DRM и обрезки — никогда.
 */
export function rankTranscodings(t: ScTrack): ScTranscoding[] {
  // Как у yt-dlp: без url/preset, abr-пресеты («сломанные»), превью и DRM — мимо.
  const list = (t.media?.transcodings ?? []).filter(x => x.url && x.preset && !/encrypted|^(ctr|cbc)-/i.test(x.format.protocol)
    && !x.snipped && !/^abr/i.test(x.preset) && !/\/preview\//.test(x.url));
  const rank = (x: ScTranscoding) => (x.format.protocol === 'hls' ? 0 : 10) + (/mpeg/.test(x.format.mime_type) ? 0 : /opus|ogg/.test(x.format.mime_type) ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b));
}
export const pickTranscoding = (t: ScTrack): ScTranscoding | null => rankTranscodings(t)[0] ?? null;
export const playable = (t: ScTrack) => t.kind !== 'playlist' && t.policy !== 'BLOCK' && Boolean(pickTranscoding(t));
export function infoOf(t: ScTrack): ScInfo {
  return {
    id: t.id, title: t.title, author: t.publisher_metadata?.artist || t.user?.username || 'SoundCloud',
    duration: t.full_duration ?? t.duration ?? 0, uri: t.permalink_url,
    artworkUrl: (t.artwork_url ?? t.user?.avatar_url ?? null)?.replace('-large.', '-t500x500.') ?? null,
  };
}

// Кэш треков (для потока нужны транскодинги; ищем по id).
const tracks = new Map<number, { t: ScTrack; at: number }>();
const remember = (t: ScTrack) => { tracks.set(t.id, { t, at: Date.now() }); if (tracks.size > 2000) tracks.delete(tracks.keys().next().value!); return t; };

export async function searchTracks(q: string, limit = 10): Promise<ScTrack[]> {
  const r = await api<{ collection: ScTrack[] }>('/search/tracks', { q, limit: Math.min(50, limit * 2), linked_partitioning: 1 });
  return r.collection.filter(playable).slice(0, limit).map(remember);
}

/** «Похожие» SoundCloud к треку — основа волны. */
export async function relatedTracks(id: number, limit = 20): Promise<ScTrack[]> {
  const r = await api<{ collection: ScTrack[] }>(`/tracks/${id}/related`, { limit: Math.min(50, limit) });
  return r.collection.filter(playable).map(remember);
}
/** Поиск по жанру/тегу (настроение и занятие волны). */
export async function tagTracks(tag: string, limit = 20, offset = 0): Promise<ScTrack[]> {
  const r = await api<{ collection: ScTrack[] }>('/search/tracks', { q: '*', 'filter.genre_or_tag': tag, limit: Math.min(50, limit), offset });
  return r.collection.filter(playable).map(remember);
}
/** Несколько треков по id (данные из кэша, недостающие — пачкой). */
export async function tracksByIds(ids: number[]): Promise<ScTrack[]> {
  const out: ScTrack[] = [], need: number[] = [];
  for (const id of ids) { const hit = tracks.get(id); if (hit && Date.now() - hit.at < 3_600_000) out.push(hit.t); else need.push(id); }
  for (let k = 0; k < need.length; k += 50) out.push(...(await api<ScTrack[]>('/tracks', { ids: need.slice(k, k + 50).join(',') }).catch(() => [])).filter(playable).map(remember));
  return out;
}

/** Ссылка SoundCloud (трек, плейлист/альбом, короткая on.soundcloud.com) → треки. */
export async function resolveUrl(url: string, max = 100): Promise<{ tracks: ScTrack[]; playlist: string | null }> {
  // Короткие ссылки on.soundcloud.com — сначала узнаём, куда ведут.
  if (/^https?:\/\/on\.soundcloud\.com\//i.test(url)) {
    const r = await http(url, { redirect: 'manual', headers: { 'User-Agent': UA } }).catch(() => null);
    const loc = r?.headers.get('location');
    if (loc) url = loc.split('?')[0];
  }
  const r = await api<ScTrack & { tracks?: ScTrack[]; title: string }>('/resolve', { url });
  if (r.kind === 'track') return { tracks: playable(r) ? [remember(r)] : [], playlist: null };
  if (r.kind === 'playlist' || r.tracks) {
    const items = (r.tracks ?? []).slice(0, max);
    // В плейлисте полные данные только у первых ~5 треков, остальные — одни id: догружаем пачками по 50.
    const missing = items.filter(x => !x.media).map(x => x.id);
    const full = new Map<number, ScTrack>();
    for (let k = 0; k < missing.length; k += 50) {
      const part = await api<ScTrack[]>('/tracks', { ids: missing.slice(k, k + 50).join(',') }).catch(() => []);
      for (const x of part) full.set(x.id, x);
    }
    const list = items.map(x => (x.media ? x : full.get(x.id))).filter((x): x is ScTrack => Boolean(x) && playable(x!));
    return { tracks: list.map(remember), playlist: r.title ?? 'плейлист' };
  }
  return { tracks: [], playlist: null };
}

async function trackById(id: number): Promise<ScTrack | null> {
  const hit = tracks.get(id);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.t;
  const r = await api<ScTrack[]>('/tracks', { ids: String(id) }).catch(() => []);
  return r[0] ? remember(r[0]) : null;
}

/** Ссылка на сам звук (m3u8 или mp3), живёт несколько минут — берём заново на каждое воспроизведение. Перебираем форматы. */
const mediaCache = new Map<number, { url: string; at: number }>();
/** Lavalink открывает поток дважды (проба + игра) — ссылку держим 2 мин, чтобы не дёргать SoundCloud зря. */
export async function mediaUrl(t: ScTrack): Promise<string> {
  const hit = mediaCache.get(t.id);
  if (hit && Date.now() - hit.at < 120_000) return hit.url;
  const url = await mediaUrlFresh(t);
  mediaCache.set(t.id, { url, at: Date.now() });
  if (mediaCache.size > 300) mediaCache.delete(mediaCache.keys().next().value!);
  return url;
}
async function mediaUrlFresh(t: ScTrack): Promise<string> {
  const list = rankTranscodings(t);
  if (!list.length) throw new Error('нет доступного формата (DRM?)');
  let last: Error | null = null;
  for (const tr of list) {
    try {
      const r = await api<{ url: string }>(tr.url, t.track_authorization ? { track_authorization: t.track_authorization } : {});
      if (r?.url) return r.url;
    } catch (e) { last = e as Error; }
  }
  // Свежие данные трека (track_authorization живёт недолго) — ещё одна попытка, потом yt-dlp.
  const fresh = (await api<ScTrack[]>('/tracks', { ids: String(t.id) }).catch(() => []))[0];
  if (fresh && fresh.track_authorization !== t.track_authorization) {
    remember(fresh);
    for (const tr of rankTranscodings(fresh)) {
      const r = await api<{ url: string }>(tr.url, fresh.track_authorization ? { track_authorization: fresh.track_authorization } : {}).catch(() => null);
      if (r?.url) return r.url;
    }
  }
  const viaDlp = await ytdlpUrl(t.permalink_url).catch(e => { last = e as Error; return null; });
  if (viaDlp) return viaDlp;
  throw last ?? new Error('SoundCloud не отдал звук');
}

/** Запасной путь: yt-dlp сам разбирается с SoundCloud (ставится setup.sh, YTDLP_PATH). */
export let ytdlpPath = process.env.YTDLP_PATH ?? 'yt-dlp';
export const ytdlpStats = { ok: 0, failed: 0, lastError: '' };
export function ytdlpUrl(permalink: string): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(ytdlpPath, ['-f', 'bestaudio/best', '-g', '--no-playlist', '--no-warnings', '--quiet', permalink], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 25_000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err = (err + d).slice(-400); });
    p.on('error', e => { clearTimeout(timer); ytdlpStats.failed++; ytdlpStats.lastError = e.message; fail(new Error(`yt-dlp: ${e.message}`)); });
    p.on('close', code => {
      clearTimeout(timer);
      const url = out.split('\n').map(x => x.trim()).find(x => /^https?:\/\//.test(x));
      if (code === 0 && url) { ytdlpStats.ok++; ok(url); } else { ytdlpStats.failed++; ytdlpStats.lastError = err.trim() || `код ${code}`; fail(new Error(`yt-dlp: ${ytdlpStats.lastError}`)); }
    });
  });
}

export const streamUrl = (id: number, startMs = 0) => `http://127.0.0.1:${STREAM_PORT}/sc/${id}.ogg${startMs > 0 ? `?t=${Math.round(startMs)}` : ''}`;
export const streamIdOf = (uri: string) => { const m = /\/sc\/(\d+)\.ogg/.exec(uri); return m ? Number(m[1]) : null; };

// ===== Локальный поток для Lavalink =====
let server: Server | null = null;
const procs = new Set<ChildProcess>();
export let ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const streamStats = { started: 0, failed: 0, lastError: '' };

export function startStreamServer(port = STREAM_PORT): Promise<Server> {
  if (server) return Promise.resolve(server);
  const s = createServer(async (req, res) => {
    const m = /^\/sc\/(\d+)\.ogg(?:\?t=(\d+))?$/.exec(req.url ?? '');
    if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404).end(); return; }
    const start = Number(m[2] ?? 0);
    try {
      const t = await trackById(Number(m[1]));
      if (!t) { res.writeHead(404).end(); return; }
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'audio/ogg' }).end(); return; }
      const src = await mediaUrl(t);
      const ff = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4', '-seg_max_retry', '3',
        ...(start ? ['-ss', (start / 1000).toFixed(2)] : []),
        '-user_agent', UA, '-i', src,
        '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '128k', '-flush_packets', '1', '-f', 'ogg', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      procs.add(ff);
      streamStats.started++;
      let err = '', started = false;
      ff.stderr.on('data', d => { err = (err + d).slice(-500); });
      // Заголовки — только когда ffmpeg выдал первые байты: сломанный источник = честный 502, а не пустой 200.
      ff.stdout.once('data', chunk => {
        started = true;
        res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store' });
        res.write(chunk);
        ff.stdout.pipe(res);
      });
      const stop = () => { if (!ff.killed) ff.kill('SIGKILL'); };
      req.on('close', stop);
      res.on('close', stop);
      ff.on('error', e => {
        streamStats.failed++; streamStats.lastError = `ffmpeg: ${e.message}`;
        console.warn('[soundcloud] ffmpeg не запустился', e.message);
        if (!res.headersSent) res.writeHead(502).end(); else res.destroy();
      });
      ff.on('close', code => {
        procs.delete(ff);
        if (!started) {
          streamStats.failed++; streamStats.lastError = `ffmpeg ${code}: ${err.trim() || 'нет звука'}`.slice(0, 400);
          console.warn('[soundcloud] ffmpeg без звука', m[1], code, err.trim());
          if (!res.headersSent) res.writeHead(502).end();
        } else if (code && code !== 255 && err) { streamStats.lastError = err.trim(); console.warn('[soundcloud] ffmpeg', code, err.trim()); }
      });
    } catch (e) {
      streamStats.failed++; streamStats.lastError = (e as Error).message;
      console.warn('[soundcloud] поток', m[1], (e as Error).message);
      if (!res.headersSent) res.writeHead(502).end(); else res.destroy();
    }
  });
  return new Promise((ok, fail) => {
    s.once('error', fail);
    s.listen(port, '127.0.0.1', () => { server = s; ok(s); });
  });
}
export function stopStreamServer(): void {
  for (const p of procs) p.kill('SIGKILL');
  server?.close(); server = null;
}
