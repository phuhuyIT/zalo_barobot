import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Server } from 'http';
import { AddressInfo } from 'net';

vi.mock('../../src/taskproof/notifyAdmin', () => ({
  notifyAdminWorkerDown: vi.fn().mockResolvedValue({ sent: true }),
}));

import { createTaskproofInternalRouter, taskproofInternalRouter } from '../../src/taskproof/internal';
import { notifyAdminWorkerDown } from '../../src/taskproof/notifyAdmin';
import { signedQueryString } from '../../src/taskproof/internalAuth';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('official-bot task-proof internal routes (Step 1)', () => {
  let server: Server;
  let baseUrl: string;
  const originalKey = process.env.INTERNAL_API_KEY;

  beforeEach(async () => {
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    const app = express();
    app.use(express.json());
    app.use(taskproofInternalRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (originalKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = originalKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.clearAllMocks();
  });

  it('rejects worker-down without INTERNAL_API_KEY', async () => {
    const res = await fetch(`${baseUrl}/internal/taskproof/worker-down`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 1 }),
    });
    expect(res.status).toBe(403);
    expect(notifyAdminWorkerDown).not.toHaveBeenCalled();
  });

  it('notifies admin when worker-down is authorized', async () => {
    const res = await fetch(`${baseUrl}/internal/taskproof/worker-down`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': 'test-internal-key',
      },
      body: JSON.stringify({ code: 1, signal: 'SIGKILL' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(notifyAdminWorkerDown).toHaveBeenCalledWith({ code: 1, signal: 'SIGKILL' });
  });
});

describe('official-bot task-proof internal routes (Step 5)', () => {
  let server: Server;
  let baseUrl: string;
  let tmp: string;
  const originalKey = process.env.INTERNAL_API_KEY;
  const sendPhoto = vi.fn().mockResolvedValue({ messageId: 'p1' });
  const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm1' });
  const reportNow = vi.fn().mockResolvedValue([
    {
      taskId: 't1',
      shortCode: 'REP001',
      reported: true,
      photosSent: 1,
      photosSkipped: 0,
      destination: 'report_group',
    },
  ]);

  async function listen(adminChatId: string = 'admin_hex'): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use(
      createTaskproofInternalRouter({
        sendPhoto,
        sendMessage,
        getAdminChatId: () => adminChatId,
        getQrTmpDir: () => tmp,
        getProofDir: () => tmp,
        lookupStoredPath: (id) => (id === 'sub1' ? path.join(tmp, 'proof.jpg') : null),
        reportNow,
      })
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  beforeEach(async () => {
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    sendPhoto.mockClear();
    sendMessage.mockClear();
    reportNow.mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-internal-'));
    await listen();
  });

  afterEach(async () => {
    if (originalKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = originalKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('deliver-qr sendPhotos the https URL to admin_official_chat_id', async () => {
    const res = await fetch(`${baseUrl}/internal/taskproof/deliver-qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': 'test-internal-key' },
      body: JSON.stringify({
        image_url: 'https://example.test/internal/taskproof/qr/abc?key=test-internal-key',
        expires_at: Date.now() + 90_000,
      }),
    });
    expect(res.status).toBe(200);
    expect(sendPhoto).toHaveBeenCalledWith(
      'admin_hex',
      'https://example.test/internal/taskproof/qr/abc?key=test-internal-key',
      expect.any(String)
    );
  });

  it('deliver-qr is 409 when admin chat id is empty', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listen('');
    const res = await fetch(`${baseUrl}/internal/taskproof/deliver-qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': 'test-internal-key' },
      body: JSON.stringify({ image_url: 'https://example.test/qr.png' }),
    });
    expect(res.status).toBe(409);
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  it('login-result and link-result notify via sendMessage', async () => {
    const login = await fetch(`${baseUrl}/internal/taskproof/login-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': 'test-internal-key' },
      body: JSON.stringify({ ok: true }),
    });
    expect(login.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('admin_hex', expect.stringMatching(/thành công/));

    const link = await fetch(`${baseUrl}/internal/taskproof/link-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': 'test-internal-key' },
      body: JSON.stringify({ official_chat_id: 'group_off', ok: true, display_name: 'Tiểu đội' }),
    });
    expect(link.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('group_off', expect.stringMatching(/Đã liên kết: Tiểu đội/));
  });

  it('serves QR and proof bytes with HMAC ?exp=&sig= and 404s missing/expired files', async () => {
    fs.writeFileSync(path.join(tmp, 'qr1.png'), PNG);
    fs.writeFileSync(path.join(tmp, 'proof.jpg'), PNG);

    const denied = await fetch(`${baseUrl}/internal/taskproof/qr/qr1`);
    expect(denied.status).toBe(403);

    const queryKey = await fetch(`${baseUrl}/internal/taskproof/qr/qr1?key=test-internal-key`);
    expect(queryKey.status).toBe(403);

    const qrQ = signedQueryString('/internal/taskproof/qr/qr1', 60_000);
    const qr = await fetch(`${baseUrl}/internal/taskproof/qr/qr1?${qrQ}`);
    expect(qr.status).toBe(200);
    expect(qr.headers.get('content-type')).toMatch(/image\/png/);
    expect(Buffer.from(await qr.arrayBuffer()).equals(PNG)).toBe(true);

    const fileQ = signedQueryString('/internal/taskproof/file/sub1', 60_000);
    const file = await fetch(`${baseUrl}/internal/taskproof/file/sub1?${fileQ}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toMatch(/image\/jpeg/);
    const body = Buffer.from(await file.arrayBuffer());
    expect(file.headers.get('content-length')).toBe(String(body.length));
    expect(body[0]).toBe(0xff);
    expect(body[1]).toBe(0xd8);
    expect(body[2]).toBe(0xff);

    const missingQ = signedQueryString('/internal/taskproof/qr/nope', 60_000);
    const missing = await fetch(`${baseUrl}/internal/taskproof/qr/nope?${missingQ}`);
    expect(missing.status).toBe(404);

    const traversalQ = signedQueryString('/internal/taskproof/qr/../secret', 60_000);
    const traversal = await fetch(`${baseUrl}/internal/taskproof/qr/../secret?${traversalQ}`);
    expect(traversal.status).toBe(404);
  });

  it('report-now requires INTERNAL_API_KEY and kicks the named task', async () => {
    const denied = await fetch(`${baseUrl}/internal/taskproof/report-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: 't1' }),
    });
    expect(denied.status).toBe(403);
    expect(reportNow).not.toHaveBeenCalled();

    const res = await fetch(`${baseUrl}/internal/taskproof/report-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': 'test-internal-key' },
      body: JSON.stringify({ task_id: 't1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.reports[0].short_code).toBe('REP001');
    expect(reportNow).toHaveBeenCalledWith('t1');
  });

  it('scan-result requires the internal key and sendMessages the group', async () => {
    const denied = await fetch(`${baseUrl}/internal/taskproof/scan-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply_chat_id: 'off_group', short_code: 'ABC123', count: 5, recorded: 2 }),
    });
    expect(denied.status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();

    const res = await fetch(`${baseUrl}/internal/taskproof/scan-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': 'test-internal-key' },
      body: JSON.stringify({
        reply_chat_id: 'off_group',
        short_code: 'ABC123',
        count: 5,
        scanned: 4,
        recorded: 2,
        skipped: 1,
        discarded: 1,
        closed: false,
        truncated: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('off_group', expect.stringMatching(/ABC123/));
    expect(sendMessage.mock.calls[0][1]).toMatch(/ghi 2 minh chứng/);
  });
});
