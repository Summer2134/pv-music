import type { Client } from 'discord.js';
import type { Player, Track } from 'lavalink-client';
import { safe } from './db.js';
import { mskDay } from './format.js';

/**
 * Статистика: сколько реально прослушано (без пауз), кем заказано и кто сидел в войсе.
 * Засчитывается трек, прослушанный хотя бы 10 с.
 */
export const MIN_LISTEN_MS = 10_000;
type Clock = { startedAt: number; pausedAt: number; pausedMs: number };
const clocks = new Map<string, Clock>();

export function startClock(guildId: string, now = Date.now()): void { clocks.set(guildId, { startedAt: now, pausedAt: 0, pausedMs: 0 }); }
export function pauseClock(guildId: string, now = Date.now()): void { const c = clocks.get(guildId); if (c && !c.pausedAt) c.pausedAt = now; }
export function resumeClock(guildId: string, now = Date.now()): void { const c = clocks.get(guildId); if (c?.pausedAt) { c.pausedMs += now - c.pausedAt; c.pausedAt = 0; } }
export function stopClock(guildId: string, durationMs: number, now = Date.now()): number {
  const c = clocks.get(guildId);
  clocks.delete(guildId);
  if (!c) return 0;
  const paused = c.pausedMs + (c.pausedAt ? now - c.pausedAt : 0);
  const listened = Math.max(0, now - c.startedAt - paused);
  return durationMs > 0 ? Math.min(listened, durationMs) : listened;
}

export const requesterId = (t: Track | null | undefined) => ((t?.requester ?? null) as { id?: string } | null)?.id ?? null;

