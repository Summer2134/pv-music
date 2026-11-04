// PV Music без Lavalink и Discord: время/перемотка, статистика прослушиваний, плейлисты/лайки через команды, лимиты команд.
// DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres DATABASE_SSL=false DATABASE_POOL_SIZE=1 MUSIC_TOKEN=x MUSIC_CLIENT_ID=1 node scripts/smoke-music.mjs
import assert from 'node:assert/strict';
const F = await import('../dist/format.js');
assert.equal(F.dur(187_000), '3:07'); assert.equal(F.dur(3_765_000), '1:02:45'); assert.equal(F.dur(-5), '0:00');
assert.equal(F.parseTime('1:30'), 90_000); assert.equal(F.parseTime('90'), 90_000); assert.equal(F.parseTime('1:02:03'), 3_723_000);
assert.equal(F.parseTime('+15', 60_000), 75_000); assert.equal(F.parseTime('-90', 60_000), 0); assert.equal(F.parseTime('abc'), null); assert.equal(F.parseTime('1:75'), null);
assert.equal([...F.progress(50, 100, 11)].filter(c => c === '🔘').length, 1);
assert.equal(F.progress(5, 0), '🔴 эфир');
assert.equal(F.clip('абвгдеж', 4), 'абв…');

const { pool, initDb } = await import('../dist/db.js');
await initDb(); await initDb();
const S = await import('../dist/stats.js');
// Часы прослушивания: пауза не считается, длительность — потолок
S.startClock('g', 0); S.pauseClock('g', 10_000); S.resumeClock('g', 40_000);
assert.equal(S.stopClock('g', 200_000, 100_000), 70_000, 'без паузы');
S.startClock('g', 0); assert.equal(S.stopClock('g', 30_000, 100_000), 30_000, 'не больше длины трека');
assert.equal(S.stopClock('нет', 1, 1), 0);

const G = 'g_mus_' + Date.now();
const member = (id, bot = false, deaf = false) => [id, { id, user: { bot }, voice: { selfDeaf: deaf, serverDeaf: false } }];
const client = { guilds: { cache: new Map([[G, { channels: { cache: new Map([['vc', { members: new Map([member('a'), member('b'), member('bot', true), member('deaf', false, true)]) }]]) } }]]) } };
const player = { guildId: G, voiceChannelId: 'vc' };
const tr = (n, author = 'Artist') => ({ info: { title: 'Song ' + n, author, uri: 'https://x/' + n, identifier: 'id' + n, sourceName: 'youtube', duration: 180_000, artworkUrl: null }, requester: { id: 'a' } });
assert.equal(await S.recordPlay(client, player, tr(1), 5_000), 0, 'меньше 10 с — не считается');
assert.equal(await S.recordPlay(client, player, tr(1), 120_000), 2, 'двое живых слушателей');
await S.recordPlay(client, player, tr(1), 180_000);
await S.recordPlay(client, player, tr(2, 'Other'), 60_000);
const top = await S.topTracks(G, 'week');
assert.equal(top[0].uri, 'https://x/1'); assert.equal(top[0].plays, 2);
const people = await S.topListeners(G, 'week');
assert.deepEqual(people.map(p => p.user_id).sort(), ['a', 'b']);
assert.equal(Number(people[0].ms), 360_000); assert.equal(people[0].tracks, 3);
assert.equal((await S.topArtists(G, 'all'))[0].author, 'Artist');
const me = await S.userStats(G, 'a', 'month');
assert.equal(me.ms, 360_000); assert.equal(me.total, 3); assert.equal(me.ordered[0].plays, 2);
const tot = await S.serverTotals(G, 'week');
assert.equal(tot.plays, 3); assert.equal(tot.people, 2);
assert((await S.recentUris(G)).has('https://x/2'));

