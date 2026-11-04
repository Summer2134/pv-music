import { findLyrics } from './lyrics.js';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, Message } from 'discord.js';
import { ADMINS, PREFIX, ROOT } from './config.js';
import { manager } from './player.js';
import { dur } from './format.js';
import { selfTest } from './diag.js';

/**
 * Секретные команды музыкального бота: «!!!» в любом чате (только владелец/MUSIC_ADMIN_IDS).
 * Сообщение сразу удаляется, ответ — в ЛС. PV Bot такие сообщения пропускает (он понимает только «!!»).
 * Перезапуск = выход процесса: systemd (pv-music.service) поднимет бота заново, перед стартом git pull + npm install.
 */
const sh = (cmd: string, args: string[], cwd = ROOT) => new Promise<string>((res, rej) =>
  execFile(cmd, args, { cwd, timeout: 30_000, env: { ...process.env, TZ: 'Europe/Moscow' } }, (e, out, err) => (e ? rej(new Error(String(err || e.message).trim())) : res(out.trim()))));
const prop = (unit: string, p: string) => sh('systemctl', ['show', '-p', p, '--value', unit]).catch(() => '');

/** Что нового на GitHub для папки music. */
export async function pendingCommits(): Promise<{ commits: string[]; error: string | null }> {
  try {
    await sh('git', ['fetch', '--quiet', 'origin', 'main']);
    const out = await sh('git', ['log', '--format=• %s', 'HEAD..origin/main', '--', '.']);
    return { commits: out.split('\n').filter(Boolean), error: null };
  } catch (e) { return { commits: [], error: (e as Error).message }; }
}

export const HELP = [
  '### 🎶 PV Music · команды',
  '`!!!` — статус',
  '`!!!update` — обновить с GitHub и перезапуститься',
  '`!!!restart` — перезапустить бота',
  '`!!!lavalink` — перезапустить звуковой движок (если музыка зависла)',
  '`!!!test` — проверить звук по шагам (SoundCloud → ffmpeg → Lavalink)',
  '`!!!текст исполнитель — название` — где ищется текст песни и почему не нашёлся',
  '`!!!сайт ссылка` — открыть страницу с сервера (пускает ли сайт) и прислать её файлом',
  '-# Вернувшись после перезапуска, бот сам напишет в ЛС.',
].join('\n');

export type Exit = (code: number) => void;
let exit: Exit = code => process.exit(code);
export function _setExit(fn: Exit): void { exit = fn; }

/** Ответ на команду (текст для ЛС). restart — выйти после отправки. */
export async function runCommand(client: Client, name: string, arg = ''): Promise<{ text: string; restart?: 'update' | 'restart'; file?: { name: string; data: Buffer } }> {
  const lava = manager();
  if (name === '' || name === 'status' || name === 'статус') {
    const node = lava.nodeManager.leastUsedNodes()[0];
    const playing = [...lava.players.values()].filter(p => p.queue.current);
    const version = await sh('git', ['log', '-1', '--format=%s · %cd', '--date=format-local:%d.%m %H:%M МСК']).catch(() => '');
    return { text: [
      '### 🎶 PV Music',
      `🟢 бот онлайн ${dur(process.uptime() * 1000)} · серверов: ${client.guilds.cache.size}`,
      node ? `🟢 звук (Lavalink) подключён${node.stats ? ` · память ${Math.round(node.stats.memory.used / 1048576)} МБ` : ''}` : '🔴 звук (Lavalink) не подключён — `!!!lavalink`',
      `🎧 играет сейчас: ${playing.length}${playing.length ? ` (${playing.map(p => client.guilds.cache.get(p.guildId)?.name ?? p.guildId).slice(0, 5).join(', ')})` : ''}`,
      version ? `-# Версия: ${version}` : '',
      '', HELP,
    ].filter(x => x !== '').join('\n') };
  }
  if (name === 'help' || name === 'помощь') return { text: HELP };
  if (name === 'текст' || name === 'lyrics') {
    if (!arg) return { text: 'Напиши так: `!!!текст исполнитель — название`' };
    const tr: string[] = [];
    const r = await findLyrics({ title: arg }, tr);
    return { text: [`### 📝 Поиск текста «${arg.slice(0, 80)}»`, ...tr.map(x => `▸ ${x}`.slice(0, 300)), r ? `-# Начало: ${r.text.split('\n').slice(0, 2).join(' / ').slice(0, 150)}` : ''].filter(Boolean).join('\n').slice(0, 3900) };
  }
  // Открыть страницу С СЕРВЕРА (видно, пускает ли сайт наш VPS) и прислать её файлом — чтобы подключить новый источник текстов.
  if (name === 'сайт' || name === 'site') {
    let url: URL;
    try { url = new URL(arg.trim()); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(); } catch { return { text: 'Напиши так: `!!!сайт https://…`' }; }
    const t = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'ru,en;q=0.8' }, signal: AbortSignal.timeout(12_000) })
      .catch(e => ({ error: (e as Error).message }) as const);
    if ('error' in res) return { text: `### 🌐 ${url.hostname}\n▸ ❌ не открылся: ${res.error}` };
    const body = Buffer.from(await res.arrayBuffer()).subarray(0, 4_000_000);
    const html = body.toString('utf8');
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '—';
    return {
      text: [`### 🌐 ${url.hostname}`, `▸ ответ: **${res.status}**${res.status === 403 ? ' (не пускает сервер)' : res.ok ? ' ✅' : ''} · ${Date.now() - t} мс · ${Math.round(body.length / 1024)} КБ`,
        `▸ заголовок: ${title.slice(0, 200)}`, res.url !== url.href ? `▸ переадресация → ${res.url.slice(0, 200)}` : '',
        '-# Страница — файлом ниже. Перешли его Claude.'].filter(Boolean).join('\n'),
      file: { name: `${url.hostname.replace(/[^a-z0-9.-]/gi, '')}.html`, data: body },
    };
  }
  if (name === 'test' || name === 'тест') {
    const r = await selfTest(lava);
    return { text: [`### ${r.ok ? '✅ Звук в порядке' : '❌ Звук сломан'}`, ...r.lines].join('\n') };
  }
  if (name === 'update' || name === 'обновить') {
    const u = await pendingCommits();
    if (u.error) return { text: `✕ GitHub не ответил: ${u.error.slice(0, 300)}\n-# Перезапустить всё равно: \`!!!restart\`` };
    if (!u.commits.length) return { text: '✅ Обновлений нет — работает свежая версия.\n-# Перезапустить всё равно: `!!!restart`' };
    return { restart: 'update', text: `🔄 Обновляюсь (${u.commits.length}):\n${u.commits.slice(0, 10).join('\n').slice(0, 1500)}\n-# Вернусь через 20–40 с и напишу. Музыка в войсах остановится.` };
  }
  if (name === 'restart' || name === 'перезапуск') return { restart: 'restart', text: '🔄 Перезапускаюсь — вернусь через 20–40 с и напишу.' };
  if (name === 'lavalink') {
    const pid = Number(await prop('lavalink', 'MainPID')) || 0;
    try { if (!pid) throw new Error(); process.kill(pid, 'SIGTERM'); } catch { return { text: '✕ Не смог перезапустить Lavalink. На сервере: `systemctl restart lavalink`' }; }
    return { text: '🔊 Перезапускаю звуковой движок — 15–30 с. Музыка прервётся, бот переподключится сам.' };
  }
  return { text: `Не знаю \`${PREFIX}${name}\`.\n\n${HELP}` };
}

