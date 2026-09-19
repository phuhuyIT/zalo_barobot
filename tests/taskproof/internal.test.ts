import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';

vi.mock('../../src/taskproof/notifyAdmin', () => ({
  notifyAdminWorkerDown: vi.fn().mockResolvedValue({ sent: true }),
}));

import { taskproofInternalRouter } from '../../src/taskproof/internal';
import { notifyAdminWorkerDown } from '../../src/taskproof/notifyAdmin';

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
