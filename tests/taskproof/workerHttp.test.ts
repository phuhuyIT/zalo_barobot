import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { createWorkerApp, startWorkerHttp } from '../../src/taskproof/worker/http';
import { WORKER_BIND_HOST } from '../../src/taskproof/env';
import { WorkerRuntime } from '../../src/taskproof/worker/runtime';
import { ZcaLoginPort } from '../../src/taskproof/worker/zcaAdapter';

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('task-proof worker HTTP (Step 5)', () => {
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

  it('refuses to bind a public address', async () => {
    await expect(startWorkerHttp(createWorkerApp(), 0, '0.0.0.0')).rejects.toThrow(/loopback/);
  });

  it('worker must not CREATE TABLE or import zaloClient; official bot must not import zca-js', () => {
    const workerDir = path.resolve(__dirname, '../../src/taskproof/worker');
    for (const file of walkTsFiles(workerDir)) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      expect(code, file).not.toMatch(/CREATE TABLE/i);
      expect(code, file).not.toMatch(/initTaskproofTables/);
      expect(code, file).not.toMatch(/zaloClient/);
    }

    const officialRoots = [
      path.resolve(__dirname, '../../src/index.ts'),
      path.resolve(__dirname, '../../src/channels'),
      path.resolve(__dirname, '../../src/core'),
      path.resolve(__dirname, '../../src/taskproof'),
    ];
    const skip = `${path.sep}worker${path.sep}`;
    for (const root of officialRoots) {
      const files = root.endsWith('.ts') ? [root] : walkTsFiles(root);
      for (const file of files) {
        if (file.includes(skip)) continue;
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        expect(code, file).not.toMatch(/['"]zca-js['"]/);
      }
    }
  });

  it('requires INTERNAL_API_KEY for /internal/taskproof/status', async () => {
    const runtime = new WorkerRuntime({
      loginPort: { login: async () => undefined, loginQR: async () => ({ cookie: [], imei: 'x', userAgent: 'y' }) },
      db: null,
    });
    const server = await startWorkerHttp(createWorkerApp({ runtime }), 0, WORKER_BIND_HOST);
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

  it('ensure-listening is authenticated and returns explicit login states', async () => {
    const runtime = new WorkerRuntime({
      loginPort: { login: async () => undefined, loginQR: async () => ({ cookie: [], imei: 'x', userAgent: 'y' }) } as ZcaLoginPort,
      db: null,
      getAdminChatId: () => '',
      getPublicBaseUrl: () => 'https://example.test',
      getSessionFilePath: () => path.join(os.tmpdir(), 'no-session.json'),
    });
    const server = await startWorkerHttp(createWorkerApp({ runtime }), 0, WORKER_BIND_HOST);
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    const denied = await fetch(`${base}/internal/taskproof/ensure-listening`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(denied.status).toBe(403);

    const failed = await fetch(`${base}/internal/taskproof/ensure-listening`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': 'test-internal-key' },
      body: '{}',
    });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ state: 'login_failed' });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('scan-history requires INTERNAL_API_KEY', async () => {
    const runtime = new WorkerRuntime({
      loginPort: { login: async () => undefined, loginQR: async () => ({ cookie: [], imei: 'x', userAgent: 'y' }) },
      db: null,
    });
    const server = await startWorkerHttp(createWorkerApp({ runtime }), 0, WORKER_BIND_HOST);
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    const denied = await fetch(`${base}/internal/taskproof/scan-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: 't1' }),
    });
    expect(denied.status).toBe(403);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
