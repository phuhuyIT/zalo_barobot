import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  parsePatrolCommand,
  getPatrolDailyStatus,
  savePatrolSubmission,
  getPatrolMembers,
  addPatrolMember,
  handlePatrolCommand,
  runPatrolReminders,
  buildCombinedPatrolMessage,
  savePatrolSiteConfig,
  getPatrolSiteConfig,
  getPatrolSiteConfigs,
  getPatrolSummaryStatus,
  groupPatrolTasksIntoShifts,
  resetPatrolDailyStatus,
  getPlatoonLeaderChatId,
  getPatrolReporterStatus,
  getSiteReporterIds,
  combineHeadquartersReports,
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

    // Cấu hình Site 1 và tạm thời tắt Site 2 trong các test đơn lẻ cũ
    savePatrolSiteConfig(
      {
        siteKey: 'site_1',
        displayName: 'Trụ sở 1 (Tân Phước Khánh)',
        leaderUserId: squad1LeaderId,
        chatId: patrolGroupId,
        mergeWithSheet: true,
        enabled: true,
      },
      mockDb
    );
    savePatrolSiteConfig({ siteKey: 'site_2', enabled: false }, mockDb);

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
      expect(res.error).toContain('Không tìm thấy thành viên:');
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
      expect(result.members).toEqual(['Nguyễn Văn A', 'Phạm Hoàng Phúc']);
      expect(result.summarySent).toBe(true);

      // Verify persisted state in SQLite
      const d = formatDateDMY(new Date());
      const status = getPatrolDailyStatus(d, mockDb);
      expect(status?.submitted).toBe(true);
      expect(status?.selectedMembers).toEqual(['Nguyễn Văn A', 'Phạm Hoàng Phúc']);
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
      expect(result.members).toEqual(['Nguyễn Văn A', 'Phạm Hoàng Phúc']);
      expect(result.summarySent).toBe(true);
      // Both platoon commander and leader (confirmation) receive messages
      expect(sendSpy).toHaveBeenCalledWith(platoonLeaderId, expect.stringContaining('LỊCH TUẦN TRA'));
      expect(sendSpy).toHaveBeenCalledWith(squad1LeaderId, expect.stringContaining('Đã nhận lịch'));
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
      expect(updateResult.members).toEqual(['Nguyễn Văn A', 'Trần Văn B', 'Phạm Hoàng Phúc']);

      const d = formatDateDMY(new Date());
      const status = getPatrolDailyStatus(d, mockDb);
      expect(status?.selectedMembers).toEqual(['Nguyễn Văn A', 'Trần Văn B', 'Phạm Hoàng Phúc']);
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
      expect(res0635.reason).toContain('đã nộp lịch');
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

    it('sends the 06:30 slot when the cron wake lands at 06:32, and does not send it again at 06:33', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'rem_late', raw: {} });

      const late = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:32',
        zaloClient: mockZalo,
        database: mockDb,
      });
      expect(late.triggered).toBe(true);
      expect(late.reminderCount).toBe(1);

      const d = formatDateDMY(new Date());
      const status = getPatrolDailyStatus(d, mockDb);
      expect(status?.lastReminderAt).toBe('06:30');

      const again = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:33',
        zaloClient: mockZalo,
        database: mockDb,
      });
      expect(again.triggered).toBe(false);
      expect(sendSpy).toHaveBeenCalledTimes(1);
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

