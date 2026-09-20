import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import { cookieHeaderFromCredentials, downloadImageBytes, isGifUrl } from '../../src/taskproof/worker/imageFetch';
import { ingestProofImage } from '../../src/taskproof/worker/proofIngest';
import { WorkerRuntime } from '../../src/taskproof/worker/runtime';
import { saveSession } from '../../src/taskproof/worker/session';
import { normalizeZcaInbound, ZcaLoginPort } from '../../src/taskproof/worker/zcaAdapter';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function openDb(): Database.Database {
  const db = new Database(':memory:');
  configureSqliteConnection(db);
  initTables(db);
  initTaskproofTables(db);
  return db;
}

function seedOpenTask(
  db: Database.Database,
  opts: {
    id?: string;
    code?: string;
    caption?: string;
    required?: number;
    createdAt?: number;
    zca?: string;
    official?: string;
  } = {}
): void {
  const zca = opts.zca ?? 'zgr-1';
  const official = opts.official ?? 'off_group';
  db.prepare(
    `INSERT OR IGNORE INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at)
     VALUES (?, ?, 'G', 1)`
  ).run(official, zca);
  db.prepare(
    `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
      link, reference_text, required_count, deadline, status, created_at)
     VALUES (?, ?, ?, ?, 'rep', 'https://x', ?, ?, 9_999_999, 'collecting', ?)`
  ).run(
    opts.id ?? 't1',
    opts.code ?? 'ABC123',
    official,
    zca,
    opts.caption ?? 'TEST TASK PROOF OCR',
    opts.required ?? 1,
    opts.createdAt ?? 10
  );
}

function proofImage(overrides: Partial<Parameters<typeof ingestProofImage>[1]> = {}) {
  return {
    threadId: 'zgr-1',
    msgId: 'msg-1',
    uidFrom: 'u1',
    displayName: 'An',
    href: 'https://cdn.example/photo.jpg',
    ...overrides,
  };
}

