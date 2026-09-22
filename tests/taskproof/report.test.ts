import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import {
  formatAdminReportedNotice,
  kickTaskCompletionReport,
  listUnreportedCompletedTasks,
  reportUnreportedCompletedTasks,
  resetReportInFlightForTests,
} from '../../src/taskproof/report';
import { completeTask } from '../../src/taskproof/lifecycle';

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
    id: string;
    code: string;
    status?: string;
    reportedAt?: number | null;
    official?: string;
    report?: string;
  }
): void {
  db.prepare(
    `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
      link, reference_text, required_count, deadline, status, created_at, remind_count, reported_at)
     VALUES (?, ?, ?, 'zca-1', ?, 'https://post.example/a', 'Caption demo', 2, 1, ?, 1, 0, ?)`
  ).run(
    opts.id,
    opts.code,
    opts.official || 'off_group',
    opts.report || 'report_group',
    opts.status || 'completed',
    opts.reportedAt === undefined ? null : opts.reportedAt
  );
}

function insertSub(
  db: Database.Database,
  opts: { id: string; taskId: string; uid: string; name: string; storedPath: string; imageUrl?: string }
): void {
  db.prepare(
    `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, stored_path, match_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.91, 1)`
  ).run(opts.id, opts.taskId, opts.uid, opts.name, opts.imageUrl || 'https://cdn.example/img.jpg', opts.storedPath);
}

