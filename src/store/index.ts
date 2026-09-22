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
import { SendHistoryEntry, RuntimeConfigOverride, Recipient } from '../types';
import { formatDateDMY } from '../sheets/dateUtils';

/**
 * Parse chuỗi JSON an toàn với giá trị fallback nếu chuỗi rỗng hoặc lỗi cú pháp.
 */
export function safeJsonParse<T>(jsonStr: string | null | undefined, fallback: T): T {
  if (!jsonStr || typeof jsonStr !== 'string') return fallback;
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return fallback;
  }
}

export interface LastMessageInfo {
  messageId: string;
  sentDate: string;
  updatedAt: string;
}

interface LastMessageRow {
  schedule_key: string;
  chat_id: string;
  message_id: string;
  sent_date: string;
  updated_at: string;
}

interface RuntimeConfigRow {
  config_key: string;
  sheet_tab_gate_duty: string | null;
  auto_send_time: string | null;
  enabled: number | null;
  send_next_day: number | null;
  recipients: string | null;
}

interface RecipientRow {
  key: string;
  display_name: string;
  chat_id: string;
  created_at: string;
  updated_at: string;
}

let db: Database.Database | null = null;

export function setDatabase(customDb: Database.Database | null): void {
  db = customDb;
}

export function resolveDatabasePath(customPath?: string): string {
  return (
    customPath ||
    process.env.DATABASE_PATH ||
    path.resolve(process.cwd(), 'data/app.db')
  );
}

export function getDatabase(customPath?: string): Database.Database {
  if (db) return db;

  const dbPath = resolveDatabasePath(customPath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  configureSqliteConnection(db);
  initTables(db);

  return db;
}

/**
 * Mở file SQLite đã có — không CREATE TABLE.
 * Dùng cho worker: nếu file chưa có, official bot chưa chạy.
 */
export function openSqliteFile(customPath?: string): Database.Database {
  const dbPath = resolveDatabasePath(customPath);
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `SQLite file not found at ${dbPath}. Official bot must create it first.`
    );
  }
  const database = new Database(dbPath, { fileMustExist: true });
  configureSqliteConnection(database);
  return database;
}

/**
 * WAL + busy_timeout cho mọi kết nối chia sẻ /data/app.db
 * (official bot và worker). Không dùng PRAGMA user_version.
 */
