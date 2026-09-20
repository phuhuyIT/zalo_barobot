import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runDueJobs } from '../src/channels/scheduler';
import { ZaloClient } from '../src/core/zaloClient';
import * as configModule from '../src/config';
import * as storeModule from '../src/store';
import { initTaskproofTables } from '../src/taskproof/store';
import Database from 'better-sqlite3';

describe('Scheduler runDueJobs() reminders and failure alert', () => {
  let mockDb: Database.Database;
  let sentMessages: { chatId: string; text: string }[] = [];

  beforeEach(() => {
    mockDb = new Database(':memory:');
    storeModule.initTables(mockDb);
    storeModule.setDatabase(mockDb);

    sentMessages = [];
    vi.spyOn(ZaloClient.prototype, 'sendMessage').mockImplementation(async (chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return { message_id: `mock_msg_${Date.now()}` } as any;
    });

    configModule.setConfig({
      squads: {
        culi: {
          display_name: 'Tiểu đội culi',
          sheet_tab_gate_duty: 'Tab_Culi',
          header_style: 'single_row',
          overnight: true,
          cutover_time: '05:30',
        },
      },
      recipients: {
        admin: 'admin_chat_id',
        squad_culi: 'culi_group_id',
      },
      schedules: [
        {
          key: 'culi_duty',
          label: 'Lịch trực cổng Tiểu đội culi',
          squad: 'culi',
          type: 'gate_duty',
          recipients: ['squad_culi'],
          auto_send_time: '05:30',
          enabled: true,
        },
      ],
      reminders: [
        {
          schedule_key: 'culi_duty',
          remind_before_send_minutes: 60,
          remind_if_not_sent_by: '05:40',
        },
      ],
    });
  });

  it('does NOT trigger failure alert at 05:40 when auto_send_time is updated to 06:00', async () => {
    // User sets send time to 06:00 via runtime override
    storeModule.saveRuntimeConfigOverride('culi_duty', {
      auto_send_time: '06:00',
    });

    // Create a date at 05:40 VN time (UTC 22:40 previous day)
    // Note: getVietnamTimeParts parses according to Asia/Ho_Chi_Minh
    // We can construct a Date in VN time:
    const testDateAt0540 = new Date('2026-09-13T05:40:00+07:00');

    const result = await runDueJobs(testDateAt0540);

    expect(result.remindersRun).not.toContain('alert_failed_culi_duty');
    expect(sentMessages.some((m) => m.text.includes('CẢNH BÁO'))).toBe(false);
  });

  it('triggers failure alert at 06:10 if schedule has not been sent by then', async () => {
    // User sets send time to 06:00 via runtime override
    storeModule.saveRuntimeConfigOverride('culi_duty', {
      auto_send_time: '06:00',
    });

    const testDateAt0610 = new Date('2026-09-13T06:10:00+07:00');

    const result = await runDueJobs(testDateAt0610);

    expect(result.remindersRun).toContain('alert_failed_culi_duty');
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain('06:10');
    expect(sentMessages[0].text).toContain('CHƯA ĐƯỢC GỬI THÀNH CÔNG');
  });

  it('does NOT trigger failure alert at 06:10 if schedule was already sent today', async () => {
    storeModule.saveRuntimeConfigOverride('culi_duty', {
      auto_send_time: '06:00',
    });

    // Simulate that schedule was sent successfully today (13/09/2026)
    storeModule.saveLastMessage('culi_duty', 'culi_group_id', 'msg_123', '13/09/2026');

    const testDateAt0610 = new Date('2026-09-13T06:10:00+07:00');

    const result = await runDueJobs(testDateAt0610);

    expect(result.remindersRun).not.toContain('alert_failed_culi_duty');
    expect(sentMessages.length).toBe(0);
  });

  it('cancels stale task-proof rows (collecting|overdue older than TASK_STALE_AFTER_MS)', async () => {
    initTaskproofTables(mockDb);
    mockDb
      .prepare(
        `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
          link, reference_text, required_count, deadline, status, created_at)
         VALUES ('old', 'OLD001', 'off', 'zgr-1', 'rep', 'https://x', 'c', 1, 0, 'collecting', 0)`
      )
      .run();
    mockDb
      .prepare(
        `INSERT INTO tasks (id, short_code, official_chat_id, report_group_id,
          link, reference_text, required_count, deadline, status, created_at)
         VALUES ('fresh', 'NEW001', 'off', 'rep', 'https://x', 'c', 1, 0, 'overdue', ?)`
      )
      .run(Date.now());

    const result = await runDueJobs(new Date('2026-09-13T06:00:00+07:00'));
    expect(result.staleCancelled).toEqual(['OLD001']);
    const rows = mockDb
      .prepare(`SELECT short_code, status FROM tasks ORDER BY short_code`)
      .all() as Array<{ short_code: string; status: string }>;
    expect(rows).toEqual([
      { short_code: 'NEW001', status: 'overdue' },
      { short_code: 'OLD001', status: 'cancelled' },
    ]);
  });
});
