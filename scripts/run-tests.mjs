// Все автотесты подряд: `npm test`. Discord, Lavalink, SoundCloud, ffmpeg и systemd подменены — сеть и ключи не нужны.
// Тест базы (smoke-music) запускается, только если задан DATABASE_URL (в CI — сервис PostgreSQL).
import { spawnSync } from 'node:child_process';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), fakes = join(here, 'fakes');
const env = {
  ...process.env, MUSIC_TOKEN: 'test', MUSIC_CLIENT_ID: '1', MUSIC_OWNER_ID: 'own', MUSIC_STREAM_PORT: '23345',
  FFMPEG_PATH: join(fakes, 'ffmpeg'), YTDLP_PATH: join(fakes, 'yt-dlp'), PATH: fakes + delimiter + process.env.PATH,
};
const tests = ['smoke-music-play', 'smoke-music-links', 'smoke-music-lyrics', 'smoke-music-stream', 'smoke-music-admin'];
if (process.env.DATABASE_URL) tests.unshift('smoke-music'); else console.log('– smoke-music пропущен: нет DATABASE_URL');
let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [join(here, `${t}.mjs`)], { env, stdio: 'inherit', timeout: 180_000 });
  if (r.status !== 0) { failed++; console.error(`✕ ${t} упал`); }
}
console.log(failed ? `\n✕ упало тестов: ${failed}` : `\n✓ все тесты прошли (${tests.length})`);
process.exit(failed ? 1 : 0);