// Команды: регистрация в лимитах Discord
const C = await import('../dist/commands.js');
assert(C.COMMANDS.length <= 100);
for (const c of C.COMMANDS) {
  assert(/^[\p{Ll}\p{N}_-]{1,32}$/u.test(c.name), 'имя ' + c.name);
  assert(c.description.length <= 100, 'описание ' + c.name);
  for (const o of c.options ?? []) { assert(o.description.length <= 100, `${c.name}.${o.name}`); for (const s of o.options ?? []) assert(s.description.length <= 100); }
}
assert(JSON.stringify(C.COMMANDS).length < 8000 * C.COMMANDS.length);

// Плейлисты через обработчик (без Lavalink: менеджер без узлов)
const P = await import('../dist/player.js');
P.createManager({ on() {}, guilds: { cache: new Map() }, user: null });
const U = 'u_mus_' + Date.now();
let last;
const it = (name, sub, opts = {}) => ({
  inCachedGuild: () => true, guildId: G, channelId: 'tc', user: { id: U, displayName: 'u', displayAvatarURL: () => '' }, commandName: name,
  member: { voice: { channelId: null } }, deferred: false, replied: false,
  options: { getSubcommand: () => sub, getString: k => opts[k] ?? null, getInteger: k => opts[k] ?? null, getBoolean: k => opts[k] ?? null, getUser: () => null },
  reply: async p => { last = p.embeds?.[0]?.toJSON().description ?? p.content; },
  editReply: async p => { last = p.embeds?.[0]?.toJSON().description; },
  deferReply: async function () { this.deferred = true; },
});
await C.handleCommand(it('плейлист', 'создать', { 'название': 'Вечер' }));
assert(/создан/.test(last), last);
await C.handleCommand(it('плейлист', 'создать', { 'название': 'вечер' }));
assert(/уже есть/.test(last), 'регистр не важен: ' + last);
const pl = (await pool.query('SELECT id FROM music_playlists WHERE user_id = $1', [U])).rows[0].id;
await pool.query("INSERT INTO music_playlist_tracks (playlist_id, pos, uri, title, author, duration_ms) VALUES ($1,1,'https://x/1','Song 1','A',1000),($1,2,'https://x/2','Song 2','B',2000)", [pl]);
await C.handleCommand(it('плейлист', 'показать', { 'название': 'ВЕЧЕР' }));
assert(/Song 1/.test(last) && /2 тр/.test(last), last);
await C.handleCommand(it('плейлист', 'список'));
assert(/Вечер/.test(last));
await C.handleCommand(it('плейлист', 'убрать', { 'название': 'Вечер', 'номер': 1 }));
assert(/Убрал/.test(last));
await C.handleCommand(it('плейлист', 'играть', { 'название': 'Вечер' }));
assert(/голосовой канал/.test(last), 'играть без войса: ' + last);
await C.handleCommand(it('плейлист', 'добавить', { 'название': 'Вечер' }));
assert(/ничего не играет/.test(last), last);
await C.handleCommand(it('плейлист', 'удалить', { 'название': 'Вечер' }));
assert.equal((await pool.query('SELECT COUNT(*)::int n FROM music_playlist_tracks WHERE playlist_id = $1', [pl])).rows[0].n, 0, 'каскад');
await C.handleCommand(it('плейлист', 'играть', { 'название': 'нет такого' }));
assert(/нет/.test(last));
// Без плеера: управление и движок
await C.handleCommand(it('пауза'));
assert(/голосовой/.test(last));
await C.handleCommand(it('играть', null, { 'запрос': 'x' }));
assert(/запускается/.test(last), 'нет Lavalink — понятный ответ: ' + last);
await C.handleCommand(it('музыка'));
assert(/PV Music/.test(last));
await C.handleCommand(it('муз-топ', null, { 'период': 'week' }));
assert(/Song 1/.test(last) && /Слушатели/.test(last));

await pool.query('DELETE FROM music_plays WHERE guild_id = $1', [G]); await pool.query('DELETE FROM music_listen WHERE guild_id = $1', [G]);
await pool.query('DELETE FROM music_playlists WHERE user_id = $1', [U]);
console.log('smoke-music: OK');
await pool.end(); process.exit(0);
