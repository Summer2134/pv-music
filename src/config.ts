import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// .env лежит в папке music/ (рядом с package.json), отдельно от .env PV Bot.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: join(root, '.env'), quiet: true } as Parameters<typeof loadEnv>[0]);

export const ROOT = root;
export const TOKEN = process.env.MUSIC_TOKEN ?? '';
export const CLIENT_ID = process.env.MUSIC_CLIENT_ID ?? '';
export const OWNER_ID = (process.env.MUSIC_OWNER_ID ?? '').trim();
/** Кто может !!!-команды: владелец + MUSIC_ADMIN_IDS (через запятую). */
export const ADMINS = new Set([OWNER_ID, ...(process.env.MUSIC_ADMIN_IDS ?? '').split(',')].map(x => x.trim()).filter(Boolean));
export const PREFIX = '!!!';
export const LAVALINK = {
  host: process.env.LAVALINK_HOST ?? '127.0.0.1',
  port: Number(process.env.LAVALINK_PORT ?? 2333),
  password: process.env.LAVALINK_PASSWORD ?? 'youshallnotpass',
};
/** Громкость при заходе (04.11.2026: владелец просил тише — было 70). */
export const DEFAULT_VOLUME = Number(process.env.MUSIC_VOLUME ?? 35);
/** Сколько ждать в пустом войсе / после конца очереди, прежде чем уйти. */
export const IDLE_LEAVE_MS = Number(process.env.MUSIC_IDLE_MS ?? 120_000);
