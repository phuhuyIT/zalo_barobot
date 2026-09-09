/**
 * store/index.ts
 *
 * Tầng lưu trữ SQLite (SQLite Store Layer) qua thư viện better-sqlite3.
 * Đáp ứng các yêu cầu:
 * - Bảng last_message: lưu message_id mới nhất và ngày gửi thành công gần nhất (F4, F1, F6).
 * - Bảng runtime_config: lưu các ghi đè cấu hình runtime từ Web UI (F9).
 * - Bảng send_history: bảng log append-only theo dõi lịch sử gửi tin (F11).
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SendHistoryEntry, RuntimeConfigOverride } from '../types';
import { formatDateDMY } from '../sheets/dateUtils';

let db: Database.Database | null = null;

export function setDatabase(customDb: Database.Database | null): void {
  db = customDb;
}

export function getDatabase(customPath?: string): Database.Database {
  if (db) return db;

  const dbPath =
    customPath ||
    process.env.DATABASE_PATH ||
    path.resolve(process.cwd(), 'data/app.db');

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initTables(db);

  return db;
}

/**
 * Đóng kết nối database (dùng khi cleanup / tests).
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Khởi tạo cấu trúc các bảng.
 */
function initTables(database: Database.Database): void {
  // 1. Bảng lưu tin nhắn gần nhất theo (schedule_key, chat_id)
  database.exec(`
    CREATE TABLE IF NOT EXISTS last_message (
      schedule_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sent_date TEXT NOT NULL, -- DD/MM/YYYY
      updated_at TEXT NOT NULL, -- ISO string
      PRIMARY KEY (schedule_key, chat_id)
    );
  `);

  // 2. Bảng ghi đè cấu hình runtime (F9)
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_config (
      config_key TEXT PRIMARY KEY,
      sheet_tab_gate_duty TEXT,
      auto_send_time TEXT,
      enabled INTEGER,
      send_next_day INTEGER
    );
  `);

  try {
    database.exec(`ALTER TABLE runtime_config ADD COLUMN send_next_day INTEGER;`);
  } catch (_) {
    // Cột đã tồn tại
  }

  // 3. Bảng lịch sử gửi (F11 - append-only log)
  database.exec(`
    CREATE TABLE IF NOT EXISTS send_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      schedule_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      result TEXT NOT NULL, -- 'success' | 'failure'
      error TEXT,
      old_message_deleted INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/**
 * Kiểm tra xem lịch này đã gửi thành công trong ngày hôm nay chưa (F1 Idempotency, F6).
 */
export function hasSentToday(
  scheduleKey: string,
  chatId: string,
  dateStr?: string,
  database?: Database.Database
): boolean {
  const d = database || getDatabase();
  const targetDate = dateStr || formatDateDMY(new Date());

  const row = d
    .prepare(
      `SELECT sent_date FROM last_message WHERE schedule_key = ? AND chat_id = ?`
    )
    .get(scheduleKey, chatId) as { sent_date: string } | undefined;

  return row?.sent_date === targetDate;
}

/**
 * Lưu message_id mới nhất sau khi gửi thành công và đánh dấu đã gửi hôm nay.
 */
export function saveLastMessage(
  scheduleKey: string,
  chatId: string,
  messageId: string,
  dateStr?: string,
  database?: Database.Database
): void {
  const d = database || getDatabase();
  const targetDate = dateStr || formatDateDMY(new Date());
  const now = new Date().toISOString();

  d.prepare(
    `INSERT INTO last_message (schedule_key, chat_id, message_id, sent_date, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(schedule_key, chat_id) DO UPDATE SET
       message_id = excluded.message_id,
       sent_date = excluded.sent_date,
       updated_at = excluded.updated_at`
  ).run(scheduleKey, chatId, messageId, targetDate, now);
}

/**
 * Lấy message_id của tin nhắn trước đó để xóa (F4).
 */
export function getLastMessageId(
  scheduleKey: string,
  chatId: string,
  database?: Database.Database
): string | null {
  const d = database || getDatabase();
  const row = d
    .prepare(
      `SELECT message_id FROM last_message WHERE schedule_key = ? AND chat_id = ?`
    )
    .get(scheduleKey, chatId) as { message_id: string } | undefined;

  return row?.message_id || null;
}

/**
 * Ghi log vào send_history (F11) và tự động dọn dẹp giữ tối đa 500 bản ghi.
 */
export function appendSendHistory(
  entry: Omit<SendHistoryEntry, 'id'>,
  database?: Database.Database
): void {
  const d = database || getDatabase();
  d.prepare(
    `INSERT INTO send_history (timestamp, schedule_key, chat_id, result, error, old_message_deleted)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    entry.timestamp,
    entry.schedule_key,
    entry.chat_id,
    entry.result,
    entry.error || null,
    entry.old_message_deleted ? 1 : 0
  );

  // Giữ tối đa 500 bản ghi gần nhất
  d.exec(`
    DELETE FROM send_history
    WHERE id NOT IN (
      SELECT id FROM send_history ORDER BY id DESC LIMIT 500
    )
  `);
}

/**
 * Lấy danh sách lịch sử gửi gần nhất (mặc định 50 bản ghi).
 */
export function getRecentSendHistory(
  limit: number = 50,
  database?: Database.Database
): SendHistoryEntry[] {
  const d = database || getDatabase();
  const rows = d
    .prepare(
      `SELECT id, timestamp, schedule_key, chat_id, result, error, old_message_deleted
       FROM send_history
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit) as any[];

  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    schedule_key: r.schedule_key,
    chat_id: r.chat_id,
    result: r.result as 'success' | 'failure',
    error: r.error,
    old_message_deleted: Boolean(r.old_message_deleted),
  }));
}

