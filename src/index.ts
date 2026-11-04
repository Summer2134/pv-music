import { ActivityType, Client, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { CLIENT_ID, OWNER_ID, ROOT, TOKEN } from './config.js';
import { execFile } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDb, pool } from './db.js';
import { createManager, manager } from './player.js';
import { COMMANDS, route } from './commands.js';
import { handleMessage, startAutoUpdate } from './admin.js';
import { selfTest } from './diag.js';
import { iconsLoaded, loadIcons } from './icons.js';
import { STREAM_PORT, startStreamServer, stopStreamServer } from './soundcloud.js';

/**
 * PV Music — отдельный музыкальный бот (просьба владельца 04.11.2026). Звук играет Lavalink (Java, отдельная служба
 * на том же сервере), бот только управляет: поиск, очередь, кнопки, статистика. Падение одного не трогает PV Bot.
 */
if (!TOKEN || !CLIENT_ID) {
  console.error('Нет MUSIC_TOKEN / MUSIC_CLIENT_ID в music/.env');
  process.exit(1);
}
process.on('unhandledRejection', e => console.error('[необработано]', e));
process.on('uncaughtException', e => console.error('[исключение]', e));

// «!!!»-команды требуют Message Content Intent (галочка в Developer Portal). Нет галочки — без них, музыка работает.
const APP_MESSAGE_CONTENT = (1 << 18) | (1 << 19);
const flags = await new REST().setToken(TOKEN).get(Routes.currentApplication()).then(a => Number((a as { flags?: number }).flags ?? 0)).catch(() => 0);
const textCommands = Boolean(flags & APP_MESSAGE_CONTENT);
if (!textCommands) console.warn('[бот] Message Content Intent выключен — команды !!! не работают (Developer Portal → Bot → Message Content Intent)');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
  ...(textCommands ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] : [])] });
if (textCommands) client.on('messageCreate', m => void handleMessage(m).catch(e => console.error('[!!!]', e)));
createManager(client);

client.once('clientReady', async c => {
  console.log(`[бот] ${c.user.tag} онлайн, серверов: ${c.guilds.cache.size}`);
  await manager().init({ id: c.user.id, username: c.user.username });
  void loadIcons(c).then(n => console.log(`[значки] плеер: ${iconsLoaded()} шт.${n ? `, загружено новых ${n}` : ''}`)).catch(e => console.warn('[значки]', e?.message));
  c.user.setActivity({ name: '/играть · музыка без лагов', type: ActivityType.Listening });
  // Через 15 с — чтобы успел подключиться звуковой движок.
  setTimeout(() => void notifyOwnerStarted(c).catch(e => console.warn('[бот] ЛС владельцу о запуске', e?.message)), 15_000).unref();
  try {
    await new REST().setToken(TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body: COMMANDS });
    console.log(`[бот] команд зарегистрировано: ${COMMANDS.length}`);
  } catch (e) { console.error('[бот] регистрация команд', e); }
});

client.on('interactionCreate', async i => {
  try { await route(i); } catch (e) {
    console.error('[команда]', e);
    if (i.isRepliable()) {
      const payload = { content: '✕ Что-то пошло не так. Попробуй ещё раз.', flags: MessageFlags.Ephemeral as const };
      await (i.deferred || i.replied ? i.followUp(payload) : i.reply(payload)).catch(() => undefined);
    }
  }
});

await startStreamServer().then(() => console.log(`[soundcloud] поток на 127.0.0.1:${STREAM_PORT}`)).catch(e => console.error('[soundcloud] поток не запустился', e.message));
await initDb().catch(e => console.error('[база] не подключилась — музыка работает без статистики:', e.message));
await client.login(TOKEN);
startAutoUpdate(() => [...manager().players.values()].some(p => p.queue.current || p.playing));

const stop = async () => {
  for (const p of manager().players.values()) await p.destroy('shutdown', true).catch(() => undefined);
  stopStreamServer();
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

/**
 * После каждого запуска (обновление !!!update, перезапуск, падение) — ЛС владельцу: вернулся, какая версия.
 * Если бот падает и поднимается по кругу — не чаще раза в 10 мин (метка в music/.last-start).
 */
async function notifyOwnerStarted(c: Client<true>): Promise<void> {
  if (!OWNER_ID) return;
  const stamp = join(ROOT, '.last-start');
  let prev = 0;
  try { prev = Number(readFileSync(stamp, 'utf8')) || 0; } catch { /* первый запуск */ }
  try { writeFileSync(stamp, String(Date.now())); } catch { /* не страшно */ }
  // PV Bot перед !!!update / !!!restart кладёт music/.restart-request — такой запуск сообщаем всегда.
  const reqFile = join(ROOT, '.restart-request');
  let requested = '';
  try { requested = readFileSync(reqFile, 'utf8').trim(); unlinkSync(reqFile); } catch { /* сам упал или первый запуск */ }
  if (!requested && Date.now() - prev < 10 * 60_000) return;
  const version = await new Promise<string>(res => execFile('git', ['log', '-1', '--format=%s · %cd', '--date=format-local:%d.%m %H:%M МСК'], { cwd: ROOT, timeout: 10_000, env: { ...process.env, TZ: 'Europe/Moscow' } }, (e, out) => res(e ? '' : out.trim())));
  const node = manager().nodeManager.leastUsedNodes().length ? '🟢 звук подключён' : '🟡 звук ещё подключается';
  const test = await selfTest(manager()).catch(e => ({ ok: false, lines: [`❌ самопроверка упала: ${(e as Error).message}`] }));
  const owner = await c.users.fetch(OWNER_ID).catch(() => null);
  await owner?.send({ embeds: [{
    color: 0x80848e,
    description: [`### ✅ PV Music снова онлайн`, requested === 'update' ? '-# Обновление установлено.' : requested ? '-# Перезапуск по твоей команде.' : '-# Перезапустился сам (падение или перезагрузка сервера).', version ? `-# Версия: ${version.slice(0, 200)}` : '', `-# ${node} · серверов: ${c.guilds.cache.size}`, '', `**Проверка звука:** ${test.ok ? 'всё работает ✅' : 'есть проблема ❌'}`, ...test.lines, '',
      textCommands ? '-# Команды: `!!!` — статус, `!!!test`, `!!!update`, `!!!restart`, `!!!lavalink`' : '-# ⚠️ Команды !!! выключены: включи Message Content Intent в Developer Portal → Bot'].filter(Boolean).join('\n'),
  }] });
}
