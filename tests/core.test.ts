import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendSchedule, buildScheduleMessage } from '../src/core';
import { ZaloClient } from '../src/core/zaloClient';
import * as sheetsModule from '../src/sheets';
import * as configModule from '../src/config';
import * as storeModule from '../src/store';
import Database from 'better-sqlite3';

describe('Core send_schedule()', () => {
  let mockDb: Database.Database;

  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
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

    // Set store db
    storeModule.setDatabase(mockDb);

    // Mock process.env
    process.env.GOOGLE_SHEET_ID = 'mock_spreadsheet_id';

    // Set config
    configModule.setConfig({
      squads: {
        main: {
          display_name: 'Tiểu đội 2',
          sheet_tab_gate_duty: 'Tab_Main',
          header_style: 'two_row_merged',
          overnight: false,
        },
      },
      recipients: {
        squad_main: 'chat_group_123',
      },
      schedules: [
        {
          key: 'main_duty',
          label: 'Lịch trực cổng Tiểu đội 2',
          squad: 'main',
          type: 'gate_duty',
          recipients: ['squad_main'],
          auto_send_time: '05:30',
          enabled: true,
        },
      ],
      reminders: [],
    });

    // Mock fetchDutySchedule
    vi.spyOn(sheetsModule, 'fetchDutySchedule').mockResolvedValue({
      date: '01/09/2026',
      unit: 'Đơn vị: Tiểu đội 2',
      isOvernight: false,
      tasks: [
        { taskName: 'Ca 1', assignee: 'Nguyễn Văn A' },
        { taskName: 'Ca 2', assignee: 'Trần Văn B' },
      ],
    });
  });

  it('builds message correctly without side effects', async () => {
    const result = await buildScheduleMessage('main_duty', '01/09/2026');
    expect(result.text).toContain('📢 Lịch trực cổng ngày 01/09/2026');
    expect(result.text).toContain('🔹 Ca 1: Nguyễn Văn A');
    expect(result.lookupDate).toBe('01/09/2026');
  });

  it('sends schedule, deletes old message best-effort, and saves history', async () => {
    // Giả lập đã có tin nhắn cũ trong store
    storeModule.saveLastMessage('main_duty', 'chat_group_123', 'old_msg_999', '31/08/2026', mockDb);

    // Mock ZaloClient
    const mockZalo = new ZaloClient('dummy_token');
    const deleteSpy = vi.spyOn(mockZalo, 'deleteMessage').mockResolvedValue(true);
    const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({
      messageId: 'new_msg_1000',
      raw: { ok: true },
    });

    const sendRes = await sendSchedule('main_duty', {
      targetDate: '01/09/2026',
      zaloClient: mockZalo,
    });

    expect(sendRes.scheduleKey).toBe('main_duty');
    expect(sendRes.results).toHaveLength(1);
    expect(sendRes.results[0].success).toBe(true);
    expect(sendRes.results[0].messageId).toBe('new_msg_1000');
    expect(sendRes.results[0].oldMessageDeleted).toBe(true);

    expect(deleteSpy).toHaveBeenCalledWith('chat_group_123', 'old_msg_999');
    expect(sendSpy).toHaveBeenCalled();

    // Verify last_message is updated
    expect(storeModule.getLastMessageId('main_duty', 'chat_group_123', mockDb)).toBe('new_msg_1000');

    // Verify send_history has record
    const history = storeModule.getRecentSendHistory(10, mockDb);
    expect(history).toHaveLength(1);
    expect(history[0].result).toBe('success');
    expect(history[0].old_message_deleted).toBe(true);
  });

  it('skips sending when isAutomated is true and already sent today (Idempotency)', async () => {
    storeModule.saveLastMessage('main_duty', 'chat_group_123', 'msg_already_sent', '01/09/2026', mockDb);

    const mockZalo = new ZaloClient('dummy_token');
    const sendSpy = vi.spyOn(mockZalo, 'sendMessage');

    const sendRes = await sendSchedule('main_duty', {
      isAutomated: true,
      targetDate: '01/09/2026',
      zaloClient: mockZalo,
    });

    expect(sendRes.results[0].skippedDueToIdempotency).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
