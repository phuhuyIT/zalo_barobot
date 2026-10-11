import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/records/store';
import { getTaskproofSetting, setTaskproofSetting } from '../../src/taskproof/records/settings';
import { handleTaskproofCommand } from '../../src/taskproof/commands';
import { extractWebhookInbound } from '../../src/taskproof/commands/payload';
import { WorkerRuntime } from '../../src/taskproof/worker/runtime';
import { saveSession } from '../../src/taskproof/worker/session';
import {
  isMemberCacheStale,
  listCachedMembers,
  observeMember,
  refreshMemberCache,
  replaceMemberCache,
} from '../../src/taskproof/worker/memberCache';
import {
  ALL_MENTION_UID,
  collectExcludeUids,
  computeMissing,
  planReminder,
  shouldAutoRemind,
} from '../../src/taskproof/worker/reminders';
import { ZcaGroupInfoSnapshot, ZcaLoginPort } from '../../src/taskproof/worker/zcaAdapter';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  configureSqliteConnection(db);
  initTables(db);
  initTaskproofTables(db);
  return db;
}

function inboundFrom(body: unknown) {
  const inbound = extractWebhookInbound(body);
  if (!inbound) throw new Error('expected inbound');
  return inbound;
}

const ADMIN = 'admin_dm';

function adminText(text: string) {
  const inbound = extractWebhookInbound({
    message: {
      text,
      chat: { id: ADMIN, chat_type: 'PRIVATE' },
      from: { id: ADMIN },
    },
  });
  if (!inbound) throw new Error('expected inbound');
  return inbound;
}

function groupText(text: string, chatId = 'off_group') {
  return inboundFrom({
    message: {
      text,
      chat: { id: chatId, chat_type: 'GROUP' },
      from: { id: 'manager_1' },
    },
  });
}

function insertOpenTask(
  db: Database.Database,
  opts: { id?: string; code?: string; zca?: string | null; status?: string } = {}
): void {
  db.prepare(
    `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
      link, reference_text, required_count, deadline, status, created_at)
     VALUES (?, ?, 'off_group', ?, 'rep', 'https://x', 'cap', 3, 0, ?, 0)`
  ).run(opts.id || 't1', opts.code || 'ABC123', opts.zca === undefined ? 'zgr-1' : opts.zca, opts.status || 'collecting');
}

function groupInfo(partial: Partial<ZcaGroupInfoSnapshot> & { memberIds: string[] }): ZcaGroupInfoSnapshot {
  return {
    groupId: 'zgr-1',
    name: 'Nhóm NV',
    currentMems: partial.memberIds.map((id) => ({ id, dName: `Name-${id}` })),
    totalMember: partial.memberIds.length,
    hasMoreMember: false,
    memVerList: [],
    adminIds: [],
    creatorId: '',
    lockViewMember: false,
    ...partial,
  };
}

function mockPort(overrides: Partial<ZcaLoginPort> = {}): ZcaLoginPort {
  return {
    login: async () => undefined,
    loginQR: async () => ({ cookie: [], imei: 'i', userAgent: 'ua' }),
    getOwnId: () => 'own-zca',
    getGroupInfo: async () => groupInfo({ memberIds: ['u1', 'u2', 'u3'] }),
    getGroupMembersInfo: async (ids) => ids.map((id) => ({ id, displayName: `Name-${id}` })),
    sendGroupMessage: async () => undefined,
    ...overrides,
  };
}

