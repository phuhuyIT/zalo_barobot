import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import { setTaskproofSetting } from '../../src/taskproof/settings';
import { handleTaskproofCommand } from '../../src/taskproof/commands';
import { extractWebhookInbound } from '../../src/taskproof/commands/payload';
import {
  cancelStaleTasks,
  cancelTask,
  closeTaskIfQuotaReached,
  countDistinctSubmitters,
  countLinkedOpenTasks,
  isTaskStale,
  listDueAutoReminders,
  markOverdueTasks,
  shouldKeepWorkerOnline,
} from '../../src/taskproof/lifecycle';
import { replaceMemberCache } from '../../src/taskproof/worker/memberCache';
import { WorkerRuntime } from '../../src/taskproof/worker/runtime';
import { saveSession } from '../../src/taskproof/worker/session';
import { ZcaLoginPort } from '../../src/taskproof/worker/zcaAdapter';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  configureSqliteConnection(db);
  initTables(db);
  initTaskproofTables(db);
  return db;
}

function insertTask(
  db: Database.Database,
  opts: {
    id?: string;
    code?: string;
    zca?: string | null;
    status?: string;
    deadline?: number;
    createdAt?: number;
    remindCount?: number;
    remindedAt?: number | null;
    requiredCount?: number;
  } = {}
): void {
  db.prepare(
    `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
      link, reference_text, required_count, deadline, status, created_at, remind_count, reminded_at)
     VALUES (?, ?, 'off_group', ?, 'rep', 'https://x', 'cap', ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id || 't1',
    opts.code || 'ABC123',
    opts.zca === undefined ? 'zgr-1' : opts.zca,
    opts.requiredCount ?? 1,
    opts.deadline ?? 100,
    opts.status || 'collecting',
    opts.createdAt ?? 0,
    opts.remindCount ?? 0,
    opts.remindedAt ?? null
  );
}

function groupText(text: string, chatId = 'off_group') {
  const inbound = extractWebhookInbound({
    message: {
      text,
      chat: { id: chatId, chat_type: 'GROUP' },
      from: { id: 'manager_1' },
    },
  });
  if (!inbound) throw new Error('expected inbound');
  return inbound;
}

function mockPort(overrides: Partial<ZcaLoginPort> = {}): ZcaLoginPort {
  return {
    login: async () => undefined,
    loginQR: async () => ({ cookie: [], imei: 'i', userAgent: 'ua' }),
    getOwnId: () => 'own-zca',
    logout: () => undefined,
    stopMessageLoop: () => undefined,
    sendGroupMessage: async () => undefined,
    ...overrides,
  };
}

describe('task-proof listen/stop + auto-remind + stale-cancel (Step 8)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function loggedInRuntime(db: Database.Database, port: ZcaLoginPort, now = 5_000): WorkerRuntime {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-life-'));
    dirs.push(dir);
    const sessionPath = path.join(dir, 'zca-session.json');
    saveSession({ cookie: [], imei: 'i', userAgent: 'ua' }, sessionPath);
    return new WorkerRuntime({
      db,
      loginPort: port,
      now: () => now,
      getSessionFilePath: () => sessionPath,
      getAdminChatId: () => 'admin',
      getPublicBaseUrl: () => 'https://example.test',
      scheduleInterval: () => () => undefined,
    });
  }

  describe('shouldKeepWorkerOnline', () => {
    it('stays up for linked open tasks, pending link, or in-flight QR', () => {
      expect(
        shouldKeepWorkerOnline({ linkedOpenCount: 1, pendingLink: false, qrInFlight: false })
      ).toBe(true);
      expect(
        shouldKeepWorkerOnline({ linkedOpenCount: 0, pendingLink: true, qrInFlight: false })
      ).toBe(true);
      expect(
        shouldKeepWorkerOnline({ linkedOpenCount: 0, pendingLink: false, qrInFlight: true })
      ).toBe(true);
    });

    it('does not stay up for unlinked-only work', () => {
      expect(
        shouldKeepWorkerOnline({ linkedOpenCount: 0, pendingLink: false, qrInFlight: false })
      ).toBe(false);
    });
  });

  describe('stale-cancel (/huy path)', () => {
    it('cancels collecting|overdue older than TASK_STALE_AFTER_MS and deletes proofs', () => {
      const db = openDb();
      const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
      dirs.push(proofDir);
      fs.mkdirSync(path.join(proofDir, 'old'));
      fs.writeFileSync(path.join(proofDir, 'old', 'a.jpg'), 'x');
      fs.mkdirSync(path.join(proofDir, 'fresh'));
      fs.writeFileSync(path.join(proofDir, 'fresh', 'b.jpg'), 'y');

      insertTask(db, { id: 'old', code: 'OLD001', createdAt: 0, status: 'collecting' });
      insertTask(db, { id: 'fresh', code: 'NEW001', createdAt: 90, status: 'overdue' });
      insertTask(db, { id: 'done', code: 'DON001', createdAt: 0, status: 'completed' });

      const cancelled = cancelStaleTasks(db, 100, { staleAfterMs: 50, proofDir });
      expect(cancelled.map((row) => row.short_code)).toEqual(['OLD001']);

      const statuses = db
        .prepare(`SELECT id, status FROM tasks ORDER BY id`)
        .all() as Array<{ id: string; status: string }>;
      expect(statuses).toEqual([
        { id: 'done', status: 'completed' },
        { id: 'fresh', status: 'overdue' },
        { id: 'old', status: 'cancelled' },
      ]);
      expect(fs.existsSync(path.join(proofDir, 'old'))).toBe(false);
      expect(fs.existsSync(path.join(proofDir, 'fresh', 'b.jpg'))).toBe(true);
      db.close();
    });

    it('isTaskStale at the exact threshold', () => {
      expect(isTaskStale(0, 7, 7)).toBe(true);
      expect(isTaskStale(1, 7, 7)).toBe(false);
    });

    it('cancelTask does not touch a completed row', () => {
      const db = openDb();
      insertTask(db, { status: 'completed' });
      expect(cancelTask(db, 't1')).toBe(false);
      const row = db.prepare(`SELECT status FROM tasks WHERE id = 't1'`).get() as { status: string };
      expect(row.status).toBe('completed');
      db.close();
    });
  });

  describe('overdue flip + auto-remind selection', () => {
    it('flips collecting past deadline to overdue without closing', () => {
      const db = openDb();
      insertTask(db, { deadline: 50, status: 'collecting' });
      expect(markOverdueTasks(db, 100)).toBe(1);
      const row = db.prepare(`SELECT status FROM tasks WHERE id = 't1'`).get() as { status: string };
      expect(row.status).toBe('overdue');
      db.close();
    });

    it('lists linked tasks that pass shouldAutoRemind', () => {
      const db = openDb();
      insertTask(db, { id: 'due', code: 'DUE001', deadline: 10, remindCount: 0 });
      insertTask(db, {
        id: 'wait',
        code: 'WAI001',
        deadline: 10,
        remindCount: 1,
        remindedAt: 180,
      });
      insertTask(db, { id: 'unlinked', code: 'UNL001', zca: null, deadline: 10 });
      insertTask(db, { id: 'maxed', code: 'MAX001', deadline: 10, remindCount: 3 });

      const due = listDueAutoReminders(db, 200, {
        maxAutoReminders: 3,
        reminderIntervalMs: 50,
      });
      expect(due.map((row) => row.id)).toEqual(['due']);
      db.close();
    });
  });

  describe('worker listen/stop', () => {
    it('logs out when the last linked open task is cancelled', async () => {
      const db = openDb();
      insertTask(db);
      const logout = vi.fn();
      const stopMessageLoop = vi.fn();
      const runtime = loggedInRuntime(
        db,
        mockPort({ logout, stopMessageLoop, startMessageLoop: () => undefined })
      );
      await runtime.ensureListening();
      expect(runtime.isLoggedIn()).toBe(true);
      expect(runtime.status().listening).toBe(true);

      cancelTask(db, 't1');
      expect(countLinkedOpenTasks(db)).toBe(0);
      const stopped = runtime.maybeStopListening();
      expect(stopped).toBe(true);
      expect(runtime.isLoggedIn()).toBe(false);
      expect(runtime.status().listening).toBe(false);
      expect(logout).toHaveBeenCalledOnce();
      expect(stopMessageLoop).toHaveBeenCalledOnce();
      expect(fs.existsSync(path.join(dirs[0], 'zca-session.json'))).toBe(true);
      db.close();
    });

    it('stays online during a pending /lienket window even with no linked tasks', async () => {
      const db = openDb();
      const logout = vi.fn();
      const runtime = loggedInRuntime(db, mockPort({ logout, startMessageLoop: () => undefined }));
      await runtime.ensureListening();
      runtime.linkGroup('off_group');
      expect(runtime.hasPendingLink()).toBe(true);
      expect(runtime.maybeStopListening()).toBe(false);
      expect(runtime.isLoggedIn()).toBe(true);
      expect(logout).not.toHaveBeenCalled();
      db.close();
    });

    it('does not stay online for an unlinked collecting task', async () => {
      const db = openDb();
      insertTask(db, { zca: null });
      const logout = vi.fn();
      const runtime = loggedInRuntime(db, mockPort({ logout, startMessageLoop: () => undefined }));
      await runtime.ensureListening();
      expect(runtime.countOpenLinkedTasks()).toBe(0);
      expect(runtime.maybeStopListening()).toBe(true);
      expect(runtime.isLoggedIn()).toBe(false);
      expect(logout).toHaveBeenCalledOnce();
      db.close();
    });

    it('deadline tick logs out after the last linked task disappears', async () => {
      const db = openDb();
      insertTask(db, { deadline: 9_999 });
      const logout = vi.fn();
      const runtime = loggedInRuntime(db, mockPort({ logout, startMessageLoop: () => undefined }));
      await runtime.ensureListening();
      cancelTask(db, 't1');
      await runtime.runDeadlineTick();
      expect(runtime.isLoggedIn()).toBe(false);
      expect(logout).toHaveBeenCalled();
      db.close();
    });
  });

  describe('automatic reminder timer', () => {
    it('sends one auto-remind after deadline and does not refresh a populated cache', async () => {
      const db = openDb();
      insertTask(db, { deadline: 100, status: 'collecting' });
      replaceMemberCache(db, 'zgr-1', [{ user_id: 'u1', display_name: 'An' }], 1);
      setTaskproofSetting('max_auto_reminders', 3, db);
      setTaskproofSetting('reminder_interval_ms', 50, db);

      const getGroupInfo = vi.fn();
      const sent: Array<{ msg: string; mentions?: unknown }> = [];
      const runtime = loggedInRuntime(
        db,
        mockPort({
          startMessageLoop: () => undefined,
          getGroupInfo,
          sendGroupMessage: async (_threadId, content) => {
            sent.push({ msg: content.msg, mentions: content.mentions });
          },
        }),
        200
      );
      await runtime.ensureListening();
      await runtime.runDeadlineTick();

      const row = db.prepare(`SELECT status, remind_count FROM tasks WHERE id = 't1'`).get() as {
        status: string;
        remind_count: number;
      };
      expect(row.status).toBe('overdue');
      expect(row.remind_count).toBe(1);
      expect(getGroupInfo).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(sent[0].mentions).toEqual([{ pos: 0, len: '@An'.length, uid: 'u1' }]);
      expect(runtime.isLoggedIn()).toBe(true);
      db.close();
    });

    it('does not auto-remind before the interval or after max_auto_reminders', async () => {
      const db = openDb();
      insertTask(db, { deadline: 100, remindCount: 1, remindedAt: 180 });
      replaceMemberCache(db, 'zgr-1', [{ user_id: 'u1', display_name: 'An' }], 1);
      setTaskproofSetting('reminder_interval_ms', 50, db);
      const sendGroupMessage = vi.fn();
      const runtime = loggedInRuntime(
        db,
        mockPort({ startMessageLoop: () => undefined, sendGroupMessage }),
        200
      );
      await runtime.ensureListening();
      await runtime.runDeadlineTick();
      expect(sendGroupMessage).not.toHaveBeenCalled();

      db.prepare(`UPDATE tasks SET remind_count = 3, reminded_at = NULL WHERE id = 't1'`).run();
      await runtime.runDeadlineTick();
      expect(sendGroupMessage).not.toHaveBeenCalled();
      db.close();
    });

    it('continues the batch when one task send fails', async () => {
      const db = openDb();
      insertTask(db, { id: 't1', code: 'AAA111', deadline: 10 });
      insertTask(db, { id: 't2', code: 'BBB222', deadline: 10 });
      replaceMemberCache(db, 'zgr-1', [{ user_id: 'u1', display_name: 'An' }], 1);
      const sent: string[] = [];
      const runtime = loggedInRuntime(
        db,
        mockPort({
          startMessageLoop: () => undefined,
          sendGroupMessage: async (_threadId, content) => {
            if (content.msg.includes('AAA111')) throw new Error('send failed');
            sent.push(content.msg);
          },
        }),
        200
      );
      await runtime.ensureListening();
      await runtime.runDeadlineTick();
      expect(sent.some((msg) => msg.includes('BBB222'))).toBe(true);
      const counts = db
        .prepare(`SELECT id, remind_count FROM tasks ORDER BY id`)
        .all() as Array<{ id: string; remind_count: number }>;
      expect(counts).toEqual([
        { id: 't1', remind_count: 0 },
        { id: 't2', remind_count: 1 },
      ]);
      db.close();
    });
  });

  describe('quota close', () => {
    it('closes collecting|overdue when distinct uid_from reaches required_count', () => {
      const db = openDb();
      insertTask(db, { requiredCount: 2, status: 'overdue' });
      expect(closeTaskIfQuotaReached(db, 't1')).toBe(false);

      db.prepare(
        `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, match_score, created_at)
         VALUES ('s1', 't1', 'u1', 'A', 'https://img', 0.9, 1)`
      ).run();
      expect(countDistinctSubmitters(db, 't1')).toBe(1);
      expect(closeTaskIfQuotaReached(db, 't1')).toBe(false);

      db.prepare(
        `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, match_score, created_at)
         VALUES ('s2', 't1', 'u2', 'B', 'https://img', 0.8, 2)`
      ).run();
      expect(closeTaskIfQuotaReached(db, 't1')).toBe(true);
      const row = db.prepare(`SELECT status FROM tasks WHERE id = 't1'`).get() as { status: string };
      expect(row.status).toBe('completed');
      db.close();
    });

    it('does not close cancelled tasks', () => {
      const db = openDb();
      insertTask(db, { status: 'cancelled', requiredCount: 1 });
      db.prepare(
        `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, match_score, created_at)
         VALUES ('s1', 't1', 'u1', 'A', 'https://img', 1, 1)`
      ).run();
      expect(closeTaskIfQuotaReached(db, 't1')).toBe(false);
      expect(countDistinctSubmitters(db, 't1')).toBe(1);
      const row = db.prepare(`SELECT status FROM tasks WHERE id = 't1'`).get() as { status: string };
      expect(row.status).toBe('cancelled');
      db.close();
    });
  });

  describe('official bot /huy', () => {
    it('cancels by exact short_code and does not report', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const doCancel = vi.fn().mockReturnValue(true);
      const handled = await handleTaskproofCommand(groupText('/huy abc123'), {
        sendMessage,
        lookupTask: (code) =>
          code === 'ABC123'
            ? { id: 'task-1', short_code: 'ABC123', status: 'collecting', zca_group_id: 'zgr-1' }
            : null,
        cancelTask: doCancel,
      });
      expect(handled).toBe(true);
      expect(doCancel).toHaveBeenCalledWith('task-1');
      expect(sendMessage.mock.calls[0][1]).toMatch(/Đã hủy task ABC123/);
      expect(sendMessage.mock.calls[0][1]).toMatch(/Không gửi báo cáo/);
    });

    it('does not cancel a missing or UUID-like code', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const doCancel = vi.fn();
      await handleTaskproofCommand(groupText('/huy ABC123'), {
        sendMessage,
        lookupTask: () => null,
        cancelTask: doCancel,
      });
      expect(doCancel).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toMatch(/Không tìm thấy mã ABC123/);

      sendMessage.mockClear();
      await handleTaskproofCommand(groupText('/huy a1b2c3d4-e5f6-7890-abcd-ef1234567890'), {
        sendMessage,
        cancelTask: doCancel,
      });
      expect(doCancel).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toMatch(/UUID/i);
    });

    it('does not swallow /gui', async () => {
      const sendMessage = vi.fn();
      const handled = await handleTaskproofCommand(groupText('/gui'), { sendMessage });
      expect(handled).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
