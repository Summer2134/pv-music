// Ссылки Spotify и Яндекс Музыки → название/исполнитель/длина (поддельные сайты, сеть не нужна).
// node scripts/smoke-music-links.mjs
import assert from 'node:assert/strict';
const L = await import('../dist/links.js');
const next = data => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: data } } } } })}</script></html>`;
const res = (body, status = 200, headers = {}) => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body), headers: { get: k => headers[k] ?? null } });
let embedBroken = false;
L._setLinksFetch(async url => {
  url = String(url);
  if (url.startsWith('https://spotify.link/')) return res('', 302, { location: 'https://open.spotify.com/track/AAA?si=1' });
  if (url.includes('/embed/track/AAA')) return embedBroken ? res('', 500) : res(next({ name: 'Песня', artists: [{ name: 'Артист' }, { name: 'Фит' }], duration: 180000 }));
  if (url.includes('/embed/playlist/PPP')) return res(next({ name: 'Мой плейлист', trackList: [{ title: 'A', subtitle: 'X', duration: 1 }, { title: 'B', subtitle: 'Y', duration: 2 }] }));
  if (url === 'https://open.spotify.com/track/AAA') return res('<meta property="og:title" content="Song &amp; Co"><meta property="og:description" content="Singer · Album · Song · 2020">');
  if (url.endsWith('/tracks/111')) return res(JSON.stringify({ result: [{ title: 'Трек', version: 'Remix', artists: [{ name: 'Исп' }], durationMs: 200000 }] }));
  if (url.endsWith('/albums/22/with-tracks')) return res(JSON.stringify({ result: { title: 'Альбом', volumes: [[{ title: 'a', artists: [] }], [{ title: 'b', artists: [{ name: 'z' }] }]] } }));
  if (url.endsWith('/users/vasya/playlists/3')) return res(JSON.stringify({ result: { title: 'Плей', tracks: [{ track: { title: 'p1', artists: [{ name: 'q' }] } }, {}] } }));
  if (url.endsWith('/tracks/999')) return res('', 451);
  if (url.includes('music.yandex.ru/album/1/track/999')) return res('<meta property="og:title" content="Звезда — Кино. Слушать онлайн на Яндекс Музыке">');
  return res('', 404);
});
assert(L.isSpotify('https://open.spotify.com/track/x') && L.isSpotify('https://spotify.link/abc') && L.isYandex('https://music.yandex.ru/album/1') && !L.isYandex('https://yandex.ru'));
let r = await L.foreignTracks('https://open.spotify.com/intl-ru/track/AAA?si=zz');
assert.deepEqual(r, { tracks: [{ title: 'Песня', author: 'Артист, Фит', duration: 180000 }], playlist: null });
r = await L.foreignTracks('https://spotify.link/abc'); assert.equal(r.tracks[0].title, 'Песня', 'короткая ссылка');
r = await L.foreignTracks('https://open.spotify.com/playlist/PPP'); assert.equal(r.playlist, 'Мой плейлист'); assert.deepEqual(r.tracks.map(t => t.author), ['X', 'Y']);
embedBroken = true; r = await L.foreignTracks('https://open.spotify.com/track/AAA');
assert.deepEqual(r.tracks[0], { title: 'Song & Co', author: 'Singer', duration: 0 }, 'запасной путь og');
r = await L.foreignTracks('https://music.yandex.ru/album/5/track/111'); assert.deepEqual(r.tracks[0], { title: 'Трек (Remix)', author: 'Исп', duration: 200000 });
r = await L.foreignTracks('https://music.yandex.com/album/22'); assert.equal(r.playlist, 'Альбом'); assert.equal(r.tracks.length, 2);
r = await L.foreignTracks('https://music.yandex.ru/users/vasya/playlists/3'); assert.equal(r.tracks.length, 1);
r = await L.foreignTracks('https://music.yandex.ru/album/1/track/999'); assert.deepEqual(r.tracks[0], { title: 'Звезда', author: 'Кино', duration: 0 }, 'API закрыт — заголовок страницы');
console.log('smoke-music-links: OK');