describe('task-proof OCR queue + file store + quota (Step 9)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('records a matching screenshot, writes PROOF_DIR/{task_id}/{id}.jpg, and closes at quota', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    dirs.push(proofDir);
    seedOpenTask(db, { required: 1 });

    const result = await ingestProofImage(db, proofImage(), {
      now: () => 100,
      proofDir,
      newId: () => 'sub-1',
      ocrImage: async () => 'chrome UI TEST TASK PROOF OCR xem them',
      downloadImage: async () => PNG,
    });

    expect(result).toMatchObject({
      outcome: 'recorded',
      taskId: 't1',
      submissionId: 'sub-1',
      closed: true,
      score: 1,
    });
    const stored = path.join(proofDir, 't1', 'sub-1.jpg');
    expect(fs.readFileSync(stored).equals(PNG)).toBe(true);
    const task = db.prepare(`SELECT status FROM tasks WHERE id = 't1'`).get() as { status: string };
    expect(task.status).toBe('completed');
    const n = (
      db.prepare(`SELECT COUNT(*) AS n FROM processed_messages`).get() as { n: number }
    ).n;
    expect(n).toBe(1);
    db.close();
  });

  it('writes processed_messages before OCR so a crash retry is at-most-once', async () => {
    const db = openDb();
    seedOpenTask(db);
    const ocrImage = vi.fn(async () => {
      throw new Error('tesseract down');
    });

    const first = await ingestProofImage(db, proofImage(), {
      ocrImage,
      downloadImage: async () => PNG,
      proofDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-')),
    });
    expect(first).toEqual({ outcome: 'discarded', reason: 'ocr_failed' });
    expect(ocrImage).toHaveBeenCalledOnce();

    ocrImage.mockClear();
    const retry = await ingestProofImage(db, proofImage(), {
      ocrImage,
      downloadImage: async () => PNG,
      proofDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-')),
    });
    expect(retry).toEqual({ outcome: 'skipped', reason: 'already_processed' });
    expect(ocrImage).not.toHaveBeenCalled();
    const submissions = db.prepare(`SELECT COUNT(*) AS n FROM submissions`).get() as { n: number };
    expect(submissions.n).toBe(0);
    db.close();
  });

  it('discards below-threshold images with no submission and no task change', async () => {
    const db = openDb();
    seedOpenTask(db, { caption: 'BỘ TƯ LỆNH THÀNH PHỐ CỤM THI ĐUA' });
    const result = await ingestProofImage(db, proofImage(), {
      ocrImage: async () => 'hoan toan khac bai viet nay',
      downloadImage: async () => PNG,
      proofDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-')),
    });
    expect(result).toEqual({ outcome: 'discarded', reason: 'below_threshold' });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM submissions`).get() as { n: number }).n).toBe(0);
    expect(
      (db.prepare(`SELECT status FROM tasks WHERE id = 't1'`).get() as { status: string }).status
    ).toBe('collecting');
    db.close();
  });

  it('overwrites the same uid_from and assigns the earlier task on an exact score tie', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    dirs.push(proofDir);
    seedOpenTask(db, { id: 'early', code: 'EAR001', caption: 'SAME CAPTION', createdAt: 1, required: 5 });
    seedOpenTask(db, { id: 'late', code: 'LAT001', caption: 'SAME CAPTION', createdAt: 2, required: 5 });

    const first = await ingestProofImage(db, proofImage({ msgId: 'm1' }), {
      now: () => 50,
      proofDir,
      newId: () => 'keep-id',
      ocrImage: async () => 'SAME CAPTION',
      downloadImage: async () => PNG,
    });
    expect(first).toMatchObject({ outcome: 'recorded', taskId: 'early', submissionId: 'keep-id', closed: false });

    const bigger = Buffer.concat([PNG, Buffer.from('x')]);
    const second = await ingestProofImage(db, proofImage({ msgId: 'm2', displayName: 'An 2' }), {
      now: () => 60,
      proofDir,
      newId: () => 'should-not-use',
      ocrImage: async () => 'SAME CAPTION',
      downloadImage: async () => bigger,
    });
    expect(second).toMatchObject({ outcome: 'recorded', taskId: 'early', submissionId: 'keep-id' });

    const rows = db.prepare(`SELECT id, task_id, uid_from, match_score FROM submissions`).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'keep-id', task_id: 'early', uid_from: 'u1' });
    expect(fs.readFileSync(path.join(proofDir, 'early', 'keep-id.jpg')).equals(bigger)).toBe(true);
    db.close();
  });

  it('does not OCR an unmapped group and does not claim processed_messages', async () => {
    const db = openDb();
    seedOpenTask(db, { zca: 'zgr-known' });
    const ocrImage = vi.fn(async () => 'TEST TASK PROOF OCR');
    const result = await ingestProofImage(db, proofImage({ threadId: 'zgr-unknown' }), {
      ocrImage,
      downloadImage: async () => PNG,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'unmapped_or_closed' });
    expect(ocrImage).not.toHaveBeenCalled();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM processed_messages`).get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('skips GIFs in normalizeZcaInbound and does not fetch gif URLs', async () => {
    const gif = normalizeZcaInbound({
      type: 1,
      threadId: 'zgr-1',
      data: {
        msgId: 'g1',
        uidFrom: 'u1',
        dName: 'An',
        msgType: 'chat.gif',
        content: { href: 'https://cdn.example/a.gif', thumb: 'https://cdn.example/a.gif', type: 'gif' },
      },
    });
    expect(gif.hasImage).toBe(false);
    expect(isGifUrl('https://cdn.example/a.gif')).toBe(true);

    const photo = normalizeZcaInbound({
      type: 1,
      threadId: 'zgr-1',
      data: {
        msgId: 'p1',
        uidFrom: 'u1',
        dName: 'An',
        content: { href: 'https://cdn.example/a.jpg', thumb: 'https://cdn.example/t.jpg', type: 'photo' },
      },
    });
    expect(photo.hasImage).toBe(true);
    expect(photo.href).toBe('https://cdn.example/a.jpg');
    expect(photo.msgId).toBe('p1');
    expect(photo.uidFrom).toBe('u1');
  });

  it('falls back to thumb when href fails and sends session cookies', async () => {
    const hrefFail = await downloadImageBytes('https://cdn.example/href.jpg', {
      fetchImpl: (async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch,
    });
    expect(hrefFail).toBeNull();

    const cookie = cookieHeaderFromCredentials([{ name: 'zpw', value: 'abc' }]);
    expect(cookie).toBe('zpw=abc');

    const db = openDb();
    seedOpenTask(db);
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    dirs.push(proofDir);
    const urls: string[] = [];
    const result = await ingestProofImage(
      db,
      proofImage({ href: 'https://cdn.example/href.jpg', thumb: 'https://cdn.example/thumb.jpg' }),
      {
        proofDir,
        ocrImage: async () => 'TEST TASK PROOF OCR',
        downloadImage: async (url) => {
          urls.push(url);
          if (url.includes('href')) return null;
          return PNG;
        },
      }
    );
    expect(urls).toEqual(['https://cdn.example/href.jpg', 'https://cdn.example/thumb.jpg']);
    expect(result.outcome).toBe('recorded');
    db.close();
  });

  it('logs the worker out after quota closes the last linked open task', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sess-'));
    dirs.push(proofDir, sessionDir);
    seedOpenTask(db, { required: 1 });
    saveSession({ cookie: [], imei: 'i', userAgent: 'ua' }, path.join(sessionDir, 'zca-session.json'));

    const logout = vi.fn();
    const runtime = new WorkerRuntime({
      db,
      loginPort: {
        login: async () => undefined,
        loginQR: async () => ({ cookie: [], imei: 'i', userAgent: 'ua' }),
        logout,
        stopMessageLoop: () => undefined,
        startMessageLoop: () => undefined,
      } as unknown as ZcaLoginPort,
      now: () => 1_000,
      getSessionFilePath: () => path.join(sessionDir, 'zca-session.json'),
      getAdminChatId: () => 'admin',
      getPublicBaseUrl: () => 'https://example.test',
      getProofDir: () => proofDir,
      scheduleInterval: () => () => undefined,
      ocrImage: async () => 'TEST TASK PROOF OCR',
      downloadImage: async () => PNG,
    });
    await runtime.ensureListening();
    expect(runtime.isLoggedIn()).toBe(true);

    const handled = runtime.handleZcaMessage({
      threadId: 'zgr-1',
      isGroup: true,
      text: '',
      displayName: 'An',
      hasImage: true,
      msgId: 'msg-live',
      uidFrom: 'u9',
      href: 'https://cdn.example/p.jpg',
    });
    expect(handled.ocr).toBe(true);
    const job = await handled.job;
    expect(job).toMatchObject({ outcome: 'recorded', closed: true });
    expect(runtime.isLoggedIn()).toBe(false);
    expect(logout).toHaveBeenCalled();
    expect(fs.existsSync(path.join(sessionDir, 'zca-session.json'))).toBe(true);
    db.close();
  });
});
