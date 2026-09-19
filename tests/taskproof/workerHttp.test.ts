import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AddressInfo } from 'net';
import { createWorkerApp, startWorkerHttp } from '../../src/taskproof/worker/http';
import { WORKER_BIND_HOST } from '../../src/taskproof/env';

describe('task-proof worker HTTP (Step 1)', () => {
  const originalKey = process.env.INTERNAL_API_KEY;

  beforeEach(() => {
    process.env.INTERNAL_API_KEY = 'test-internal-key';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = originalKey;
  });

  it('binds 127.0.0.1 only and serves /health without auth', async () => {
    const server = await startWorkerHttp(createWorkerApp(), 0, WORKER_BIND_HOST);
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.process).toBe('taskproof-worker');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not CREATE TABLE or import zaloClient/zca-js (official bot owns schema)', () => {
    const dir = path.resolve(__dirname, '../../src/taskproof/worker');
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/CREATE TABLE/i);
      expect(code, file).not.toMatch(/initTaskproofTables/);
      expect(code, file).not.toMatch(/zaloClient/);
      expect(code, file).not.toMatch(/['"]zca-js['"]/);
    }
  });

  it('requires INTERNAL_API_KEY for /internal/taskproof/status', async () => {
    const server = await startWorkerHttp(createWorkerApp(), 0, WORKER_BIND_HOST);
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    const denied = await fetch(`${base}/internal/taskproof/status`);
    expect(denied.status).toBe(403);

    const ok = await fetch(`${base}/internal/taskproof/status`, {
      headers: { 'x-internal-key': 'test-internal-key' },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({
      logged_in: false,
      listening: false,
      open_task_count: 0,
      pending_link: false,
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