describe('Two-Site Patrol Feature Tests (Mục 1 - 7)', () => {
  let mockDb: Database.Database;

  const squad1LeaderId = 'user_leader_squad_1';
  const squad2LeaderId = 'user_leader_squad_2';
  const squad1GroupId = 'group_patrol_squad_1';
  const squad2GroupId = 'group_patrol_squad_2';
  const platoonLeaderId = 'chat_platoon_leader';
  const adminChatId = 'admin_chat_id';

  beforeEach(() => {
    mockDb = new Database(':memory:');
    storeModule.initTables(mockDb);
    storeModule.setDatabase(mockDb);

    storeModule.saveRecipient(
      { key: 'admin', display_name: 'Admin', chat_id: adminChatId },
      mockDb
    );

    delete process.env.SITE_1_LEADER_2_USER_ID;
    delete process.env.TIUDOI_1_LEADER_2_USER_ID;
    process.env.TIUDOI_1_LEADER_USER_ID = squad1LeaderId;
    process.env.PATROL_GROUP_ID = squad1GroupId;
    process.env.SITE_2_LEADER_USER_ID = squad2LeaderId;
    process.env.SITE_2_PATROL_GROUP_ID = squad2GroupId;
    process.env.PLATOON_LEADER_CHAT_ID = platoonLeaderId;

    savePatrolSiteConfig(
      {
        siteKey: 'site_1',
        displayName: 'Trụ sở 1 (Tân Phước Khánh):',
        leaderUserId: squad1LeaderId,
        chatId: squad1GroupId,
        mergeWithSheet: true,
        reminderTimes: ['06:30', '06:35', '06:40'],
        maxReminders: 3,
        enabled: true,
      },
      mockDb
    );

    savePatrolSiteConfig(
      {
        siteKey: 'site_2',
        displayName: 'Trụ sở 2 (Thạnh Hội):',
        leaderUserId: squad2LeaderId,
        chatId: squad2GroupId,
        mergeWithSheet: false,
        reminderTimes: ['06:30', '06:45'],
        maxReminders: 2,
        enabled: true,
      },
      mockDb
    );

    // Seed members for Ban CHQS roster
    addPatrolMember('Nguyễn Văn A', ['Nguyen Van A', 'A'], mockDb);
    addPatrolMember('Trần Văn B', ['Tran Van B', 'B'], mockDb);
    addPatrolMember('Lê Văn C', ['Le Van C', 'C'], mockDb);
    addPatrolMember('Hoàng Văn D', ['Hoang Van D', 'D'], mockDb);
  });

  afterEach(() => {
    mockDb.close();
  });

  describe('Multi-Shift and No-Patrol Command Parsing', () => {
    it('parses no-patrol commands: tuantra 0, tuantra nghi, tuantra none', () => {
      const r1 = parsePatrolCommand('tuantra 0');
      expect(r1.isValid).toBe(true);
      expect(r1.isNoPatrol).toBe(true);
      expect(r1.members).toEqual([]);

      const r2 = parsePatrolCommand('tuantra nghi');
      expect(r2.isValid).toBe(true);
      expect(r2.isNoPatrol).toBe(true);

      const r3 = parsePatrolCommand('tuantra NONE');
      expect(r3.isValid).toBe(true);
      expect(r3.isNoPatrol).toBe(true);

      const r4 = parsePatrolCommand('/tuantra 0');
      expect(r4.isValid).toBe(true);
      expect(r4.isNoPatrol).toBe(true);
    });

    it('parses multi-shift commands with Ca 1 and Ca 2', () => {
      const roster = getPatrolMembers(mockDb);
      const res = parsePatrolCommand('tuantra Ca 1: Nguyen Van A Ca 2: Tran Van B', roster);
      expect(res.isValid).toBe(true);
      expect(res.isMultiShift).toBe(true);
      expect(res.shifts).toHaveLength(2);
      expect(res.shifts![0].shiftNumber).toBe(1);
      expect(res.shifts![0].members).toEqual(['Nguyễn Văn A']);
      expect(res.shifts![1].shiftNumber).toBe(2);
      expect(res.shifts![1].members).toEqual(['Trần Văn B']);
    });

    it('parses multi-shift commands with Shift keyword, commas, and delimiters', () => {
      const roster = getPatrolMembers(mockDb);
      const res = parsePatrolCommand(
        'tuantra Shift 1: Nguyen Van A, Tran Van B Shift 2: Le Van C va Tran Van B',
        roster
      );
      expect(res.isValid).toBe(true);
      expect(res.isMultiShift).toBe(true);
      expect(res.shifts).toHaveLength(2);
      expect(res.shifts![0].members).toEqual(['Nguyễn Văn A', 'Trần Văn B']);
      expect(res.shifts![1].members).toEqual(['Lê Văn C', 'Trần Văn B']);
    });
  });

  describe('Site 1 Sheet Merging and Shift Count Validation', () => {
    it('alerts Admin and halts submission when reported shift count mismatches Google Sheet', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm1', raw: {} });

      // Sheet only has 1 shift, but leader submits 2 shifts
      const result = await handlePatrolCommand(
        {
          text: 'tuantra Ca 1: Nguyen Van A Ca 2: Tran Van B',
          chatId: squad1GroupId,
          senderId: squad1LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' }],
        }
      );

      expect(result.handled).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Shift count mismatch');

      // Admin was alerted
      expect(sendSpy).toHaveBeenCalledWith(
        adminChatId,
        expect.stringContaining('⚠️ CẢNH BÁO LỆCH SỐ CA TUẦN TRA')
      );

      // Platoon leader was NOT sent anything
      expect(sendSpy).not.toHaveBeenCalledWith(platoonLeaderId, expect.anything());
    });

    it('merges Site 1 multi-shifts with Google Sheet in positional order', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm2', raw: {} });

      // Sheet has 2 shifts: Ca 1 (Phúc), Ca 2 (Luân)
      const result = await handlePatrolCommand(
        {
          text: 'tuantra Ca 1: Nguyen Van A Ca 2: Tran Van B',
          chatId: squad1GroupId,
          senderId: squad1LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
          mockMySquadTasks: [
            { taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' },
            { taskName: 'Đi tuần', assignee: 'Phạm Hữu Luân', subTask: 'Ca 2' },
          ],
        }
      );

      expect(result.handled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.shifts).toHaveLength(2);
      // Positional order: reported member first, sheet member appended
      expect(result.shifts![0].members).toEqual(['Nguyễn Văn A', 'Phạm Hoàng Phúc']);
      expect(result.shifts![1].members).toEqual(['Trần Văn B', 'Phạm Hữu Luân']);
    });

    it('Hướng B: merges 2 sheet members in 1 single shift (Người 1 + Người 2) with reported single shift', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_single', raw: {} });

      // Cấu hình giống hệt file Excel ngày 16/09: Đi tuần có 2 người (Người 1: Tài, Người 2: Phúc)
      const mockTasks = [
        { taskName: 'Đi tuần - Người 1', assignee: 'Lương Văn Tài', subTask: 'Người 1' },
        { taskName: 'Đi tuần - Người 2', assignee: 'Phạm Hoàng Phúc', subTask: 'Người 2' },
      ];

      const result = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          chatId: squad1GroupId,
          senderId: squad1LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
          mockMySquadTasks: mockTasks,
        }
      );

      expect(result.handled).toBe(true);
      expect(result.success).toBe(true);
      // Chỉ có 1 ca tuần tra duy nhất
      expect(result.shifts).toHaveLength(1);
      // Ghép toàn bộ người của TĐ1 và 2 người của TĐ2 vào ca này
      expect(result.shifts![0].members).toEqual([
        'Nguyễn Văn A',
        'Lương Văn Tài',
        'Phạm Hoàng Phúc',
      ]);
    });

    it('Hướng B: merges 1 sheet member when Người 2 is absent (ngày 15/09)', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_single2', raw: {} });

      // Ngày 15/09: chỉ có 1 người đi tuần (Nguyễn Phi Hoàng)
      const mockTasks = [
        { taskName: 'Đi tuần - Người 1', assignee: 'Nguyễn Phi Hoàng', subTask: 'Người 1' },
      ];

      const result = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          chatId: squad1GroupId,
          senderId: squad1LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
          mockMySquadTasks: mockTasks,
        }
      );

      expect(result.handled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.shifts).toHaveLength(1);
      expect(result.shifts![0].members).toEqual(['Nguyễn Văn A', 'Nguyễn Phi Hoàng']);
    });

    it('Hướng B: detects mismatch when Sheet has Người 1 + Người 2 (1 shift) but leader reports 2 shifts', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_err', raw: {} });

      const mockTasks = [
        { taskName: 'Đi tuần - Người 1', assignee: 'Lương Văn Tài', subTask: 'Người 1' },
        { taskName: 'Đi tuần - Người 2', assignee: 'Phạm Hoàng Phúc', subTask: 'Người 2' },
      ];

      const result = await handlePatrolCommand(
        {
          text: 'tuantra Ca 1: Nguyen Van A Ca 2: Tran Van B',
          chatId: squad1GroupId,
          senderId: squad1LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
          mockMySquadTasks: mockTasks,
        }
      );

      expect(result.handled).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Lệch số ca tuần tra: Google Sheet có 1 ca nhưng người báo cáo gửi 2 ca');
      expect(sendSpy).toHaveBeenCalledWith(
        adminChatId,
        expect.stringContaining('⚠️ CẢNH BÁO LỆCH SỐ CA TUẦN TRA')
      );
    });

    it('groupPatrolTasksIntoShifts correctly distinguishes multi-member single shift vs multi-shift', () => {
      // 1. Nhóm 2 người trong 1 ca (Người 1, Người 2)
      const res1 = groupPatrolTasksIntoShifts([
        { taskName: 'Đi tuần - Người 1', assignee: 'Lương Văn Tài', subTask: 'Người 1' },
        { taskName: 'Đi tuần - Người 2', assignee: 'Phạm Hoàng Phúc', subTask: 'Người 2' },
      ]);
      expect(res1).toHaveLength(1);
      expect(res1[0].shiftNumber).toBe(1);
      expect(res1[0].members).toEqual(['Lương Văn Tài', 'Phạm Hoàng Phúc']);

      // 2. Nhóm các ca riêng biệt (Ca 1, Ca 2)
      const res2 = groupPatrolTasksIntoShifts([
        { taskName: 'Đi tuần - Ca 1', assignee: 'Lương Văn Tài', subTask: 'Ca 1' },
        { taskName: 'Đi tuần - Ca 2', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 2' },
      ]);
      expect(res2).toHaveLength(2);
      expect(res2[0].members).toEqual(['Lương Văn Tài']);
      expect(res2[1].members).toEqual(['Phạm Hoàng Phúc']);

      // 3. Nhóm đa ca có nhiều người mỗi ca (Ca 1 - Người 1, Ca 1 - Người 2, Ca 2)
      const res3 = groupPatrolTasksIntoShifts([
        { taskName: 'Đi tuần', assignee: 'A', subTask: 'Ca 1 - Người 1' },
        { taskName: 'Đi tuần', assignee: 'B', subTask: 'Ca 1 - Người 2' },
        { taskName: 'Đi tuần', assignee: 'C', subTask: 'Ca 2' },
      ]);
      expect(res3).toHaveLength(2);
      expect(res3[0].members).toEqual(['A', 'B']);
      expect(res3[1].members).toEqual(['C']);

      // 4. Mảng rỗng
      expect(groupPatrolTasksIntoShifts([])).toEqual([]);
    });
  });

  describe('Two-Site Synchronization & Reporting Workflow', () => {
    it('waits for both sites before sending summary to Platoon Leader', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm3', raw: {} });

      // Step 1: Site 1 submits schedule
      const res1 = await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          chatId: squad1GroupId,
          senderId: squad1LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc' }],
        }
      );

      expect(res1.handled).toBe(true);
      expect(res1.success).toBe(true);
      expect(res1.waitingForOtherSite).toBe(true);
      expect(res1.summarySent).toBe(false);
      // Platoon leader must NOT be contacted yet
      expect(sendSpy).not.toHaveBeenCalledWith(platoonLeaderId, expect.anything());

      // Step 2: Site 2 submits schedule
      const res2 = await handlePatrolCommand(
        {
          text: 'tuantra Hoang Van D',
          chatId: squad2GroupId,
          senderId: squad2LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
        }
      );

      expect(res2.handled).toBe(true);
      expect(res2.success).toBe(true);
      expect(res2.summarySent).toBe(true);

      // Platoon leader receives combined summary
      expect(sendSpy).toHaveBeenCalledWith(platoonLeaderId, expect.any(String));

      // Check message formatting
      const summaryStatus = getPatrolSummaryStatus(formatDateDMY(new Date()), mockDb);
      expect(summaryStatus?.summarySent).toBe(true);
      const content = summaryStatus?.lastContent || '';
      expect(content).toContain('LỊCH TUẦN TRA');
      expect(content).toContain('Trụ sở 1 (Tân Phước Khánh):');
      expect(content).toContain('Nguyễn Văn A, Phạm Hoàng Phúc.');
      expect(content).toContain('Trụ sở 2 (Thạnh Hội):');
      expect(content).toContain('Hoàng Văn D.');
    });

    it('formats summary message properly when Site 2 has no patrol (tuantra 0)', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm4', raw: {} });

      // Site 1 submits
      await handlePatrolCommand(
        {
          text: 'tuantra Nguyen Van A',
          chatId: squad1GroupId,
          senderId: squad1LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
          mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc' }],
        }
      );

      // Site 2 submits tuantra 0
      const res2 = await handlePatrolCommand(
        {
          text: 'tuantra 0',
          chatId: squad2GroupId,
          senderId: squad2LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
        }
      );

      expect(res2.handled).toBe(true);
      expect(res2.isNoPatrol).toBe(true);
      expect(res2.summarySent).toBe(true);

      const summaryStatus = getPatrolSummaryStatus(formatDateDMY(new Date()), mockDb);
      const content = summaryStatus?.lastContent || '';
      expect(content).toContain('Trụ sở 1 (Tân Phước Khánh):');
      expect(content).toContain('Nguyễn Văn A, Phạm Hoàng Phúc.');
      expect(content).toContain('Trụ sở 2 (Thạnh Hội):');
      expect(content).toContain('(Hôm nay không có ca tuần tra)');
    });

    it('deletes old summary message (F4) when a site updates schedule later', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'msg_initial_123', raw: {} });
      const deleteSpy = vi.spyOn(mockZalo, 'deleteMessage').mockResolvedValue(true);

      // Initial submissions for both sites
      await handlePatrolCommand(
        { text: 'tuantra Nguyen Van A', chatId: squad1GroupId, senderId: squad1LeaderId },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true, mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc' }] }
      );
      await handlePatrolCommand(
        { text: 'tuantra Tran Van B', chatId: squad2GroupId, senderId: squad2LeaderId },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true }
      );

      // Site 1 sends update
      await handlePatrolCommand(
        { text: 'tuantra Le Van C', chatId: squad1GroupId, senderId: squad1LeaderId },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true, mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc' }] }
      );

      // Old message should have been deleted
      expect(deleteSpy).toHaveBeenCalledWith(platoonLeaderId, 'msg_initial_123');
    });

    it('Site 2 normalizes names and rejects unknown members using Ban CHQS roster', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_site2_err', raw: {} });

      // 1. Site 2 submits unknown member -> rejects with error
      const resUnknown = await handlePatrolCommand(
        { text: 'tuantra Người Ngoài Ban CHQS', chatId: squad2GroupId, senderId: squad2LeaderId },
        { zaloClient: mockZalo, database: mockDb }
      );
      expect(resUnknown.handled).toBe(true);
      expect(resUnknown.success).toBe(false);
      expect(sendSpy).toHaveBeenCalledWith(squad2GroupId, expect.stringContaining('Không tìm thấy thành viên:'));
      sendSpy.mockClear();

      // 2. Site 2 submits with alias / unaccented name -> normalizes to full official name
      const resValid = await handlePatrolCommand(
        { text: 'tuantra hoang van d', chatId: squad2GroupId, senderId: squad2LeaderId },
        { zaloClient: mockZalo, database: mockDb }
      );
      expect(resValid.handled).toBe(true);
      expect(resValid.success).toBe(true);
      expect(resValid.members).toEqual(['Hoàng Văn D']);
    });
  });

  describe('Independent Reminder Schedules for Site 1 and Site 2', () => {
    it('handles reminders independently according to each site schedule', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm5', raw: {} });

      // 1. At 06:30 -> both sites are due (Site 1: 06:30, Site 2: 06:30)
      const res0630 = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:30',
        zaloClient: mockZalo,
        database: mockDb,
      });
      expect(res0630.triggered).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(squad1LeaderId, expect.stringContaining('Nhắc nhở nộp lịch'));
      expect(sendSpy).toHaveBeenCalledWith(squad2LeaderId, expect.stringContaining('Nhắc nhở nộp lịch'));
      sendSpy.mockClear();

      // 2. Site 1 submits schedule at 06:32
      await handlePatrolCommand(
        { text: 'tuantra Nguyen Van A', chatId: squad1GroupId, senderId: squad1LeaderId },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true, mockMySquadTasks: [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc' }] }
      );

      // 3. At 06:35 -> Site 1 has 06:35 in reminderTimes but already submitted -> skipped. Site 2 does not have 06:35 -> skipped.
      const res0635 = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:35',
        zaloClient: mockZalo,
        database: mockDb,
      });
      expect(res0635.triggered).toBe(false);
      expect(sendSpy).not.toHaveBeenCalled();

      // 4. At 06:45 -> Site 1 does not have 06:45 -> skipped. Site 2 has 06:45 -> reminder #2 sent to Site 2 leader!
      const res0645 = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:45',
        zaloClient: mockZalo,
        database: mockDb,
      });
      expect(res0645.triggered).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(squad2LeaderId, expect.stringContaining('(Lần 2/'));
      expect(sendSpy).not.toHaveBeenCalledWith(squad1LeaderId, expect.anything());
    });
  });

  describe('Site Configs CRUD & Persistence', () => {
    it('persists updated site configs in SQLite', () => {
      const initialConfigs = getPatrolSiteConfigs(mockDb);
      expect(initialConfigs).toHaveLength(2);

      savePatrolSiteConfig(
        {
          siteKey: 'site_2',
          displayName: 'Trụ sở 2 (Thạnh Hội - Mới):',
          reminderTimes: ['06:25', '06:45'],
          maxReminders: 4,
          enabled: true,
        },
        mockDb
      );

      const updated = getPatrolSiteConfig('site_2', mockDb);
      expect(updated).not.toBeNull();
      expect(updated?.displayName).toBe('Trụ sở 2 (Thạnh Hội - Mới):');
      expect(updated?.reminderTimes).toEqual(['06:25', '06:45']);
      expect(updated?.maxReminders).toBe(4);
    });

    it('resets patrol daily status and summary status for testing', () => {
      savePatrolSubmission(
        {
          date: '16/09/2026',
          siteKey: 'site_1',
          groupId: squad1GroupId,
          senderId: squad1LeaderId,
          leaderUserId: squad1LeaderId,
          selectedMembers: ['Nguyễn Văn A'],
        },
        mockDb
      );
      savePatrolSubmission(
        {
          date: '16/09/2026',
          siteKey: 'site_2',
          groupId: squad2GroupId,
          senderId: squad2LeaderId,
          leaderUserId: squad2LeaderId,
          selectedMembers: ['Hoàng Văn B'],
        },
        mockDb
      );

      expect(getPatrolDailyStatus('16/09/2026', 'site_1', mockDb)).not.toBeNull();
      expect(getPatrolDailyStatus('16/09/2026', 'site_2', mockDb)).not.toBeNull();

      // Reset specific site
      const res1 = resetPatrolDailyStatus('16/09/2026', 'site_1', mockDb);
      expect(res1.deletedDaily).toBe(1);
      expect(getPatrolDailyStatus('16/09/2026', 'site_1', mockDb)).toBeNull();
      expect(getPatrolDailyStatus('16/09/2026', 'site_2', mockDb)).not.toBeNull();

      // Reset all sites for date
      const res2 = resetPatrolDailyStatus('16/09/2026', undefined, mockDb);
      expect(res2.deletedDaily).toBe(1);
      expect(getPatrolDailyStatus('16/09/2026', 'site_2', mockDb)).toBeNull();
    });

    it('resolves platoon leader chat ID from SQLite DB recipients table before env variable', () => {
      // 1. When DB has no record for platoon_leader, it falls back to process.env.PLATOON_LEADER_CHAT_ID
      expect(getPlatoonLeaderChatId(mockDb)).toBe(platoonLeaderId);

      // 2. When configured in DB (via Web UI), it takes precedence over env variable
      storeModule.saveRecipient(
        {
          key: 'platoon_leader',
          display_name: 'Trung đội trưởng',
          chat_id: 'chat_id_from_sqlite_ui',
        },
        mockDb
      );

      expect(getPlatoonLeaderChatId(mockDb)).toBe('chat_id_from_sqlite_ui');
    });
  });

  describe('Headquarters 1 reported by two people', () => {
    const secondLeaderId = 'user_leader_squad_1b';

    beforeEach(() => {
      savePatrolSiteConfig(
        {
          siteKey: 'site_1',
          displayName: 'Trụ sở 1 (Tân Phước Khánh):',
          leaderUserId: squad1LeaderId,
          leaderUserId2: secondLeaderId,
          chatId: squad1GroupId,
          mergeWithSheet: true,
          reminderTimes: ['06:30', '06:35', '06:40'],
          maxReminders: 3,
          enabled: true,
        },
        mockDb
      );
    });

    it('keeps headquarters 2 on a single reporter', () => {
      const site2 = getPatrolSiteConfig('site_2', mockDb)!;
      savePatrolSiteConfig({ siteKey: 'site_2', leaderUserId2: 'should_be_ignored' }, mockDb);
      const reloaded = getPatrolSiteConfig('site_2', mockDb)!;
      expect(reloaded.leaderUserId2).toBe('should_be_ignored');
      expect(getSiteReporterIds(reloaded)).toEqual([site2.leaderUserId]);
      expect(getSiteReporterIds(getPatrolSiteConfig('site_1', mockDb)!)).toEqual([
        squad1LeaderId,
        secondLeaderId,
      ]);
    });

    it('waits for both headquarters 1 reporters, merges them with the sheet, then the platoon summary', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_two', raw: {} });
      const today = formatDateDMY(new Date());
      const sheetTasks = [{ taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc' }];

      const first = await handlePatrolCommand(
        { text: 'tuantra Nguyen Van A', chatId: squad1GroupId, senderId: squad1LeaderId, messageId: 'hq1_a' },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true, mockMySquadTasks: sheetTasks }
      );
      expect(first.success).toBe(true);
      expect(first.waitingForOtherReporter).toBe(true);
      expect(first.summarySent).toBe(false);
      expect(getPatrolDailyStatus(today, 'site_1', mockDb)?.submitted).toBeFalsy();
      expect(getPatrolReporterStatus(today, 'site_1', squad1LeaderId, mockDb)?.submitted).toBe(true);
      expect(sendSpy).not.toHaveBeenCalledWith(platoonLeaderId, expect.anything());

      const second = await handlePatrolCommand(
        { text: 'tuantra Tran Van B', chatId: squad1GroupId, senderId: secondLeaderId, messageId: 'hq1_b' },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true, mockMySquadTasks: sheetTasks }
      );
      expect(second.success).toBe(true);
      expect(second.waitingForOtherReporter).toBeFalsy();
      expect(second.waitingForOtherSite).toBe(true);
      expect(second.summarySent).toBe(false);
      expect(second.shifts?.[0].members).toEqual(['Nguyễn Văn A', 'Trần Văn B', 'Phạm Hoàng Phúc']);
      expect(sendSpy).not.toHaveBeenCalledWith(platoonLeaderId, expect.anything());

      const site2 = await handlePatrolCommand(
        { text: 'tuantra Hoang Van D', chatId: squad2GroupId, senderId: squad2LeaderId, messageId: 'hq2' },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true }
      );
      expect(site2.summarySent).toBe(true);
      const content = getPatrolSummaryStatus(today, mockDb)?.lastContent || '';
      expect(content).toContain('Nguyễn Văn A, Trần Văn B, Phạm Hoàng Phúc.');
      expect(content).toContain('Hoàng Văn D.');
      expect(content).toContain('Trụ sở 2 (Thạnh Hội):');
    });

    it('merges multi-shift reports from both people with the sheet by shift', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_multi', raw: {} });

      await handlePatrolCommand(
        {
          text: 'tuantra Ca 1: Nguyen Van A Ca 2: Tran Van B',
          chatId: squad1GroupId,
          senderId: squad1LeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
          mockMySquadTasks: [
            { taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' },
            { taskName: 'Đi tuần', assignee: 'Lê Văn C', subTask: 'Ca 2' },
          ],
        }
      );
      const second = await handlePatrolCommand(
        {
          text: 'tuantra Ca 1: Le Van C Ca 2: Hoang Van D',
          chatId: squad1GroupId,
          senderId: secondLeaderId,
        },
        {
          zaloClient: mockZalo,
          database: mockDb,
          skipSheetFetchForTesting: true,
          mockMySquadTasks: [
            { taskName: 'Đi tuần', assignee: 'Phạm Hoàng Phúc', subTask: 'Ca 1' },
            { taskName: 'Đi tuần', assignee: 'Lê Văn C', subTask: 'Ca 2' },
          ],
        }
      );

      expect(second.success).toBe(true);
      expect(second.shifts?.[0].members).toEqual(['Nguyễn Văn A', 'Lê Văn C', 'Phạm Hoàng Phúc']);
      expect(second.shifts?.[1].members).toEqual(['Trần Văn B', 'Hoàng Văn D', 'Lê Văn C']);
    });

    it('does not send a summary when the two headquarters 1 reports disagree', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_bad', raw: {} });

      await handlePatrolCommand(
        { text: 'tuantra Nguyen Van A', chatId: squad1GroupId, senderId: squad1LeaderId },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true }
      );
      const second = await handlePatrolCommand(
        {
          text: 'tuantra Ca 1: Tran Van B Ca 2: Le Van C',
          chatId: squad1GroupId,
          senderId: secondLeaderId,
        },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true }
      );

      expect(second.success).toBe(false);
      expect(second.error).toContain('không khớp');
      expect(sendSpy).toHaveBeenCalledWith(adminChatId, expect.stringContaining('CẢNH BÁO LỆCH LỊCH'));
      expect(sendSpy).not.toHaveBeenCalledWith(platoonLeaderId, expect.anything());
      expect(getPatrolDailyStatus(formatDateDMY(new Date()), 'site_1', mockDb)?.submitted).toBeFalsy();
    });

    it('reminds only the headquarters 1 reporter who has not submitted', async () => {
      savePatrolSiteConfig({ siteKey: 'site_2', enabled: false }, mockDb);
      const mockZalo = new ZaloClient('dummy_token');
      const sendSpy = vi.spyOn(mockZalo, 'sendMessage').mockResolvedValue({ messageId: 'm_rem', raw: {} });

      const firstSlot = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:30',
        zaloClient: mockZalo,
        database: mockDb,
      });
      expect(firstSlot.triggered).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(squad1LeaderId, expect.stringContaining('Nhắc nhở nộp lịch'));
      expect(sendSpy).toHaveBeenCalledWith(secondLeaderId, expect.stringContaining('Nhắc nhở nộp lịch'));
      sendSpy.mockClear();

      await handlePatrolCommand(
        { text: 'tuantra Nguyen Van A', chatId: squad1GroupId, senderId: squad1LeaderId },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true }
      );

      const secondSlot = await runPatrolReminders(new Date(), {
        overrideTimeHM: '06:35',
        zaloClient: mockZalo,
        database: mockDb,
      });
      expect(secondSlot.triggered).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(secondLeaderId, expect.stringContaining('(Lần 2/'));
      expect(sendSpy).not.toHaveBeenCalledWith(squad1LeaderId, expect.anything());
    });

    it('rejects a third sender for headquarters 1', async () => {
      const mockZalo = new ZaloClient('dummy_token');
      const result = await handlePatrolCommand(
        { text: 'tuantra Nguyen Van A', chatId: squad1GroupId, senderId: 'someone_else' },
        { zaloClient: mockZalo, database: mockDb, skipSheetFetchForTesting: true }
      );
      expect(result.ignoredReason).toBe('unauthorized_sender');
    });

    it('combines two single-shift name lists in reporter order', () => {
      const combined = combineHeadquartersReports([
        { hasPatrol: true, isMultiShift: false, members: ['Nguyễn Văn A'], shifts: [] },
        { hasPatrol: true, isMultiShift: false, members: ['Trần Văn B'], shifts: [] },
      ]);
      expect(combined.ok).toBe(true);
      if (combined.ok) {
        expect(combined.members).toEqual(['Nguyễn Văn A', 'Trần Văn B']);
      }
    });
  });
});
