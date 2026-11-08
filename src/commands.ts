import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder,
  type AutocompleteInteraction, type ButtonInteraction, type ChatInputCommandInteraction, type GuildMember, type Interaction, type StringSelectMenuInteraction,
} from 'discord.js';
import type { Player, RepeatMode, SearchResult, Track } from 'lavalink-client';
import { dbReady, safe } from './db.js';
import { clip, dur, hours, isUrl, num, parseTime, plain } from './format.js';
import { COLOR, SEEK_STEP_MS, controlDenied, startWave, stopWave, posOf, queueMenu, seekTo, card, checkEmpty, guildSettings, manager, nowView, playerFor, postNowPlaying, refreshNowPlaying, saveSettings } from './player.js';
import { pauseClock, resumeClock, serverTotals, topArtists, topListeners, topTracks, userStats, type Period } from './stats.js';
import { resolve, suggestInfo } from './search.js';
import { WAVE_OPTIONS, feedback, isWaveTrack, loadPrefs, noPrefs, prefsText, savePrefs, waveOf, type WaveGroup, type WavePrefs } from './wave.js';
import { ico } from './icons.js';
import { findLyrics } from './lyrics.js';

const EPH = MessageFlags.Ephemeral;
export const MAX_QUEUE = 500;
export const MAX_PLAYLISTS = 25;
export const MAX_PLAYLIST_TRACKS = 300;

// ===== Описание команд =====
const period = (o: any) => o.setName('период').setDescription('За какое время').addChoices(
  { name: 'неделя', value: 'week' }, { name: 'месяц', value: 'month' }, { name: 'всё время', value: 'all' });