describe('T6 completion report (Step 10)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetReportInFlightForTests();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a dead image and still reports the rest', async () => {
    const db = openDb();
    const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    dirs.push(proofRoot);
    const taskDir = path.join(proofRoot, 't1');
    fs.mkdirSync(taskDir, { recursive: true });
    const livePath = path.join(taskDir, 's2.jpg');
    fs.writeFileSync(livePath, Buffer.from('jpeg'));

    insertTask(db, { id: 't1', code: 'REP001' });
    insertSub(db, {
      id: 'dead1',
      taskId: 't1',
      uid: 'u1',
      name: 'A',
      storedPath: path.join(taskDir, 's1.jpg'),
      imageUrl: 'http://cdn.example/dead.jpg',
    });
    insertSub(db, {
      id: 'ok2',
      taskId: 't1',
      uid: 'u2',
      name: 'B',
      storedPath: livePath,
      imageUrl: 'https://cdn.example/b.jpg',
    });

    const sendPhoto = vi.fn(async (_chatId: string, photoUrl: string) => {
      if (photoUrl.includes('dead1')) throw new Error('invalid photo URL');
      return { messageId: 'p' };
    });
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm' });

    const results = await reportUnreportedCompletedTasks(db, {
      sendPhoto,
      sendMessage,
      proofFileUrl: (id) => `https://public.example/internal/taskproof/file/${id}?key=k`,
      proofDir: proofRoot,
      now: () => 999,
      getAdminChatId: () => 'admin_dm',
    });

    expect(results).toHaveLength(1);
    expect(results[0].reported).toBe(true);
    expect(results[0].photosSkipped).toBe(1);
    expect(results[0].photosSent).toBe(1);
    expect(results[0].destination).toBe('report_group');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('admin_dm', 'Đã báo cáo task REP001.');
    expect(sendMessage.mock.calls.some((call) => call[0] === 'report_group')).toBe(false);
    expect(sendPhoto.mock.calls.every((call) => call.length === 2)).toBe(true);
    expect(sendPhoto.mock.calls.some((c) => String(c[1]).includes('dead1'))).toBe(true);

    const row = db
      .prepare(`SELECT reported_at, status FROM tasks WHERE id = 't1'`)
      .get() as { reported_at: number; status: string };
    expect(row.status).toBe('completed');
    expect(row.reported_at).toBe(999);
    expect(fs.existsSync(taskDir)).toBe(false);
    db.close();
  });

  it('falls back to the task group when report_group photo send fails', async () => {
    const db = openDb();
    insertTask(db, { id: 't2', code: 'FB001', official: 'off_group', report: 'report_group' });
    insertSub(db, {
      id: 's-fb',
      taskId: 't2',
      uid: 'u1',
      name: 'A',
      storedPath: '/tmp/missing.jpg',
      imageUrl: 'http://cdn.example/not-https.jpg',
    });

    const sendPhoto = vi.fn(async (chatId: string) => {
      if (chatId === 'report_group') throw new Error('bot is not a member');
      return { messageId: 'p' };
    });
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm' });

    const results = await reportUnreportedCompletedTasks(db, {
      sendPhoto,
      sendMessage,
      proofFileUrl: (id) => `https://public.example/file/${id}`,
      proofDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-')),
      now: () => 50,
      getAdminChatId: () => 'admin_dm',
    });

    expect(results[0].reported).toBe(true);
    expect(results[0].destination).toBe('fallback_group');
    expect(sendPhoto).toHaveBeenCalledWith('off_group', 'https://public.example/file/s-fb');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('admin_dm', 'Đã báo cáo task FB001.');
    expect(sendMessage.mock.calls.some((call) => call[0] === 'off_group' || call[0] === 'report_group')).toBe(
      false
    );
    db.close();
  });

  it('does not pick cancelled tasks even if reported_at is null', () => {
    const db = openDb();
    insertTask(db, { id: 'c1', code: 'CAN001', status: 'cancelled', reportedAt: null });
    insertTask(db, { id: 'ok', code: 'OK0001', status: 'completed', reportedAt: null });
    const rows = listUnreportedCompletedTasks(db);
    expect(rows.map((r) => r.short_code)).toEqual(['OK0001']);
    db.close();
  });

  it('/dong feeds the report queue without deleting proofs yet', () => {
    const db = openDb();
    insertTask(db, { id: 't3', code: 'DNG001', status: 'collecting' });
    expect(completeTask(db, 't3')).toBe(true);
    const queued = listUnreportedCompletedTasks(db);
    expect(queued.map((r) => r.short_code)).toEqual(['DNG001']);
    db.close();
  });

  it('kickTaskCompletionReport only sends the closed task', async () => {
    const db = openDb();
    insertTask(db, { id: 't-a', code: 'KCK001' });
    insertTask(db, { id: 't-b', code: 'KCK002' });
    const sendPhoto = vi.fn().mockResolvedValue({ messageId: 'p' });
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm' });
    const results = await kickTaskCompletionReport('t-a', db, {
      sendPhoto,
      sendMessage,
      proofFileUrl: (id) => `https://public.example/file/${id}`,
      proofDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-')),
      now: () => 7,
      getAdminChatId: () => 'admin_dm',
    });
    expect(results).toHaveLength(1);
    expect(results[0].shortCode).toBe('KCK001');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('admin_dm', formatAdminReportedNotice('KCK001'));
    const leftover = listUnreportedCompletedTasks(db);
    expect(leftover.map((r) => r.short_code)).toEqual(['KCK002']);
    db.close();
  });

  it('does not double-send when kick and poll overlap', async () => {
    const db = openDb();
    insertTask(db, { id: 't-dup', code: 'DUP001' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendPhoto = vi.fn().mockResolvedValue({ messageId: 'p' });
    const sendMessage = vi.fn(async () => {
      await gate;
      return { messageId: 'm' };
    });
    const deps = {
      sendPhoto,
      sendMessage,
      proofFileUrl: (id: string) => `https://public.example/file/${id}`,
      proofDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-')),
      now: () => 8,
      getAdminChatId: () => 'admin_dm',
    };
    const first = reportUnreportedCompletedTasks(db, { ...deps, taskId: 't-dup' });
    const second = reportUnreportedCompletedTasks(db, { ...deps, taskId: 't-dup' });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(a[0].reported).toBe(true);
    expect(b[0].reported).toBe(true);
    db.close();
  });

  it('notifies the admin with the short code only', () => {
    expect(formatAdminReportedNotice('ABC123')).toBe('Đã báo cáo task ABC123.');
  });

  it('does not mark reported or text anyone when every photo send fails', async () => {
    const db = openDb();
    insertTask(db, { id: 't-fail', code: 'FL0001' });
    insertSub(db, {
      id: 's-fail',
      taskId: 't-fail',
      uid: 'u1',
      name: 'A',
      storedPath: '/tmp/missing.jpg',
      imageUrl: 'http://cdn.example/not-https.jpg',
    });
    const sendPhoto = vi.fn().mockRejectedValue(new Error('invalid photo URL'));
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm' });
    const results = await reportUnreportedCompletedTasks(db, {
      sendPhoto,
      sendMessage,
      proofFileUrl: (id) => `https://public.example/file/${id}`,
      proofDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-')),
      now: () => 3,
      getAdminChatId: () => 'admin_dm',
    });
    expect(results[0].reported).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    const row = db.prepare(`SELECT reported_at FROM tasks WHERE id = 't-fail'`).get() as {
      reported_at: number | null;
    };
    expect(row.reported_at).toBeNull();
    db.close();
  });
});
