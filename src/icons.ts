import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { ROOT } from './config.js';

/**
 * Значки кнопок плеера (рисовал Codex, music/assets/icons/*.png) — эмодзи приложения PV Music `mu_<имя>`.
 * При старте бот догружает недостающие; не вышло (нет прав/сети) — на кнопках остаются обычные эмодзи.
 */
const DIR = join(ROOT, 'assets', 'icons');
const ids = new Map<string, string>();
export type Emo = string | { id: string; name: string };

/** Значок для кнопки: эмодзи приложения, если загружен, иначе запасной обычный эмодзи. */
export function ico(name: string, fallback: string): Emo {
  const id = ids.get(name);
  return id ? { id, name: `mu_${name}` } : fallback;
}

export async function loadIcons(client: Client<true>): Promise<number> {
  if (!existsSync(DIR)) return 0;
  const files = readdirSync(DIR).filter(f => /^[a-z_]+\.png$/.test(f));
  const app = client.application;
  const have = await app.emojis.fetch().catch(() => null);
  if (!have) return 0;
  for (const e of have.values()) if (e.name?.startsWith('mu_')) ids.set(e.name.slice(3), e.id);
  let added = 0;
  for (const f of files) {
    const name = f.replace(/\.png$/, '');
    if (ids.has(name)) continue;
    const e = await app.emojis.create({ name: `mu_${name}`, attachment: readFileSync(join(DIR, f)) }).catch(err => { console.warn('[значки]', name, err?.message); return null; });
    if (e) { ids.set(name, e.id); added++; }
  }
  return added;
}
export const iconsLoaded = () => ids.size;
