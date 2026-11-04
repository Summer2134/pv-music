// PV Music: /играть, очередь, кнопки и управление на поддельном Lavalink (настоящий движок — только на сервере).
// MUSIC_TOKEN=x MUSIC_CLIENT_ID=1 node scripts/smoke-music-play.mjs   (база не нужна)
import assert from 'node:assert/strict';
const P = await import('../dist/player.js');
const C = await import('../dist/commands.js');
const sent = [];
const channel = { lastMessageId: null, isSendable: () => true, send: async p => { const m = { id: 'm' + sent.length, p, edit: async x => { m.p = { ...m.p, ...x }; }, delete: async () => { m.deleted = true; } }; sent.push(m); channel.lastMessageId = m.id; return m; } };
const client = { on() {}, guilds: { cache: new Map() }, channels: { fetch: async () => channel, cache: new Map() }, user: { id: 'bot' } };
const lava = P.createManager(client);
const T = (n, extra = {}) => ({ info: { title: 'Track ' + n, author: 'A' + n, uri: 'https://youtu.be/' + n, identifier: String(n), duration: 200_000, isStream: false, isSeekable: true, artworkUrl: null, sourceName: 'youtube', ...extra }, requester: { id: 'u1' } });
const searches = [];
// Поддельный SoundCloud API (поиск, ссылки, плейлисты) — бот ходит в него напрямую.
const SC = await import('../dist/soundcloud.js');
const scT = (id, title, extra = {}) => ({ id, kind: 'track', title, duration: 200_000, permalink_url: 'https://soundcloud.com/a/t' + id, artwork_url: 'https://i1.sndcdn.com/a-large.jpg', user: { username: 'A' + id },
  media: { transcodings: [{ url: 'https://api-v2.soundcloud.com/media/' + id + '/hls', preset: 'aac_1_0', format: { protocol: 'hls', mime_type: 'audio/mp4' } }] }, ...extra });
const jres = x => ({ ok: true, status: 200, json: async () => x, text: async () => JSON.stringify(x) });
SC._setFetch(async url => {
  url = String(url);
  if (url === 'https://soundcloud.com/') return { ok: true, status: 200, text: async () => '<script crossorigin src="https://a-v2.sndcdn.com/assets/0-abc.js"></script>' };
  if (url.includes('/assets/')) return { ok: true, status: 200, text: async () => 'x={client_id:"abcdefghijklmnopqrstuvwxyz012345"}' };
  const u = new URL(url);
  searches.push('sc:' + u.pathname.split('/')[1]);
  if (u.pathname === '/search/tracks') {
    const q = u.searchParams.get('q');
    if (q === 'пусто') return jres({ collection: [] });
    if (/Broken/.test(q)) return jres({ collection: [scT(777, 'Broken song', { duration: 190_000 })] });
    return jres({ collection: [scT(q.length, 'Track ' + q.length), scT(99, 'Track 99'), scT(98, 'DRM', { media: { transcodings: [{ url: 'x', preset: 'aac_1_0', format: { protocol: 'cbc-encrypted-hls', mime_type: 'audio/mp4' } }] } })] });
  }
  if (u.pathname === '/resolve') {
    const target = u.searchParams.get('url');
    if (/sets/.test(target)) return jres({ kind: 'playlist', title: 'Мой плейлист', tracks: [scT(10, 'Track 10'), scT(11, 'Track 11'), { id: 12 }] });
    return jres(scT(55, 'Track by link'));
  }
  const rel = /^\/tracks\/(\d+)\/related$/.exec(u.pathname);
  if (rel) return jres({ collection: [scT(300 + Number(rel[1]) % 7, 'Related A', { user: { username: 'R1' } }), scT(400, 'Related B', { user: { username: 'R2' } })] });
  if (u.pathname === '/tracks') return jres(u.searchParams.get('ids').split(',').map(id => scT(Number(id), 'Track ' + id)));
  return jres({ url: 'http://media/x.m3u8' });
});
const node = { search: async ({ query, source }) => {
  searches.push(source ?? 'url');
  const sc = /\/sc\/(\d+)\.ogg/.exec(query);
  if (sc) return { loadType: 'track', tracks: [{ ...T(Number(sc[1]), { title: 'Unknown title', sourceName: 'http', uri: query, isStream: true }), encoded: 'ENC:' + query }] };
  if (query.includes('youtu')) return { loadType: 'track', tracks: [T(5, { title: 'Broken song', author: 'Somebody - Topic', sourceName: 'youtube' })] };
  return { loadType: 'empty', tracks: [] };
} };
lava.nodeManager.leastUsedNodes = () => [node];
let player = null;
const mkPlayer = o => {
  const q = { current: null, tracks: [], previous: [],
    add: async (t, i) => { const arr = Array.isArray(t) ? t : [t]; if (i === undefined) q.tracks.push(...arr); else q.tracks.splice(i, 0, ...arr); },
    splice: async (i, n) => q.tracks.splice(i, n), shuffle: async () => { q.tracks.reverse(); return q.tracks.length; } };
  const data = {};
  return player = { guildId: o.guildId, voiceChannelId: o.voiceChannelId, textChannelId: o.textChannelId, connected: false, playing: false, paused: false, volume: o.volume, repeatMode: 'off', position: 30_000, queue: q,
    set: (k, v) => { data[k] = v; }, get: k => data[k],
    connect: async () => { player.connected = true; },
    play: async (opt = {}) => { if (opt.clientTrack) { if (q.current) q.previous.unshift(q.current); q.current = opt.clientTrack; } else { q.current = q.tracks.shift(); } player.playing = true; },
    pause: async () => { player.paused = true; }, resume: async () => { player.paused = false; },
    skip: async to => { q.previous.unshift(q.current); if (to) q.tracks.splice(0, to - 1); q.current = q.tracks.shift() ?? null; },
    stopPlaying: async () => { q.tracks.length = 0; q.current = null; player.playing = false; },
    destroy: async () => { player.destroyed = true; },
    setVolume: async v => { player.volume = v; }, setRepeatMode: async m => { player.repeatMode = m; }, seek: async ms => { player.position = ms; },
    filterManager: { resetFilters: async () => {}, setEQPreset: async () => { player.eq = true; }, toggleNightcore: async () => {}, toggleVaporwave: async () => {}, toggleRotation: async () => {}, toggleKaraoke: async () => {} },
  };
};
lava.getPlayer = () => player ?? undefined;
lava.createPlayer = mkPlayer;

