import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export type Db = ReturnType<typeof createDb>;

/**
 * Opens (creating if needed) a SQLite database and runs pending migrations.
 * Tests pass ':memory:' for a fresh isolated DB per test file.
 */
export function createDb(dbPath = process.env.DATABASE_PATH ?? './data/messenger.db') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
