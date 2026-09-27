/**
 * store.ts
 *
 * Bảng task-proof trên cùng file SQLite (/data/app.db).
 * Chỉ official bot gọi initTaskproofTables (CREATE TABLE IF NOT EXISTS).
 * Worker chỉ assertTaskproofTablesExist — không CREATE, không PRAGMA user_version.
 *
 * Hai namespace ID (không dùng lẫn):
 * - official_chat_id: webhook Official Bot Platform (nhóm sau khi admin chọn
 *   lúc /task 1-1; /lienket và /gui vẫn gõ trong nhóm)
 * - zca_group_id: threadId zca-js (OCR, mention) — NULL đến khi /lienket
 * task_group_picks và task_sample_pending chỉ official bot dùng (chọn nhóm 1-1
 * và ảnh mẫu cho caption). Worker không cần hai bảng đó.
 */

import Database from 'better-sqlite3';
import { openSqliteFile } from '../store';
import { seedTaskproofSettings } from './settings';

export const TASKPROOF_TABLES = [
  'tasks',
  'submissions',
  'group_members_cache',
  'group_id_map',
  'processed_messages',
  'taskproof_settings',
] as const;

export type TaskStatus = 'collecting' | 'overdue' | 'completed' | 'cancelled';

const initializedDbs = new WeakSet<Database.Database>();

let workerDb: Database.Database | null = null;

export function initTaskproofTables(database: Database.Database): void {
  if (initializedDbs.has(database)) return;

  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      short_code TEXT NOT NULL UNIQUE,
      official_chat_id TEXT NOT NULL,
      zca_group_id TEXT,
      report_group_id TEXT NOT NULL,
      link TEXT NOT NULL,
      reference_text TEXT NOT NULL,
      required_count INTEGER NOT NULL,
      deadline INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reminded_at INTEGER,
      remind_count INTEGER NOT NULL DEFAULT 0,
      reported_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_short_code ON tasks(short_code);
    CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_open_zca ON tasks(zca_group_id, status);

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      uid_from TEXT NOT NULL,
      display_name TEXT NOT NULL,
      image_url TEXT NOT NULL,
      stored_path TEXT,
      match_score REAL NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(task_id, uid_from)
    );

    CREATE TABLE IF NOT EXISTS group_members_cache (
      zca_group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (zca_group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_id_map (
      official_chat_id TEXT PRIMARY KEY,
      zca_group_id     TEXT NOT NULL UNIQUE,
      display_name     TEXT,
      linked_at        INTEGER NOT NULL,
      linked_by_uid    TEXT
    );

    CREATE TABLE IF NOT EXISTS processed_messages (
      zca_group_id TEXT NOT NULL,
      msg_id       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (zca_group_id, msg_id)
    );

    CREATE TABLE IF NOT EXISTS taskproof_settings (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_group_picks (
      token TEXT PRIMARY KEY,
      admin_chat_id TEXT NOT NULL,
      link TEXT NOT NULL,
      reference_text TEXT NOT NULL,
      required_count INTEGER,
      deadline INTEGER NOT NULL,
      report_group_id TEXT NOT NULL DEFAULT '',
      groups_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      chosen_official_chat_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_group_picks_admin
      ON task_group_picks(admin_chat_id, created_at);

    CREATE TABLE IF NOT EXISTS task_sample_pending (
      admin_chat_id TEXT PRIMARY KEY,
      link TEXT NOT NULL,
      required_count INTEGER,
      deadline INTEGER NOT NULL,
      report_group_id TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      image_path TEXT NOT NULL DEFAULT '',
      photo_url TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id);
    CREATE INDEX IF NOT EXISTS idx_processed_messages_created ON processed_messages(created_at);
  `);

  ensureSubmissionProofOrigin(database);
  initializedDbs.add(database);
  seedTaskproofSettings(database);
}

/** Ảnh mẫu giữ nguyên khi cùng người gửi ảnh sau trong nhóm. Worker chỉ đọc cột này. */
export function ensureSubmissionProofOrigin(database: Database.Database): void {
  const cols = database.prepare(`PRAGMA table_info(submissions)`).all() as Array<{ name: string }>;
  if (cols.some((col) => col.name === 'proof_origin')) return;
  database.exec(
    `ALTER TABLE submissions ADD COLUMN proof_origin TEXT NOT NULL DEFAULT 'group'`
  );
}

const PROCESSED_MESSAGE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const GROUP_PICK_RETENTION_MS = 24 * 60 * 60 * 1000;

export function pruneTaskproofEphemeral(
  database: Database.Database,
  now: number = Date.now()
): { processed: number; picks: number } {
  const processed = database
    .prepare(`DELETE FROM processed_messages WHERE created_at < ?`)
    .run(now - PROCESSED_MESSAGE_TTL_MS);
  const picks = database
    .prepare(`DELETE FROM task_group_picks WHERE expires_at < ?`)
    .run(now - GROUP_PICK_RETENTION_MS);
  database.prepare(`DELETE FROM task_sample_pending WHERE expires_at < ?`).run(now);
  return { processed: Number(processed.changes || 0), picks: Number(picks.changes || 0) };
}

export function listMissingTaskproofTables(database: Database.Database): string[] {
  const existing = new Set(
    (
      database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
  );
  return TASKPROOF_TABLES.filter((name) => !existing.has(name));
}

export function assertTaskproofTablesExist(database: Database.Database): void {
  const missing = listMissingTaskproofTables(database);
  if (missing.length === 0) return;
  throw new Error(
    `Task-proof tables missing: ${missing.join(', ')}. Official bot must create them first.`
  );
}

/**
 * Kết nối worker: WAL + busy_timeout, không CREATE TABLE.
 * Thiếu file hoặc thiếu bảng → throw (worker từ chối start).
 */
export function getWorkerDatabase(customPath?: string): Database.Database {
  if (workerDb) return workerDb;
  workerDb = openSqliteFile(customPath);
  try {
    assertTaskproofTablesExist(workerDb);
  } catch (err) {
    workerDb.close();
    workerDb = null;
    throw err;
  }
  return workerDb;
}

export function peekWorkerDatabase(): Database.Database | null {
  return workerDb;
}

export function closeWorkerDatabase(): void {
  if (workerDb) {
    workerDb.close();
    workerDb = null;
  }
}
