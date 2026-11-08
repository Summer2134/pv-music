import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder, MessageFlags, SeparatorSpacingSize, StringSelectMenuBuilder,
  type Client, type Message, type SendableChannels,
} from 'discord.js';
import { LavalinkManager, type Player, type Track } from 'lavalink-client';
import { ADMINS, CLIENT_ID, DEFAULT_VOLUME, IDLE_LEAVE_MS, LAVALINK } from './config.js';
import { safe } from './db.js';
import { clip, dur, plain } from './format.js';
import { pauseClock, recentUris, recordPlay, requesterId, resumeClock, startClock, stopClock } from './stats.js';
import { markYoutubeBroken, resolve, soundcloudTwin } from './search.js';
import { artwork, nowCardPng } from './card.js';
import { ico, type Emo } from './icons.js';
import { streamUrl } from './soundcloud.js';
import { feedback, fillWave, isWaveTrack, loadPrefs, prefsText, waveOf, WAVE_AHEAD, type WaveState } from './wave.js';

/** Ледяная гамма Vafels: синий акцент, понятные главное и опасное действия. */
export const COLOR = { main: 0x7fb8e6, ok: 0x9fe0c0, err: 0xeb7373, idle: 0x243047 };
export const card = (text: string, color = COLOR.main) => new EmbedBuilder().setColor(color).setDescription(text);

export type Requester = { id: string; username: string; avatar?: string | null };
const REPEAT_ICON = { off: '↪', track: '🔂', queue: '🔁' } as const;
const REPEAT_NAME = { off: 'выкл', track: 'трек', queue: 'очередь' } as const;

let lava: LavalinkManager;
let client: Client | null = null;
const setClient = (c: Client) => { client = c; };
export const manager = () => lava;

/** Настройки сервера (громкость, автоплей) — кэш в памяти, хранятся в music_settings. */
const settings = new Map<string, { volume: number; autoplay: boolean }>();
export async function guildSettings(guildId: string) {
  if (!settings.has(guildId)) {
    const row = (await safe<{ volume: number | null; autoplay: boolean }>('SELECT volume, autoplay FROM music_settings WHERE guild_id = $1', [guildId]))?.[0];
    settings.set(guildId, { volume: row?.volume ?? DEFAULT_VOLUME, autoplay: row?.autoplay ?? false });
  }
  return settings.get(guildId)!;
}
export async function saveSettings(guildId: string, patch: Partial<{ volume: number; autoplay: boolean }>) {
  const s = { ...(await guildSettings(guildId)), ...patch };
  settings.set(guildId, s);
  await safe(`INSERT INTO music_settings (guild_id, volume, autoplay) VALUES ($1, $2, $3)
    ON CONFLICT (guild_id) DO UPDATE SET volume = $2, autoplay = $3`, [guildId, s.volume, s.autoplay]);
}

// ===== Плеер «сейчас играет» (Components V2, как у больших музыкальных ботов) =====
const BAR = 18;
/** Полоска времени: ━━━━━●──────. */
export function timeline(pos: number, total: number): string {
  if (!total) return '🔴 прямой эфир';
  const k = Math.max(0, Math.min(BAR, Math.round((pos / total) * BAR)));
  return `\`${dur(pos)}\` ${'━'.repeat(k)}●${'─'.repeat(BAR - k)} \`${dur(total)}\``;
}
/** Короткая строка-статус под плеером (ошибка трека, «играю с SoundCloud»…), живёт 2 мин. */
const notes = new Map<string, { text: string; until: number }>();
export function setNote(guildId: string, text: string, ms = 120_000): void { notes.set(guildId, { text, until: Date.now() + ms }); }
const noteOf = (g: string) => { const n = notes.get(g); return n && n.until > Date.now() ? n.text : ''; };

/** Хозяин музыки: кто заказал текущий трек (автоплей — последний, кто заказывал сам). */
export function trackOwner(player: Player): string | null {
  for (const t of [player.queue.current, ...player.queue.previous] as (Track | null)[]) {
    const id = requesterId(t);
    if (id && id !== CLIENT_ID) return id;
  }
  return null;
}
/** Управлять может только владелец бота и тот, кто заказал трек (решение владельца 04.11.2026).
 *  Заказавший ушёл из войса — управление свободно, иначе музыка застрянет. */