describe('task-proof reminders (Step 7)', () => {
  describe('planReminder', () => {
    it('sends nothing when nobody is missing', () => {
      const plan = planReminder({
        missing: [],
        shortCode: 'ABC123',
        maxMentions: 8,
        maxTextLen: 1500,
        cacheAvailable: true,
      });
      expect(plan.kind).toBe('none');
      expect(plan.msg).toBe('');
    });

    it('mentions each uid when the list fits in one message', () => {
      const plan = planReminder({
        missing: [
          { user_id: 'u1', display_name: 'An' },
          { user_id: 'u2', display_name: 'Bình' },
        ],
        shortCode: 'ABC123',
        maxMentions: 8,
        maxTextLen: 1500,
        cacheAvailable: true,
      });
      expect(plan.kind).toBe('mentions');
      expect(plan.missingCount).toBe(2);
      expect(plan.mentions).toHaveLength(2);
      expect(plan.mentions[0]).toMatchObject({ pos: 0, uid: 'u1', len: '@An'.length });
      expect(plan.mentions[1].uid).toBe('u2');
      expect(plan.mentions[1].pos).toBe('@An '.length);
      expect(plan.msg.startsWith('@An @Bình')).toBe(true);
      expect(plan.msg).toMatch(/ABC123/);
      expect(plan.msg).not.toMatch(/👉/); // no link when not provided
    });

    it('appends the post link to mention messages when provided', () => {
      const plan = planReminder({
        missing: [
          { user_id: 'u1', display_name: 'An' },
        ],
        shortCode: 'ABC123',
        maxMentions: 8,
        maxTextLen: 1500,
        cacheAvailable: true,
        link: 'https://facebook.com/post/123',
      });
      expect(plan.kind).toBe('mentions');
      expect(plan.msg).toContain('chưa nộp minh chứng cho bài viết https://facebook.com/post/123');
    });

    it('uses one @all (uid -1) when there are too many missing people', () => {
      const missing = Array.from({ length: 9 }, (_, i) => ({
        user_id: `u${i}`,
        display_name: `N${i}`,
      }));
      const plan = planReminder({
        missing,
        shortCode: 'ABC123',
        maxMentions: 8,
        maxTextLen: 1500,
        cacheAvailable: true,
      });
      expect(plan.kind).toBe('all');
      expect(plan.mentions).toEqual([{ pos: 0, len: 4, uid: ALL_MENTION_UID }]);
      expect(plan.msg).toMatch(/^@all /);
      expect(plan.msg).toMatch(/Còn 9 người/);
    });

    it('appends the post link to @all messages when provided', () => {
      const missing = Array.from({ length: 9 }, (_, i) => ({
        user_id: `u${i}`,
        display_name: `N${i}`,
      }));
      const plan = planReminder({
        missing,
        shortCode: 'ABC123',
        maxMentions: 8,
        maxTextLen: 1500,
        cacheAvailable: true,
        link: 'https://facebook.com/post/456',
      });
      expect(plan.kind).toBe('all');
      expect(plan.msg).toContain('chưa nộp minh chứng cho bài viết https://facebook.com/post/456');
    });

    it('uses @all when rendered text is over MAX_REMINDER_TEXT_LEN', () => {
      const missing = [
        { user_id: 'u1', display_name: 'A'.repeat(80) },
        { user_id: 'u2', display_name: 'B'.repeat(80) },
      ];
      const plan = planReminder({
        missing,
        shortCode: 'ABC123',
        maxMentions: 8,
        maxTextLen: 100,
        cacheAvailable: true,
      });
      expect(plan.kind).toBe('all');
      expect(plan.mentions[0].uid).toBe(ALL_MENTION_UID);
    });

    it('sends a generic group message with no mentions when cache is empty', () => {
      const plan = planReminder({
        missing: [],
        shortCode: 'ABC123',
        maxMentions: 8,
        maxTextLen: 1500,
        cacheAvailable: false,
      });
      expect(plan.kind).toBe('generic');
      expect(plan.mentions).toEqual([]);
      expect(plan.msg).toMatch(/ABC123/);
    });

    it('appends the post link to generic messages when provided', () => {
      const plan = planReminder({
        missing: [],
        shortCode: 'ABC123',
        maxMentions: 8,
        maxTextLen: 1500,
        cacheAvailable: false,
        link: 'https://facebook.com/post/789',
      });
      expect(plan.kind).toBe('generic');
      expect(plan.msg).toContain('cho bài viết https://facebook.com/post/789');
    });
  });

  describe('missing set', () => {
    it('subtracts submissions and exclude uids (bot + zca own + list)', () => {
      const exclude = collectExcludeUids({
        officialBotUid: 'bot',
        zcaOwnUid: 'own-setting',
        liveOwnId: 'own-live',
        extra: ['skip-me'],
      });
      const missing = computeMissing(
        [
          { user_id: 'u1', display_name: 'A' },
          { user_id: 'u2', display_name: 'B' },
          { user_id: 'bot', display_name: 'Bot' },
          { user_id: 'own-live', display_name: 'Me' },
          { user_id: 'skip-me', display_name: 'Skip' },
        ],
        ['u2'],
        exclude
      );
      expect(missing.map((m) => m.user_id)).toEqual(['u1']);
    });

    it('treats a stripped submission uid as the same member', () => {
      const missing = computeMissing(
        [{ user_id: '123_0', display_name: 'Admin' }],
        ['123'],
        new Set()
      );
      expect(missing).toEqual([]);
    });
  });

  describe('shouldAutoRemind', () => {
    const base = {
      status: 'overdue',
      deadline: 100,
      remindCount: 0,
      remindedAt: null as number | null,
      now: 200,
      maxAutoReminders: 3,
      reminderIntervalMs: 50,
    };
    it('fires after deadline within max count', () => {
      expect(shouldAutoRemind(base)).toBe(true);
    });
    it('does not fire before deadline or after max reminders', () => {
      expect(shouldAutoRemind({ ...base, now: 100 })).toBe(false);
      expect(shouldAutoRemind({ ...base, remindCount: 3 })).toBe(false);
      expect(shouldAutoRemind({ ...base, remindedAt: 180, now: 200 })).toBe(false);
      expect(shouldAutoRemind({ ...base, status: 'completed' })).toBe(false);
    });
  });

  describe('member cache', () => {
    it('uses memVerList when memberIds is empty', async () => {
      const db = openDb();
      const result = await refreshMemberCache({
        db,
        port: mockPort({
          getGroupInfo: async () =>
            groupInfo({
              memberIds: [],
              memVerList: ['u1_0', 'u2_3'],
              currentMems: [],
              totalMember: 2,
            }),
          getGroupMembersInfo: async () => [
            { id: 'u1', displayName: 'An' },
            { id: 'u2', displayName: 'Binh' },
          ],
        }),
        zcaGroupId: 'zgr-1',
        now: 1000,
        forceRefresh: true,
      });
      expect(result.ok).toBe(true);
      expect(listCachedMembers(db, 'zgr-1').map((m) => m.user_id).sort()).toEqual(['u1', 'u2']);
      db.close();
    });

    it('does not replace cache with only the logged-in account', async () => {
      const db = openDb();
      replaceMemberCache(db, 'zgr-1', [{ user_id: 'u1', display_name: 'An' }], 1);
      const result = await refreshMemberCache({
        db,
        port: mockPort({
          getOwnId: () => 'own-zca',
          getGroupInfo: async () =>
            groupInfo({
              memberIds: ['own-zca'],
              totalMember: 9,
              lockViewMember: true,
            }),
        }),
        zcaGroupId: 'zgr-1',
        now: 2000,
        forceRefresh: true,
      });
      expect(result.usedStale).toBe(true);
      expect(listCachedMembers(db, 'zgr-1')[0].user_id).toBe('u1');
      db.close();
    });

    it('uses memberIds, falls back to currentMems, upserts displayName', async () => {
      const db = openDb();
      const port = mockPort({
        getGroupInfo: async () =>
          groupInfo({
            memberIds: ['u1', 'u2'],
            currentMems: [
              { id: 'u1', dName: 'FromCurrent' },
              { id: 'u2', dName: 'B' },
            ],
          }),
        getGroupMembersInfo: async () => [{ id: 'u1', displayName: 'An' }],
      });
      const result = await refreshMemberCache({
        db,
        port,
        zcaGroupId: 'zgr-1',
        now: 1000,
        forceRefresh: true,
      });
      expect(result.ok).toBe(true);
      expect(listCachedMembers(db, 'zgr-1')).toEqual([
        { user_id: 'u1', display_name: 'An' },
        { user_id: 'u2', display_name: 'B' },
      ]);
      db.close();
    });

    it('keeps stale cache when getGroupInfo fails', async () => {
      const db = openDb();
      replaceMemberCache(db, 'zgr-1', [{ user_id: 'old', display_name: 'Old' }], 1);
      const result = await refreshMemberCache({
        db,
        port: mockPort({
          getGroupInfo: async () => {
            throw new Error('network');
          },
        }),
        zcaGroupId: 'zgr-1',
        now: 9_000_000,
        forceRefresh: true,
      });
      expect(result.usedStale).toBe(true);
      expect(listCachedMembers(db, 'zgr-1')[0].user_id).toBe('old');
      db.close();
    });

    it('warns when hasMoreMember or ids < totalMember', async () => {
      const db = openDb();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = await refreshMemberCache({
        db,
        port: mockPort({
          getGroupInfo: async () =>
            groupInfo({
              memberIds: ['u1'],
              totalMember: 9,
              hasMoreMember: true,
            }),
        }),
        zcaGroupId: 'zgr-1',
        now: 1,
        forceRefresh: true,
      });
      expect(result.warning).toMatch(/incomplete/);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      db.close();
    });

    it('observeMember upserts a speaker without wiping the cache', () => {
      const db = openDb();
      replaceMemberCache(db, 'zgr-1', [{ user_id: 'u1', display_name: 'An' }], 1);
      observeMember(db, 'zgr-1', 'u2_0', 'Binh', 2);
      expect(listCachedMembers(db, 'zgr-1').map((m) => m.user_id).sort()).toEqual(['u1', 'u2']);
      db.close();
    });

    it('is stale when empty or older than MEMBER_CACHE_MAX_AGE_MS', () => {
      const db = openDb();
      expect(isMemberCacheStale(db, 'zgr-1', 100, 50)).toBe(true);
      replaceMemberCache(db, 'zgr-1', [{ user_id: 'u1', display_name: 'A' }], 80);
      expect(isMemberCacheStale(db, 'zgr-1', 100, 50)).toBe(false);
      expect(isMemberCacheStale(db, 'zgr-1', 200, 50)).toBe(true);
      db.close();
    });
  });

  describe('WorkerRuntime.remind', () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
      dirs.length = 0;
    });

    function loggedInRuntime(db: Database.Database, port: ZcaLoginPort): WorkerRuntime {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-remind-'));
      dirs.push(dir);
      const sessionPath = path.join(dir, 'zca-session.json');
      saveSession({ cookie: [], imei: 'i', userAgent: 'ua' }, sessionPath);
      return new WorkerRuntime({
        db,
        loginPort: port,
        now: () => 5_000,
        getSessionFilePath: () => sessionPath,
        getAdminChatId: () => 'admin',
        getPublicBaseUrl: () => 'https://example.test',
      });
    }

    it('refreshes cache, mentions missing members, increments remind_count', async () => {
      const db = openDb();
      insertOpenTask(db);
      db.prepare(
        `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, match_score, created_at)
         VALUES ('s1', 't1', 'u2', 'B', 'https://img', 0.9, 0)`
      ).run();
      setTaskproofSetting('official_bot_uid', 'u3', db);
      setTaskproofSetting('max_mentions_per_message', 8, db);

      const sent: Array<{ threadId: string; msg: string; mentions?: unknown }> = [];
      const getGroupInfo = vi.fn(async () => groupInfo({ memberIds: ['u1', 'u2', 'u3'] }));
      const runtime = loggedInRuntime(
        db,
        mockPort({
          getGroupInfo,
          sendGroupMessage: async (threadId, content) => {
            sent.push({ threadId, msg: content.msg, mentions: content.mentions });
          },
        })
      );

      const result = await runtime.remind('t1');
      expect(result).toMatchObject({ httpStatus: 200, reminded: true, kind: 'mentions', missing_count: 1 });
      expect(getGroupInfo).toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(sent[0].threadId).toBe('zgr-1');
      expect(sent[0].mentions).toEqual([{ pos: 0, len: '@Name-u1'.length, uid: 'u1' }]);
      const row = db.prepare(`SELECT remind_count FROM tasks WHERE id = 't1'`).get() as { remind_count: number };
      expect(row.remind_count).toBe(1);
      db.close();
    });

    it('drops the zca account and the OA bot when official_bot_uid is not a member id', async () => {
      const db = openDb();
      insertOpenTask(db);
      setTaskproofSetting('official_bot_uid', '1789269039087327867:session-token', db);
      setTaskproofSetting('zca_own_uid', 'c9ee54a3b3eb5ab503fa', db);
      setTaskproofSetting('max_mentions_per_message', 8, db);

      const sent: Array<{ mentions?: Array<{ uid: string }> }> = [];
      const runtime = loggedInRuntime(
        db,
        mockPort({
          getOwnId: () => 'own-zca',
          getGroupInfo: async () =>
            groupInfo({
              memberIds: ['u1', 'own-zca', 'bot1'],
              currentMems: [
                { id: 'u1', dName: 'An', accountType: 0 },
                { id: 'own-zca', dName: 'Baro', accountType: 0 },
                { id: 'bot1', dName: 'Bot Trùm a2', accountType: 1 },
              ],
            }),
          sendGroupMessage: async (_threadId, content) => {
            sent.push({ mentions: content.mentions });
          },
        })
      );

      const result = await runtime.remind('t1');
      expect(result).toMatchObject({ httpStatus: 200, reminded: true, kind: 'mentions', missing_count: 1 });
      expect(sent[0].mentions).toEqual([{ pos: 0, len: '@Name-u1'.length, uid: 'u1' }]);
      expect(getTaskproofSetting('official_bot_uid', db)).toBe('bot1');
      db.close();
    });

    it('sends one @all when missing exceeds max_mentions_per_message', async () => {
      const db = openDb();
      insertOpenTask(db);
      setTaskproofSetting('max_mentions_per_message', 2, db);
      const ids = ['u1', 'u2', 'u3'];
      const sent: Array<{ mentions?: Array<{ uid: string }> }> = [];
      const runtime = loggedInRuntime(
        db,
        mockPort({
          getGroupInfo: async () => groupInfo({ memberIds: ids }),
          sendGroupMessage: async (_threadId, content) => {
            sent.push({ mentions: content.mentions });
          },
        })
      );
      const result = await runtime.remind('t1');
      expect(result.kind).toBe('all');
      expect(result.missing_count).toBe(3);
      expect(sent[0].mentions).toEqual([{ pos: 0, len: 4, uid: ALL_MENTION_UID }]);
      db.close();
    });

    it('treats a cache of only excluded uids as unavailable (generic, not "no one missing")', async () => {
      const db = openDb();
      insertOpenTask(db);
      replaceMemberCache(db, 'zgr-1', [{ user_id: 'own-zca', display_name: 'Bot' }], 1);
      const sent: Array<{ msg: string; mentions?: unknown }> = [];
      const runtime = loggedInRuntime(
        db,
        mockPort({
          getOwnId: () => 'own-zca',
          getGroupInfo: async () =>
            groupInfo({
              memberIds: ['own-zca'],
              totalMember: 5,
              lockViewMember: true,
            }),
          sendGroupMessage: async (_threadId, content) => {
            sent.push({ msg: content.msg, mentions: content.mentions });
          },
        })
      );
      const result = await runtime.remind('t1');
      expect(result).toMatchObject({ httpStatus: 200, reminded: true, kind: 'generic' });
      expect(sent[0].mentions).toBeUndefined();
      expect(sent[0].msg).toMatch(/không lấy được danh sách/i);
      db.close();
    });

    it('sends a generic message when member metadata cannot be retrieved', async () => {
      const db = openDb();
      insertOpenTask(db);
      const sent: Array<{ msg: string; mentions?: unknown }> = [];
      const runtime = loggedInRuntime(
        db,
        mockPort({
          getGroupInfo: async () => null,
          sendGroupMessage: async (_threadId, content) => {
            sent.push({ msg: content.msg, mentions: content.mentions });
          },
        })
      );
      const result = await runtime.remind('t1');
      expect(result).toMatchObject({ httpStatus: 200, reminded: true, kind: 'generic' });
      expect(sent[0].mentions).toBeUndefined();
      expect(sent[0].msg).toMatch(/bài viết https:\/\/x/);
      db.close();
    });

    it('does not send when the group is unlinked', async () => {
      const db = openDb();
      insertOpenTask(db, { zca: null });
      const sendGroupMessage = vi.fn();
      const runtime = loggedInRuntime(db, mockPort({ sendGroupMessage }));
      const result = await runtime.remind('t1');
      expect(result).toMatchObject({ httpStatus: 409, reminded: false, error: 'unlinked' });
      expect(sendGroupMessage).not.toHaveBeenCalled();
      db.close();
    });

    it('sends nothing when everyone already submitted', async () => {
      const db = openDb();
      insertOpenTask(db);
      for (const uid of ['u1', 'u2', 'u3']) {
        db.prepare(
          `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, match_score, created_at)
           VALUES (?, 't1', ?, 'n', 'https://img', 0.9, 0)`
        ).run(`s-${uid}`, uid);
      }
      const sendGroupMessage = vi.fn();
      const runtime = loggedInRuntime(
        db,
        mockPort({
          getGroupInfo: async () => groupInfo({ memberIds: ['u1', 'u2', 'u3'] }),
          sendGroupMessage,
        })
      );
      const result = await runtime.remind('t1');
      expect(result).toMatchObject({ reminded: false, kind: 'none', missing_count: 0 });
      expect(sendGroupMessage).not.toHaveBeenCalled();
      db.close();
    });
  });

  describe('official bot /nhac', () => {
    it('resolves exact short_code then ensure-listening then remind', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const ensureListening = vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} });
      const remind = vi.fn().mockResolvedValue({
        status: 200,
        json: { reminded: true, kind: 'mentions', missing_count: 2 },
      });
      const handled = await handleTaskproofCommand(adminText('/nhac abc123'), {
        sendMessage,
        getAdminChatId: () => ADMIN,
        ensureListening,
        remind,
        lookupTask: (code) =>
          code === 'ABC123'
            ? { id: 'task-1', short_code: 'ABC123', status: 'collecting', zca_group_id: 'zgr-1' }
            : null,
      });
      expect(handled).toBe(true);
      expect(ensureListening).toHaveBeenCalledOnce();
      expect(remind).toHaveBeenCalledWith('task-1');
      expect(sendMessage.mock.calls[0][1]).toMatch(/Đã nhắc 2 người/);
    });

    it('does not call worker for a missing or UUID-like code', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const remind = vi.fn();
      await handleTaskproofCommand(adminText('/nhac ABC123'), {
        sendMessage,
        getAdminChatId: () => ADMIN,
        remind,
        lookupTask: () => null,
      });
      expect(remind).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toMatch(/Không tìm thấy mã ABC123/);

      sendMessage.mockClear();
      const uuidHandled = await handleTaskproofCommand(
        adminText('/nhac a1b2c3d4-e5f6-7890-abcd-ef1234567890'),
        { sendMessage, remind, getAdminChatId: () => ADMIN }
      );
      expect(uuidHandled).toBe(true);
      expect(remind).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toMatch(/UUID/i);
    });

    it('asks for /lienket when the task has no zca_group_id', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const remind = vi.fn();
      await handleTaskproofCommand(adminText('/nhac ABC123'), {
        sendMessage,
        getAdminChatId: () => ADMIN,
        remind,
        lookupTask: () => ({
          id: 't1',
          short_code: 'ABC123',
          status: 'collecting',
          zca_group_id: null,
        }),
      });
      expect(remind).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toMatch(/lienket/i);
    });

    it('does not swallow /gui', async () => {
      const sendMessage = vi.fn();
      const handled = await handleTaskproofCommand(groupText('/gui'), { sendMessage });
      expect(handled).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('does not fail silently when the worker is down', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      await handleTaskproofCommand(adminText('/nhac ABC123'), {
        sendMessage,
        getAdminChatId: () => ADMIN,
        ensureListening: async () => {
          throw new Error('ECONNREFUSED');
        },
        lookupTask: () => ({
          id: 't1',
          short_code: 'ABC123',
          status: 'collecting',
          zca_group_id: 'zgr-1',
        }),
      });
      expect(sendMessage.mock.calls[0][1]).toMatch(/Worker không chạy/);
      expect(sendMessage.mock.calls[0][1]).toMatch(/\/gui/);
    });
  });
});
