import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import {
  formatWorkerDownOpenTasksMessage,
  notifyIfWorkerDownWithOpenTasks,
} from '../../src/taskproof/health';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  configureSqliteConnection(db);
  initTables(db);
  initTaskproofTables(db);
  return db;
}

describe('worker health notify (Step 11)', () => {
  it('notifies admin when the worker is down and linked open tasks exist', async () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at, remind_count)
       VALUES ('t1', 'OPN001', 'off', 'zca-1', 'rep', 'https://x', 'c', 1, 1, 'collecting', 1, 0)`
    ).run();

    const sendMessage = vi.fn().mockResolvedValue({});
    const result = await notifyIfWorkerDownWithOpenTasks(db, {
      probe: async () => false,
      sendMessage,
      getAdminChatId: () => 'admin_1',
      now: () => 1000,
      throttleMs: 60_000,
      lastNotifiedAt: { value: 0 },
    });

    expect(result.notified).toBe(true);
    expect(result.openCount).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith('admin_1', expect.stringContaining('/gui không bị ảnh hưởng'));
    expect(sendMessage.mock.calls[0][1]).toContain('1 task liên kết');
    db.close();
  });

  it('does not notify when there are no linked open tasks', async () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at, remind_count)
       VALUES ('t1', 'UNL001', 'off', NULL, 'rep', 'https://x', 'c', 1, 1, 'collecting', 1, 0)`
    ).run();
    const sendMessage = vi.fn();
    const result = await notifyIfWorkerDownWithOpenTasks(db, {
      probe: async () => false,
      sendMessage,
      getAdminChatId: () => 'admin_1',
    });
    expect(result.notified).toBe(false);
    expect(result.reason).toBe('no_linked_open_tasks');
    expect(sendMessage).not.toHaveBeenCalled();
    db.close();
  });

  it('does not notify when the worker is up', async () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at, remind_count)
       VALUES ('t1', 'OPN001', 'off', 'zca-1', 'rep', 'https://x', 'c', 1, 1, 'overdue', 1, 0)`
    ).run();
    const sendMessage = vi.fn();
    const result = await notifyIfWorkerDownWithOpenTasks(db, {
      probe: async () => true,
      sendMessage,
      getAdminChatId: () => 'admin_1',
    });
    expect(result.notified).toBe(false);
    expect(result.reason).toBe('worker_up');
    expect(sendMessage).not.toHaveBeenCalled();
    db.close();
  });

  it('throttles repeat alerts', async () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at, remind_count)
       VALUES ('t1', 'OPN001', 'off', 'zca-1', 'rep', 'https://x', 'c', 1, 1, 'collecting', 1, 0)`
    ).run();
    const sendMessage = vi.fn().mockResolvedValue({});
    const stamp = { value: 0 };
    const first = await notifyIfWorkerDownWithOpenTasks(db, {
      probe: async () => false,
      sendMessage,
      getAdminChatId: () => 'admin_1',
      now: () => 10_000,
      throttleMs: 60_000,
      lastNotifiedAt: stamp,
    });
    const second = await notifyIfWorkerDownWithOpenTasks(db, {
      probe: async () => false,
      sendMessage,
      getAdminChatId: () => 'admin_1',
      now: () => 20_000,
      throttleMs: 60_000,
      lastNotifiedAt: stamp,
    });
    expect(first.notified).toBe(true);
    expect(second.notified).toBe(false);
    expect(second.reason).toBe('throttled');
    expect(sendMessage).toHaveBeenCalledOnce();
    db.close();
  });

  it('mentions /gui still works in the alert text', () => {
    expect(formatWorkerDownOpenTasksMessage(3)).toContain('/gui không bị ảnh hưởng');
    expect(formatWorkerDownOpenTasksMessage(3)).toContain('3');
  });
});
