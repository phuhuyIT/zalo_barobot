import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables, saveRecipient } from '../../src/store';
import {
  TASKPROOF_TABLES,
  assertTaskproofTablesExist,
  closeWorkerDatabase,
  getWorkerDatabase,
  initTaskproofTables,
  listMissingTaskproofTables,
} from '../../src/taskproof/store';
import {
  TASKPROOF_SETTING_DEFAULTS,
  getAllTaskproofSettings,
  getTaskproofSetting,
  seedTaskproofSettings,
  setTaskproofSetting,
} from '../../src/taskproof/settings';

function openMemory(): Database.Database {
  const db = new Database(':memory:');
  configureSqliteConnection(db);
  initTables(db);
  return db;
}

describe('task-proof schema (Step 2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemory();
  });

  afterEach(() => {
    db.close();
  });

  it('creates all Section 6 tables and indexes', () => {
    expect(listMissingTaskproofTables(db)).toEqual([...TASKPROOF_TABLES]);
    initTaskproofTables(db);
    expect(listMissingTaskproofTables(db)).toEqual([]);
    assertTaskproofTablesExist(db);

    const indexes = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_tasks_short_code', 'idx_tasks_open', 'idx_task_group_picks_admin'])
    );
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toContain('task_group_picks');
  });

  it('does not touch PRAGMA user_version', () => {
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(0);
    initTaskproofTables(db);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(0);
  });

  it('enforces unique short_code and unique (task_id, uid_from)', () => {
    initTaskproofTables(db);
    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 1, 0, 'collecting', 0)`
    ).run('t1', 'ABC123', 'off_1', 'rep_1', 'https://example.com', 'caption');

    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, short_code, official_chat_id, report_group_id,
            link, reference_text, required_count, deadline, status, created_at)
           VALUES ('t2', 'ABC123', 'off_1', 'rep_1', 'https://x', 'c', 1, 0, 'collecting', 0)`
        )
        .run()
    ).toThrow();

    db.prepare(
      `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, stored_path, match_score, created_at)
       VALUES ('s1', 't1', 'u1', 'A', 'https://img', '/data/proofs/t1/s1.jpg', 0.9, 0)`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, match_score, created_at)
           VALUES ('s2', 't1', 'u1', 'A', 'https://img', 0.8, 1)`
        )
        .run()
    ).toThrow();
  });

  it('refuses to start when a table is missing', () => {
    initTaskproofTables(db);
    db.exec(`DROP TABLE submissions`);
    expect(listMissingTaskproofTables(db)).toEqual(['submissions']);
    expect(() => assertTaskproofTablesExist(db)).toThrow(/submissions/);
  });
});

describe('task-proof settings reader (Step 2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemory();
    initTaskproofTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('seeds in-code defaults when rows are missing', () => {
    expect(getTaskproofSetting('default_required_count', db)).toBe(12);
    expect(getTaskproofSetting('default_deadline_offset_ms', db)).toBe(3_600_000);
    expect(getTaskproofSetting('link_pending_ms', db)).toBe(120_000);
    expect(getTaskproofSetting('remind_exclude_uids', db)).toEqual([]);
    expect(getAllTaskproofSettings(db)).toMatchObject(TASKPROOF_SETTING_DEFAULTS);
  });

  it('lets DB values override in-code defaults', () => {
    setTaskproofSetting('default_deadline_offset_ms', 5_000, db);
    setTaskproofSetting('max_mentions_per_message', 12, db);
    setTaskproofSetting('remind_exclude_uids', ['111', '222'], db);

    expect(getTaskproofSetting('default_deadline_offset_ms', db)).toBe(5_000);
    expect(getTaskproofSetting('max_mentions_per_message', db)).toBe(12);
    expect(getTaskproofSetting('remind_exclude_uids', db)).toEqual(['111', '222']);
    expect(getTaskproofSetting('default_required_count', db)).toBe(12);
  });

  it('bumps leftover default_required_count 1 to 12 once, then keeps later values', () => {
    db.prepare(`DELETE FROM taskproof_settings WHERE key = ?`).run('_migrated_required_count_1_to_12');
    setTaskproofSetting('default_required_count', 1, db);
    seedTaskproofSettings(db);
    expect(getTaskproofSetting('default_required_count', db)).toBe(12);

    setTaskproofSetting('default_required_count', 5, db);
    seedTaskproofSettings(db);
    expect(getTaskproofSetting('default_required_count', db)).toBe(5);

    setTaskproofSetting('default_required_count', 1, db);
    seedTaskproofSettings(db);
    expect(getTaskproofSetting('default_required_count', db)).toBe(1);
  });

  it('falls back to default when stored JSON is the wrong type', () => {
    db.prepare(`UPDATE taskproof_settings SET value_json = ? WHERE key = ?`).run(
      '"not-a-number"',
      'default_required_count'
    );
    expect(getTaskproofSetting('default_required_count', db)).toBe(12);
  });

  it('copies recipients.admin into admin_official_chat_id when empty', () => {
    const fresh = openMemory();
    saveRecipient({ key: 'admin', display_name: 'Admin', chat_id: 'admin_chat_99' }, fresh);
    initTaskproofTables(fresh);
    expect(getTaskproofSetting('admin_official_chat_id', fresh)).toBe('admin_chat_99');
    fresh.close();
  });

  it('does not store env secret names in settings', () => {
    const keys = (
      db.prepare(`SELECT key FROM taskproof_settings`).all() as Array<{ key: string }>
    ).map((row) => row.key);
    expect(keys).not.toEqual(
      expect.arrayContaining([
        'INTERNAL_API_KEY',
        'ADMIN_PASSWORD',
        'ZALO_BOT_TOKEN',
        'ZALO_WEBHOOK_SECRET',
      ])
    );
  });
});

describe('worker database open (Step 2)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskproof-'));
    dbPath = path.join(tmpDir, 'app.db');
    closeWorkerDatabase();
  });

  afterEach(() => {
    closeWorkerDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws if the sqlite file does not exist', () => {
    expect(() => getWorkerDatabase(dbPath)).toThrow(/not found/i);
  });

  it('throws if the file exists but task-proof tables do not', () => {
    const botDb = new Database(dbPath);
    configureSqliteConnection(botDb);
    initTables(botDb);
    botDb.close();
    expect(() => getWorkerDatabase(dbPath)).toThrow(/Task-proof tables missing/);
  });

  it('opens after official bot has created tables, without CREATE TABLE', () => {
    const botDb = new Database(dbPath);
    configureSqliteConnection(botDb);
    initTables(botDb);
    initTaskproofTables(botDb);
    botDb.close();

    const worker = getWorkerDatabase(dbPath);
    assertTaskproofTablesExist(worker);
    expect(Number(worker.pragma('busy_timeout', { simple: true }))).toBe(5000);
  });
});
