import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function openDatabase(dataDir) {
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'uploads'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'jinlin.sqlite'), { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) throw new Error('数据库版本高于当前程序，禁止使用旧版本打开');
  if (version === 0) db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('parent','teacher','admin')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE profiles (user_id TEXT PRIMARY KEY REFERENCES users(id), data TEXT NOT NULL);
    CREATE TABLE drafts (user_id TEXT PRIMARY KEY REFERENCES users(id), data TEXT NOT NULL);
    CREATE TABLE policies (
      id TEXT PRIMARY KEY, organization TEXT NOT NULL, contact TEXT NOT NULL,
      documents TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE registration_consents (
      user_id TEXT PRIMARY KEY REFERENCES users(id), policy_id TEXT NOT NULL REFERENCES policies(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE slots (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 100), enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(date,start,end)
    );
    CREATE TABLE appointments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), slot_id TEXT NOT NULL REFERENCES slots(id),
      profile TEXT NOT NULL, policy_id TEXT NOT NULL REFERENCES policies(id), signature TEXT NOT NULL,
      evidence_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','confirmed','completed','rejected','cancelled')),
      teacher_id TEXT REFERENCES users(id), staff_note TEXT NOT NULL DEFAULT '',
      request_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id,request_key)
    );
    CREATE INDEX appointments_owner ON appointments(user_id,created_at);
    CREATE INDEX appointments_slot ON appointments(slot_id,status);
    CREATE TABLE media (
      id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(id),
      uploader_id TEXT NOT NULL REFERENCES users(id), filename TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE growth (
      id INTEGER PRIMARY KEY AUTOINCREMENT, appointment_id TEXT NOT NULL REFERENCES appointments(id),
      teacher_id TEXT NOT NULL REFERENCES users(id), occurred_at TEXT NOT NULL,
      title TEXT NOT NULL, text TEXT NOT NULL, diet TEXT NOT NULL, nap TEXT NOT NULL,
      mood TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE growth_media (
      growth_id INTEGER NOT NULL REFERENCES growth(id), media_id TEXT NOT NULL UNIQUE REFERENCES media(id),
      PRIMARY KEY(growth_id,media_id)
    );
    CREATE INDEX growth_appointment ON growth(appointment_id,id);
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL, tag TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(id),
      user_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX comments_post ON comments(post_id,id);
    CREATE TABLE likes (
      post_id INTEGER NOT NULL REFERENCES posts(id), user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY(post_id,user_id)
    );
    CREATE TABLE favorites (
      user_id TEXT NOT NULL REFERENCES users(id), item TEXT NOT NULL, PRIMARY KEY(user_id,item)
    );
    CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL,
      target TEXT NOT NULL, created_at TEXT NOT NULL
    );
    PRAGMA user_version=1;
    COMMIT;
  `);
  if (version < 2) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE appointments ADD COLUMN signed_documents TEXT;
    PRAGMA user_version=2;
    COMMIT;`);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export const stamp = () => new Date().toISOString();
export function audit(db, user, action, target) {
  db.prepare('INSERT INTO audit(user_id,action,target,created_at) VALUES(?,?,?,?)')
    .run(user || null, action, target, stamp());
}
