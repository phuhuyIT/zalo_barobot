import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { Server } from 'http';
import Database from 'better-sqlite3';
import { webhookRouter } from '../src/channels/webhook';
import * as storeModule from '../src/store';
import { initTaskproofTables } from '../src/taskproof/store';
import { ZaloClient } from '../src/core/zaloClient';

vi.mock('../src/patrol', () => ({
  handlePatrolCommand: vi.fn().mockResolvedValue({ handled: true, success: true }),
}));

vi.mock('../src/taskproof/workerClient', () => ({
  postEnsureListening: vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} }),
  postLinkGroup: vi.fn(),
  postRemind: vi.fn(),
  getWorkerStatus: vi.fn(),
}));

describe('Webhook Channel Authentication & Handling', () => {
  let server: Server;
  let baseUrl: string;
  let mockDb: Database.Database;
  const originalSecret = process.env.ZALO_WEBHOOK_SECRET;
  const originalEnforce = process.env.ZALO_WEBHOOK_ENFORCE_SECRET;

  beforeEach(async () => {
    process.env.ZALO_WEBHOOK_SECRET = 'test_secret_123';
    delete process.env.ZALO_WEBHOOK_ENFORCE_SECRET;
    mockDb = new Database(':memory:');
    storeModule.initTables(mockDb);
    storeModule.setDatabase(mockDb);
    initTaskproofTables(mockDb);
    vi.spyOn(ZaloClient.prototype, 'sendMessage').mockResolvedValue({
      messageId: 'mock',
      raw: {},
    });
    vi.spyOn(ZaloClient.prototype, 'sendPhoto').mockResolvedValue({
      messageId: 'mock',
      raw: {},
    });

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as { rawBody?: string }).rawBody = buf.toString('utf8');
        },
      })
    );
    app.use(express.text({ type: ['text/plain'], limit: '2mb' }));
    app.use(webhookRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (originalSecret !== undefined) {
      process.env.ZALO_WEBHOOK_SECRET = originalSecret;
    } else {
      delete process.env.ZALO_WEBHOOK_SECRET;
    }

    if (originalEnforce !== undefined) {
      process.env.ZALO_WEBHOOK_ENFORCE_SECRET = originalEnforce;
    } else {
      delete process.env.ZALO_WEBHOOK_ENFORCE_SECRET;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    storeModule.setDatabase(null);
    mockDb.close();
    vi.restoreAllMocks();
  });

  it('accepts valid secret token in x-bot-secret-token header', async () => {
    const res = await fetch(`${baseUrl}/webhook/zalo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret-token': 'test_secret_123',
      },
      body: JSON.stringify({
        message: { text: 'tuantra Văn A', chat: { id: 'group_123' }, from: { id: 'user_1' } },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('accepts valid secret token in x-telegram-bot-api-secret-token header', async () => {
    const res = await fetch(`${baseUrl}/webhook/zalo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': 'test_secret_123',
      },
      body: JSON.stringify({
        message: { text: 'tuantra Văn A', chat: { id: 'group_123' }, from: { id: 'user_1' } },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('accepts valid secret token passed via query param', async () => {
    const res = await fetch(`${baseUrl}/webhook/zalo?secret_token=test_secret_123`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: { text: 'tuantra Văn A', chat: { id: 'group_123' }, from: { id: 'user_1' } },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('rejects with 403 when provided secret token is wrong', async () => {
    const res = await fetch(`${baseUrl}/webhook/zalo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret-token': 'wrong_token',
      },
      body: JSON.stringify({
        message: { text: 'tuantra Văn A', chat: { id: 'group_123' } },
      }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized secret token');
  });

  it('allows request when secret header is absent by default (Zalo Bot non-blocking compatibility)', async () => {
    const res = await fetch(`${baseUrl}/webhook/zalo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: { text: 'tuantra Văn A', chat: { id: 'group_123' }, from: { id: 'user_1' } },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('blocks request with 403 when secret is absent and ZALO_WEBHOOK_ENFORCE_SECRET=true', async () => {
    process.env.ZALO_WEBHOOK_ENFORCE_SECRET = 'true';

    const res = await fetch(`${baseUrl}/webhook/zalo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: { text: 'tuantra Văn A', chat: { id: 'group_123' }, from: { id: 'user_1' } },
      }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized: missing secret token');
  });

  it('still accepts /gui (schedule command, not task-proof)', async () => {
    const res = await fetch(`${baseUrl}/webhook/zalo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret-token': 'test_secret_123',
      },
      body: JSON.stringify({
        message: { text: '/gui', chat: { id: 'group_123' }, from: { id: 'user_1' } },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('accepts /task JSON posted as text/plain (Zalo Java client)', async () => {
    const res = await fetch(`${baseUrl}/webhook/zalo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'x-bot-secret-token': 'test_secret_123',
      },
      body: JSON.stringify({
        ok: true,
        result: {
          event_name: 'message.text.received',
          message: {
            text: '/task Link: https://example.com/p Caption: hi HanChot: 19/09/2026 18:00',
            chat: { id: 'group_task', chat_type: 'GROUP' },
            from: { id: 'manager_1' },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('accepts /task on the official result.message envelope', async () => {
    const res = await fetch(`${baseUrl}/webhook/zalo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret-token': 'test_secret_123',
      },
      body: JSON.stringify({
        ok: true,
        result: {
          event_name: 'message.text.received',
          message: {
            text: '/task Link: https://example.com/p Caption: hi HanChot: 19/09/2026 18:00',
            chat: { id: 'group_task', chat_type: 'GROUP' },
            from: { id: 'manager_1' },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
