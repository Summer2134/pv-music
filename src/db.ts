import pg from 'pg';

/**
 * Своя статистика музыки в той же базе, что и PV Bot (таблицы music_*). База упала — музыка играет дальше,
 * статистика просто не пишется (все вызовы через safe()).
 */
const url = process.env.DATABASE_URL;
export const pool = new pg.Pool(url ? {
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'false' || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  max: Number(process.env.DATABASE_POOL_SIZE ?? 4),
} : { max: 1 });
pool.on('error', e => console.error('[база]', e.message));
export let dbReady = false;

export async function initDb(): Promise<void> {
  if (!url) { console.warn('[база] DATABASE_URL не задан — статистика и плейлисты выключены'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS music_plays (
      id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, requester_id TEXT, source TEXT, identifier TEXT,
      title TEXT NOT NULL, author TEXT, uri TEXT, artwork TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
      listened_ms INTEGER NOT NULL DEFAULT 0, listeners INTEGER NOT NULL DEFAULT 0, played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS music_plays_guild_time ON music_plays (guild_id, played_at);
    CREATE INDEX IF NOT EXISTS music_plays_requester ON music_plays (requester_id, played_at);
    CREATE TABLE IF NOT EXISTS music_listen (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day DATE NOT NULL, ms BIGINT NOT NULL DEFAULT 0, tracks INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, day)
    );
    CREATE TABLE IF NOT EXISTS music_likes (
      user_id TEXT NOT NULL, uri TEXT NOT NULL, title TEXT NOT NULL, author TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, uri)
    );
    CREATE TABLE IF NOT EXISTS music_playlists (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS music_playlists_name ON music_playlists (user_id, lower(name));
    CREATE TABLE IF NOT EXISTS music_playlist_tracks (
      playlist_id BIGINT NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE, pos INTEGER NOT NULL,
      uri TEXT NOT NULL, title TEXT NOT NULL, author TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (playlist_id, pos)
    );
    CREATE TABLE IF NOT EXISTS music_wave_fb (
      user_id TEXT NOT NULL, track_id BIGINT NOT NULL, artist TEXT, title TEXT, uri TEXT, score REAL NOT NULL DEFAULT 0,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS music_wave_prefs (
      user_id TEXT PRIMARY KEY, activity TEXT, mood TEXT, character TEXT, lang TEXT
    );
    CREATE TABLE IF NOT EXISTS music_settings (
      guild_id TEXT PRIMARY KEY, volume INTEGER, autoplay BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
  // Разовые правки данных: громкость по умолчанию стала 35% — сохранённые 70% сбрасываем один раз.
  await pool.query('CREATE TABLE IF NOT EXISTS music_meta (key TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const first = await pool.query("INSERT INTO music_meta (key) VALUES ('volume-35') ON CONFLICT DO NOTHING RETURNING key");
  if (first.rowCount) await pool.query('UPDATE music_settings SET volume = NULL');
  dbReady = true;
}

/** Запрос, который не роняет музыку: при ошибке — null и строка в лог. */
export async function safe<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[] | null> {
  if (!dbReady) return null;
  try { return (await pool.query<T>(sql, params)).rows; } catch (e) { console.error('[база]', (e as Error).message); return null; }
}