/** Конец трека: запись прослушивания + минуты всем, кто был в войсе (не боты, не оглохшие). */
export async function recordPlay(client: Client, player: Player, track: Track, listenedMs: number, now = Date.now()): Promise<number> {
  if (listenedMs < MIN_LISTEN_MS) return 0;
  const guild = client.guilds.cache.get(player.guildId);
  const channel = player.voiceChannelId ? guild?.channels.cache.get(player.voiceChannelId) : null;
  const listeners = channel && 'members' in channel && typeof (channel.members as Map<string, unknown>).values === 'function'
    ? [...(channel.members as Map<string, { id: string; user: { bot: boolean }; voice: { selfDeaf?: boolean | null; serverDeaf?: boolean | null } }>).values()]
      .filter(m => !m.user.bot && !m.voice.selfDeaf && !m.voice.serverDeaf).map(m => m.id)
    : [];
  const i = track.info;
  await safe(`INSERT INTO music_plays (guild_id, requester_id, source, identifier, title, author, uri, artwork, duration_ms, listened_ms, listeners)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [player.guildId, requesterId(track), i.sourceName, i.identifier, i.title.slice(0, 300), (i.author ?? '').slice(0, 200), i.uri, i.artworkUrl, Math.min(i.duration || 0, 2e9), Math.round(listenedMs), listeners.length]);
  if (listeners.length) await safe(`INSERT INTO music_listen (guild_id, user_id, day, ms, tracks)
    SELECT $1, u, $3::date, $4, 1 FROM unnest($2::text[]) u
    ON CONFLICT (guild_id, user_id, day) DO UPDATE SET ms = music_listen.ms + EXCLUDED.ms, tracks = music_listen.tracks + 1`,
    [player.guildId, listeners, mskDay(now), Math.round(listenedMs)]);
  return listeners.length;
}

export type Period = 'week' | 'month' | 'all';
const since = (p: Period) => p === 'week' ? "NOW() - INTERVAL '7 days'" : p === 'month' ? "NOW() - INTERVAL '30 days'" : "'epoch'::timestamptz";
const sinceDay = (p: Period) => p === 'week' ? "CURRENT_DATE - 7" : p === 'month' ? "CURRENT_DATE - 30" : "'1970-01-01'::date";

export async function topTracks(guildId: string, p: Period, limit = 10) {
  return await safe<{ title: string; author: string; uri: string; plays: number }>(
    `SELECT MIN(title) title, MIN(author) author, uri, COUNT(*)::int plays FROM music_plays
     WHERE guild_id = $1 AND played_at >= ${since(p)} GROUP BY uri ORDER BY plays DESC, MAX(played_at) DESC LIMIT $2`, [guildId, limit]) ?? [];
}
export async function topListeners(guildId: string, p: Period, limit = 10) {
  return await safe<{ user_id: string; ms: string; tracks: number }>(
    `SELECT user_id, SUM(ms)::bigint ms, SUM(tracks)::int tracks FROM music_listen
     WHERE guild_id = $1 AND day >= ${sinceDay(p)} GROUP BY user_id ORDER BY ms DESC LIMIT $2`, [guildId, limit]) ?? [];
}
export async function topArtists(guildId: string, p: Period, limit = 5) {
  return await safe<{ author: string; plays: number }>(
    `SELECT author, COUNT(*)::int plays FROM music_plays WHERE guild_id = $1 AND played_at >= ${since(p)} AND author <> ''
     GROUP BY author ORDER BY plays DESC LIMIT $2`, [guildId, limit]) ?? [];
}
export async function serverTotals(guildId: string, p: Period) {
  return (await safe<{ plays: number; ms: string; people: number }>(
    `SELECT (SELECT COUNT(*)::int FROM music_plays WHERE guild_id = $1 AND played_at >= ${since(p)}) plays,
            (SELECT COALESCE(SUM(listened_ms),0)::bigint FROM music_plays WHERE guild_id = $1 AND played_at >= ${since(p)}) ms,
            (SELECT COUNT(DISTINCT user_id)::int FROM music_listen WHERE guild_id = $1 AND day >= ${sinceDay(p)}) people`, [guildId]))?.[0] ?? null;
}
export async function userStats(guildId: string, userId: string, p: Period) {
  const listen = (await safe<{ ms: string; tracks: number; days: number }>(
    `SELECT COALESCE(SUM(ms),0)::bigint ms, COALESCE(SUM(tracks),0)::int tracks, COUNT(*)::int days FROM music_listen
     WHERE guild_id = $1 AND user_id = $2 AND day >= ${sinceDay(p)}`, [guildId, userId]))?.[0];
  const ordered = await safe<{ title: string; author: string; uri: string; plays: number }>(
    `SELECT MIN(title) title, MIN(author) author, uri, COUNT(*)::int plays FROM music_plays
     WHERE guild_id = $1 AND requester_id = $2 AND played_at >= ${since(p)} GROUP BY uri ORDER BY plays DESC LIMIT 5`, [guildId, userId]) ?? [];
  const artists = await safe<{ author: string; plays: number }>(
    `SELECT author, COUNT(*)::int plays FROM music_plays WHERE guild_id = $1 AND requester_id = $2 AND played_at >= ${since(p)} AND author <> ''
     GROUP BY author ORDER BY plays DESC LIMIT 3`, [guildId, userId]) ?? [];
  const total = (await safe<{ n: number }>(`SELECT COUNT(*)::int n FROM music_plays WHERE guild_id = $1 AND requester_id = $2 AND played_at >= ${since(p)}`, [guildId, userId]))?.[0]?.n ?? 0;
  return { ms: Number(listen?.ms ?? 0), tracks: listen?.tracks ?? 0, days: listen?.days ?? 0, ordered, artists, total };
}
/** Последние сыгранные треки сервера (для автоплея: не повторять). */
export async function recentUris(guildId: string, limit = 50): Promise<Set<string>> {
  return new Set((await safe<{ uri: string }>('SELECT uri FROM music_plays WHERE guild_id = $1 ORDER BY played_at DESC LIMIT $2', [guildId, limit]) ?? []).map(r => r.uri));
}
