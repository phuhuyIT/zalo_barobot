import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/records/store';
import { setTaskproofSetting } from '../../src/taskproof/records/settings';
import {
  formatTasksListReply,
  insertNewTask,
  listOpenTasks,
  resolveTaskDeadline,
} from '../../src/taskproof/records/tasks';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  configureSqliteConnection(db);
  initTables(db);
  initTaskproofTables(db);
  return db;
}

describe('insertNewTask / listTasks (T1, T3)', () => {
  it('inserts UUID id, 6-char short_code, and copies zca_group_id from the map', () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at)
       VALUES ('off_group', 'zca-thread-1', 'Nhom', 1)`
    ).run();
    setTaskproofSetting('default_required_count', 3, db);
    setTaskproofSetting('default_report_group_id', 'default_rep', db);

    const created = insertNewTask(
      {
        officialChatId: 'off_group',
        link: 'https://example.com/p',
        referenceText: 'Caption here',
        deadlineUtcMs: 1_700_000_000_000,
        now: 10,
      },
      db
    );

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(created.short_code).toMatch(/^[A-Z0-9]{6}$/);
    expect(created.short_code).not.toBe(created.id.slice(0, 6).toUpperCase());
    expect(created.zca_group_id).toBe('zca-thread-1');
    expect(created.required_count).toBe(3);
    expect(created.report_group_id).toBe('default_rep');
    expect(created.status).toBe('collecting');
    db.close();
  });

  it('defaults deadline to now + default_deadline_offset_ms', () => {
    const db = openDb();
    setTaskproofSetting('default_deadline_offset_ms', 3_600_000, db);
    expect(resolveTaskDeadline(null, 1_000, db)).toBe(3_601_000);
    expect(resolveTaskDeadline(9_000, 1_000, db)).toBe(9_000);
    db.close();
  });

  it('retries short_code on UNIQUE collision instead of slicing the UUID', () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at, remind_count)
       VALUES ('existing', 'AAAAAA', 'off', 'rep', 'https://x', 'c', 1, 1, 'collecting', 1, 0)`
    ).run();

    const created = insertNewTask(
      {
        officialChatId: 'off',
        link: 'https://example.com/p',
        referenceText: 'Cap',
        deadlineUtcMs: 1,
        shortCode: 'AAAAAA',
      },
      db
    );
    expect(created.short_code).toMatch(/^[A-Z0-9]{6}$/);
    expect(created.short_code).not.toBe('AAAAAA');
    db.close();
  });

  it('lists only collecting and overdue tasks with the post link', () => {
    const db = openDb();
    const insert = db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at, remind_count)
       VALUES (?, ?, 'off', NULL, 'rep', ?, 'c', 2, 1, ?, ?, 1)`
    );
    insert.run('t1', 'ABC123', 'https://facebook.com/posts/abc', 'collecting', 2);
    insert.run('t2', 'DEF456', 'https://facebook.com/posts/def', 'overdue', 3);
    insert.run('t3', 'DONE01', 'https://facebook.com/posts/done', 'completed', 4);
    insert.run('t4', 'CANC01', 'https://facebook.com/posts/canc', 'cancelled', 5);
    db.prepare(
      `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, match_score, created_at)
       VALUES ('s1', 't1', 'u1', 'A', 'https://img', 1, 1)`
    ).run();

    const rows = listOpenTasks(db);
    expect(rows.map((row) => row.short_code)).toEqual(['DEF456', 'ABC123']);
    expect(rows[1].submitted_count).toBe(1);
    const text = formatTasksListReply(rows);
    expect(text).toBe(
      [
        'Danh sách task:',
        '• DEF456 — quá hạn — 0/2',
        '  https://facebook.com/posts/def',
        '• ABC123 — đang thu — 1/2',
        '  https://facebook.com/posts/abc',
      ].join('\n')
    );
    expect(formatTasksListReply([])).toBe('Không có task đang thu hoặc quá hạn.');
    db.close();
  });
});
