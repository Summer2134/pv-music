import type { LavalinkManager, Player, Track } from 'lavalink-client';
import { safe } from './db.js';
import * as SC from './soundcloud.js';
import { scTrack } from './search.js';

/**
 * «Моя волна» как в Яндекс Музыке (04.11.2026, просьба владельца). Бесконечная подборка под того, кто включил:
 *  — вкус: ❤️ лайки, 👍 волны, дослушанные треки (music_plays), лайки друзей в том же войсе (слабее);
 *  — кандидаты: «похожие» SoundCloud к трекам вкуса, поиск по тегам настроения/занятия, любимое;
 *  — 👎 — трек больше не попадётся, а у исполнителя после двух дизлайков — тоже; пропуск <30 с — лёгкий минус.
 * Настройки (как «Настроить волну»): занятие, настроение, характер, язык — сохраняются за человеком.
 */
export type WavePrefs = { activity: string | null; mood: string | null; character: string | null; lang: string | null };
export type WaveState = { owner: string; ownerName: string; prefs: WavePrefs; recent: number[]; artists: string[]; filling?: boolean };

export const WAVE_OPTIONS = {
  activity: { wake: 'Просыпаюсь', road: 'В дороге', work: 'Работаю', gym: 'Тренируюсь', sleep: 'Засыпаю' },
  mood: { energetic: 'Бодрое', happy: 'Весёлое', calm: 'Спокойное', sad: 'Грустное' },
  character: { fav: 'Любимое', new: 'Незнакомое', popular: 'Популярное' },
  lang: { ru: 'Русский', foreign: 'Иностранный', instr: 'Без слов' },
} as const;
export type WaveGroup = keyof typeof WAVE_OPTIONS;
const TAGS: Record<string, string[]> = {
  wake: ['morning', 'upbeat', 'pop'], road: ['drive', 'phonk', 'synthwave'], work: ['lofi', 'focus', 'chillhop'], gym: ['workout', 'phonk', 'hardstyle'], sleep: ['sleep', 'ambient', 'calm'],
  energetic: ['energetic', 'trap', 'hype'], happy: ['happy', 'dance', 'pop'], calm: ['chill', 'relax', 'lofi'], sad: ['sad', 'emotional', 'melancholy'],
  ru: ['русский рэп', 'russian rap', 'русский поп'], instr: ['instrumental', 'beats', 'lofi'],
};
const CYR = /[а-яё]/i;
const MIN_MS = 90_000, MAX_MS = 9 * 60_000;
export const WAVE_AHEAD = 2;

export const noPrefs = (): WavePrefs => ({ activity: null, mood: null, character: null, lang: null });
export async function loadPrefs(userId: string): Promise<WavePrefs> {
  const r = (await safe<WavePrefs>('SELECT activity, mood, character, lang FROM music_wave_prefs WHERE user_id = $1', [userId]))?.[0];
  return r ?? noPrefs();
}
export async function savePrefs(userId: string, p: WavePrefs): Promise<void> {
  await safe(`INSERT INTO music_wave_prefs (user_id, activity, mood, character, lang) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (user_id) DO UPDATE SET activity = $2, mood = $3, character = $4, lang = $5`, [userId, p.activity, p.mood, p.character, p.lang]);
}
export const prefsText = (p: WavePrefs) => (Object.keys(WAVE_OPTIONS) as WaveGroup[])
  .map(g => p[g] ? (WAVE_OPTIONS[g] as Record<string, string>)[p[g]!] : null).filter(Boolean).join(' · ');

export const scIdOf = (t: Track | null | undefined) => { const m = /^sc:(\d+)$/.exec(t?.info.identifier ?? ''); return m ? Number(m[1]) : null; };
export const isWaveTrack = (t: Track | null | undefined) => Boolean((t?.userData as { wave?: number } | undefined)?.wave);
export const waveOf = (p: Player | null | undefined) => (p?.get('wave') as WaveState | null | undefined) ?? null;

