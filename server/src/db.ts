import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','draft','pending','rejected')),
    data TEXT NOT NULL,
    sort REAL NOT NULL DEFAULT 0,
    member_id TEXT,
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX items_coll ON items(collection, status, published_at DESC);

  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    banned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE member_tokens (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE admins (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE amens (
    target TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (target, actor)
  );

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    member_id TEXT NOT NULL,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    parent_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_target ON comments(target, created_at);

  CREATE TABLE chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    is_mod INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      v++;
      db.prepare('UPDATE schema_version SET v = ?').run(v);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : fallback;
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

/** Monotonic content version — bumps on every content write so clients can revalidate cheaply (ETag). */
export function contentVersion(db: DB): number {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'content_version'").get() as { value: string } | undefined;
  return r ? Number(r.value) : 0;
}
export function bumpVersion(db: DB): number {
  const next = contentVersion(db) + 1;
  db.prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(next));
  return next;
}
