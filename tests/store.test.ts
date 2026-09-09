import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  saveLastMessage,
  getLastMessageId,
  hasSentToday,
  appendSendHistory,
  getRecentSendHistory,
  saveRuntimeConfigOverride,
  getRuntimeConfigOverride,
  getAllRuntimeConfigOverrides,
} from '../src/store';

describe('SQLite Store Layer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Init tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS last_message (
        schedule_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sent_date TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (schedule_key, chat_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_config (
        config_key TEXT PRIMARY KEY,
        sheet_tab_gate_duty TEXT,
        auto_send_time TEXT,
        enabled INTEGER,
        send_next_day INTEGER
      );
      CREATE TABLE IF NOT EXISTS send_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        schedule_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        result TEXT NOT NULL,
        error TEXT,
        old_message_deleted INTEGER NOT NULL DEFAULT 0
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('manages last_message and idempotency correctly', () => {
    expect(getLastMessageId('main_duty', 'chat_123', db)).toBeNull();
    expect(hasSentToday('main_duty', 'chat_123', '01/09/2026', db)).toBe(false);

    // Lưu tin nhắn thành công
    saveLastMessage('main_duty', 'chat_123', 'msg_001', '01/09/2026', db);

    expect(getLastMessageId('main_duty', 'chat_123', db)).toBe('msg_001');
    expect(hasSentToday('main_duty', 'chat_123', '01/09/2026', db)).toBe(true);
    // Khác ngày -> false
    expect(hasSentToday('main_duty', 'chat_123', '02/09/2026', db)).toBe(false);

    // Cập nhật tin nhắn mới
    saveLastMessage('main_duty', 'chat_123', 'msg_002', '01/09/2026', db);
    expect(getLastMessageId('main_duty', 'chat_123', db)).toBe('msg_002');
  });

  it('records send history and retrieves in descending order', () => {
    appendSendHistory(
      {
        timestamp: '2026-09-01T05:30:00.000Z',
        schedule_key: 'main_duty',
        chat_id: 'chat_123',
        result: 'success',
        old_message_deleted: true,
      },
      db
    );

    appendSendHistory(
      {
        timestamp: '2026-09-01T05:31:00.000Z',
        schedule_key: 'culi_duty',
        chat_id: 'chat_456',
        result: 'failure',
        error: 'Network timeout',
        old_message_deleted: false,
      },
      db
    );

    const history = getRecentSendHistory(10, db);
    expect(history).toHaveLength(2);
    expect(history[0].schedule_key).toBe('culi_duty');
    expect(history[0].result).toBe('failure');
    expect(history[0].error).toBe('Network timeout');
    expect(history[0].old_message_deleted).toBe(false);

    expect(history[1].schedule_key).toBe('main_duty');
    expect(history[1].result).toBe('success');
    expect(history[1].old_message_deleted).toBe(true);
  });

  it('manages runtime config overrides (F9)', () => {
    expect(getRuntimeConfigOverride('main', db)).toBeNull();

    saveRuntimeConfigOverride(
      'main',
      {
        sheet_tab_gate_duty: 'Tab Mới Tháng 10',
      },
      db
    );

    let override = getRuntimeConfigOverride('main', db);
    expect(override?.sheet_tab_gate_duty).toBe('Tab Mới Tháng 10');

    // Cập nhật thêm auto_send_time
    saveRuntimeConfigOverride(
      'main_duty',
      {
        auto_send_time: '06:00',
        enabled: false,
      },
      db
    );

    const all = getAllRuntimeConfigOverrides(db);
    expect(all['main'].sheet_tab_gate_duty).toBe('Tab Mới Tháng 10');
    expect(all['main_duty'].auto_send_time).toBe('06:00');
    expect(all['main_duty'].enabled).toBe(false);
  });
});
