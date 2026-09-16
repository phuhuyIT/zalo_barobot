import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  parsePatrolCommand,
  normalizeVietnamese,
  initPatrolTables,
  getPatrolDailyStatus,
  savePatrolSubmission,
  getPatrolMembers,
  addPatrolMember,
  handlePatrolCommand,
  runPatrolReminders,
  buildCombinedPatrolMessage,
} from '../src/patrol';
import { ZaloClient } from '../src/core/zaloClient';
import * as storeModule from '../src/store';
import { formatDateDMY } from '../src/sheets';

describe('Patrol Feature Tests (Mục 30: Tests 1 - 16)', () => {
  let mockDb: Database.Database;

  const squad1LeaderId = 'user_leader_squad_1';
  const patrolGroupId = 'group_patrol_chat_id';
  const platoonLeaderId = 'chat_platoon_leader';

  beforeEach(() => {
    mockDb = new Database(':memory:');
    storeModule.initTables(mockDb);
    storeModule.setDatabase(mockDb);

    process.env.TIUDOI_1_LEADER_USER_ID = squad1LeaderId;
    process.env.PATROL_GROUP_ID = patrolGroupId;
    process.env.PLATOON_LEADER_CHAT_ID = platoonLeaderId;

    // Seed mock members into squad 1 roster
    addPatrolMember('Nguyễn Văn A', ['Nguyen Van A', 'A', 'van a'], mockDb);
    addPatrolMember('Trần Văn B', ['Tran Van B', 'B', 'van b'], mockDb);
    addPatrolMember('Lê Văn C', ['Le Van C', 'C'], mockDb);
  });

  afterEach(() => {
    mockDb.close();
  });

  describe('Command Parser (Tests 1 - 4)', () => {
    it('Test 1: tuantra Nguyen Van A -> valid', () => {
      const roster = getPatrolMembers(mockDb);
      const res = parsePatrolCommand('tuantra Nguyen Van A', roster);
      expect(res.isValid).toBe(true);
      expect(res.members).toEqual(['Nguyễn Văn A']);
    });

    it('Test 2: tuantra Nguyen Van A Tran Van B -> valid', () => {
      const roster = getPatrolMembers(mockDb);
      const res = parsePatrolCommand('tuantra Nguyen Van A Tran Van B', roster);
      expect(res.isValid).toBe(true);
      expect(res.members).toEqual(['Nguyễn Văn A', 'Trần Văn B']);
    });

    it('Test 3: tuantra -> invalid', () => {
      const roster = getPatrolMembers(mockDb);
      const res = parsePatrolCommand('tuantra', roster);
      expect(res.isValid).toBe(false);
      expect(res.members).toHaveLength(0);
      expect(res.error).toContain('Cú pháp không hợp lệ');
    });

    it('Test 4: tuantra A B C -> invalid if only 1–2 members are supported', () => {
      const roster = getPatrolMembers(mockDb);
      const res = parsePatrolCommand('tuantra A B C', roster);
      expect(res.isValid).toBe(false);
      expect(res.error).toContain('Chỉ hỗ trợ lịch đi tuần từ 1 đến 2 người');
    });

    it('supports delimiter syntax with + or ,', () => {
      const roster = getPatrolMembers(mockDb);
      const resPlus = parsePatrolCommand('tuantra + Nguyen Van A + Tran Van B', roster);
      expect(resPlus.isValid).toBe(true);
      expect(resPlus.members).toEqual(['Nguyễn Văn A', 'Trần Văn B']);

      const resComma = parsePatrolCommand('tuantra Nguyen Van A, Tran Van B', roster);
      expect(resComma.isValid).toBe(true);
      expect(resComma.members).toEqual(['Nguyễn Văn A', 'Trần Văn B']);
    });

    it('rejects unknown member when roster is configured', () => {
      const roster = getPatrolMembers(mockDb);
      const res = parsePatrolCommand('tuantra Người Lạ Hoàn Toàn', roster);
      expect(res.isValid).toBe(false);
      expect(res.error).toContain('Unable to find member:');
    });

    it('works with delimiters when no roster is configured', () => {
      const res = parsePatrolCommand('tuantra Phạm Hoàng Phúc + Phạm Hữu Luân', []);
      expect(res.isValid).toBe(true);
      expect(res.members).toEqual(['Phạm Hoàng Phúc', 'Phạm Hữu Luân']);
    });
  });

  describe('Sender & Group Validation (Tests 5 - 6)', () => {
    it('Test 5: A user who is not the Squad 1 leader submits the command -> ignore/reject', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm1', raw: {} });

      const result = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          senderId: 'random_user_123', // Không phải Squad 1 leader
          chatId: patrolGroupId,
          messageId: 'msg_t5',
        },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true }
      );

      expect(result.handled).toBe(true);
      expect(result.success).toBe(false);
      expect(result.ignoredReason).toBe('unauthorized_sender');
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('Test 6: Command arrives from another group -> ignore/reject', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm1', raw: {} });

      const result = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          senderId: squad1LeaderId,
          chatId: 'some_other_group_999', // Không phải PATROL_GROUP_ID
          messageId: 'msg_t6',
        },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true }
      );

      expect(result.handled).toBe(true);
      expect(result.success).toBe(false);
      expect(result.ignoredReason).toBe('unauthorized_group');
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('Schedule Submission & Combining (Tests 7, 14, 16)', () => {
    it('Test 7: Leader submits schedule at 06:20 -> submitted = true', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_sent', raw: {} });

      const result = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          senderId: squad1LeaderId,
          chatId: patrolGroupId,
          messageId: 'msg_t7',
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' }],
        }
      );

      expect(result.success).toBe(true);
      expect(result.members).toEqual(['Nguyễn Văn A']);
      expect(result.summarySent).toBe(true);

      // Verify persisted state in SQLite
      const d = formatDateDMY(new Date());
      const status = getPatrolDailyStatus(d, mockDb);
      expect(status?.submitted).toBe(true);
      expect(status?.selectedMembers).toEqual(['Nguyễn Văn A']);
      expect(status?.leaderUserId).toBe(squad1LeaderId);
    });

    it('Leader submits schedule via private chat directly to bot -> confirms to leader and sends summary to platoon leader', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_sent', raw: {} });

      const result = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          senderId: squad1LeaderId,
          chatId: squad1LeaderId, // Private chat directly to bot
          messageId: 'msg_direct_private',
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' }],
        }
      );

      expect(result.success).toBe(true);
      expect(result.members).toEqual(['Nguyễn Văn A']);
      expect(result.summarySent).toBe(true);
      // Both platoon commander and leader (confirmation) receive messages
      expect(sendSpy).toHaveBeenCalledWith(platoonLeaderId, expect.stringContaining('LỊCH ĐI TUẦN TRA'));
      expect(sendSpy).toHaveBeenCalledWith(squad1LeaderId, expect.stringContaining('Đã nhận lịch đi tuần'));
    });

    it('Test 14: Leader sends a different valid schedule later that day -> update schedule and send updated summary', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_sent', raw: {} });

      // First submission (06:10)
      await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          senderId: squad1LeaderId,
          chatId: patrolGroupId,
          messageId: 'msg_first',
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' }],
        }
      );

      // Second submission (06:20) with updated members
      const updateResult = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A Tran Van B',
          senderId: squad1LeaderId,
          chatId: patrolGroupId,
          messageId: 'msg_second',
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' }],
        }
      );

      expect(updateResult.success).toBe(true);
      expect(updateResult.summarySent).toBe(true);
      expect(updateResult.members).toEqual(['Nguyễn Văn A', 'Trần Văn B']);

      const d = formatDateDMY(new Date());
      const status = getPatrolDailyStatus(d, mockDb);
      expect(status?.selectedMembers).toEqual(['Nguyễn Văn A', 'Trần Văn B']);
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });

    it('Test 16: Duplicate message/event is processed -> no duplicate summary or reminder', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_sent', raw: {} });

      // Process event first time
      const res1 = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          senderId: squad1LeaderId,
          chatId: patrolGroupId,
          messageId: 'duplicate_msg_id_100',
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' }],
        }
      );
      expect(res1.success).toBe(true);
      expect(res1.summarySent).toBe(true);

      // Retry event with same messageId
      const res2 = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          senderId: squad1LeaderId,
          chatId: patrolGroupId,
          messageId: 'duplicate_msg_id_100',
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' }],
        }
      );

      expect(res2.ignoredReason).toBe('duplicate_message');
      expect(res2.summarySent).toBe(false);
      expect(sendSpy).toHaveBeenCalledTimes(1); // Not called again!
    });
  });

  describe('Reminders at 06:30, 06:35, 06:40 (Tests 8 - 13, 15)', () => {
    it('Test 8: Leader submitted schedule earlier -> Scheduler checks at 06:30 -> no reminder', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage');

      const d = formatDateDMY(new Date());
      savePatrolSubmission(
        {
          date: d,
          groupId: patrolGroupId,
          senderId: squad1LeaderId,
          leaderUserId: squad1LeaderId,
          selectedMembers: ['Nguyễn Văn A'],
        },
        mockDb
      );

      const res = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:30',
        zaloClient: mockZalo,
        database: mockDb,
      });

      expect(res.triggered).toBe(false);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('Test 9: No schedule exists at 06:30 -> reminder #1', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'rem_1', raw: {} });

      const res = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:30',
        zaloClient: mockZalo,
        database: mockDb,
      });

      expect(res.triggered).toBe(true);
      expect(res.reminderCount).toBe(1);
      expect(sendSpy).toHaveBeenCalledWith(
        squad1LeaderId,
        expect.stringContaining('Lần 1/3')
      );

      // Verify persisted in DB
      const d = formatDateDMY(new Date());
      const status = getPatrolDailyStatus(d, mockDb);
      expect(status?.reminderCount).toBe(1);
      expect(status?.lastReminderAt).toBe('06:30');
    });

    it('Test 10: No schedule exists at 06:35 -> reminder #2', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'rem_2', raw: {} });

      // Simulate reminder #1 already sent
      const d = formatDateDMY(new Date());
      mockDb.prepare(
        `INSERT INTO patrol_daily_status (date, group_id, sender_id, leader_user_id, reminder_count, last_reminder_at, status, created_at, updated_at)
         VALUES (?, ?, '', ?, 1, '06:30', 'pending', datetime('now'), datetime('now'))`
      ).run(d, patrolGroupId, squad1LeaderId);

      const res = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:35',
        zaloClient: mockZalo,
        database: mockDb,
      });

      expect(res.triggered).toBe(true);
      expect(res.reminderCount).toBe(2);
      expect(sendSpy).toHaveBeenCalledWith(
        squad1LeaderId,
        expect.stringContaining('Lần 2/3')
      );
    });

    it('Test 11: No schedule exists at 06:40 -> reminder #3', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'rem_3', raw: {} });

      // Simulate reminder #2 already sent
      const d = formatDateDMY(new Date());
      mockDb.prepare(
        `INSERT INTO patrol_daily_status (date, group_id, sender_id, leader_user_id, reminder_count, last_reminder_at, status, created_at, updated_at)
         VALUES (?, ?, '', ?, 2, '06:35', 'pending', datetime('now'), datetime('now'))`
      ).run(d, patrolGroupId, squad1LeaderId);

      const res = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:40',
        zaloClient: mockZalo,
        database: mockDb,
      });

      expect(res.triggered).toBe(true);
      expect(res.reminderCount).toBe(3);
      expect(sendSpy).toHaveBeenCalledWith(
        squad1LeaderId,
        expect.stringContaining('Lần 3/3')
      );
    });

    it('Test 12: Scheduler checks at 06:45 -> no reminder', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage');

      const res = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:45',
        zaloClient: mockZalo,
        database: mockDb,
      });

      expect(res.triggered).toBe(false);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('Test 13: Reminder #1 was sent at 06:30 and the leader submits at 06:32 -> stop reminders', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm', raw: {} });

      // 1. Send reminder #1 at 06:30
      await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:30',
        zaloClient: mockZalo,
        database: mockDb,
      });

      // 2. Leader submits at 06:32
      await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          senderId: squad1LeaderId,
          chatId: patrolGroupId,
          messageId: 'msg_0632',
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc' }],
        }
      );

      sendSpy.mockClear();

      // 3. Scheduler checks at 06:35 -> must NOT send reminder #2
      const res0635 = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:35',
        zaloClient: mockZalo,
        database: mockDb,
      });

      expect(res0635.triggered).toBe(false);
      expect(res0635.reason).toContain('Tiểu đội trưởng 1 đã nộp lịch');
      expect(sendSpy).not.toHaveBeenCalled();

      // 4. Scheduler checks at 06:40 -> must NOT send reminder #3
      const res0640 = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:40',
        zaloClient: mockZalo,
        database: mockDb,
      });

      expect(res0640.triggered).toBe(false);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('Test 15: Application restarts after reminder #1 -> reminderCount must not reset to 0', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm', raw: {} });

      // Run reminder #1
      await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:30',
        zaloClient: mockZalo,
        database: mockDb,
      });

      // Simulate application restart: Read directly from SQLite
      const d = formatDateDMY(new Date());
      const statusAfterRestart = getPatrolDailyStatus(d, mockDb);
      expect(statusAfterRestart?.reminderCount).toBe(1);
      expect(statusAfterRestart?.lastReminderAt).toBe('06:30');

      // Scheduler triggers at 06:35 after restart -> should be reminder #2, NOT reset to 1
      const res0635 = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:35',
        zaloClient: mockZalo,
        database: mockDb,
      });

      expect(res0635.triggered).toBe(true);
      expect(res0635.reminderCount).toBe(2);
    });

    it('Idempotency: duplicate run at 06:30 does not send reminder twice', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm', raw: {} });

      // First execution at 06:30
      const firstRun = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:30',
        zaloClient: mockZalo,
        database: mockDb,
      });
      expect(firstRun.triggered).toBe(true);
      expect(firstRun.reminderCount).toBe(1);

      // Second execution at 06:30 (e.g. cron retry or accidental double call)
      const secondRun = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:30',
        zaloClient: mockZalo,
        database: mockDb,
      });
      expect(secondRun.triggered).toBe(false);
      expect(secondRun.reason).toContain('đã được gửi');
      expect(sendSpy).toHaveBeenCalledTimes(1); // Only 1 message sent!
    });
  });

  describe('Report Message Formatting (Mục 13 & 35)', () => {
    it('combines Squad 1 and My squad patrol schedules properly', () => {
      const combined = buildCombinedPatrolMessage(
        '15/09/2026',
        ['Nguyễn Văn A', 'Trần Văn B'],
        [
          { taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' },
          { taskName: 'Đi tuần', assignee: 'Phạm Hữu Luân', subTask: 'Ca 2' },
        ]
      );

      expect(combined).toContain('📋 LỊCH ĐI TUẦN TRA NGÀY 15/09/2026');
      expect(combined).toContain('Tiểu đội 1:');
      expect(combined).toContain('- Nguyễn Văn A');
      expect(combined).toContain('- Trần Văn B');
      expect(combined).toContain('Tiểu đội 2:');
      expect(combined).toContain('- Ca 1: Phạm Hoàng Phúc');
      expect(combined).toContain('- Ca 2: Phạm Hữu Luân');
    });
  });
});