// ===== Оценки: 👍 +2, 👎 −3, дослушал +0.5, пропустил <30 с −1 =====
export async function feedback(userId: string, t: Track, score: number): Promise<void> {
  const id = scIdOf(t);
  if (!id) return;
  await safe(`INSERT INTO music_wave_fb (user_id, track_id, artist, title, uri, score) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (user_id, track_id) DO UPDATE SET score = GREATEST(-10, LEAST(10, music_wave_fb.score + $6)), at = NOW()`,
    [userId, id, (t.info.author ?? '').slice(0, 200).toLowerCase(), t.info.title.slice(0, 300), t.info.uri, score]);
}

type Taste = { seeds: number[]; loved: number[]; banned: Set<number>; bannedArtists: Set<string>; knownArtists: Set<string> };
async function taste(owner: string, friends: string[], guildId: string): Promise<Taste> {
  const ids = (rows: Array<{ id: string | number }> | null) => (rows ?? []).map(r => Number(r.id)).filter(Boolean);
  const fb = await safe<{ track_id: string; artist: string; score: number }>('SELECT track_id, artist, score FROM music_wave_fb WHERE user_id = $1', [owner]) ?? [];
  const banned = new Set(fb.filter(r => r.score <= -2).map(r => Number(r.track_id)));
  const dis = new Map<string, number>();
  for (const r of fb) if (r.score <= -2 && r.artist) dis.set(r.artist, (dis.get(r.artist) ?? 0) + 1);
  const bannedArtists = new Set([...dis].filter(([, n]) => n >= 2).map(([a]) => a));
  const thumbs = fb.filter(r => r.score >= 1).sort((a, b) => b.score - a.score).map(r => Number(r.track_id));
  // ❤️ лайки хранятся ссылкой — id берём из истории прослушиваний по той же ссылке.
  const liked = ids(await safe<{ id: string }>(`SELECT DISTINCT ON (p.uri) substring(p.identifier from 4) id FROM music_likes l
    JOIN music_plays p ON p.uri = l.uri AND p.identifier LIKE 'sc:%' WHERE l.user_id = $1 LIMIT 60`, [owner]));
  const played = ids(await safe<{ id: string }>(`SELECT substring(identifier from 4) id FROM music_plays
    WHERE requester_id = $1 AND identifier LIKE 'sc:%' AND listened_ms >= duration_ms * 0.7
    GROUP BY identifier ORDER BY COUNT(*) DESC, MAX(played_at) DESC LIMIT 40`, [owner]));
  const friendIds = friends.length ? ids(await safe<{ id: string }>(`SELECT DISTINCT substring(p.identifier from 4) id FROM music_likes l
    JOIN music_plays p ON p.uri = l.uri AND p.identifier LIKE 'sc:%' WHERE l.user_id = ANY($1) LIMIT 30`, [friends])) : [];
  let seeds = [...new Set([...thumbs, ...liked, ...played])];
  const loved = [...new Set([...thumbs, ...liked])];
  if (!seeds.length) seeds = ids(await safe<{ id: string }>(`SELECT substring(identifier from 4) id FROM music_plays
    WHERE guild_id = $1 AND identifier LIKE 'sc:%' AND played_at > NOW() - INTERVAL '30 days'
    GROUP BY identifier ORDER BY COUNT(*) DESC LIMIT 30`, [guildId])); // новичок — вкус сервера
  const known = await safe<{ a: string }>(`SELECT DISTINCT lower(author) a FROM music_plays WHERE requester_id = $1 AND author IS NOT NULL LIMIT 300`, [owner]) ?? [];
  return { seeds: [...seeds, ...friendIds.filter(x => !seeds.includes(x)).slice(0, Math.ceil(seeds.length / 3) + 3)], loved, banned, bannedArtists, knownArtists: new Set(known.map(r => r.a)) };
}

const pick = <T>(a: T[], n: number) => [...a].sort(() => Math.random() - 0.5).slice(0, n);
const tagsOf = (t: SC.ScTrack) => `${t.genre ?? ''} ${t.tag_list ?? ''}`.toLowerCase();