/** true — сообщение было командой (дальше не обрабатывать). */
export async function handleMessage(message: Message): Promise<boolean> {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return false;
  if (!ADMINS.has(message.author.id)) return false;
  const name = message.content.slice(PREFIX.length).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  await message.delete().catch(() => undefined);
  const arg = message.content.slice(PREFIX.length).trim().split(/\s+/).slice(1).join(' ');
  const r: Awaited<ReturnType<typeof runCommand>> = await runCommand(message.client, name, arg).catch(e => ({ text: `✕ Ошибка: ${(e as Error).message}`.slice(0, 400) }));
  await message.author.send({ embeds: [{ color: 0x80848e, description: r.text }], files: r.file ? [{ attachment: r.file.data, name: r.file.name }] : [] }).catch(e => console.warn('[!!!] ЛС не дошло', e?.message));
  if (r.restart) {
    try { writeFileSync(join(ROOT, '.restart-request'), r.restart); } catch { /* не страшно */ }
    setTimeout(() => exit(0), 1500);
  }
  return true;
}

/**
 * Автообновление (04.11.2026, просьба владельца: «зачем каждый раз на серваке обновлять»): раз в 10 мин git fetch;
 * есть новые коммиты в music/ и музыка нигде не играет — перезапуск с меткой update (systemd поднимет с git pull,
 * после старта — ЛС владельцу «обновление установлено»). Играет — ждём следующей проверки. MUSIC_AUTO_UPDATE=false — выкл.
 */
export function startAutoUpdate(isBusy: () => boolean, everyMs = 10 * 60_000): void {
  if (process.env.MUSIC_AUTO_UPDATE === 'false' || !process.env.INVOCATION_ID) return; // только под systemd на сервере
  setInterval(async () => {
    const u = await pendingCommits();
    if (u.error || !u.commits.length || isBusy()) return;
    // Уже перезапускались ради этой версии, а код так и не скачался (git pull упал) — по кругу не крутимся.
    const target = await sh('git', ['rev-parse', 'origin/main']).catch(() => '');
    const tried = (() => { try { return readFileSync(join(ROOT, '.update-tried'), 'utf8').trim(); } catch { return ''; } })();
    if (!target || target === tried) return;
    try { writeFileSync(join(ROOT, '.update-tried'), target); } catch { /* не страшно */ }
    console.log(`[обновление] новых изменений: ${u.commits.length} — перезапускаюсь`);
    try { writeFileSync(join(ROOT, '.restart-request'), 'update'); } catch { /* не страшно */ }
    exit(0);
  }, everyMs).unref();
}