export function configureSqliteConnection(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
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
export function initTables(database: Database.Database): void {
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

  // 2. Bảng ghi đè cấu hình runtime (F9 & F12)
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_config (
      config_key TEXT PRIMARY KEY,
      sheet_tab_gate_duty TEXT,
      auto_send_time TEXT,
      enabled INTEGER,
      send_next_day INTEGER,
      recipients TEXT
    );
  `);

  const runtimeCols = database.prepare(`PRAGMA table_info(runtime_config)`).all() as Array<{ name: string }>;
  if (!runtimeCols.some((col) => col.name === 'send_next_day')) {
    database.exec(`ALTER TABLE runtime_config ADD COLUMN send_next_day INTEGER;`);
  }
  if (!runtimeCols.some((col) => col.name === 'recipients')) {
    database.exec(`ALTER TABLE runtime_config ADD COLUMN recipients TEXT;`);
  }

  // 3. Bảng người nhận lịch runtime (F12)
  database.exec(`
    CREATE TABLE IF NOT EXISTS recipients (
      key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 4. Bảng lịch sử gửi (F11 - append-only log)
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

    CREATE INDEX IF NOT EXISTS idx_last_message_date ON last_message(sent_date);
    CREATE INDEX IF NOT EXISTS idx_send_history_schedule ON send_history(schedule_key, timestamp);
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
 * Lấy đầy đủ thông tin gửi tin nhắn gần nhất (dùng cho Web UI / API).
 */
export function getLastMessageInfo(
  scheduleKey: string,
  chatId: string,
  database?: Database.Database
): LastMessageInfo | null {
  const d = database || getDatabase();
  const row = d
    .prepare(
      `SELECT message_id, sent_date, updated_at FROM last_message WHERE schedule_key = ? AND chat_id = ?`
    )
    .get(scheduleKey, chatId) as LastMessageRow | undefined;

  if (!row) return null;
  return {
    messageId: row.message_id,
    sentDate: row.sent_date,
    updatedAt: row.updated_at,
  };
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
        `SELECT sheet_tab_gate_duty, auto_send_time, enabled, send_next_day, recipients
         FROM runtime_config
         WHERE config_key = ?`
      )
      .get(configKey) as RuntimeConfigRow | undefined;

    if (!row) return null;

    const recipientsParsed = row.recipients
      ? safeJsonParse<string[]>(row.recipients, [])
      : undefined;

    return {
      sheet_tab_gate_duty: row.sheet_tab_gate_duty ?? undefined,
      auto_send_time: row.auto_send_time ?? undefined,
      enabled: row.enabled !== null && row.enabled !== undefined ? Boolean(row.enabled) : undefined,
      send_next_day: row.send_next_day !== null && row.send_next_day !== undefined ? Boolean(row.send_next_day) : undefined,
      recipients: recipientsParsed,
    };
  } catch (err: unknown) {
    console.error(`[Store] Lỗi đọc runtime_config cho key '${configKey}':`, err);
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
    const rows = d.prepare(`SELECT * FROM runtime_config`).all() as RuntimeConfigRow[];

    const result: Record<string, RuntimeConfigOverride> = {};
    for (const r of rows) {
      const recipientsParsed = r.recipients
        ? safeJsonParse<string[]>(r.recipients, [])
        : undefined;

      result[r.config_key] = {
        sheet_tab_gate_duty: r.sheet_tab_gate_duty ?? undefined,
        auto_send_time: r.auto_send_time ?? undefined,
        enabled: r.enabled !== null && r.enabled !== undefined ? Boolean(r.enabled) : undefined,
        send_next_day: r.send_next_day !== null && r.send_next_day !== undefined ? Boolean(r.send_next_day) : undefined,
        recipients: recipientsParsed,
      };
    }
    return result;
  } catch (err: unknown) {
    console.error('[Store] Lỗi đọc danh sách runtime_config:', err);
    return {};
  }
}

/**
 * Lưu cấu hình runtime override (F9 & F12).
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
  const recipientsVal =
    override.recipients !== undefined
      ? JSON.stringify(override.recipients)
      : existing.recipients !== undefined
      ? JSON.stringify(existing.recipients)
      : null;

  d.prepare(
    `INSERT INTO runtime_config (config_key, sheet_tab_gate_duty, auto_send_time, enabled, send_next_day, recipients)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(config_key) DO UPDATE SET
       sheet_tab_gate_duty = excluded.sheet_tab_gate_duty,
       auto_send_time = excluded.auto_send_time,
       enabled = excluded.enabled,
       send_next_day = excluded.send_next_day,
       recipients = excluded.recipients`
  ).run(configKey, sheetTab, sendTime, enabledVal, sendNextDayVal, recipientsVal);
}

/**
 * Lấy tất cả danh sách người nhận (F12).
 */
export function getAllRecipients(database?: Database.Database): Recipient[] {
  const d = database || getDatabase();
  try {
    const rows = d.prepare(`SELECT key, display_name, chat_id, created_at, updated_at FROM recipients ORDER BY display_name ASC`).all() as RecipientRow[];
    return rows.map((r) => ({
      key: r.key,
      display_name: r.display_name,
      chat_id: r.chat_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  } catch (err: unknown) {
    console.error('[Store] Lỗi đọc danh sách recipients:', err);
    return [];
  }
}

/**
 * Lấy thông tin 1 người nhận theo key (F12).
 */
export function getRecipient(key: string, database?: Database.Database): Recipient | null {
  const d = database || getDatabase();
  try {
    const row = d.prepare(`SELECT key, display_name, chat_id, created_at, updated_at FROM recipients WHERE key = ?`).get(key) as RecipientRow | undefined;
    if (!row) return null;
    return {
      key: row.key,
      display_name: row.display_name,
      chat_id: row.chat_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch (err: unknown) {
    console.error(`[Store] Lỗi đọc recipient cho key '${key}':`, err);
    return null;
  }
}

/**
 * Thêm hoặc cập nhật người nhận (F12).
 */
export function saveRecipient(
  recipient: { key: string; display_name: string; chat_id: string },
  database?: Database.Database
): void {
  const d = database || getDatabase();
  const now = new Date().toISOString();
  const existing = getRecipient(recipient.key, d);

  const createdAt = existing?.created_at || now;
  const updatedAt = now;

  d.prepare(
    `INSERT INTO recipients (key, display_name, chat_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       display_name = excluded.display_name,
       chat_id = excluded.chat_id,
       updated_at = excluded.updated_at`
  ).run(recipient.key.trim(), recipient.display_name.trim(), recipient.chat_id.trim(), createdAt, updatedAt);
}

/**
 * Xóa người nhận và tự động gỡ khỏi các schedule đang gán (F12).
 * Tránh để lại recipient_key rác gây lỗi khi gửi.
 */
export function deleteRecipient(
  key: string,
  database?: Database.Database
): { deletedKey: string; affectedSchedules: string[] } {
  const d = database || getDatabase();
  const affectedSchedules: string[] = [];

  const performDelete = d.transaction(() => {
    // Tìm các schedule trong runtime_config đang gán recipient này
    const rows = d.prepare(`SELECT config_key, recipients FROM runtime_config WHERE recipients IS NOT NULL`).all() as { config_key: string; recipients: string }[];
    for (const r of rows) {
      const recList = safeJsonParse<string[]>(r.recipients, []);
      if (Array.isArray(recList) && recList.includes(key)) {
        const updatedList = recList.filter((k) => k !== key);
        d.prepare(`UPDATE runtime_config SET recipients = ? WHERE config_key = ?`).run(
          JSON.stringify(updatedList),
          r.config_key
        );
        affectedSchedules.push(r.config_key);
      }
    }

    // Xóa khỏi bảng recipients
    d.prepare(`DELETE FROM recipients WHERE key = ?`).run(key);
  });

  performDelete();

  return { deletedKey: key, affectedSchedules };
}

/**
 * Seed danh sách người nhận ban đầu nếu bảng recipients chưa có dữ liệu (F12).
 */
export function seedDefaultRecipients(
  defaults: { key: string; display_name: string; chat_id: string }[],
  database?: Database.Database
): void {
  const d = database || getDatabase();
  try {
    const countRow = d.prepare(`SELECT COUNT(*) as count FROM recipients`).get() as { count: number } | undefined;
    if (countRow?.count === 0) {
      for (const item of defaults) {
        if (item.key && item.chat_id) {
          saveRecipient(item, d);
        }
      }
    }
  } catch (err: unknown) {
    console.warn('[Store] Không thể seed danh sách người nhận mặc định:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Đặt lại (reset/xóa) trạng thái đã gửi trong ngày (last_message) và lịch sử gửi (send_history) để kiểm thử.
 */
export function resetScheduleSentStatus(
  date?: string,
  scheduleKey?: string,
  database?: Database.Database
): { deletedLastMessage: number; deletedHistory: number } {
  const d = database || getDatabase();
  let deletedLastMessage: number;
  let deletedHistory = 0;

  if (date && scheduleKey) {
    const info = d.prepare(`DELETE FROM last_message WHERE sent_date = ? AND schedule_key = ?`).run(date, scheduleKey);
    deletedLastMessage = info.changes;
  } else if (date) {
    const info = d.prepare(`DELETE FROM last_message WHERE sent_date = ?`).run(date);
    deletedLastMessage = info.changes;
  } else {
    const info1 = d.prepare(`DELETE FROM last_message`).run();
    const info2 = d.prepare(`DELETE FROM send_history`).run();
    deletedLastMessage = info1.changes;
    deletedHistory = info2.changes;
  }

  return { deletedLastMessage, deletedHistory };
}

/**
 * Xóa trắng file data/webhook.log
 */
export function clearWebhookLog(): boolean {
  try {
    const logPath = path.resolve(process.cwd(), 'data/webhook.log');
    if (fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '');
    }
    return true;
  } catch (err: unknown) {
    console.error('[Store] Lỗi xóa file webhook.log:', err);
    return false;
  }
}