let last, lastEmbed;
const perms = { has: () => true };
const it = (name, opts = {}, vc = 'vc1') => ({
  inCachedGuild: () => true, guildId: 'g', channelId: 'tc', user: { id: 'u1', displayName: 'u' }, commandName: name, deferred: false, replied: false,
  guild: { members: { me: {} } },
  member: { voice: { channelId: vc, channel: vc ? { id: vc, permissionsFor: () => perms } : null } },
  options: { getString: k => opts[k] ?? null, getInteger: k => opts[k] ?? null, getBoolean: k => opts[k] ?? null, getSubcommand: () => null, getUser: () => null },
  client,
  reply: async function (p) { lastEmbed = p.embeds?.[0]?.toJSON(); last = lastEmbed?.description ?? p.content; this.eph = Boolean(p.flags); },
  editReply: async p => { lastEmbed = p.embeds?.[0]?.toJSON(); last = lastEmbed?.description; },
  deferReply: async function (o) { this.deferred = true; this.eph = Boolean(o?.flags); lastDefer = this; },
});
let lastDefer;
await C.handleCommand(it('играть', { 'запрос': 'песня' }, null));
assert(/голосовой/.test(last));
await C.handleCommand(it('играть', { 'запрос': 'песня' }));
assert(/Включаю/.test(last), last);
assert(lastDefer.eph, '«Включаю» видит только запросивший');
assert.equal(player.queue.current.info.title, 'Track 5'); assert.equal(player.connected, true);
assert.equal(player.volume, 35, 'громкость по умолчанию — 35%');
await C.handleCommand(it('играть', { 'запрос': 'https://soundcloud.com/a/sets/my?si=123' }));
assert(/Мой плейлист/.test(last) && /3/.test(last));
assert.equal(player.queue.tracks.length, 3);
await C.handleCommand(it('играть', { 'запрос': 'вне', 'следующим': true }));
assert.equal(player.queue.tracks[0].info.title, 'Track 3', 'следующим — в начало');
await C.handleCommand(it('играть', { 'запрос': 'пусто' }));
assert(/Ничего не нашёл/.test(last));
searches.length = 0;
await C.handleCommand(it('играть', { 'запрос': 'https://soundcloud.com/x/y' }));
assert.deepEqual(searches.slice(0, 1), ['sc:resolve'], 'ссылка SoundCloud — через его API');
const byLink = player.queue.tracks.at(-1);
assert.equal(byLink.info.title, 'Track by link'); assert.equal(byLink.info.uri, 'https://soundcloud.com/a/t55', 'в карточке — ссылка SoundCloud, не локальный поток');
assert.equal(byLink.info.isStream, false); assert.equal(byLink.info.duration, 200_000); assert(/t500x500/.test(byLink.info.artworkUrl));
searches.length = 0;
await C.handleCommand(it('играть', { 'запрос': 'https://youtu.be/abc' }));
assert.deepEqual(searches.slice(0, 2), ['url', 'sc:search'], 'ссылка YouTube → название → тот же трек на SoundCloud');
assert.equal(player.queue.tracks.at(-1).info.title, 'Broken song');
// Spotify-ссылка → название с embed-страницы → тот же трек на SoundCloud
const Lk = await import('../dist/links.js');
Lk._setLinksFetch(async () => ({ ok: true, status: 200, text: async () => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { name: 'Broken song', artists: [{ name: 'X' }], duration: 190000 } } } } } })}</script>` }));
await C.handleCommand(it('играть', { 'запрос': 'https://open.spotify.com/track/abc?si=1' }));
assert.equal(player.queue.tracks.at(-1).info.title, 'Broken song', 'Spotify → SoundCloud');
// Другой войс
await C.handleCommand(it('пауза', {}, 'vc2'));
assert(/зайди туда/.test(last));
// Управление
await C.handleCommand(it('пауза')); assert(player.paused);
await C.handleCommand(it('пауза')); assert(!player.paused);
const n = player.queue.tracks.length;
await C.handleCommand(it('пропуск')); assert.equal(player.queue.tracks.length, n - 1);
await C.handleCommand(it('пропуск', { 'до': 99 })); assert(/В очереди/.test(last));
await C.handleCommand(it('назад')); assert(/Назад/.test(last), last);
await C.handleCommand(it('громкость', { 'уровень': 120 })); assert.equal(player.volume, 120);
// SoundCloud: перемотка = новый поток с ?t=, сдвиг помним, исходный поток возвращается треку.
const scCur = player.queue.current;
assert(/^sc:\d+$/.test(scCur.info.identifier), scCur.info.identifier);
scCur.encoded = 'ORIG'; const prevLen = player.queue.previous.length; searches.length = 0;
await C.handleCommand(it('перемотка', { 'время': '1:10' })); assert(/Перемотал на 1:10/.test(last), last);
assert.equal(player.queue.current.info, scCur.info, 'та же карточка трека');
player.position = 0; lava.emit('trackStart', player, player.queue.current);
assert.equal(P.posOf(player), 70_000, 'позиция с учётом сдвига');
assert.equal(player.queue.current.encoded, 'ORIG', 'повтор/назад — с начала');
assert.equal(player.queue.previous.length, prevLen, 'перемотка не попадает в историю');
const view = await P.nowView(player); const seekIds = JSON.stringify(view.components.map(c => c.toJSON()));
for (const id of ['mus:back', 'mus:fwd', 'mus:voldown', 'mus:volup']) assert(seekIds.includes(id), id);
lava.emit('trackStart', player, T(42)); assert.equal(P.posOf(player), 0, 'новый трек — сдвиг сброшен');
player.position = 30_000;
player.queue.current = scCur; player.queue.current = T(1, { isSeekable: true });
await C.handleCommand(it('перемотка', { 'время': '1:10' })); assert.equal(player.position, 70_000);
await C.handleCommand(it('перемотка', { 'время': '+20' })); assert.equal(player.position, 90_000);
await C.handleCommand(it('перемотка', { 'время': '9:99' })); assert(/Не понял/.test(last));
await C.handleCommand(it('перемотка', { 'время': '10:00' })); assert(/длится/.test(last));
player.queue.current = scCur;
await C.handleCommand(it('повтор', { 'режим': 'track' })); assert.equal(player.repeatMode, 'track');
const firstBefore = player.queue.tracks[0];
await C.handleCommand(it('переместить', { 'откуда': 1, 'куда': 2 })); assert.equal(player.queue.tracks[1], firstBefore);
await C.handleCommand(it('убрать', { 'номер': 1 })); assert(/Убрал/.test(last));
await C.handleCommand(it('фильтр', { 'эффект': 'bass' })); assert(player.eq);
await C.handleCommand(it('очередь'));
assert(/Очередь/.test(lastEmbed.author.name) && /Сейчас/.test(last));
const sc = it('сейчас'); await C.handleCommand(sc);
assert(/внизу/.test(last) && sc.eph, 'сейчас — плеер внизу, ответ личный');
// Сообщение плеера (Components V2) и кнопки
await P.postNowPlaying(client, player);
const npMsg = sent.at(-1);
const json = JSON.stringify(npMsg.p.components.map(c => c.toJSON()));
assert(npMsg.p.flags, 'флаг Components V2');
assert(/attachment:\/\/np\.png/.test(json), 'карточка-картинка в плеере');
assert.equal(npMsg.p.files?.[0]?.name, 'np.png');
assert(npMsg.p.files[0].attachment.length > 10_000, 'PNG нарисован');
const ids = [...json.matchAll(/"custom_id":"([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'id уникальны: ' + ids);
assert(ids.includes('mus:queue') && ids.includes('mus:autoplay') && ids.includes('mus:lyrics') && !ids.includes('mus:jump'), ids.join());

assert(/Пауза|Играть/.test(json), 'подпись на кнопке паузы');
assert(json.length < 8000);
// Тот же плеер последним в канале — следующий трек правит его, а не плодит сообщения
const before = sent.length; await P.postNowPlaying(client, player); assert.equal(sent.length, before, 'правка на месте');
assert.equal(npMsg.p.files?.[0]?.name, 'np.png', 'при правке картинка перерисована');
let updated, deferred;
const btn = id => ({ inCachedGuild: () => true, customId: 'mus:' + id, guildId: 'g', user: { id: 'u1', displayName: 'u' }, member: { voice: { channelId: 'vc1' } }, channel,
  reply: async p => { last = p.embeds?.[0]?.toJSON().description; }, update: async p => { updated = p; }, deferUpdate: async () => { deferred = true; } });
// Кнопка «📝 Текст» — слова только нажавшему (lrclib.net подменён)
const realFetch = globalThis.fetch;
globalThis.fetch = async url => String(url).includes('lrclib.net') ? { ok: true, status: 200, json: async () => ({ trackName: 'Track', artistName: player.queue.current.info.author, plainLyrics: 'строка один\nстрока два' }) } : realFetch(url);
let lyr; await C.handleButton({ ...btn('lyrics'), deferReply: async o => { lyr = { eph: Boolean(o?.flags) }; }, editReply: async p => { lyr.text = p.embeds[0].toJSON().description; } });
globalThis.fetch = realFetch;
assert(lyr?.eph && /строка два/.test(lyr.text), 'текст песни эфемерно: ' + JSON.stringify(lyr));
// Управляет только заказавший трек (и владелец бота); пока он в войсе — чужим отказ
const vs = new Map([['u1', { channelId: 'vc1' }]]); client.guilds.cache.set('g', { voiceStates: { cache: vs } });
const stranger = id => ({ ...btn(id), user: { id: 'u2', displayName: 'x' } });
const wasPaused = player.paused; last = '';
await C.handleButton(stranger('pause')); assert.equal(player.paused, wasPaused, 'чужой не ставит паузу'); assert(/управляет <@u1>/.test(last), last);
await C.handleButton(stranger('stop')); assert(!player.destroyed, 'чужой не выключает');
let qrep2; await C.handleButton({ ...stranger('queue'), reply: async p => { qrep2 = p; } }); assert(qrep2?.components, 'очередь смотреть может любой');
vs.delete('u1'); await C.handleButton(stranger('pause')); assert.notEqual(player.paused, wasPaused, 'заказавший ушёл — управление свободно');
await C.handleButton(stranger('pause')); vs.set('u1', { channelId: 'vc1' });
await C.handleButton(btn('pause')); assert(player.paused && updated);
await C.handleButton(btn('volup')); assert.equal(player.volume, 130);
// Кнопка очереди → список только нажавшему, в нём меню выбора трека
let qrep; await C.handleButton({ ...btn('queue'), reply: async p => { qrep = p; } });
assert(qrep?.flags && JSON.stringify(qrep.components.map(c => c.toJSON())).includes('mus:jump'), 'очередь — эфемерно с меню');
const target = player.queue.tracks[1];
await C.handleButton({ ...btn('jump'), isStringSelectMenu: () => true, values: ['2'] });
assert.equal(player.queue.current, target, 'jump включает выбранный'); assert(/Включаю/.test(updated.embeds[0].toJSON().description));
await C.handleButton(btn('autoplay'));
assert((await P.guildSettings('g')).autoplay, 'автоплей кнопкой');
// YouTube не отдал звук (старый трек в очереди) → тот же трек с SoundCloud
const broken = T(5, { title: 'Broken song', sourceName: 'youtube', identifier: 'yt1' });
player.queue.current = null; player.playing = false;
lava.emit('trackError', player, broken, { exception: { message: 'Sign in to confirm you’re not a bot' } });
await new Promise(r => setTimeout(r, 50));
assert.equal(player.queue.current?.info.sourceName, 'soundcloud', 'сыграли с SoundCloud');
searches.length = 0;
await C.handleCommand(it('играть', { 'запрос': 'новая' }));
assert.equal(searches[0], 'sc:search', 'текст — поиск SoundCloud');
await C.handleButton({ ...btn('skip'), member: { voice: { channelId: 'other' } } }); assert(/зайди туда/.test(last));
await C.handleButton(btn('stop')); assert(player.destroyed && deferred);
assert.equal(player.get('stoppedBy'), 'u1', 'кто выключил — запомнили для сообщения');
// Ушёл из войса: плеер удалён, в чате короткая строка с причиной
const np2 = sent.at(-1); np2.deleted = false;
lava.emit('playerDestroy', player, 'empty-channel');
await new Promise(r => setTimeout(r, 50));
assert(np2.deleted, 'плеер удалён');
assert(/Все вышли из войса/.test(JSON.stringify(sent.at(-1).p.components.map(c => c.toJSON()))), 'сообщение о причине');
// Моя волна: треки волны помечены, держится запас, свои /играть — раньше волны, 👎 пропускает
player.destroyed = false; player.queue.current = null; player.queue.tracks.length = 0; player.playing = false;
const W = await import('../dist/wave.js');
const got = await P.startWave(player, { id: 'u1', username: 'u' });
assert(got >= 2 && player.queue.current && W.isWaveTrack(player.queue.current), 'волна запустилась: ' + got);
assert(player.queue.tracks.every(W.isWaveTrack) && player.queue.tracks.length >= 1);
const ids1 = [player.queue.current, ...player.queue.tracks].map(t => t.info.identifier);
assert.equal(new Set(ids1).size, ids1.length, 'без повторов');
const wv = JSON.stringify((await P.nowView(player)).components.map(c => c.toJSON()));
assert(wv.includes('mus:dislike') && wv.includes('mus:wave:panel') && wv.includes('МОЯ ВОЛНА') === false, 'кнопки волны');
await C.handleCommand(it('играть', { 'запрос': 'свой трек' }));
assert(!W.isWaveTrack(player.queue.tracks[0]), 'свой трек — раньше треков волны');
const beforeDis = player.queue.current;
await C.handleButton(btn('dislike')); assert(/в дизлайках/.test(last), last); assert.notEqual(player.queue.current, beforeDis, '👎 — следующий');
let panel; await C.handleButton({ ...btn('wave:panel'), reply: async p => { panel = p; } });
assert(panel.flags && JSON.stringify(panel.components.map(c => c.toJSON())).includes('mus:wave:set:mood:sad'), 'настройки волны');
await P.stopWave(player); assert(!W.waveOf(player) && !player.queue.tracks.some(W.isWaveTrack), 'волна выключена');
// /волна, когда музыка ещё не играла (плеера нет) — раньше падало «Что-то пошло не так»
player = null;
await C.handleCommand(it('волна'));
assert(/Моя волна\*\* включена/.test(last), last);
assert(player && W.waveOf(player) && player.queue.current, 'волна запустилась с нуля');
// Автодополнение
let choices;
await C.handleAutocomplete({ options: { getFocused: () => ({ name: 'запрос', value: 'привет мир' }) }, user: { id: 'u1' }, respond: async c => { choices = c; } });
assert(choices.length >= 1 && choices.every(c => c.name.length <= 100 && c.value.length <= 100), JSON.stringify(choices));
await C.handleAutocomplete({ options: { getFocused: () => ({ name: 'запрос', value: 'h' }) }, user: { id: 'u1' }, respond: async c => { choices = c; } });
assert.equal(choices.length, 0, 'одна буква — без поиска');
console.log('smoke-music-play: OK');
process.exit(0);
