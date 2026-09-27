import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import * as storeModule from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import { taskproofWebRouter } from '../../src/taskproof/webApi';
import { getTaskproofSetting, setTaskproofSetting } from '../../src/taskproof/settings';
import { kickTaskCompletionReport } from '../../src/taskproof/report';
import { postOcrDebug } from '../../src/taskproof/workerClient';

vi.mock('../../src/taskproof/workerClient', () => ({
  postEnsureListening: vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} }),
  postMaybeStop: vi.fn().mockResolvedValue({ status: 200, json: {} }),
  postOcrDebug: vi.fn(),
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

  it('clamps numeric UI settings to safe ranges', async () => {
    const res = await fetch(`${baseUrl}/api/taskproof/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ocr_match_threshold: 9,
        default_required_count: 0,
        max_mentions_per_message: 99,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.settings.ocr_match_threshold).toBe(1);
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

  it('proxies a proof image to the worker OCR and returns the raw text', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    vi.mocked(postOcrDebug).mockResolvedValue({
      status: 200,
      json: { success: true, text: 'DÒNG 1\nDÒNG 2', char_count: 13, elapsed_ms: 12 },
    });

    const res = await fetch(`${baseUrl}/api/taskproof/debug-ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, text: 'DÒNG 1\nDÒNG 2', elapsed_ms: 12 });
    const sent = vi.mocked(postOcrDebug).mock.calls[0][0];
    expect(Buffer.isBuffer(sent) || sent instanceof Uint8Array).toBe(true);
    expect(Buffer.from(sent).equals(png)).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 0 });
  });

  it('rejects a non-image debug upload before calling the worker', async () => {
    vi.mocked(postOcrDebug).mockClear();
    const res = await fetch(`${baseUrl}/api/taskproof/debug-ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('not-an-image'),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
    expect(postOcrDebug).not.toHaveBeenCalled();
  });

  it('returns 502 when the worker OCR endpoint is down', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    vi.mocked(postOcrDebug).mockRejectedValue(new Error('worker_unreachable: connect ECONNREFUSED'));
    const res = await fetch(`${baseUrl}/api/taskproof/debug-ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(String(data.error)).toContain('worker');
  });

  it('scores OCR text against a caption with the saved threshold', async () => {
    setTaskproofSetting('ocr_match_threshold', 0.99, db);
    const hit = await fetch(`${baseUrl}/api/taskproof/debug-match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ocr_text: 'BỘ TƯ LỆNH THÀNH PHỐ',
        reference_text: 'Bộ Tư lệnh thành phố',
      }),
    });
    expect(hit.status).toBe(200);
    const hitJson = await hit.json();
    expect(hitJson.threshold).toBe(0.99);
    expect(hitJson.match).toMatchObject({ score: 1, isMatch: true, matchType: 'exact' });
    expect(hitJson.normalized_ocr).toBe('bo tu lenh thanh pho');
    expect(hitJson.normalized_reference).toBe('bo tu lenh thanh pho');

    const miss = await fetch(`${baseUrl}/api/taskproof/debug-match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ocr_text: 'hoan toan khac',
        reference_text: 'Bộ Tư lệnh thành phố khởi công nhà tình nghĩa',
      }),
    });
    const missJson = await miss.json();
    expect(missJson.match.isMatch).toBe(false);
    expect(missJson.threshold).toBe(0.99);
  });
});
