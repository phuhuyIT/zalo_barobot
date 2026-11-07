import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import * as storeModule from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/records/store';
import { taskproofWebRouter } from '../../src/taskproof/http/webApi';
import { getTaskproofSetting, setTaskproofSetting } from '../../src/taskproof/records/settings';
import { kickTaskCompletionReport } from '../../src/taskproof/records/report';
import { postRefreshMembers } from '../../src/taskproof/http/workerClient';
vi.mock('../../src/taskproof/http/workerClient', () => ({
  postEnsureListening: vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} }),
  postMaybeStop: vi.fn().mockResolvedValue({ status: 200, json: {} }),
  postRefreshMembers: vi.fn().mockResolvedValue({ status: 200, json: { refreshed: [] } }),
}));

vi.mock('../../src/taskproof/records/report', () => ({
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
        default_required_count: 8,
        default_report_group_id: 'rep_group',
        remind_exclude_uids: 'uid_a, uid_b',
        INTERNAL_API_KEY: 'should-not-store',
        PUBLIC_BASE_URL: 'https://evil.example',
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.settings.default_required_count).toBe(8);
    expect(data.settings.default_report_group_id).toBe('rep_group');
    expect(data.settings.remind_exclude_uids).toEqual(['uid_a', 'uid_b']);
    expect(data.settings.INTERNAL_API_KEY).toBeUndefined();
    expect(getTaskproofSetting('default_required_count', db)).toBe(8);
  });

  it('lists cached group members for the exclude buttons', async () => {
    db.prepare(
      `INSERT INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at, linked_by_uid)
       VALUES ('off_1', 'zca-1', 'Nhom A', 1, NULL)`
    ).run();
    const insertMember = db.prepare(
      `INSERT INTO group_members_cache (zca_group_id, user_id, display_name, updated_at)
       VALUES (?, ?, ?, ?)`
    );
    insertMember.run('zca-1', 'uid_b', 'Binh', 2);
    insertMember.run('zca-1', 'uid_a', 'An', 2);
    insertMember.run('zca-orphan', 'uid_c', 'Chi', 1);

    const res = await fetch(`${baseUrl}/api/taskproof`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.members).toEqual([
      {
        zca_group_id: 'zca-1',
        official_chat_id: 'off_1',
        group_name: 'Nhom A',
        user_id: 'uid_a',
        display_name: 'An',
      },
      {
        zca_group_id: 'zca-1',
        official_chat_id: 'off_1',
        group_name: 'Nhom A',
        user_id: 'uid_b',
        display_name: 'Binh',
      },
      {
        zca_group_id: 'zca-orphan',
        official_chat_id: null,
        group_name: null,
        user_id: 'uid_c',
        display_name: 'Chi',
      },
    ]);
  });

  it('returns cached members after the worker refresh, and surfaces not_listening', async () => {
    vi.mocked(postRefreshMembers).mockResolvedValueOnce({
      status: 409,
      json: { success: false, error: 'not_listening', refreshed: [] },
    });
    const denied = await fetch(`${baseUrl}/api/taskproof/members/refresh`, { method: 'POST' });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ success: false, error: 'not_listening', members: [] });

    vi.mocked(postRefreshMembers).mockImplementationOnce(async () => {
      db.prepare(
        `INSERT INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at, linked_by_uid)
         VALUES ('off_1', 'zca-1', 'Nhom A', 1, NULL)`
      ).run();
      db.prepare(
        `INSERT INTO group_members_cache (zca_group_id, user_id, display_name, updated_at)
         VALUES ('zca-1', 'uid_a', 'An', 1)`
      ).run();
      return { status: 200, json: { refreshed: [{ zca_group_id: 'zca-1', member_count: 1, ok: true }] } };
    });
    const res = await fetch(`${baseUrl}/api/taskproof/members/refresh`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.members).toEqual([
      {
        zca_group_id: 'zca-1',
        official_chat_id: 'off_1',
        group_name: 'Nhom A',
        user_id: 'uid_a',
        display_name: 'An',
      },
    ]);
  });

  it('rejects a cross-origin settings write', async () => {
    const cross = await fetch(`${baseUrl}/api/taskproof/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ default_required_count: 4 }),
    });
    expect(cross.status).toBe(403);
    expect(getTaskproofSetting('default_required_count', db)).not.toBe(4);

    const site = await fetch(`${baseUrl}/api/taskproof/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ default_required_count: 4 }),
    });
    expect(site.status).toBe(403);

    const read = await fetch(`${baseUrl}/api/taskproof/settings`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(read.status).toBe(200);
  });

  it('clamps numeric UI settings to safe ranges', async () => {
    const res = await fetch(`${baseUrl}/api/taskproof/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        default_required_count: 0,
        max_mentions_per_message: 99,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.settings.default_required_count).toBe(1);
    expect(data.settings.max_mentions_per_message).toBe(20);
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
