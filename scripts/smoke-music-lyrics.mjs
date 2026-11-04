// Тексты: lrclib → Genius (поиск + страница) → lyrics.ovh, на поддельных сайтах. node scripts/smoke-music-lyrics.mjs
import assert from 'node:assert/strict';
const L = await import('../dist/lyrics.js');
const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const page = `<html><div class="x"><div data-lyrics-container="true" class="Lyrics__Container"><div data-exclude-from-selection="true"><div>12 Contributors</div><span>Translations</span></div>[Куплет 1]<br/>Я иду по <a href="/x"><span>району</span></a>,<br>мне не страшно &amp; ок<br/></div></div>
<p>реклама</p><div data-lyrics-container="true">[Припев]<br/>Йе-йе, it&#x27;s &quot;ok&quot;<div class="inner">вложенный</div></div></html>`;
const calls = [];
let lrcEmpty = true, geniusBlocked = false;
L._setLyricsFetch(async url => {
  url = String(url); calls.push(url.split('?')[0]);
  if (url.includes('lrclib.net')) return lrcEmpty ? res([]) : res({ trackName: 'T', artistName: 'A', plainLyrics: 'из lrclib' });
  if (url.includes('genius.com/api/search')) return res({ response: { sections: [{ hits: [
    { result: { title: 'Чужая песня', primary_artist: { name: 'Кто-то' }, url: 'https://genius.com/wrong' } },
    { result: { title: 'Район (Remix)', primary_artist: { name: 'Mayot' }, url: 'https://genius.com/Mayot-rayon-lyrics' } }] }] } });
  if (url === 'https://genius.com/Mayot-rayon-lyrics') return geniusBlocked ? res('', 403) : res(page);
  if (url.includes('lyrics.ovh')) return res({ lyrics: 'english words' });
  return res('', 404);
});
let r = await L.findLyrics({ title: 'Район (Official Video)', author: 'MAYOT' });
assert.equal(r.source, 'Genius', 'lrclib пусто → Genius');
assert.equal(r.title, 'Mayot — Район (Remix)');
assert(!/Contributors|Translations|реклама/.test(r.text), 'служебное вырезано: ' + r.text);
assert(r.text.startsWith('[Куплет 1]\nЯ иду по району,\nмне не страшно & ок'), r.text);
assert(/Йе-йе, it's "ok"/.test(r.text) && /вложенный/.test(r.text), 'второй блок и вложенные div');
assert(!calls.includes('https://genius.com/wrong'), 'неподходящий результат не открываем');
lrcEmpty = false;
r = await L.findLyrics({ title: 'X', author: 'A' }); assert.equal(r.source, 'lrclib.net', 'lrclib первым');
lrcEmpty = true; geniusBlocked = true;
r = await L.findLyrics({ title: 'Район', author: 'Mayot' }); assert.equal(r.source, 'lyrics.ovh', 'Genius не пустил → lyrics.ovh');
assert.equal(L.geniusText('<div>нет текста</div>'), null);
// SoundCloud: исполнитель — ник залившего, настоящий — в названии; Genius называет трек просто «101»
assert.deepEqual(L.variants('OG Buda, Villian - 101 причина', 'user8842'), [
  { title: 'OG Buda, Villian - 101 причина', author: 'user8842' }, { title: '101 причина', author: 'OG Buda' }, { title: '101 причина', author: '' }]);
L._setLyricsFetch(async url => {
  url = String(url);
  // lrclib по одному названию отдаёт ЧУЖУЮ «101 причина» (Kai Angel) — её брать нельзя
  if (url.includes('lrclib.net')) return url.includes('/search') ? res([{ trackName: '101 ПРИЧИНА', artistName: 'Kai Angel', plainLyrics: 'чужой текст' }]) : res('', 404);
  if (url.includes('genius.com/api/search')) return /user8842/.test(decodeURIComponent(url)) ? res({ response: { sections: [{ hits: [] }] } })
    : res({ response: { sections: [{ hits: [{ result: { title: '101', primary_artist: { name: 'Villian & OG Buda' }, url: 'https://genius.com/Villian-and-og-buda-101-lyrics' } }] }] } });
  if (url === 'https://genius.com/Villian-and-og-buda-101-lyrics') return res('<div data-lyrics-container="true">[Интро]<br/>сто одна причина</div>');
  return res('', 404);
});
const tr = [];
r = await L.findLyrics({ title: 'OG Buda, Villian - 101 причина', author: 'user8842' }, tr);
assert.equal(r?.source, 'Genius', tr.join(' | ')); assert(/сто одна причина/.test(r.text));
assert(tr.some(x => /Genius поиск/.test(x)) && tr.at(-1).startsWith('✅'), 'отчёт по шагам: ' + tr.join(' | '));
assert(tr.some(x => /других исполнителей \(Kai Angel/.test(x)), 'чужой исполнитель отброшен: ' + tr.join(' | '));
// Как у владельца: «!!!текст Villian — 101 причина»
const tr2 = []; r = await L.findLyrics({ title: 'Villian — 101 причина' }, tr2);
assert.equal(r?.source, 'Genius', tr2.join(' | ')); assert(!/чужой/.test(r.text));
// mogtext.com: поиск → адрес /song/… → <pre class="lyrics-text"> (реклама делит текст на два блока); чужой исполнитель отброшен
assert.equal(L.slugify('VILLIAN & OG Buda 101 причина'), 'villian-og-buda-101-prichina');
assert.equal(L.slugify('Общество Мёртвых Поэтов'), 'obschestvo-mertvyh-poetov');
const mog = (artist, title, body) => `<meta property="og:title" content="${artist} – ${title} | Текст песни"><pre class="lyrics-text" id="lyrics-pre-original">${body}</pre><div class="ad">реклама</div><pre class="lyrics-text">последняя строка</pre>`;
L._setLyricsFetch(async url => {
  url = String(url);
  if (url.includes('lrclib.net')) return res([]);
  if (url.includes('mogtext.com/search')) return res('<a href="/song/kai-angel-101-prichina/">a</a><a href="/song/villian-og-buda-101-prichina/">b</a><a href="/song/drugoe/">c</a>');
  if (url.endsWith('/song/kai-angel-101-prichina/')) return res(mog('Kai Angel', '101 ПРИЧИНА', 'чужой текст\nещё строка'));
  if (url.endsWith('/song/villian-og-buda-101-prichina/')) return res(mog('VILLIAN &#38; OG Buda', '101 причина', 'Эй\nМне нужен новый образец'));
  return res('', 403);
});
const tr3 = []; r = await L.findLyrics({ title: 'Villian — 101 причина' }, tr3);
assert.equal(r?.source, 'mogtext.com', tr3.join(' | '));
assert.equal(r.title, 'VILLIAN & OG Buda — 101 причина');
assert.equal(r.text, 'Эй\nМне нужен новый образец\nпоследняя строка', 'оба блока, без рекламы');
assert(tr3.some(x => /Kai Angel.*другой исполнитель/.test(x)), 'Kai Angel отброшен: ' + tr3.join(' | '));
// Разметка куплетов/припевов, если её нет
const flat = ['Эй', 'Первая строка', 'Вторая строка', 'Есть сто одна причина', 'Сказать что любишь', 'Деньги меняют', 'Лишь о тебе',
  'Куплет два раз', 'Куплет два два', 'Куплет два три', 'Куплет два четыре', 'Есть сто одна причина', 'Сказать что любишь', 'Деньги меняют', 'Лишь о тебе (тебе)', 'Хвост'].join('\n');
const st = L.structure(flat);
assert.equal(st.split('[Припев]').length - 1, 2, st);
assert(st.startsWith('[Интро]\nЭй') && /\[Куплет 1\]\nКуплет два раз/.test(st) && /\[Аутро\]\nХвост$/.test(st), st);
assert.equal(L.structure('[Куплет]\nа\nб\nв\n[Припев]\nа\nб\nв'), '[Куплет]\nа\nб\nв\n[Припев]\nа\nб\nв', 'готовую разметку не трогаем');
assert.equal(L.structure('раз\nдва\nтри'), 'раз\nдва\nтри', 'без повторов — как есть');
console.log('smoke-music-lyrics: OK');
