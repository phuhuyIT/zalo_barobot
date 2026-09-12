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
    storeModule.initTables(mockDb);

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
        platoon_leader: 'chat_group_456',
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
        {
          key: 'leave_stats',
          label: 'Thống kê tranh thủ Tiểu đội 2',
          squad: 'main',
          type: 'leave_roster_stats',
          sheet_tab: 'Tab_Leave',
          recipients: ['squad_main'],
          auto_send_time: null,
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

    // Mock fetchLeaveStats (F13)
    vi.spyOn(sheetsModule, 'fetchLeaveStats').mockResolvedValue({
      unit: 'Đơn vị: Tiểu đội 2',
      totalTurns: 2,
      latestTurnDate: '11/09/2026',
      stats: [
        {
          name: 'Lương Văn Tài',
          leaveCount: 0,
          missedCount: 1,
          lastLeaveDate: null,
          turnsSinceLastLeave: null,
        },
        {
          name: 'Mai Đức Tính',
          leaveCount: 1,
          missedCount: 0,
          lastLeaveDate: '11/09/2026',
          turnsSinceLastLeave: 0,
        },
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

  it('sends to overridden recipients sequentially (F12)', async () => {
    // Override recipients for main_duty in store
    storeModule.saveRuntimeConfigOverride(
      'main_duty',
      {
        recipients: ['squad_main', 'platoon_leader'],
      },
      mockDb
    );

    const mockZalo = new ZaloClient('dummy_token');
    const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({
      messageId: 'msg_test',
      raw: { ok: true },
    });

    const sendRes = await sendSchedule('main_duty', {
      targetDate: '01/09/2026',
      zaloClient: mockZalo,
    });

    expect(sendRes.results).toHaveLength(2);
    expect(sendRes.results[0].recipientKey).toBe('squad_main');
    expect(sendRes.results[0].chatId).toBe('chat_group_123');
    expect(sendRes.results[1].recipientKey).toBe('platoon_leader');
    expect(sendRes.results[1].chatId).toBe('chat_group_456');
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('builds and sends leave_roster_stats message (F13)', async () => {
    const preview = await buildScheduleMessage('leave_stats');
    expect(preview.text).toContain('📊 THỐNG KÊ TẦN SUẤT TRANH THỦ');
    expect(preview.text).toContain('Lương Văn Tài: Về 0 lần | Mất lượt: 1 | Chưa từng về');

    const mockZalo = new ZaloClient('dummy_token');
    const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({
      messageId: 'msg_stats_1',
      raw: { ok: true },
    });

    const sendRes = await sendSchedule('leave_stats', {
      zaloClient: mockZalo,
    });

    expect(sendRes.scheduleKey).toBe('leave_stats');
    expect(sendRes.results).toHaveLength(1);
    expect(sendRes.results[0].success).toBe(true);
    expect(sendSpy).toHaveBeenCalled();
  });
});
