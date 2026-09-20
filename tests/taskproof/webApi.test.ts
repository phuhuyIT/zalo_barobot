import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import * as storeModule from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import { taskproofWebRouter } from '../../src/taskproof/webApi';
import { getTaskproofSetting } from '../../src/taskproof/settings';
import { kickTaskCompletionReport } from '../../src/taskproof/report';

vi.mock('../../src/taskproof/workerClient', () => ({
  postEnsureListening: vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} }),
}));

vi.mock('../../src/taskproof/report', () => ({
  kickTaskCompletionReport: vi.fn().mockResolvedValue([{ reported: true }]),
  reportUnreportedCompletedTasks: vi.fn().mockResolvedValue([]),
}));

describe('Task-proof Web UI API (Step 12)', () => {
  let server: Server;
  let baseUrl: string;
  let db: Database.Database;

  beforeEach(async () => {
    vi.mocked(kickTaskCompletionReport).mockClear();
    db = new Database(':memory:');
    storeModule.initTables(db);
    storeModule.setDatabase(db);
    initTaskproofTables(db);

    const app = express();
    app.use(express.json());
    app.use(taskproofWebRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storeModule.setDatabase(null);
    db.close();
  });

  it('saves UI settings to DB without accepting secrets', async () => {
    const res = await fetch(`${baseUrl}/api/taskproof/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ocr_match_threshold: 0.7,
        default_report_group_id: 'rep_group',
        remind_exclude_uids: 'uid_a, uid_b',
        INTERNAL_API_KEY: 'should-not-store',
        PUBLIC_BASE_URL: 'https://evil.example',
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.settings.ocr_match_threshold).toBe(0.7);
    expect(data.settings.default_report_group_id).toBe('rep_group');
    expect(data.settings.remind_exclude_uids).toEqual(['uid_a', 'uid_b']);
    expect(data.settings.INTERNAL_API_KEY).toBeUndefined();
    expect(getTaskproofSetting('ocr_match_threshold', db)).toBe(0.7);
  });

  it('adds and deletes a group map, unlinking open tasks on delete', async () => {
    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at, remind_count)
       VALUES ('t1', 'MAP001', 'off_1', 'zca-old', 'rep', 'https://x', 'c', 1, 1, 'collecting', 1, 0)`
    ).run();

    const added = await fetch(`${baseUrl}/api/taskproof/group-map`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        official_chat_id: 'off_1',
        zca_group_id: 'zca-new',
        display_name: 'Nhom A',
      }),
    });
    expect(added.status).toBe(200);
    const addedJson = await added.json();
    expect(addedJson.maps[0].zca_group_id).toBe('zca-new');
    const linked = db.prepare(`SELECT zca_group_id FROM tasks WHERE id = 't1'`).get() as {
      zca_group_id: string;
    };
    expect(linked.zca_group_id).toBe('zca-new');

    const deleted = await fetch(`${baseUrl}/api/taskproof/group-map/${encodeURIComponent('off_1')}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    const after = db
      .prepare(`SELECT zca_group_id, status FROM tasks WHERE id = 't1'`)
      .get() as { zca_group_id: string | null; status: string };
    expect(after.zca_group_id).toBeNull();
    expect(after.status).toBe('collecting');
  });

  it('rejects a conflicting group map pair', async () => {
    await fetch(`${baseUrl}/api/taskproof/group-map`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ official_chat_id: 'off_a', zca_group_id: 'zca-1' }),
    });
    const conflict = await fetch(`${baseUrl}/api/taskproof/group-map`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ official_chat_id: 'off_b', zca_group_id: 'zca-1' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('/dong and /huy use the same complete/cancel functions as chat commands', async () => {
    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at, remind_count)
       VALUES ('t1', 'DNG001', 'off', 'rep', 'https://x', 'c', 1, 1, 'collecting', 1, 0),
              ('t2', 'HUY001', 'off', 'rep', 'https://x', 'c', 1, 1, 'collecting', 1, 0)`
    ).run();

    const dong = await fetch(`${baseUrl}/api/taskproof/tasks/dng001/dong`, { method: 'POST' });
    expect(dong.status).toBe(200);
    expect(kickTaskCompletionReport).toHaveBeenCalledWith('t1');
    const dongRow = db.prepare(`SELECT status, reported_at FROM tasks WHERE id = 't1'`).get() as {
      status: string;
      reported_at: number | null;
    };
    expect(dongRow.status).toBe('completed');
    expect(dongRow.reported_at).toBeNull();

    const huy = await fetch(`${baseUrl}/api/taskproof/tasks/HUY001/huy`, { method: 'POST' });
    expect(huy.status).toBe(200);
    const huyRow = db.prepare(`SELECT status FROM tasks WHERE id = 't2'`).get() as { status: string };
    expect(huyRow.status).toBe('cancelled');
  });
});