/**
 * Lấy cấu hình runtime override cho 1 key (squad key hoặc schedule key).
 */
export function getRuntimeConfigOverride(
  configKey: string,
  database?: Database.Database
): RuntimeConfigOverride | null {
  const d = database || getDatabase();
  try {
    const row = d
      .prepare(
        `SELECT sheet_tab_gate_duty, auto_send_time, enabled, send_next_day
         FROM runtime_config
         WHERE config_key = ?`
      )
      .get(configKey) as any;

    if (!row) return null;

    return {
      sheet_tab_gate_duty: row.sheet_tab_gate_duty ?? undefined,
      auto_send_time: row.auto_send_time ?? undefined,
      enabled: row.enabled !== null && row.enabled !== undefined ? Boolean(row.enabled) : undefined,
      send_next_day: row.send_next_day !== null && row.send_next_day !== undefined ? Boolean(row.send_next_day) : undefined,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Lấy tất cả các cấu hình runtime override.
 */
export function getAllRuntimeConfigOverrides(
  database?: Database.Database
): Record<string, RuntimeConfigOverride> {
  const d = database || getDatabase();
  try {
    const rows = d.prepare(`SELECT * FROM runtime_config`).all() as any[];

    const result: Record<string, RuntimeConfigOverride> = {};
    for (const r of rows) {
      result[r.config_key] = {
        sheet_tab_gate_duty: r.sheet_tab_gate_duty ?? undefined,
        auto_send_time: r.auto_send_time ?? undefined,
        enabled: r.enabled !== null && r.enabled !== undefined ? Boolean(r.enabled) : undefined,
        send_next_day: r.send_next_day !== null && r.send_next_day !== undefined ? Boolean(r.send_next_day) : undefined,
      };
    }
    return result;
  } catch (_) {
    return {};
  }
}

/**
 * Lưu cấu hình runtime override (F9).
 */
export function saveRuntimeConfigOverride(
  configKey: string,
  override: RuntimeConfigOverride,
  database?: Database.Database
): void {
  const d = database || getDatabase();

  const existing = getRuntimeConfigOverride(configKey, d) || {};
  const sheetTab =
    override.sheet_tab_gate_duty !== undefined
      ? override.sheet_tab_gate_duty
      : existing.sheet_tab_gate_duty ?? null;
  const sendTime =
    override.auto_send_time !== undefined
      ? override.auto_send_time
      : existing.auto_send_time ?? null;
  const enabledVal =
    override.enabled !== undefined
      ? override.enabled
        ? 1
        : 0
      : existing.enabled !== undefined
      ? existing.enabled
        ? 1
        : 0
      : null;
  const sendNextDayVal =
    override.send_next_day !== undefined
      ? override.send_next_day
        ? 1
        : 0
      : existing.send_next_day !== undefined
      ? existing.send_next_day
        ? 1
        : 0
      : null;

  d.prepare(
    `INSERT INTO runtime_config (config_key, sheet_tab_gate_duty, auto_send_time, enabled, send_next_day)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(config_key) DO UPDATE SET
       sheet_tab_gate_duty = excluded.sheet_tab_gate_duty,
       auto_send_time = excluded.auto_send_time,
       enabled = excluded.enabled,
       send_next_day = excluded.send_next_day`
  ).run(configKey, sheetTab, sendTime, enabledVal, sendNextDayVal);
}
