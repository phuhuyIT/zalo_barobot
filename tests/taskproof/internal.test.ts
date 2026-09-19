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

  async function listen(adminChatId: string = 'admin_hex'): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use(
      createTaskproofInternalRouter({
        sendPhoto,
        sendMessage,
        getAdminChatId: () => adminChatId,
        getQrTmpDir: () => tmp,
        lookupStoredPath: (id) => (id === 'sub1' ? path.join(tmp, 'proof.jpg') : null),
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

  it('serves QR and proof bytes with ?key= and 404s missing/expired files', async () => {
    fs.writeFileSync(path.join(tmp, 'qr1.png'), PNG);
    fs.writeFileSync(path.join(tmp, 'proof.jpg'), PNG);

    const denied = await fetch(`${baseUrl}/internal/taskproof/qr/qr1`);
    expect(denied.status).toBe(403);

    const qr = await fetch(`${baseUrl}/internal/taskproof/qr/qr1?key=test-internal-key`);
    expect(qr.status).toBe(200);
    expect(qr.headers.get('content-type')).toMatch(/image\/png/);
    expect(Buffer.from(await qr.arrayBuffer()).equals(PNG)).toBe(true);

    const file = await fetch(`${baseUrl}/internal/taskproof/file/sub1?key=test-internal-key`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toMatch(/image\/jpeg/);

    const missing = await fetch(`${baseUrl}/internal/taskproof/qr/nope?key=test-internal-key`);
    expect(missing.status).toBe(404);

    const traversal = await fetch(`${baseUrl}/internal/taskproof/qr/../secret?key=test-internal-key`);
    expect(traversal.status).toBe(404);
  });
});