export const COMMANDS = [
  new SlashCommandBuilder().setName('играть').setDescription('Включить трек или плейлист: название или любая ссылка')
    .addStringOption(o => o.setName('запрос').setDescription('Название, исполнитель или ссылка (YouTube, SoundCloud, Spotify, mp3…)').setRequired(true).setAutocomplete(true).setMaxLength(500))
    .addBooleanOption(o => o.setName('следующим').setDescription('Поставить сразу после текущего')),
  new SlashCommandBuilder().setName('пауза').setDescription('Пауза / продолжить'),
  new SlashCommandBuilder().setName('пропуск').setDescription('Следующий трек')
    .addIntegerOption(o => o.setName('до').setDescription('Перейти к треку с этим номером в очереди').setMinValue(1)),
  new SlashCommandBuilder().setName('назад').setDescription('Предыдущий трек'),
  new SlashCommandBuilder().setName('стоп').setDescription('Остановить музыку, очистить очередь и выйти'),
  new SlashCommandBuilder().setName('очередь').setDescription('Что играет дальше')
    .addIntegerOption(o => o.setName('страница').setDescription('Номер страницы').setMinValue(1)),
  new SlashCommandBuilder().setName('сейчас').setDescription('Что сейчас играет'),
  new SlashCommandBuilder().setName('повтор').setDescription('Повтор трека или очереди')
    .addStringOption(o => o.setName('режим').setDescription('Режим').setRequired(true).addChoices(
      { name: 'выключить', value: 'off' }, { name: 'этот трек', value: 'track' }, { name: 'вся очередь', value: 'queue' })),
  new SlashCommandBuilder().setName('перемешать').setDescription('Перемешать очередь'),
  new SlashCommandBuilder().setName('громкость').setDescription('Громкость 1–150%')
    .addIntegerOption(o => o.setName('уровень').setDescription('Процент').setRequired(true).setMinValue(1).setMaxValue(150)),
  new SlashCommandBuilder().setName('перемотка').setDescription('Перемотать: 1:30, 90, +15, -10')
    .addStringOption(o => o.setName('время').setDescription('Например 1:30 или +15').setRequired(true)),
  new SlashCommandBuilder().setName('убрать').setDescription('Убрать трек из очереди')
    .addIntegerOption(o => o.setName('номер').setDescription('Номер в очереди').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('переместить').setDescription('Переставить трек в очереди')
    .addIntegerOption(o => o.setName('откуда').setDescription('Номер трека').setRequired(true).setMinValue(1))
    .addIntegerOption(o => o.setName('куда').setDescription('Новый номер').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('очистить').setDescription('Очистить очередь (текущий трек доиграет)'),
  new SlashCommandBuilder().setName('текст').setDescription('Текст песни')
    .addStringOption(o => o.setName('песня').setDescription('Пусто — текущая')),
  new SlashCommandBuilder().setName('фильтр').setDescription('Звуковой эффект')
    .addStringOption(o => o.setName('эффект').setDescription('Какой').setRequired(true).addChoices(
      { name: 'выключить всё', value: 'off' }, { name: 'бас', value: 'bass' }, { name: 'найткор', value: 'nightcore' },
      { name: 'вейпорвейв', value: 'vaporwave' }, { name: '8D', value: '8d' }, { name: 'караоке', value: 'karaoke' })),
  new SlashCommandBuilder().setName('волна').setDescription('Моя волна: бесконечная музыка под твой вкус, как в Яндекс Музыке'),
  new SlashCommandBuilder().setName('автоплей').setDescription('Когда очередь кончится — включать похожее'),
  new SlashCommandBuilder().setName('лайк').setDescription('Добавить текущий трек в «Любимое»'),
  new SlashCommandBuilder().setName('любимое').setDescription('Включить свои лайкнутые треки')
    .addBooleanOption(o => o.setName('перемешать').setDescription('В случайном порядке')),
  new SlashCommandBuilder().setName('плейлист').setDescription('Свои плейлисты')
    .addSubcommand(s => s.setName('создать').setDescription('Новый плейлист').addStringOption(o => o.setName('название').setDescription('Название').setRequired(true).setMaxLength(40)))
    .addSubcommand(s => s.setName('добавить').setDescription('Добавить трек (пусто — текущий, или вся очередь)')
      .addStringOption(o => o.setName('название').setDescription('Плейлист').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('запрос').setDescription('Трек или ссылка; пусто — текущий').setAutocomplete(true))
      .addBooleanOption(o => o.setName('очередь').setDescription('Добавить всю текущую очередь')))
    .addSubcommand(s => s.setName('играть').setDescription('Включить плейлист')
      .addStringOption(o => o.setName('название').setDescription('Плейлист').setRequired(true).setAutocomplete(true))
      .addBooleanOption(o => o.setName('перемешать').setDescription('В случайном порядке')))
    .addSubcommand(s => s.setName('показать').setDescription('Треки плейлиста').addStringOption(o => o.setName('название').setDescription('Плейлист').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('убрать').setDescription('Убрать трек из плейлиста')
      .addStringOption(o => o.setName('название').setDescription('Плейлист').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('номер').setDescription('Номер трека').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('список').setDescription('Мои плейлисты'))
    .addSubcommand(s => s.setName('удалить').setDescription('Удалить плейлист').addStringOption(o => o.setName('название').setDescription('Плейлист').setRequired(true).setAutocomplete(true))),
  new SlashCommandBuilder().setName('муз-топ').setDescription('Топ сервера: треки, исполнители, слушатели').addStringOption(period),
  new SlashCommandBuilder().setName('моя-музыка').setDescription('Сколько ты слушал и что заказывал')
    .addUserOption(o => o.setName('участник').setDescription('Чья статистика')).addStringOption(period),
  new SlashCommandBuilder().setName('музыка').setDescription('Как пользоваться ботом'),
].map(c => c.toJSON());

// ===== Помощники =====
const reply = (i: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction, text: string, color = COLOR.main, ephemeral = true) =>
  (i.deferred || i.replied ? i.editReply({ embeds: [card(text, color)] }) : i.reply({ embeds: [card(text, color)], flags: ephemeral ? EPH : undefined }));
const fail = (i: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction, text: string) => reply(i, `✕ ${text}`, COLOR.err);

/** Проверка «ты в том же войсе». Возвращает текст ошибки или null. */
function voiceProblem(i: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction, player: Player | undefined, needPlayer = true): string | null {
  const member = i.member as GuildMember | null;
  const vc = member?.voice?.channelId;
  if (!vc) return 'Зайди в голосовой канал.';
  if (needPlayer && !player?.queue.current && !player?.queue.tracks.length) return 'Сейчас ничего не играет. Включи: `/играть`';
  if (player?.voiceChannelId && player.voiceChannelId !== vc) return `Я играю в <#${player.voiceChannelId}> — зайди туда.`;
  return null;
}
const trackLine = (t: Track, n?: number) => `${n ? `\`${n}.\` ` : ''}[${plain(clip(t.info.title, 60))}](${t.info.uri}) · ${plain(clip(t.info.author || '', 30))} \`${t.info.isStream ? 'эфир' : dur(t.info.duration)}\``;

function queueEmbed(player: Player, page = 1) {
  const per = 10, list = player.queue.tracks as Track[];
  const pages = Math.max(1, Math.ceil(list.length / per)), p = Math.min(Math.max(1, page), pages);
  const total = list.reduce((s, t) => s + (t.info.isStream ? 0 : t.info.duration), 0);
  const cur = player.queue.current;
  return card([
    cur ? `**Сейчас:** ${trackLine(cur)}` : '',
    '',
    list.length ? list.slice((p - 1) * per, p * per).map((t, k) => trackLine(t, (p - 1) * per + k + 1)).join('\n') : '-# Дальше пусто — добавь: `/играть`',
    '',
    `-# ${list.length} в очереди · ${dur(total)} · страница ${p}/${pages}`,
  ].join('\n')).setAuthor({ name: '📜 Очередь' });
}

async function addResult(player: Player, r: SearchResult, next: boolean): Promise<{ added: Track[]; playlist: string | null }> {
  const room = MAX_QUEUE - player.queue.tracks.length;
  if (room <= 0) return { added: [], playlist: null };
  const tracks = (r.loadType === 'playlist' ? r.tracks : r.tracks.slice(0, 1)).slice(0, room);
  const waveAt = (player.queue.tracks as Track[]).findIndex(isWaveTrack); // свои треки — раньше треков волны
  if (next) await player.queue.add(tracks, 0); else if (waveAt >= 0) await player.queue.add(tracks, waveAt); else await player.queue.add(tracks);
  return { added: tracks, playlist: r.loadType === 'playlist' ? r.playlist?.name ?? 'плейлист' : null };
}
async function startIfIdle(player: Player): Promise<void> {
  if (!player.playing && !player.paused) await player.play({ paused: false });
}

/** Поставить в очередь готовые строки (лайки/плейлисты): каждая — поиск по ссылке. */
async function enqueueRows(i: ChatInputCommandInteraction, rows: Array<{ uri: string; title: string; author: string | null }>, label: string, shuffle: boolean) {
  const player = manager().getPlayer(i.guildId!);
  const problem = voiceProblem(i, player, false);
  if (problem) return void fail(i, problem);
  if (!rows.length) return void fail(i, `${label} пуст.`);
  await i.deferReply({ flags: EPH });
  const p = await playerFor(i.guildId!, (i.member as GuildMember).voice.channelId!, i.channelId);
  if (shuffle) rows = [...rows].sort(() => Math.random() - 0.5);
  let added = 0;
  // Первый — сразу (чтобы заиграло без ожидания), остальные — пачкой по 5 параллельно.
  const one = async (row: (typeof rows)[number]) => {
    if (p.queue.tracks.length >= MAX_QUEUE) return;
    const r = await resolve(manager(), isUrl(row.uri) ? row.uri : `${row.author ?? ''} ${row.title}`, i.user).catch(() => null);
    if (r?.tracks[0]) { await p.queue.add(r.tracks[0]); added++; }
  };
  await one(rows[0]);
  await startIfIdle(p);
  for (let k = 1; k < rows.length; k += 5) await Promise.all(rows.slice(k, k + 5).map(one));
  await i.editReply({ embeds: [card(`✅ ${label}: в очередь **${added}** из ${rows.length}${shuffle ? ' · перемешано' : ''}.`, COLOR.ok)] });
}

// ===== Плейлисты =====
async function playlistByName(userId: string, name: string) {
  return (await safe<{ id: string; name: string }>('SELECT id, name FROM music_playlists WHERE user_id = $1 AND lower(name) = lower($2)', [userId, name.trim()]))?.[0] ?? null;
}
async function playlistRows(id: string) {
  return await safe<{ pos: number; uri: string; title: string; author: string | null; duration_ms: number }>(
    'SELECT pos, uri, title, author, duration_ms FROM music_playlist_tracks WHERE playlist_id = $1 ORDER BY pos', [id]) ?? [];
}
async function addToPlaylist(id: string, tracks: Track[]): Promise<number> {
  const rows = await playlistRows(id);
  const have = new Set(rows.map(r => r.uri));
  let pos = rows.length ? Math.max(...rows.map(r => r.pos)) + 1 : 1, n = 0;
  for (const t of tracks) {
    if (rows.length + n >= MAX_PLAYLIST_TRACKS) break;
    if (have.has(t.info.uri)) continue;
    have.add(t.info.uri);
    const ok = await safe('INSERT INTO music_playlist_tracks (playlist_id, pos, uri, title, author, duration_ms) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [id, pos++, t.info.uri, t.info.title.slice(0, 300), (t.info.author ?? '').slice(0, 200), Math.min(t.info.duration || 0, 2e9)]);
    if (ok) n++;
  }
  return n;
}

async function playlistCommand(i: ChatInputCommandInteraction) {
  if (!dbReady) return void fail(i, 'Плейлисты сейчас недоступны — база не подключена.');
  const sub = i.options.getSubcommand(), me = i.user.id, name = i.options.getString('название') ?? '';
  if (sub === 'список') {
    const rows = await safe<{ name: string; n: number }>(`SELECT p.name, COUNT(t.pos)::int n FROM music_playlists p LEFT JOIN music_playlist_tracks t ON t.playlist_id = p.id
      WHERE p.user_id = $1 GROUP BY p.id ORDER BY p.created_at`, [me]) ?? [];
    return void reply(i, rows.length ? rows.map(r => `🎵 **${plain(r.name)}** — ${r.n} тр.`).join('\n') + '\n\n-# Включить: `/плейлист играть`' : 'Плейлистов пока нет. Создай: `/плейлист создать`');
  }
  if (sub === 'создать') {
    const clean = name.replace(/[*_`~|<>@#]/g, '').trim();
    if (!clean) return void fail(i, 'Пустое название.');
    const count = (await safe<{ n: number }>('SELECT COUNT(*)::int n FROM music_playlists WHERE user_id = $1', [me]))?.[0]?.n ?? 0;
    if (count >= MAX_PLAYLISTS) return void fail(i, `Не больше ${MAX_PLAYLISTS} плейлистов.`);
    const r = await safe('INSERT INTO music_playlists (user_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [me, clean]);
    return void (r?.length ? reply(i, `✅ Плейлист **${plain(clean)}** создан. Добавляй: \`/плейлист добавить\``, COLOR.ok) : fail(i, 'Такой плейлист уже есть.'));
  }
  const pl = await playlistByName(me, name);
  if (!pl) return void fail(i, `Плейлиста «${plain(name)}» нет. Мои: \`/плейлист список\``);
  if (sub === 'удалить') {
    await safe('DELETE FROM music_playlists WHERE id = $1', [pl.id]);
    return void reply(i, `🗑️ Плейлист **${plain(pl.name)}** удалён.`);
  }
  if (sub === 'показать') {
    const rows = await playlistRows(pl.id);
    const total = rows.reduce((s, r) => s + r.duration_ms, 0);
    return void reply(i, [`### 🎵 ${plain(pl.name)}`, ...rows.slice(0, 30).map((r, k) => `\`${k + 1}.\` ${plain(clip(r.title, 60))} · ${plain(clip(r.author ?? '', 30))}`),
      rows.length > 30 ? `-# …и ещё ${rows.length - 30}` : '', `-# ${rows.length} тр. · ${dur(total)}`].filter(Boolean).join('\n'));
  }
  if (sub === 'убрать') {
    const rows = await playlistRows(pl.id), n = i.options.getInteger('номер', true), row = rows[n - 1];
    if (!row) return void fail(i, `В плейлисте ${rows.length} тр.`);
    await safe('DELETE FROM music_playlist_tracks WHERE playlist_id = $1 AND pos = $2', [pl.id, row.pos]);
    return void reply(i, `Убрал **${plain(clip(row.title, 80))}** из «${plain(pl.name)}».`);
  }
  if (sub === 'играть') return void enqueueRows(i, await playlistRows(pl.id), `Плейлист «${plain(pl.name)}»`, Boolean(i.options.getBoolean('перемешать')));
  if (sub === 'добавить') {
    const player = manager().getPlayer(i.guildId!);
    const q = i.options.getString('запрос');
    let tracks: Track[] = [];
    if (i.options.getBoolean('очередь')) tracks = [player?.queue.current, ...(player?.queue.tracks ?? [])].filter(Boolean) as Track[];
    else if (q) {
      await i.deferReply({ flags: EPH });
      const r = await resolve(manager(), q, i.user).catch(() => null);
      tracks = r ? (r.loadType === 'playlist' ? r.tracks : r.tracks.slice(0, 1)) : [];
    } else if (player?.queue.current) tracks = [player.queue.current];
    if (!tracks.length) return void fail(i, q ? 'Ничего не нашёл.' : 'Сейчас ничего не играет — укажи трек в «запрос».');
    const n = await addToPlaylist(pl.id, tracks);
    return void reply(i, n ? `✅ В «${plain(pl.name)}» добавлено: **${n}**${n === 1 ? ` — ${plain(clip(tracks[0].info.title, 80))}` : ''}.` : 'Эти треки уже есть в плейлисте (или он заполнен).', n ? COLOR.ok : COLOR.main);
  }
}

// ===== Текст песни: lrclib → Genius → lyrics.ovh (lyrics.ts) =====
export const lyrics = findLyrics;

// ===== Статистика =====
async function topCommand(i: ChatInputCommandInteraction) {
  if (!dbReady) return void fail(i, 'Статистика недоступна — база не подключена.');
  const p = (i.options.getString('период') ?? 'week') as Period, label = { week: 'за неделю', month: 'за месяц', all: 'за всё время' }[p];
  await i.deferReply();
  const [tracks, people, artists, totals] = await Promise.all([topTracks(i.guildId!, p), topListeners(i.guildId!, p), topArtists(i.guildId!, p), serverTotals(i.guildId!, p)]);
  const medal = (k: number) => ['🥇', '🥈', '🥉'][k] ?? `\`${k + 1}.\``;
  const e = card([
    `## 🎧 Музыка сервера ${label}`,
    totals ? `-# ${num(totals.plays)} треков · ${hours(Number(totals.ms))} музыки · слушали ${totals.people} чел.` : '',
    '', '### 🔥 Треки',
    tracks.length ? tracks.map((t, k) => `${medal(k)} [${plain(clip(t.title, 50))}](${t.uri}) · ${plain(clip(t.author ?? '', 25))} — **${t.plays}**`).join('\n') : '-# пока пусто',
    '', '### 🎤 Исполнители',
    artists.length ? artists.map((a, k) => `${medal(k)} ${plain(clip(a.author, 40))} — **${a.plays}**`).join('\n') : '-# пока пусто',
    '', '### 👂 Слушатели',
    people.length ? people.map((u, k) => `${medal(k)} <@${u.user_id}> — **${hours(Number(u.ms))}** · ${u.tracks} тр.`).join('\n') : '-# пока пусто',
  ].filter(x => x !== '').join('\n').slice(0, 4000));
  await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
}
async function myCommand(i: ChatInputCommandInteraction) {
  if (!dbReady) return void fail(i, 'Статистика недоступна — база не подключена.');
  const user = i.options.getUser('участник') ?? i.user;
  const p = (i.options.getString('период') ?? 'week') as Period, label = { week: 'за неделю', month: 'за месяц', all: 'за всё время' }[p];
  const s = await userStats(i.guildId!, user.id, p);
  const e = card([
    `## 🎧 ${user.id === i.user.id ? 'Твоя музыка' : `Музыка ${plain(user.displayName)}`} ${label}`,
    `# ${hours(s.ms)}`,
    `-# прослушано в войсе · ${s.tracks} тр. · ${s.days} дн. · заказано ${s.total}`,
    '', '### 🔁 Чаще всего заказывал',
    s.ordered.length ? s.ordered.map((t, k) => `\`${k + 1}.\` [${plain(clip(t.title, 50))}](${t.uri}) — **${t.plays}**`).join('\n') : '-# пока ничего',
    s.artists.length ? `\n**Любимые исполнители:** ${s.artists.map(a => plain(a.author)).join(', ')}` : '',
  ].join('\n')).setThumbnail(user.displayAvatarURL());
  await i.reply({ embeds: [e], allowedMentions: { parse: [] } });
}

// ===== Обработчик команд =====
export async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
  if (!i.inCachedGuild()) return void i.reply({ content: 'Только на сервере.', flags: EPH });
  const lava = manager();
  const player = lava.getPlayer(i.guildId);
  const name = i.commandName;
  if (!lava.nodeManager.leastUsedNodes().length && ['играть', 'любимое'].includes(name)) return void fail(i, 'Музыкальный движок запускается — попробуй через полминуты.');

  if (name === 'играть') {
    const problem = voiceProblem(i, player, false);
    if (problem) return void fail(i, problem);
    const me = i.guild.members.me;
    const vc = i.member.voice.channel!;
    if (me && !vc.permissionsFor(me).has(['Connect', 'Speak'])) return void fail(i, `Нет прав зайти или говорить в <#${vc.id}>.`);
    await i.deferReply({ flags: EPH });
    const q = i.options.getString('запрос', true);
    const r = await resolve(lava, q, i.user).catch(() => null);
    if (!r) return void i.editReply({ embeds: [card(`✕ Ничего не нашёл по «${plain(clip(q, 80))}».${isUrl(q) ? '\n-# Ссылка не открылась: сервис не поддерживается или трек недоступен в регионе.' : ''}`, COLOR.err)] });
    const p = await playerFor(i.guildId, vc.id, i.channelId);
    const was = Boolean(p.queue.current);
    const { added, playlist } = await addResult(p, r, Boolean(i.options.getBoolean('следующим')));
    if (!added.length) return void i.editReply({ embeds: [card(`✕ Очередь заполнена (${MAX_QUEUE}).`, COLOR.err)] });
    await startIfIdle(p);
    const t = added[0];
    const text = playlist
      ? `✅ Плейлист **${plain(clip(playlist, 80))}** — в очереди **${added.length}** тр.`
      : was ? `✅ В очередь${i.options.getBoolean('следующим') ? ' (следующим)' : ` · №${p.queue.tracks.indexOf(t) + 1}`}: ${trackLine(t)}` : `▶️ Включаю: ${trackLine(t)}`;
    await i.editReply({ embeds: [card(text, COLOR.ok).setThumbnail(t.info.artworkUrl ?? null)] });
    if (was) void refreshNowPlaying(p);
    return;
  }
  if (name === 'музыка') return void reply(i, [
    '## 🎶 PV Music',
    '`/играть` — название или ссылка: SoundCloud, Spotify, Яндекс Музыка, YouTube, mp3; плейлисты и альбомы — до 25 треков. Подсказки появляются прямо при вводе.',
    '`/волна` — 🌊 Моя волна: бесконечная музыка под твой вкус. ❤️ — больше такого, 👎 — в дизлайки и дальше; настройки: занятие, настроение, характер, язык.',
    'Кнопки под плеером: ⏮️ ⏸️ ⏭️ · ⏪ ⏩ 10 с · 🔉 🔊 · 📜 очередь · 🔀 🔁 ♾️ ❤️ ⏹️',
    '`/очередь` `/пропуск` `/назад` `/перемотка` `/повтор` `/перемешать` `/убрать` `/переместить` `/очистить` `/громкость`',
    '`/текст` — слова песни · `/фильтр` — бас, найткор, 8D… · `/автоплей` — похожее, когда очередь кончится',
    '`/лайк` и `/любимое` · `/плейлист` — свои плейлисты',
    '`/муз-топ` — топ сервера · `/моя-музыка` — сколько ты слушал',
    '-# Управляет тот, кто заказал текущий трек (ушёл из войса — любой). Пустой войс — пауза, потом ухожу.',
  ].join('\n'));
  if (name === 'муз-топ') return topCommand(i);
  if (name === 'моя-музыка') return myCommand(i);
  if (name === 'плейлист') return playlistCommand(i);
  if (name === 'любимое') {
    if (!dbReady) return void fail(i, 'База не подключена.');
    const rows = await safe<{ uri: string; title: string; author: string | null }>('SELECT uri, title, author FROM music_likes WHERE user_id = $1 ORDER BY added_at DESC LIMIT $2', [i.user.id, MAX_PLAYLIST_TRACKS]) ?? [];
    return enqueueRows(i, rows, '«Любимое»', Boolean(i.options.getBoolean('перемешать')));
  }
  if (name === 'лайк') return void like(i, player);
  if (name === 'текст') {
    const q = i.options.getString('песня');
    const cur = player?.queue.current;
    if (!q && !cur) return void fail(i, 'Сейчас ничего не играет — напиши название песни.');
    await i.deferReply({ flags: EPH });
    const found = await lyrics(q ? { title: q } : { title: cur!.info.title, author: cur!.info.author, duration: cur!.info.duration });
    if (!found) return void i.editReply({ embeds: [card('✕ Текст не нашёл. Попробуй указать «исполнитель — песня» вручную.', COLOR.err)] });
    const text = found.text.length > 3900 ? found.text.slice(0, 3900) + '\n…' : found.text;
    return void i.editReply({ embeds: [card(`### 📝 ${plain(clip(found.title, 200))}\n${plain(text)}`).setFooter({ text: `Текст: ${found.source}` })] });
  }

  if (name === 'волна') return waveAction(i, 'go');
  // Дальше — управление: нужен плеер и тот же войс.
  const problem = voiceProblem(i, player, name !== 'автоплей');
  if (problem) return void fail(i, problem);
  const denied = ['очередь', 'сейчас'].includes(name) ? null : controlDenied(i.user.id, player);
  if (denied) return void fail(i, denied);
  if (name === 'автоплей') {
    const s = await guildSettings(i.guildId);
    await saveSettings(i.guildId, { autoplay: !s.autoplay });
    if (player) void refreshNowPlaying(player);
    return void reply(i, !s.autoplay ? '♾️ Автоплей **включён**: когда очередь кончится, включу похожее.' : 'Автоплей **выключен**.');
  }
  const p = player!;
  if (name === 'стоп') p.set('stoppedBy', i.user.id);
  if (name === 'сейчас') { await postNowPlaying(i.client, p); return void reply(i, '🎶 Плеер — внизу чата.'); }
  if (name === 'очередь') return void i.reply({ embeds: [queueEmbed(p, i.options.getInteger('страница') ?? 1)], flags: EPH });
  if (name === 'перемотка') await i.deferReply({ flags: EPH }); // SoundCloud открывает новый поток 1–3 с
  const result = await control(p, name, i);
  if (result) await reply(i, result.text, result.ok ? COLOR.ok : COLOR.err);
  void refreshNowPlaying(p);
}

type Result = { ok: boolean; text: string } | null;
/** Общая логика для команд и кнопок. */
async function control(p: Player, name: string, i: ChatInputCommandInteraction | null): Promise<Result> {
  const ok = (text: string) => ({ ok: true, text }), no = (text: string) => ({ ok: false, text });
  switch (name) {
    case 'пауза': case 'pause':
      if (p.paused) { await p.resume(); resumeClock(p.guildId); p.set('autoPaused', false); return ok('▶️ Продолжаю.'); }
      await p.pause(); pauseClock(p.guildId); return ok('⏸️ Пауза.');
    case 'пропуск': case 'skip': {
      const to = i?.options.getInteger('до');
      if (to && to > p.queue.tracks.length) return no(`В очереди ${p.queue.tracks.length} тр.`);
      if (!p.queue.tracks.length && !(await guildSettings(p.guildId)).autoplay) { await p.stopPlaying(true, false); return ok('⏭️ Пропустил — очередь закончилась.'); }
      const title = p.queue.current?.info.title ?? '';
      await p.skip(to ?? 0, false);
      return ok(`⏭️ Пропустил **${plain(clip(title, 80))}**.`);
    }
    case 'назад': case 'prev': {
      const prev = p.queue.previous[0];
      if (!prev) return no('Предыдущего трека нет.');
      p.queue.previous.shift();
      if (p.queue.current) await p.queue.add(p.queue.current, 0);
      await p.play({ clientTrack: prev });
      // Текущий, который мы вернули в очередь, не должен остаться ещё и в истории.
      if (p.queue.previous[0]?.info.uri === prev.info.uri) p.queue.previous.shift();
      return ok(`⏮️ Назад: **${plain(clip(prev.info.title, 80))}**.`);
    }
    case 'стоп': case 'stop':
      await p.destroy('stopped');
      return ok('⏹️ Остановил и вышел.');
    case 'повтор': case 'loop': {
      const order: RepeatMode[] = ['off', 'queue', 'track'];
      const mode = (i?.options.getString('режим') as RepeatMode | null) ?? order[(order.indexOf(p.repeatMode) + 1) % 3];
      await p.setRepeatMode(mode);
      return ok({ off: '➡️ Повтор выключен.', track: '🔂 Повторяю этот трек.', queue: '🔁 Повторяю всю очередь.' }[mode]);
    }
    case 'перемешать': case 'shuffle':
      if (p.queue.tracks.length < 2) return no('В очереди меньше двух треков.');
      await p.queue.shuffle(); return ok(`🔀 Перемешал ${p.queue.tracks.length} тр.`);
    case 'громкость': case 'voldown': case 'volup': {
      const v = name === 'громкость' ? i!.options.getInteger('уровень', true) : Math.max(5, Math.min(150, p.volume + (name === 'volup' ? 10 : -10)));
      await p.setVolume(v); await saveSettings(p.guildId, { volume: v });
      return ok(`🔊 Громкость ${v}%.`);
    }
    case 'перемотка': {
      const cur = p.queue.current;
      if (!cur || cur.info.isStream) return no('Этот трек нельзя перематывать.');
      const ms = parseTime(i!.options.getString('время', true), posOf(p));
      if (ms === null) return no('Не понял время. Примеры: `1:30`, `90`, `+15`, `-10`.');
      if (ms >= cur.info.duration) return no(`Трек длится ${dur(cur.info.duration)}.`);
      const err = await seekTo(p, ms);
      return err ? no(err) : ok(`⏩ Перемотал на ${dur(ms)}.`);
    }
    case 'убрать': {
      const n = i!.options.getInteger('номер', true);
      const t = p.queue.tracks[n - 1];
      if (!t) return no(`В очереди ${p.queue.tracks.length} тр.`);
      await p.queue.splice(n - 1, 1);
      return ok(`Убрал **${plain(clip(t.info.title, 80))}**.`);
    }
    case 'переместить': {
      const from = i!.options.getInteger('откуда', true), to = i!.options.getInteger('куда', true), len = p.queue.tracks.length;
      if (from > len || to > len) return no(`В очереди ${len} тр.`);
      const [t] = await p.queue.splice(from - 1, 1) as Track[];
      await p.queue.add(t, to - 1);
      return ok(`↕️ **${plain(clip(t.info.title, 60))}** теперь №${to}.`);
    }
    case 'очистить': {
      const n = p.queue.tracks.length;
      await p.queue.splice(0, n);
      return ok(`🧹 Очередь очищена (${n} тр.). Текущий доиграет.`);
    }
    case 'фильтр': {
      const f = i!.options.getString('эффект', true), fm = p.filterManager;
      await fm.resetFilters();
      if (f === 'bass') await fm.setEQPreset('BassboostMedium');
      if (f === 'nightcore') await fm.toggleNightcore();
      if (f === 'vaporwave') await fm.toggleVaporwave();
      if (f === '8d') await fm.toggleRotation(0.2);
      if (f === 'karaoke') await fm.toggleKaraoke();
      return ok(f === 'off' ? '🎚️ Эффекты выключены.' : `🎚️ Эффект включён: **${{ bass: 'бас', nightcore: 'найткор', vaporwave: 'вейпорвейв', '8d': '8D', karaoke: 'караоке' }[f]}**. Выключить: \`/фильтр выключить всё\``);
    }
  }
  return null;
}

async function like(i: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction, player: Player | undefined) {
  const t = player?.queue.current;
  if (!t) return void fail(i, 'Сейчас ничего не играет.');
  if (!dbReady) return void fail(i, 'База не подключена.');
  await i.deferReply({ flags: EPH });
  const r = await safe(`INSERT INTO music_likes (user_id, uri, title, author, duration_ms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING uri`,
    [i.user.id, t.info.uri, t.info.title.slice(0, 300), (t.info.author ?? '').slice(0, 200), Math.min(t.info.duration || 0, 2e9)]);
  if (!r?.length) {
    await safe('DELETE FROM music_likes WHERE user_id = $1 AND uri = $2', [i.user.id, t.info.uri]);
    void feedback(i.user.id, t, -2).catch(() => undefined);
    return void reply(i, `💔 Убрал из «Любимого»: **${plain(clip(t.info.title, 80))}**.`);
  }
  void feedback(i.user.id, t, 2).catch(() => undefined); // как в Яндексе: лайк — волна запомнит
  return void reply(i, `❤️ В «Любимое»: **${plain(clip(t.info.title, 80))}**.\n-# Волна запомнит: похожего будет больше. Всё любимое: \`/любимое\``, COLOR.ok);
}

/** Кнопка «📝 Текст» в плеере: слова текущего трека видит только нажавший (lrclib.net, как /текст). */
async function showLyrics(i: ButtonInteraction | StringSelectMenuInteraction, player: Player | undefined) {
  const t = player?.queue.current;
  if (!t) return void fail(i, 'Сейчас ничего не играет.');
  await i.deferReply({ flags: EPH });
  const found = await lyrics({ title: t.info.title, author: t.info.author, duration: t.info.duration }).catch(() => null);
  if (!found) return void i.editReply({ embeds: [card(`✕ Текст «${plain(clip(t.info.title, 80))}» не нашёл.\n-# Попробуй вручную: \`/текст песня: исполнитель — название\``, COLOR.err)] });
  const text = found.text.length > 3900 ? found.text.slice(0, 3900) + '\n…' : found.text;
  return void i.editReply({ embeds: [card(`### 📝 ${plain(clip(found.title, 200))}\n${plain(text)}`).setFooter({ text: `Текст: ${found.source}` })] });
}

// ===== Моя волна: окно настроек (видит только нажавший) =====
function wavePanel(prefs: WavePrefs, active: boolean) {
  const rows = (Object.keys(WAVE_OPTIONS) as WaveGroup[]).map(g => new ActionRowBuilder<ButtonBuilder>().addComponents(
    Object.entries(WAVE_OPTIONS[g]).map(([v, label]) => new ButtonBuilder().setCustomId(`mus:wave:set:${g}:${v}`)
      .setLabel(prefs[g] === v ? `✓ ${label}` : label).setStyle(prefs[g] === v ? ButtonStyle.Primary : ButtonStyle.Secondary))));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('mus:wave:go').setEmoji(ico('wave', '🌊')).setLabel(active ? 'Обновить волну' : 'Запустить волну').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mus:wave:reset').setLabel('Сбросить').setStyle(ButtonStyle.Secondary),
    ...(active ? [new ButtonBuilder().setCustomId('mus:wave:off').setEmoji(ico('stop', '⏹️')).setLabel('Выключить волну').setStyle(ButtonStyle.Secondary)] : [])));
  const chosen = prefsText(prefs);
  return {
    embeds: [card([
      '## 🌊 Моя волна',
      'Бесконечная музыка под твой вкус. Учится на ❤️ лайках, 👎 дизлайках и на том, что ты дослушиваешь или пропускаешь.',
      '-# Ряды: занятие · настроение · характер · язык. Ничего не выбрано — волна просто под тебя.',
      chosen ? `**Сейчас:** ${chosen}` : '**Сейчас:** просто под тебя',
    ].join('\n'))],
    components: rows,
  };
}
async function waveAction(i: ChatInputCommandInteraction | ButtonInteraction, action: string): Promise<void> {
  const player = manager().getPlayer(i.guildId!);
  const mine = waveOf(player)?.owner === i.user.id;
  if (action === 'panel' || action === '') {
    await i.deferReply({ flags: EPH });
    const prefs = await loadPrefs(i.user.id);
    return void i.editReply({ ...wavePanel(prefs, Boolean(player && mine)) }).catch(() => undefined);
  }
  if (action.startsWith('set:') || action === 'reset') {
    const button = i as ButtonInteraction;
    await button.deferUpdate().catch(() => undefined);
    const [, g, v] = action.split(':') as [string, WaveGroup, string];
    const prefs = action === 'reset' ? noPrefs() : await loadPrefs(i.user.id);
    if (action !== 'reset') prefs[g] = prefs[g] === v ? null : v;
    await savePrefs(i.user.id, prefs);
    return void button.editReply(wavePanel(prefs, Boolean(player && mine))).catch(() => undefined);
  }
  if (action === 'off') {
    if (!player || !waveOf(player)) return void fail(i, 'Волна и так выключена.');
    const denied = mine ? null : controlDenied(i.user.id, player);
    if (denied) return void fail(i, denied);
    await i.deferReply({ flags: EPH });
    await stopWave(player);
    return void reply(i, '⏹️ Волна выключена. Текущий трек доиграет.');
  }
  // go: запустить/обновить волну
  const problem = voiceProblem(i, player, false);
  if (problem) return void fail(i, problem);
  const denied = player?.queue.current ? controlDenied(i.user.id, player) : null;
  if (denied) return void fail(i, denied);
  const vc = (i.member as GuildMember).voice.channel!;
  const me = i.guild!.members.me;
  if (me && !vc.permissionsFor(me).has(['Connect', 'Speak'])) return void fail(i, `Нет прав зайти или говорить в <#${vc.id}>.`);
  await i.deferReply({ flags: EPH });
  const p = await playerFor(i.guildId!, vc.id, i.channelId!);
  const n = await startWave(p, { id: i.user.id, username: (i.member as GuildMember).displayName ?? i.user.username }).catch(e => { console.warn('[волна]', e.message); return 0; });
  if (!n) { await stopWave(p).catch(() => undefined); return void i.editReply({ embeds: [card('✕ Не получилось собрать волну — SoundCloud не ответил. Попробуй ещё раз через минуту.', COLOR.err)] }); }
  const prefs = await loadPrefs(i.user.id), chosen = prefsText(prefs);
  await i.editReply({ ...wavePanel(prefs, true), embeds: [card(`🌊 **Моя волна** включена${chosen ? ` · ${chosen.toLowerCase()}` : ''}.\n-# ❤️ — больше такого · 👎 — в дизлайки и дальше. Ниже — настройки волны: выбери и нажми «Обновить волну».`, COLOR.ok)] });
}

// ===== Кнопки и меню плеера =====
export async function handleButton(i: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  if (!i.inCachedGuild() || !i.customId.startsWith('mus:')) return;
  const action = i.customId.slice(4);
  const player = manager().getPlayer(i.guildId);
  if (action === 'like') return like(i, player);
  if (action === 'lyrics') return showLyrics(i, player);
  if (action.startsWith('wave:')) return waveAction(i as ButtonInteraction, action.slice(5));
  if (action === 'dislike') {
    const t = player?.queue.current;
    if (!player || !t) return void fail(i, 'Сейчас ничего не играет.');
    const p2 = voiceProblem(i, player); if (p2) return void fail(i, p2);
    const d2 = controlDenied(i.user.id, player); if (d2) return void fail(i, d2);
    await i.deferReply({ flags: EPH });
    await feedback(i.user.id, t, -3).catch(() => undefined);
    await safe('DELETE FROM music_likes WHERE user_id = $1 AND uri = $2', [i.user.id, t.info.uri]);
    await player.skip(0, false).catch(() => player.stopPlaying(true, false));
    return void reply(i, `👎 **${plain(clip(t.info.title, 80))}** — в дизлайках, больше не попадётся. Включаю дальше.`);
  }
  if (action === 'leave') {
    const denied = controlDenied(i.user.id, player);
    if (denied) return void fail(i, denied);
    await i.deferUpdate().catch(() => undefined);
    player?.set('stoppedBy', i.user.id);
    if (player) await player.destroy('stopped');
    return;
  }
  if (action === 'replay') {
    const member = i.member as GuildMember;
    const last = player?.queue.previous[0];
    if (!player || !last) return void fail(i, 'Нечего повторять — включи: `/играть`');
    if (member.voice.channelId !== player.voiceChannelId) return void fail(i, `Зайди в <#${player.voiceChannelId}>.`);
    await i.deferUpdate().catch(() => undefined);
    await player.queue.add(last);
    if (!player.playing) await player.play({ paused: false });
    return;
  }
  const problem = voiceProblem(i, player, action !== 'autoplay' && action !== 'queue');
  if (problem) return void fail(i, problem);
  const denied = action === 'queue' ? null : controlDenied(i.user.id, player);
  if (denied) return void fail(i, denied);
  if (action === 'stop') player?.set('stoppedBy', i.user.id);
  if (action === 'autoplay') {
    await i.deferUpdate().catch(() => undefined);
    const s = await guildSettings(i.guildId);
    await saveSettings(i.guildId, { autoplay: !s.autoplay });
    // Очередь уже кончилась, а автоплей включили — сразу похожее.
    if (!s.autoplay && player && !player.queue.current && player.queue.previous[0]) {
      const last = player.queue.previous[0];
      const r = await resolve(manager(), `${last.info.author.replace(/\s*-\s*topic$/i, '')}`, i.user).catch(() => null);
      const pick = r?.tracks.find(t => t.info.uri !== last.info.uri);
      if (pick) { await player.queue.add(pick); await player.play({ paused: false }); }
      return;
    }
  } else if (action === 'queue') {
    if (!player?.queue.tracks.length) return void fail(i, 'Очередь пуста — добавь: `/играть`');
    return void i.reply({ embeds: [queueEmbed(player, 1)], components: [queueMenu(player)], flags: EPH }).catch(() => undefined);
  } else if (action === 'back' || action === 'fwd') {
    await i.deferUpdate().catch(() => undefined);
    const err = await seekTo(player!, posOf(player!) + (action === 'fwd' ? SEEK_STEP_MS : -SEEK_STEP_MS));
    if (err) return void i.followUp({ embeds: [card(`✕ ${err}`, COLOR.err)], flags: EPH }).catch(() => undefined);
    return void refreshNowPlaying(player!);
  } else if (action === 'jump' && i.isStringSelectMenu()) {
    const n = Number(i.values[0]);
    if (!(n >= 1 && n <= player!.queue.tracks.length)) return void fail(i, 'Этого трека в очереди уже нет.');
    const pick = player!.queue.tracks[n - 1] as Track;
    await i.deferUpdate().catch(() => undefined);
    await player!.skip(n, false);
    return void i.editReply({ embeds: [card(`▶️ Включаю **${plain(clip(pick.info.title, 80))}**.`, COLOR.ok)], components: [] }).catch(() => undefined);
  } else {
    // Сначала принимаем кнопку: действие и новая обложка могут занять больше 3 секунд Discord.
    await i.deferUpdate().catch(() => undefined);
    const r = await control(player!, action, null);
    if (!r) return;
    if (!r.ok) return void i.followUp({ embeds: [card(`✕ ${r.text}`, COLOR.err)], flags: EPH }).catch(() => undefined);
    if (['stop', 'skip', 'prev'].includes(action)) return; // новый трек сам обновит плеер
  }
  const p = manager().getPlayer(i.guildId);
  if (p?.queue.current) { const v = await nowView(p); await i.editReply({ components: v.components, files: v.files, attachments: [] }).catch(() => undefined); }
}

// ===== Автодополнение =====
export async function handleAutocomplete(i: AutocompleteInteraction): Promise<void> {
  const focused = i.options.getFocused(true);
  try {
    if (focused.name === 'название') {
      const rows = await safe<{ name: string }>('SELECT name FROM music_playlists WHERE user_id = $1 AND name ILIKE $2 ORDER BY created_at LIMIT 25',
        [i.user.id, `%${String(focused.value).replace(/[%_]/g, '')}%`]) ?? [];
      return void await i.respond(rows.map(r => ({ name: r.name, value: r.name })));
    }
    if (focused.name === 'запрос') {
      const list = await suggestInfo(String(focused.value));
      return void await i.respond(list.filter(t => t.uri && t.uri.length <= 100).slice(0, 10).map(t => ({
        name: clip(`${t.title} — ${t.author} (${dur(t.duration)})`, 100),
        value: t.uri,
      })));
    }
    await i.respond([]);
  } catch { await i.respond([]).catch(() => undefined); }
}

export async function route(i: Interaction): Promise<void> {
  if (i.isAutocomplete()) return handleAutocomplete(i);
  if (i.isButton() || i.isStringSelectMenu()) return handleButton(i);
  if (i.isChatInputCommand()) return handleCommand(i);
}
export { checkEmpty };