/** Следующие треки волны (SoundCloud-треки, ещё не загруженные в Lavalink). */
export async function nextWave(guildId: string, w: WaveState, friends: string[], count: number, recentGuild: Set<string>): Promise<SC.ScTrack[]> {
  const tt = await taste(w.owner, friends, guildId);
  const p = w.prefs;
  const tags = [...(p.activity ? TAGS[p.activity] : []), ...(p.mood ? TAGS[p.mood] : []), ...(p.lang === 'ru' || p.lang === 'instr' ? TAGS[p.lang] : [])];
  type Cand = { t: SC.ScTrack; w: number };
  const cands: Cand[] = [];
  const add = (list: SC.ScTrack[], weight: number) => { for (const t of list) cands.push({ t, w: weight }); };
  const seeds = pick(tt.seeds.slice(0, 40), p.character === 'new' ? 4 : 3);
  const related = await Promise.all(seeds.map(id => SC.relatedTracks(id, 20).catch(() => [] as SC.ScTrack[])));
  add(related.flat(), p.character === 'popular' ? 1 : 1.2);
  if (p.character === 'new' && related.flat().length) {
    const deeper = pick(related.flat(), 2).map(t => t.id);
    add((await Promise.all(deeper.map(id => SC.relatedTracks(id, 20).catch(() => [] as SC.ScTrack[])))).flat(), 1.3);
  }
  if (tags.length || !tt.seeds.length) {
    const tagList = tags.length ? pick(tags, 2) : ['pop', 'hip-hop'];
    add((await Promise.all(tagList.map(tag => SC.tagTracks(tag, 30, Math.floor(Math.random() * 3) * 30).catch(() => [] as SC.ScTrack[])))).flat(), 1);
  }
  if ((p.character === 'fav' || !p.character) && tt.loved.length) add(await SC.tracksByIds(pick(tt.loved, p.character === 'fav' ? 6 : 2)).catch(() => []), p.character === 'fav' ? 1.6 : 0.9);

  const seen = new Set<number>();
  const scored = cands.filter(({ t }) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    const i = SC.infoOf(t), artist = i.author.toLowerCase();
    if (i.duration < MIN_MS || i.duration > MAX_MS) return false;
    if (tt.banned.has(t.id) || tt.bannedArtists.has(artist) || w.recent.includes(t.id) || recentGuild.has(i.uri)) return false;
    if (p.lang === 'ru' && !CYR.test(i.title + i.author)) return false;
    if (p.lang === 'foreign' && CYR.test(i.title + i.author)) return false;
    if (p.character === 'new' && tt.knownArtists.has(artist)) return false;
    return true;
  }).map(({ t, w: weight }) => {
    const i = SC.infoOf(t), artist = i.author.toLowerCase();
    const plays = Math.log10((t.playback_count ?? 0) + 10);
    let s = weight + plays * (p.character === 'popular' ? 0.6 : 0.15) + Math.random() * 1.2;
    if (tags.some(tag => tagsOf(t).includes(tag.split(' ')[0]))) s += 0.8;
    if (w.artists.slice(-4).includes(artist)) s -= 1.5; // не крутить одного исполнителя подряд
    return { t, s };
  }).sort((a, b) => b.s - a.s);
  const out: SC.ScTrack[] = [];
  const artistsNow = new Set<string>();
  for (const { t } of scored) {
    const a = SC.infoOf(t).author.toLowerCase();
    if (artistsNow.has(a)) continue;
    artistsNow.add(a); out.push(t);
    if (out.length >= count) break;
  }
  return out;
}

/** Догрузить волну: держим WAVE_AHEAD треков наперёд. Вызывается на старте трека и в автоплее. */
export async function fillWave(lava: LavalinkManager, player: Player, friends: string[], recentGuild: Set<string>, min = WAVE_AHEAD): Promise<number> {
  const w = waveOf(player);
  if (!w || w.filling) return 0;
  const queued = (player.queue.tracks as Track[]).filter(isWaveTrack).length;
  if (queued >= min) return 0;
  w.filling = true;
  try {
    const list = await nextWave(player.guildId, w, friends, min - queued + 1, recentGuild);
    let n = 0;
    for (const t of list) {
      if (n >= min - queued) break;
      const track = await scTrack(lava, t, { id: w.owner, username: w.ownerName }).catch(() => null);
      if (!track) continue;
      track.userData = { ...(track.userData ?? {}), wave: 1 };
      w.recent.push(t.id); w.artists.push(SC.infoOf(t).author.toLowerCase());
      if (w.recent.length > 200) w.recent.splice(0, 50);
      if (w.artists.length > 20) w.artists.splice(0, 10);
      await player.queue.add(track);
      n++;
    }
    return n;
  } finally { w.filling = false; }
}
