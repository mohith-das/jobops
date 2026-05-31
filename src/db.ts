// SQLite handle. WAL mode + a single migration on first open.
//
// Writes from MCP tools must go through `runInWriteLock(fn)` (defined here) so concurrent
// tracker / outreach / application mutations don't interleave. better-sqlite3 is sync, so
// the lock is just a JS promise queue.
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, 'migrations');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  ensureMigrationsTable(db);
  applyPendingMigrations(db);
  _db = db;
  return db;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function applyPendingMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set<string>(
    db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name as string),
  );
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    });
    tx();
    // eslint-disable-next-line no-console
    console.error(`[db] applied migration ${file}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Single write lock. tracker / application / outreach writes wait their turn.
// ──────────────────────────────────────────────────────────────────────────────

let writeQueue: Promise<unknown> = Promise.resolve();

export function runInWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = writeQueue.then(() => fn());
  // Keep the chain alive even if a task throws — failures shouldn't deadlock the queue.
  writeQueue = next.catch(() => undefined);
  return next;
}
