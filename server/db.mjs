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
  if (version > 6) throw new Error('数据库版本高于当前程序，禁止使用旧版本打开');
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
  if (version < 3) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE media ADD COLUMN purpose TEXT NOT NULL DEFAULT 'growth';
    CREATE TABLE morning_versions (
      id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(id),
      revision INTEGER NOT NULL, lock INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('draft','submitted')),
      profile TEXT NOT NULL, service_date TEXT NOT NULL,
      ask TEXT NOT NULL, look TEXT NOT NULL, touch TEXT NOT NULL, inspect TEXT NOT NULL, doctor TEXT NOT NULL,
      author_id TEXT NOT NULL REFERENCES users(id), author_name TEXT NOT NULL,
      source_media_id TEXT REFERENCES media(id), source TEXT NOT NULL DEFAULT 'daily',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT,
      content_hash TEXT, parent_signature TEXT, confirmed_by TEXT REFERENCES users(id), confirmed_at TEXT,
      UNIQUE(appointment_id,revision)
    );
    CREATE INDEX morning_appointment ON morning_versions(appointment_id,revision);
    CREATE TABLE morning_requests (
      user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
      appointment_id TEXT NOT NULL REFERENCES appointments(id), operation TEXT NOT NULL,
      payload_hash TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES morning_versions(id), response TEXT NOT NULL,
      PRIMARY KEY(user_id,request_key)
    );
    PRAGMA user_version=3;
    COMMIT;`);
  if (version < 4) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE posts ADD COLUMN moderation TEXT NOT NULL DEFAULT 'approved';
    ALTER TABLE posts ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE posts ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE posts ADD COLUMN reviewed_by TEXT REFERENCES users(id);
    ALTER TABLE posts ADD COLUMN reviewed_at TEXT;
    CREATE INDEX posts_moderation ON posts(moderation,id);
    PRAGMA user_version=4;
    COMMIT;`);
  if (version < 5) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE slots ADD COLUMN service_type TEXT;
    ALTER TABLE policies ADD COLUMN service_type TEXT;
    ALTER TABLE appointments ADD COLUMN service_type TEXT;
    ALTER TABLE appointments ADD COLUMN address TEXT NOT NULL DEFAULT '';
    ALTER TABLE appointments ADD COLUMN signatures TEXT;
    CREATE TABLE service_reviews(appointment_id TEXT PRIMARY KEY REFERENCES appointments(id), user_id TEXT NOT NULL REFERENCES users(id), rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE consultations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), teacher_id TEXT REFERENCES users(id), category TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX consultations_owner ON consultations(user_id,updated_at);
    CREATE INDEX consultations_teacher ON consultations(teacher_id,updated_at);
    CREATE TABLE consultation_messages(id TEXT PRIMARY KEY, consultation_id TEXT NOT NULL REFERENCES consultations(id), user_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE consultation_media(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES consultation_messages(id), filename TEXT NOT NULL UNIQUE, mime TEXT NOT NULL);
    CREATE TABLE consultation_requests(user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(user_id,request_key));
    PRAGMA user_version=5;
    COMMIT;`);
  if (version < 6) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE growth ADD COLUMN game_activity TEXT NOT NULL DEFAULT '';
    PRAGMA user_version=6;
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
