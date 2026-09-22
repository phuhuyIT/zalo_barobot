import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import { WorkerRuntime } from '../../src/taskproof/worker/runtime';
import { saveSession, ZcaCredentials } from '../../src/taskproof/worker/session';
import { ZcaLoginPort } from '../../src/taskproof/worker/zcaAdapter';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-runtime-'));
}

function fakeCreds(): ZcaCredentials {
  return { cookie: [{ name: 'zpw' }], imei: 'imei-1', userAgent: 'ua-1' };
}

describe('task-proof ensure-listening / session / QR (Step 5)', () => {
  const dirs: string[] = [];
  const originalKey = process.env.INTERNAL_API_KEY;

  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    vi.useRealTimers();
    if (originalKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = originalKey;
  });

  it('reuses a saved session and does not start QR', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const sessionPath = path.join(dir, 'zca-session.json');
    saveSession(fakeCreds(), sessionPath);
    const login = vi.fn().mockResolvedValue(undefined);
    const loginQR = vi.fn();
    const runtime = new WorkerRuntime({
      loginPort: { login, loginQR } as unknown as ZcaLoginPort,
      getSessionFilePath: () => sessionPath,
      getAdminChatId: () => 'admin',
      getPublicBaseUrl: () => 'https://example.test',
    });

    const result = await runtime.ensureListening();
    expect(result).toMatchObject({ httpStatus: 200, state: 'reusing_session' });
    expect(login).toHaveBeenCalledOnce();
    expect(loginQR).not.toHaveBeenCalled();
    expect(runtime.status().logged_in).toBe(true);
  });

  it('returns qr_required immediately without waiting for the scan', async () => {
    const dir = tempDir();
    dirs.push(dir);
    let releaseQr!: (creds: ZcaCredentials) => void;
    const loginQR = vi.fn(
      () =>
        new Promise<ZcaCredentials>((resolve) => {
          releaseQr = resolve;
        })
    );
    const deliver = vi.fn().mockResolvedValue({ status: 200, json: {} });
    const runtime = new WorkerRuntime({
      loginPort: { login: vi.fn(), loginQR } as unknown as ZcaLoginPort,
      getSessionFilePath: () => path.join(dir, 'missing.json'),
      getAdminChatId: () => 'admin_hex',
      getPublicBaseUrl: () => 'https://example.test',
      getQrTmpDir: () => dir,
      getQrTimeoutMs: () => 90_000,
      deliverQr: deliver,
      postLoginResult: vi.fn(),
    });

    const started = Date.now();
    const result = await runtime.ensureListening();
    expect(Date.now() - started).toBeLessThan(200);
    expect(result).toMatchObject({ httpStatus: 200, state: 'qr_required' });
    expect(loginQR).toHaveBeenCalledOnce();
    expect(runtime.isQrInFlight()).toBe(true);

    const again = await runtime.ensureListening();
    expect(again.state).toBe('qr_required');
    expect(loginQR).toHaveBeenCalledOnce();

    releaseQr(fakeCreds());
    await vi.waitFor(() => expect(runtime.isLoggedIn()).toBe(true));
    expect(runtime.isQrInFlight()).toBe(false);
  });

  it('delivers a token-gated https QR URL then persists the session', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const sessionPath = path.join(dir, 'zca-session.json');
    const qrDir = path.join(dir, 'qr-tmp');
    fs.mkdirSync(qrDir);
    const delivered: string[] = [];
    const loginResults: Array<{ ok: boolean; error?: string }> = [];

    const runtime = new WorkerRuntime({
      loginPort: {
        login: vi.fn(),
        loginQR: async ({ qrPath, onGenerated }) => {
          fs.writeFileSync(qrPath, PNG);
          await onGenerated({ abort: () => undefined });
          return fakeCreds();
        },
      },
      getSessionFilePath: () => sessionPath,
      getAdminChatId: () => 'admin_hex',
      getPublicBaseUrl: () => 'https://codespace.example',
      getQrTmpDir: () => qrDir,
      getQrTimeoutMs: () => 5_000,
      deliverQr: async (imageUrl, expiresAt) => {
        delivered.push(imageUrl);
        expect(expiresAt).toBeGreaterThan(Date.now());
        return { status: 200, json: { success: true } };
      },
      postLoginResult: async (ok, error) => {
        loginResults.push({ ok, error });
      },
    });

    process.env.INTERNAL_API_KEY = 'test-internal-key';
    const result = await runtime.ensureListening();
    expect(result.state).toBe('qr_required');
    await vi.waitFor(() => expect(loginResults.some((r) => r.ok)).toBe(true));
    expect(delivered[0]).toMatch(
      /^https:\/\/codespace\.example\/internal\/taskproof\/qr\/[a-f0-9]+\?exp=\d+&sig=[a-f0-9]+$/
    );
    expect(fs.existsSync(sessionPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sessionPath, 'utf8')).imei).toBe('imei-1');
  });

  it('keeps waiting for a QR scan if sendPhoto cannot fetch the image URL', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const loginResults: Array<{ ok: boolean; error?: string }> = [];
    const runtime = new WorkerRuntime({
      loginPort: {
        login: vi.fn(),
        loginQR: async ({ onGenerated }) => {
          await onGenerated({ abort: () => undefined });
          return fakeCreds();
        },
      },
      getSessionFilePath: () => path.join(dir, 'session.json'),
      getAdminChatId: () => 'admin_hex',
      getPublicBaseUrl: () => 'https://example.test',
      getQrTmpDir: () => dir,
      getQrTimeoutMs: () => 5_000,
      deliverQr: async () => ({
        status: 409,
        json: { error: 'The photo URL is invalid' },
      }),
      postLoginResult: async (ok, error) => {
        loginResults.push({ ok, error });
      },
    });

    expect((await runtime.ensureListening()).state).toBe('qr_required');
    await vi.waitFor(() => expect(runtime.isLoggedIn()).toBe(true));
    expect(loginResults).toEqual([{ ok: true, error: undefined }]);
  });

  it('returns 409 login_failed when admin_official_chat_id is empty (does not hang)', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const loginQR = vi.fn();
    const runtime = new WorkerRuntime({
      loginPort: { login: vi.fn(), loginQR } as unknown as ZcaLoginPort,
      getSessionFilePath: () => path.join(dir, 'missing.json'),
      getAdminChatId: () => '',
      getPublicBaseUrl: () => 'https://example.test',
    });
    const result = await runtime.ensureListening();
    expect(result).toMatchObject({ httpStatus: 409, state: 'login_failed' });
    expect(loginQR).not.toHaveBeenCalled();
  });

  it('does not auto-retry QR after timeout; a later ensure-listening may start a new one', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const loginQR = vi.fn().mockRejectedValue(Object.assign(new Error('qr_timeout'), { code: 'qr_timeout' }));
    const loginResults: Array<{ ok: boolean; error?: string }> = [];
    const runtime = new WorkerRuntime({
      loginPort: { login: vi.fn(), loginQR } as unknown as ZcaLoginPort,
      getSessionFilePath: () => path.join(dir, 'missing.json'),
      getAdminChatId: () => 'admin_hex',
      getPublicBaseUrl: () => 'https://example.test',
      getQrTmpDir: () => dir,
      getQrTimeoutMs: () => 50,
      postLoginResult: async (ok, error) => {
        loginResults.push({ ok, error });
      },
      deliverQr: async () => ({ status: 200, json: {} }),
    });

    expect((await runtime.ensureListening()).state).toBe('qr_required');
    await vi.waitFor(() => expect(loginResults).toEqual([{ ok: false, error: 'qr_timeout' }]));
    expect(loginQR).toHaveBeenCalledOnce();

    loginQR.mockRejectedValueOnce(Object.assign(new Error('qr_timeout'), { code: 'qr_timeout' }));
    expect((await runtime.ensureListening()).state).toBe('qr_required');
    expect(loginQR).toHaveBeenCalledTimes(2);
  });

  it('link-group method B writes the map and rejects conflicting pairs', () => {
    const db = new Database(':memory:');
    configureSqliteConnection(db);
    initTables(db);
    initTaskproofTables(db);
    const runtime = new WorkerRuntime({
      db,
      loginPort: { login: vi.fn(), loginQR: vi.fn() } as unknown as ZcaLoginPort,
    });

    const first = runtime.linkGroup('off_1', 'zgr-aaa');
    expect(first.httpStatus).toBe(200);
    const again = runtime.linkGroup('off_1', 'zgr-aaa');
    expect(again.httpStatus).toBe(200);

    const conflict = runtime.linkGroup('off_1', 'zgr-bbb');
    expect(conflict.httpStatus).toBe(409);

    const pending = runtime.linkGroup('off_2');
    expect(pending.body.pending).toBe(true);
    expect(runtime.status().pending_link).toBe(true);
    db.close();
  });
});
