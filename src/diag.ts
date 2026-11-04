import { spawn } from 'node:child_process';
import type { LavalinkManager } from 'lavalink-client';
import * as SC from './soundcloud.js';

/**
 * Самопроверка звука (04.11.2026): после запуска и по `!!!test` — по шагам, где ломается.
 * SoundCloud API → ссылка на звук → ffmpeg → yt-dlp → Lavalink открывает наш поток.
 */
const ver = (bin: string, args: string[]) => new Promise<string | null>(res => {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.on('error', () => res(null));
  p.on('close', code => res(code === 0 ? out.split('\n')[0].trim().slice(0, 60) : null));
  setTimeout(() => p.kill('SIGKILL'), 10_000);
});

export async function selfTest(lava: LavalinkManager, query = 'lofi'): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const step = async (name: string, fn: () => Promise<string>) => {
    try { lines.push(`✅ ${name}: ${await fn()}`); return true; } catch (e) { ok = false; lines.push(`❌ ${name}: ${String((e as Error).message ?? e).slice(0, 180)}`); return false; }
  };
  await step('ffmpeg', async () => (await ver(SC.ffmpegPath, ['-version'])) ?? (() => { throw new Error('не установлен — нужен pv-music-update'); })());
  const dlp = await ver(SC.ytdlpPath, ['--version']);
  lines.push(dlp ? `✅ yt-dlp: ${dlp}` : '⚠️ yt-dlp: нет (запасной путь выключен)');
  let track: SC.ScTrack | undefined;
  await step('SoundCloud client_id', async () => `${(await SC.getClientId()).slice(0, 6)}…`);
  await step('SoundCloud поиск', async () => {
    track = (await SC.searchTracks(query, 3))[0];
    if (!track) throw new Error('пусто');
    return `«${track.title.slice(0, 40)}»`;
  });
  if (track) {
    await step('ссылка на звук', async () => {
      const u = await SC.mediaUrl(track!);
      return /m3u8/.test(u) ? 'HLS' : new URL(u).hostname;
    });
    await step('Lavalink открыл поток', async () => {
      const node = lava.nodeManager.leastUsedNodes()[0];
      if (!node) throw new Error('Lavalink не подключён — `!!!lavalink`');
      const r = await node.search({ query: SC.streamUrl(track!.id) }, null);
      if (!r.tracks.length) throw new Error(`${r.loadType}${(r as { exception?: { message?: string } }).exception?.message ? ` · ${(r as { exception?: { message?: string } }).exception!.message}` : ''}`);
      return r.loadType;
    });
  }
  const st = SC.streamStats;
  lines.push(`-# потоков: ${st.started}, ошибок: ${st.failed}${st.lastError ? ` · последняя: ${st.lastError.slice(0, 120)}` : ''} · yt-dlp: ${SC.ytdlpStats.ok}/${SC.ytdlpStats.failed}`);
  return { ok, lines };
}