export function controlDenied(userId: string, player: Player | undefined): string | null {
  if (!player || ADMINS.has(userId)) return null;
  const own = trackOwner(player);
  if (!own || own === userId) return null;
  const inVoice = client?.guilds.cache.get(player.guildId)?.voiceStates.cache.get(own)?.channelId === player.voiceChannelId;
  if (!inVoice) return null;
  return `Сейчас управляет <@${own}> — он заказал этот трек. Свой трек добавь через \`/играть\`.`;
}
/** Список очереди для кнопки 📜 (видит только нажавший): выбрать трек — включится сразу. */
export function queueMenu(player: Player) {
  const list = player.queue.tracks as Track[];
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('mus:jump')
    .setPlaceholder(`Включить из очереди — ${list.length} тр.`)
    .addOptions(list.slice(0, 25).map((x, k) => ({
      label: clip(`${k + 1}. ${x.info.title}`, 100), value: String(k + 1),
      description: clip(`${x.info.author.replace(/\s*-\s*topic$/i, '')} · ${x.info.isStream ? 'эфир' : dur(x.info.duration)}`, 100),
    }))));
}
/** Позиция с учётом перемотки SoundCloud (новый поток начинается с нуля, сдвиг помним в плеере). */
export const posOf = (p: Player) => p.position + (Number(p.get('seekOffset')) || 0);
export const SEEK_STEP_MS = 10_000;
/** Перемотка. Обычные треки — seek Lavalink; SoundCloud идёт через наш ffmpeg — открываем поток с нужной секунды и подменяем трек. */
export async function seekTo(p: Player, ms: number): Promise<string | null> {
  const cur = p.queue.current as Track | null;
  if (!cur || cur.info.isStream || !cur.info.duration) return 'Этот трек нельзя перематывать.';
  ms = Math.max(0, Math.min(Math.round(ms), cur.info.duration - 1500));
  if (cur.info.isSeekable) { p.set('seekOffset', 0); await p.seek(ms); return null; }
  const m = /^sc:(\d+)$/.exec(cur.info.identifier ?? '');
  if (!m) return 'Этот трек нельзя перематывать.';
  if (p.get('seeking')) return 'Уже перематываю, секунду.';
  const node = manager().nodeManager.leastUsedNodes()[0];
  const r = node ? await node.search({ query: streamUrl(Number(m[1]), ms) }, cur.requester).catch(() => null) : null;
  const enc = r?.tracks?.[0]?.encoded;
  if (!enc) return 'Не получилось перемотать, попробуй ещё раз.';
  p.set('seeking', { orig: cur.encoded, ms });
  setTimeout(() => p.set('seeking', null), 15_000).unref?.();
  await p.play({ clientTrack: { ...cur, encoded: enc, info: cur.info } as Track, paused: p.paused });
  return null;
}
const btn = (id: string, emoji: Emo, style = ButtonStyle.Secondary, disabled = false, label?: string) => {
  const x = new ButtonBuilder().setCustomId(`mus:${id}`).setEmoji(emoji).setStyle(style).setDisabled(disabled);
  return label ? x.setLabel(label) : x;
};
const V2 = MessageFlags.IsComponentsV2;

/** Картинка-карточка трека (card.ts). Сбой рисования — плеер работает текстом, как раньше. */
async function cardFile(player: Player, t: Track): Promise<AttachmentBuilder | null> {
  try {
    const i = t.info;
    const req = requesterId(t);
    const reqName = req ? (client?.users?.cache?.get(req)?.displayName ?? (t.requester as Requester | null)?.username ?? null) : null;
    const next = (player.queue.tracks as Track[])[0];
    const cover = await artwork(i.artworkUrl);
    const png = nowCardPng({
      title: i.title, author: (i.author || 'неизвестно').replace(/\s*-\s*topic$/i, ''), requester: reqName,
      cover, coverKey: i.artworkUrl ?? i.identifier, position: posOf(player), duration: i.duration, isStream: i.isStream || !i.duration,
      paused: player.paused, label: isWaveTrack(t) ? 'МОЯ ВОЛНА' : null, next: next ? `${next.info.title} — ${next.info.author.replace(/\s*-\s*topic$/i, '')}` : null, source: i.sourceName,
    });
    return new AttachmentBuilder(png, { name: 'np.png' });
  } catch (e) { console.warn('[плеер] карточка', (e as Error).message); return null; }
}

