// Свой SoundCloud: client_id со страницы, выбор формата без DRM, локальный поток через ffmpeg (подставной).
// FFMPEG_PATH=/путь/к/fake-ffmpeg MUSIC_STREAM_PORT=23345 node scripts/smoke-music-stream.mjs
import assert from 'node:assert/strict';
const SC = await import('../dist/soundcloud.js');
let pageHits = 0, authFails = 1;
const tr = (id, protocol = 'hls', mime = 'audio/mp4') => ({ id, kind: 'track', title: 't' + id, duration: 1000, permalink_url: 'https://soundcloud.com/x/' + id, artwork_url: null,
  media: { transcodings: [{ url: `https://api-v2.soundcloud.com/media/${id}`, preset: 'aac_1_0', format: { protocol, mime_type: mime } }] } });
const res = (x, status = 200) => ({ ok: status < 400, status, json: async () => x, text: async () => (typeof x === 'string' ? x : JSON.stringify(x)) });
SC._setFetch(async url => {
  url = String(url);
  if (url === 'https://soundcloud.com/') { pageHits++; return res('<script crossorigin src="https://a-v2.sndcdn.com/assets/1-a.js"></script><script crossorigin src="https://a-v2.sndcdn.com/assets/2-b.js"></script>'); }
  if (url.endsWith('2-b.js')) return res('var x=1');
  if (url.endsWith('1-a.js')) return res('({client_id:"ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"})');
  const u = new URL(url);
  assert.equal(u.searchParams.get('client_id'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  if (u.pathname === '/tracks') {
    if (authFails-- > 0) return res({}, 401); // client_id протух — бот берёт новый и повторяет
    const id = Number(u.searchParams.get('ids'));
    if (id === 3) return res([tr(3, 'ctr-encrypted-hls')]);
    if (id === 20) return res([{ ...tr(20), media: { transcodings: [
      { url: 'https://api-v2.soundcloud.com/gone/20', preset: 'aac_1_0', format: { protocol: 'hls', mime_type: 'audio/mpeg' } },
      { url: 'https://api-v2.soundcloud.com/media/20', preset: 'aac_1_0', format: { protocol: 'progressive', mime_type: 'audio/mpeg' } }] } }]);
    if (id === 21 || id === 22) return res([{ ...tr(id), permalink_url: id === 22 ? 'https://soundcloud.com/x/fail' : 'https://soundcloud.com/x/21',
      media: { transcodings: [{ url: 'https://api-v2.soundcloud.com/gone/' + id, preset: 'aac_1_0', format: { protocol: 'hls', mime_type: 'audio/mp4' } }] } }]);
    return res([tr(id)]);
  }
  if (u.pathname === '/media/30') return res({ url: 'https://cf-hls-media.sndcdn.com/silent.m3u8' });
  if (u.pathname.startsWith('/media/')) return res({ url: 'https://cf-hls-media.sndcdn.com/x.m3u8' });
  if (u.pathname === '/search/tracks') return res({ collection: [tr(10)] });
  return res({}, 404);
});
// Формат: HLS первым (progressive mp3 SoundCloud отдаёт 404), DRM никогда
assert.equal(SC.pickTranscoding({ media: { transcodings: [
  { url: 'a', preset: 'aac_1_0', format: { protocol: 'hls', mime_type: 'audio/mp4' } },
  { url: 'b', preset: 'aac_1_0', format: { protocol: 'progressive', mime_type: 'audio/mpeg' } },
  { url: 'c', preset: 'aac_1_0', format: { protocol: 'cbc-encrypted-hls', mime_type: 'audio/mp4' } }] } }).url, 'a');
assert.equal(SC.pickTranscoding(tr(3, 'cbc-encrypted-hls')), null, 'только DRM — играть нечем');
assert.equal(SC.playable({ ...tr(4), policy: 'BLOCK' }), false);
assert.equal(SC.infoOf({ ...tr(5), artwork_url: 'https://i1.sndcdn.com/artworks-x-large.jpg' }).artworkUrl, 'https://i1.sndcdn.com/artworks-x-t500x500.jpg');
assert.equal(SC.streamIdOf(SC.streamUrl(42, 5000)), 42);

const port = Number(process.env.MUSIC_STREAM_PORT ?? 23345);
await SC.startStreamServer(port);
const get = async path => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }; };
const a = await get('/sc/10.ogg');
assert.equal(a.status, 200); assert.equal(a.type, 'audio/ogg');
assert(a.body.startsWith('OggS'), 'поток идёт из ffmpeg');
const args = JSON.parse(a.body.slice(4));
assert.equal(args[args.indexOf('-i') + 1], 'https://cf-hls-media.sndcdn.com/x.m3u8', 'ffmpeg читает HLS SoundCloud');
assert(args.includes('libopus') && args.includes('ogg'));
assert(!args.includes('-ss'));
assert.equal(pageHits, 2, 'на 401 client_id взят заново');
const b = await get('/sc/11.ogg?t=5000');
assert.equal(JSON.parse(b.body.slice(4))[JSON.parse(b.body.slice(4)).indexOf('-ss') + 1], '5.00', 'старт с позиции');
assert.equal((await get('/sc/3.ogg')).status, 502, 'DRM — понятная ошибка');
const c = JSON.parse((await get('/sc/20.ogg')).body.slice(4));
assert.equal(c[c.indexOf('-i') + 1], 'https://cf-hls-media.sndcdn.com/x.m3u8', 'первый формат 404 → взяли следующий');
const d = JSON.parse((await get('/sc/21.ogg')).body.slice(4));
assert.equal(d[d.indexOf('-i') + 1], 'https://cf-media.sndcdn.com/dlp.m3u8', 'все форматы 404 → yt-dlp');
assert.equal((await get('/sc/22.ogg')).status, 502, 'и yt-dlp не смог — 502');
assert.equal((await get('/sc/30.ogg')).status, 502, 'ffmpeg не выдал звука — 502, а не пустой 200');
assert(/403/.test(SC.streamStats.lastError), 'причина видна в самопроверке');
assert.equal((await get('/x')).status, 404);
// Самопроверка по шагам (поиск отдаёт трек 10, Lavalink — поддельный)
const D = await import('../dist/diag.js');
const okLava = { nodeManager: { leastUsedNodes: () => [{ search: async () => ({ loadType: 'track', tracks: [{}] }) }] } };
const t1 = await D.selfTest(okLava);
assert(t1.ok, t1.lines.join('\n'));
assert(t1.lines.some(l => /✅ ffmpeg/.test(l)) && t1.lines.some(l => /✅ Lavalink открыл поток/.test(l)));
const t2 = await D.selfTest({ nodeManager: { leastUsedNodes: () => [] } });
assert(!t2.ok && t2.lines.some(l => /❌ Lavalink/.test(l)), 'без Lavalink — понятный ❌');
SC.stopStreamServer();
console.log('smoke-music-stream: OK');
process.exit(0);
