import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { Server } from 'http';
import { webhookRouter } from '../src/channels/webhook';

vi.mock('../src/patrol', () => ({
  handlePatrolCommand: vi.fn().mockResolvedValue({ handled: true, success: true }),
}));

describe('Webhook Channel Authentication & Handling', () => {
  let server: Server;
  let baseUrl: string;
  const originalSecret = process.env.ZALO_WEBHOOK_SECRET;
  const originalEnforce = process.env.ZALO_WEBHOOK_ENFORCE_SECRET;

  beforeEach(async () => {
    process.env.ZALO_WEBHOOK_SECRET = 'test_secret_123';
    delete process.env.ZALO_WEBHOOK_ENFORCE_SECRET;

    const app = express();
    app.use(express.json());
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
    vi.clearAllMocks();
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
});