export async function nowView(player: Player, disabled = false) {
  const t = player.queue.current;
  const autoplay = (await guildSettings(player.guildId)).autoplay;
  if (!t) return endView(player, autoplay, disabled);
  const c = new ContainerBuilder().setAccentColor(player.paused ? COLOR.idle : COLOR.main);
  const i = t.info, req = requesterId(t);
  const file = await cardFile(player, t);
  if (file) {
    c.addMediaGalleryComponents(g => g.addItems(it => it.setURL('attachment://np.png').setDescription(clip(`${i.title} — ${i.author}`, 200))));
  } else {
    const head = [`-# ${player.paused ? '⏸ НА ПАУЗЕ' : '🎶 СЕЙЧАС ИГРАЕТ'}`,
      `### ${i.uri?.startsWith('http') ? `[${plain(clip(i.title, 90))}](${i.uri})` : plain(clip(i.title, 90))}`,
      `**${plain(clip((i.author || 'неизвестно').replace(/\s*-\s*topic$/i, ''), 60))}**${req ? ` · <@${req}>` : ''}`,
      timeline(posOf(player), i.isStream ? 0 : i.duration)].join('\n');
    c.addTextDisplayComponents(x => x.setContent(head));
  }
  const list = player.queue.tracks as Track[];
  const left = list.reduce((sum, x) => sum + (x.info.isStream ? 0 : x.info.duration), 0);
  const wave = waveOf(player);
  const status = [
    [wave ? `🌊 волна <@${wave.owner}>${prefsText(wave.prefs) ? ` · ${prefsText(wave.prefs).toLowerCase()}` : ''}` : '', i.uri?.startsWith('http') ? `[открыть трек](${i.uri})` : ''].filter(Boolean).join(' · '),
    [`громкость ${player.volume}%`, `повтор: ${REPEAT_NAME[player.repeatMode]}`, autoplay && !wave ? 'автоплей' : '', list.length ? `в очереди ${list.length} · ${dur(left)}` : ''].filter(Boolean).join(' · '),
  ].filter(Boolean).map(x => `-# ${x}`).join('\n');
  const note = noteOf(player.guildId);
  c.addTextDisplayComponents(x => x.setContent(`${status}${note ? `\n-# ${note}` : ''}`));
  // Главное действие — синее, опасное — красное; второстепенные кнопки остаются спокойными.
  const seekable = !i.isStream && !!i.duration && (i.isSeekable || /^sc:\d+$/.test(i.identifier ?? ''));
  c.addActionRowComponents(row => row.addComponents(
    btn('prev', ico('prev', '⏮️'), ButtonStyle.Secondary, disabled || !player.queue.previous.length),
    btn('pause', player.paused ? ico('play', '▶️') : ico('pause', '⏸️'), ButtonStyle.Primary, disabled, player.paused ? 'Играть' : 'Пауза'),
    btn('skip', ico('next', '⏭️'), ButtonStyle.Secondary, disabled),
    btn('lyrics', ico('lyrics', '📝'), ButtonStyle.Secondary, disabled || i.isStream, 'Текст'),
  ));
  c.addActionRowComponents(row => row.addComponents(
    btn('back', ico('rewind', '⏪'), ButtonStyle.Secondary, disabled || !seekable, '10 с'),
    btn('fwd', ico('forward', '⏩'), ButtonStyle.Secondary, disabled || !seekable, '10 с'),
    btn('voldown', ico('vol_down', '🔉'), ButtonStyle.Secondary, disabled || player.volume <= 5, '−'),
    btn('volup', ico('vol_up', '🔊'), ButtonStyle.Secondary, disabled || player.volume >= 150, '+'),
    btn('queue', ico('queue', '📜'), ButtonStyle.Secondary, disabled || !list.length),
  ));
  // Волна: как в Яндекс Музыке — 👎 (в дизлайки и дальше), ❤️ (в любимое, волна учтёт), настройки волны.
  if (wave) c.addActionRowComponents(row => row.addComponents(
    btn('dislike', ico('dislike', '👎'), ButtonStyle.Secondary, disabled),
    btn('like', ico('like', '❤️'), ButtonStyle.Secondary, disabled),
    btn('wave:panel', ico('wave', '🌊'), ButtonStyle.Primary, disabled, 'Волна'),
    btn('stop', ico('stop', '⏹️'), ButtonStyle.Danger, disabled),
  ));
  else c.addActionRowComponents(row => row.addComponents(
    btn('shuffle', ico('shuffle', '🔀'), ButtonStyle.Secondary, disabled || list.length < 2),
    btn('loop', ico(`loop_${player.repeatMode}`, REPEAT_ICON[player.repeatMode]), player.repeatMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary, disabled),
    btn('autoplay', ico('autoplay', '♾️'), autoplay ? ButtonStyle.Primary : ButtonStyle.Secondary, disabled),
    btn('like', ico('like', '❤️'), ButtonStyle.Secondary, disabled),
    btn('stop', ico('stop', '⏹️'), ButtonStyle.Danger, disabled),
  ));
  return { components: [c], files: file ? [file] : [], flags: V2 as typeof V2, allowedMentions: { parse: [] as [] } };
}

/** Очередь кончилась: что было последним и что делать дальше. */
function endView(player: Player, autoplay: boolean, disabled = false) {
  const last = player.queue.previous[0];
  const c = new ContainerBuilder().setAccentColor(COLOR.idle);
  c.addTextDisplayComponents(x => x.setContent(['### Очередь закончилась',
    last ? `-# Последним играл: ${plain(clip(last.info.title, 70))} — ${plain(clip(last.info.author.replace(/\s*-\s*topic$/i, ''), 40))}` : '',
    noteOf(player.guildId) ? `-# ${noteOf(player.guildId)}` : '',
    '-# Включи ещё: `/играть` — название или любая ссылка'].filter(Boolean).join('\n')));
  c.addActionRowComponents(row => row.addComponents(
    btn('wave:go', ico('wave', '🌊'), ButtonStyle.Secondary, disabled, 'Моя волна'),
    btn('replay', ico('loop_queue', '🔁'), ButtonStyle.Secondary, disabled || !last, 'Ещё раз'),
    btn('autoplay', ico('autoplay', '♾️'), ButtonStyle.Secondary, disabled, autoplay ? 'Автоплей вкл' : 'Включить похожее'),
    btn('leave', ico('leave', '👋'), ButtonStyle.Secondary, disabled, 'Выйти'),
  ));
  return { components: [c], files: [] as AttachmentBuilder[], flags: V2 as typeof V2, allowedMentions: { parse: [] as [] } };
}
function closedView(text: string) {
  const c = new ContainerBuilder().setAccentColor(COLOR.idle).addTextDisplayComponents(x => x.setContent(text));
  return { components: [c], flags: V2 as typeof V2 };
}

const npMessages = new Map<string, Message>();
async function channelOf(client: Client, player: Player): Promise<SendableChannels | null> {
  if (!player.textChannelId) return null;
  const ch = await client.channels.fetch(player.textChannelId).catch(() => null);
  return ch?.isSendable() ? ch : null;
}
export const npMessageId = (guildId: string) => npMessages.get(guildId)?.id ?? null;
/** Новый трек: если плеер — последнее сообщение в канале, правим его; иначе старое убираем и шлём новое вниз. */
export async function postNowPlaying(client: Client, player: Player): Promise<void> {
  const old = npMessages.get(player.guildId);
  const ch = await channelOf(client, player);
  if (!ch) return;
  const view = await nowView(player);
  if (old && 'lastMessageId' in ch && ch.lastMessageId === old.id) {
    const ok = await old.edit({ components: view.components, files: view.files, attachments: [], allowedMentions: view.allowedMentions }).then(() => true).catch(() => false);
    if (ok) return;
  }
  npMessages.delete(player.guildId);
  await old?.delete().catch(() => undefined);
  const msg = await ch.send(view).catch(e => { console.warn('[плеер] не отправился', e?.message); return null; });
  if (msg) npMessages.set(player.guildId, msg);
}
export async function refreshNowPlaying(player: Player): Promise<void> {
  const msg = npMessages.get(player.guildId);
  if (!msg) return;
  const view = await nowView(player);
  await msg.edit({ components: view.components, files: view.files, attachments: [], allowedMentions: view.allowedMentions }).catch(() => npMessages.delete(player.guildId));
}
/** Бот уходит: плеер удаляем, в чате — одна короткая строка, почему ушёл. */
/** Сообщение «почему ушёл» само удаляется через минуту (просьба владельца). */
const LEAVE_NOTE_TTL_MS = 60_000;
async function closeNowPlaying(player: Player, text: string, ttlMs = LEAVE_NOTE_TTL_MS): Promise<void> {
  const msg = npMessages.get(player.guildId);
  npMessages.delete(player.guildId);
  const ch = msg?.channel ?? (client ? await channelOf(client, player) : null);
  await msg?.delete().catch(() => undefined);
  if (!ch || !('send' in ch)) return;
  const sent = await ch.send({ components: closedView(text).components, flags: V2, allowedMentions: { parse: [] } }).catch(() => undefined);
  if (sent && ttlMs > 0) setTimeout(() => void sent.delete().catch(() => undefined), ttlMs).unref?.();
}
async function endNowPlaying(player: Player): Promise<void> {
  const msg = npMessages.get(player.guildId);
  if (!msg) return;
  const view = endView(player, (await guildSettings(player.guildId)).autoplay);
  await msg.edit({ components: view.components, files: [], attachments: [] }).catch(() => undefined);
}

// ===== Автоплей: очередь кончилась — похожее по исполнителю =====
async function autoPlay(player: Player, last: Track): Promise<void> {
  if (waveOf(player)) { await fillWave(lava, player, listenerIds(player), await recentUris(player.guildId, 100)).catch(e => console.warn('[волна]', e.message)); return; }
  if (!(await guildSettings(player.guildId)).autoplay || !last?.info) return;
  const played = await recentUris(player.guildId);
  for (const uri of player.queue.previous.map(t => t.info.uri)) played.add(uri);
  played.add(last.info.uri);
  const r = await resolve(lava, `${last.info.author} ${last.info.title.split(/[([-]/)[0]}`.trim(), { id: CLIENT_ID, username: 'автоплей' }).catch(() => null)
    ?? await resolve(lava, last.info.author, { id: CLIENT_ID, username: 'автоплей' }).catch(() => null);
  const pick = r?.tracks.filter(t => !played.has(t.info.uri) && !t.info.isStream && t.info.duration < 15 * 60_000);
  if (pick?.length) await player.queue.add(pick[Math.floor(Math.random() * Math.min(5, pick.length))]);
}

// ===== Уход из пустого войса =====
const idleTimers = new Map<string, NodeJS.Timeout>();
/** Кто живой сидит с ботом (для общей волны). */
export function listenerIds(player: Player): string[] {
  const ch = player.voiceChannelId ? client?.channels.cache.get(player.voiceChannelId) : null;
  return ch && 'members' in ch ? [...(ch.members as Map<string, { id: string; user: { bot: boolean } }>).values()].filter(m => !m.user.bot).map(m => m.id) : [];
}
/** Включить волну человека. Ничего не играет — сразу первый трек; иначе волна пойдёт после очереди. */
export async function startWave(player: Player, user: { id: string; username: string }): Promise<number> {
  const prev = waveOf(player);
  const prefs = await loadPrefs(user.id);
  const state: WaveState = { owner: user.id, ownerName: user.username, prefs, recent: prev?.owner === user.id ? prev.recent : [], artists: [] };
  // Новая волна или новые настройки — старые треки волны из очереди убираем.
  const keep = (player.queue.tracks as Track[]).filter(t => !isWaveTrack(t));
  await player.queue.splice(0, player.queue.tracks.length);
  if (keep.length) await player.queue.add(keep);
  player.set('wave', state);
  const others = listenerIds(player).filter(id => id !== user.id);
  const n = await fillWave(lava, player, others, await recentUris(player.guildId, 100), WAVE_AHEAD + (player.queue.current ? 0 : 1));
  if (n && !player.queue.current) await player.play({ paused: false });
  void refreshNowPlaying(player);
  return n;
}
export async function stopWave(player: Player): Promise<void> {
  player.set('wave', null);
  const keep = (player.queue.tracks as Track[]).filter(t => !isWaveTrack(t));
  await player.queue.splice(0, player.queue.tracks.length);
  if (keep.length) await player.queue.add(keep);
  void refreshNowPlaying(player);
}
export function humansIn(client: Client, player: Player): number {
  const ch = player.voiceChannelId ? client.channels.cache.get(player.voiceChannelId) : null;
  return ch && 'members' in ch ? [...(ch.members as Map<string, { user: { bot: boolean } }>).values()].filter(m => !m.user.bot).length : 0;
}
export function checkEmpty(client: Client, guildId: string): void {
  const player = lava.getPlayer(guildId);
  if (!player) return;
  const empty = humansIn(client, player) === 0;
  const timer = idleTimers.get(guildId);
  if (!empty) {
    if (timer) { clearTimeout(timer); idleTimers.delete(guildId); }
    if (player.get('autoPaused') && player.paused) { player.set('autoPaused', false); void player.resume().then(() => { resumeClock(guildId); void refreshNowPlaying(player); }); }
    return;
  }
  if (timer) return;
  if (player.playing && !player.paused) { player.set('autoPaused', true); void player.pause().then(() => { pauseClock(guildId); void refreshNowPlaying(player); }); }
  idleTimers.set(guildId, setTimeout(() => {
    idleTimers.delete(guildId);
    const p = lava.getPlayer(guildId);
    if (p && humansIn(client, p) === 0) void p.destroy('empty-channel');
  }, IDLE_LEAVE_MS));
}

export function createManager(discord: Client): LavalinkManager {
  const client = discord;
  setClient(discord);
  lava = new LavalinkManager({
    nodes: [{ id: 'main', host: LAVALINK.host, port: LAVALINK.port, authorization: LAVALINK.password, retryAmount: 1e9, retryDelay: 5000 }],
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    autoSkip: true,
    client: { id: CLIENT_ID, username: 'PV Music' },
    playerOptions: {
      defaultSearchPlatform: 'ytmsearch',
      clientBasedPositionUpdateInterval: 150,
      applyVolumeAsFilter: false,
      requesterTransformer: (r: unknown): Requester => {
        const u = r as { id: string; username?: string; displayAvatarURL?: () => string };
        return { id: u?.id ?? '', username: u?.username ?? '', avatar: typeof u?.displayAvatarURL === 'function' ? u.displayAvatarURL() : null };
      },
      onDisconnect: { autoReconnect: true, destroyPlayer: false },
      onEmptyQueue: { destroyAfterMs: IDLE_LEAVE_MS, autoPlayFunction: autoPlay },
    },
    queueOptions: { maxPreviousTracks: 25 },
  });
  client.on('raw', d => void lava.sendRawData(d));

  lava.on('trackStart', (player, track) => {
    const sk = player.get('seeking') as { orig?: string; ms: number } | null;
    if (sk && track) {
      // Перемотка: часы и статистика не сбрасываются, трек получает назад исходный поток (повтор/«назад» — с начала).
      player.set('seeking', null); player.set('seekOffset', sk.ms);
      if (sk.orig) track.encoded = sk.orig;
      if (player.queue.previous[0]?.info.identifier === track.info.identifier) player.queue.previous.shift();
      return void refreshNowPlaying(player);
    }
    player.set('seekOffset', 0);
    startClock(player.guildId);
    if (track) void postNowPlaying(client, player);
    const w = waveOf(player);
    if (w) void recentUris(player.guildId, 100).then(r => fillWave(lava, player, listenerIds(player).filter(id => id !== w.owner), r))
      .then(n => { if (n) void refreshNowPlaying(player); }).catch(e => console.warn('[волна]', e.message));
  });
  lava.on('trackEnd', (player, track) => {
    if (player.get('seeking')) return; // это старый поток, подменённый перемоткой
    const listened = stopClock(player.guildId, track?.info.duration ?? 0);
    // Волна учится и без кнопок: пропуск в первые 30 с — минус, дослушал — плюс.
    const w = waveOf(player);
    if (w && track && isWaveTrack(track) && track.info.duration > 60_000) {
      const fb = listened < 30_000 ? -1 : listened >= track.info.duration * 0.8 ? 0.5 : 0;
      if (fb) void feedback(w.owner, track, fb).catch(() => undefined);
    }
    if (track) void recordPlay(client, player, track, listened).catch(e => console.error('[статистика]', e));
  });
  lava.on('trackError', (player, track, payload) => {
    const t = track as Track | null;
    console.warn('[трек] ошибка', t?.info?.sourceName, t?.info?.title, payload.exception?.message);
    void (async () => {
      // YouTube не отдал звук (частый блок серверных IP) — тот же трек с SoundCloud.
      if (t?.info && /youtube/i.test(t.info.sourceName ?? '') && !player.get(`sc:${t.info.identifier}`)) {
        player.set(`sc:${t.info.identifier}`, true);
        markYoutubeBroken();
        const twin = await soundcloudTwin(lava, t).catch(() => null);
        if (twin) {
          await player.queue.add(twin, 0);
          if (!player.playing || !player.queue.current) await player.play({ paused: false }).catch(() => undefined);
          setNote(player.guildId, `⚠️ YouTube не отдал «${clip(t.info.title, 40)}» — играю с SoundCloud`);
          return;
        }
      }
      setNote(player.guildId, `⚠️ Не получилось сыграть «${clip(t?.info?.title ?? 'трек', 50)}» — пропустил`);
      void refreshNowPlaying(player);
    })().catch(e => console.error('[трек] запасной поиск', e));
  });
  lava.on('trackStuck', (player, track) => console.warn('[трек] завис', track?.info.title));
  lava.on('queueEnd', player => {
    stopClock(player.guildId, 0);
    void endNowPlaying(player);
  });
  lava.on('playerDestroy', (player, reason) => {
    stopClock(player.guildId, 0);
    const t = idleTimers.get(player.guildId);
    if (t) { clearTimeout(t); idleTimers.delete(player.guildId); }
    const by = player.get('stoppedBy') as string | undefined;
    const text = reason === 'empty-channel' ? '👋 Все вышли из войса — я тоже ушёл.'
      : reason === 'kicked' ? '😶 Меня выгнали из войса — музыка выключена.'
        : reason === 'stopped' ? `⏹️ Музыку выключил${by ? ` <@${by}>` : 'и'}.`
          : reason === 'shutdown' ? '🔄 Перезапускаюсь — включите музыку снова через минуту.'
            : '💤 Очередь давно закончилась — я ушёл. Включить снова: `/играть`';
    void closeNowPlaying(player, `-# ${text}`);
  });
  lava.nodeManager.on('connect', node => console.log(`[lavalink] подключён ${node.id}`));
  lava.nodeManager.on('disconnect', (node, reason) => console.warn(`[lavalink] отключён ${node.id}`, reason?.reason ?? ''));
  lava.nodeManager.on('error', (node, error) => console.warn(`[lavalink] ошибка ${node.id}:`, (error as Error)?.message ?? error));

  client.on('voiceStateUpdate', (oldS, newS) => {
    const g = newS.guild.id;
    if (!lava.getPlayer(g)) return;
    // Бота выгнали из войса руками — закрываем плеер.
    if (newS.id === client.user?.id && oldS.channelId && !newS.channelId) { void lava.getPlayer(g)?.destroy('kicked'); return; }
    checkEmpty(client, g);
  });

  // Полоска прогресса — раз в 15 с.
  setInterval(() => {
    for (const player of lava.players.values()) if (player.playing && !player.paused) void refreshNowPlaying(player);
  }, 15_000).unref();
  return lava;
}

export const isPlaying = (p: Player | undefined | null) => Boolean(p?.queue.current);
export async function playerFor(guildId: string, voiceChannelId: string, textChannelId: string): Promise<Player> {
  const vol = (await guildSettings(guildId)).volume;
  const player = lava.getPlayer(guildId) ?? lava.createPlayer({ guildId, voiceChannelId, textChannelId, selfDeaf: true, selfMute: false, volume: vol });
  if (!player.connected) await player.connect();
  if (!player.textChannelId) player.textChannelId = textChannelId;
  return player;
}
