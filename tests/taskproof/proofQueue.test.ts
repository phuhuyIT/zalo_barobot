import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import {
  cookieHeaderFromCredentials,
  downloadImageBytes,
  isGifUrl,
  isImageHref,
  isZaloMediaHost,
} from '../../src/taskproof/worker/imageFetch';
import { ImageScore } from '../../src/taskproof/worker/imageMatch';
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
    link?: string;
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
     VALUES (?, ?, ?, ?, 'rep', ?, ?, ?, 9_999_999, 'collecting', ?)`
  ).run(
    opts.id ?? 't1',
    opts.code ?? 'ABC123',
    official,
    zca,
    opts.link ?? 'https://x',
    opts.caption ?? 'TEST TASK PROOF OCR',
    opts.required ?? 1,
    opts.createdAt ?? 10
  );
}

function passScore(): Promise<ImageScore> {
  return Promise.resolve({ score: 1, decision: 'PASS' });
}

function seedSample(db: Database.Database, proofDir: string, taskId = 't1'): void {
  const samplePath = path.join(proofDir, taskId, 'sample.jpg');
  fs.mkdirSync(path.dirname(samplePath), { recursive: true });
  fs.writeFileSync(samplePath, PNG);
  db.prepare(
    `INSERT INTO submissions
       (id, task_id, uid_from, display_name, image_url, stored_path, match_score, created_at, proof_origin)
     VALUES (?, ?, 'admin', 'Admin', 'sample://admin', ?, 1, 1, 'sample')`
  ).run(`sample-${taskId}`, taskId, samplePath);
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

describe('task-proof image queue + file store + quota (Step 9)', () => {
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
    seedSample(db, proofDir);

    const kickReport = vi.fn().mockResolvedValue(undefined);
    const result = await ingestProofImage(db, proofImage(), {
      now: () => 100,
      proofDir,
      newId: () => 'sub-1',
      scoreImages: () => passScore(),
      downloadImage: async () => PNG,
      kickReport,
    });

    expect(result).toMatchObject({
      outcome: 'recorded',
      taskId: 't1',
      submissionId: 'sub-1',
      closed: true,
      score: 1,
    });
    expect(kickReport).toHaveBeenCalledWith('t1');
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

  it('does not claim processed_messages when the open task has no sample image', async () => {
    const db = openDb();
    seedOpenTask(db);
    const result = await ingestProofImage(db, proofImage(), {
      scoreImages: () => passScore(),
      downloadImage: async () => PNG,
      proofDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-')),
    });
    expect(result).toEqual({ outcome: 'discarded', reason: 'no_reference' });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM processed_messages`).get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('scores a group photo against tasks.sample_stored_path with no sample submission', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    dirs.push(proofDir);
    seedOpenTask(db, { required: 5 });
    const samplePath = path.join(proofDir, 't1', 'sample.jpg');
    fs.mkdirSync(path.dirname(samplePath), { recursive: true });
    fs.writeFileSync(samplePath, PNG);
    db.prepare(`UPDATE tasks SET sample_stored_path = ? WHERE id = 't1'`).run(samplePath);

    const result = await ingestProofImage(db, proofImage(), {
      now: () => 100,
      proofDir,
      newId: () => 'sub-1',
      scoreImages: () => passScore(),
      downloadImage: async () => PNG,
    });

    expect(result).toMatchObject({ outcome: 'recorded', taskId: 't1', submissionId: 'sub-1', score: 1 });
    db.close();
  });

  it('does not claim processed_messages when image match fails so a retry can run', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    dirs.push(proofDir);
    seedOpenTask(db);
    seedSample(db, proofDir);
    const scoreImages = vi.fn<() => Promise<ImageScore>>();
    scoreImages.mockRejectedValueOnce(new Error('opencv down'));

    const first = await ingestProofImage(db, proofImage(), {
      scoreImages,
      downloadImage: async () => PNG,
      proofDir,
    });
    expect(first).toEqual({ outcome: 'discarded', reason: 'image_match_failed' });
    expect(scoreImages).toHaveBeenCalledOnce();
    const claimed = (
      db.prepare(`SELECT COUNT(*) AS n FROM processed_messages`).get() as { n: number }
    ).n;
    expect(claimed).toBe(0);

    scoreImages.mockReset();
    scoreImages.mockResolvedValueOnce({ score: 1, decision: 'PASS' });
    const retry = await ingestProofImage(db, proofImage(), {
      scoreImages,
      downloadImage: async () => PNG,
      proofDir,
    });
    expect(retry.outcome).toBe('recorded');
    expect(scoreImages).toHaveBeenCalledOnce();
    db.close();
  });

  it('discards below-threshold images with no submission and no task change', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    dirs.push(proofDir);
    seedOpenTask(db, { caption: 'BỘ TƯ LỆNH THÀNH PHỐ CỤM THI ĐUA' });
    seedSample(db, proofDir);
    const result = await ingestProofImage(db, proofImage(), {
      scoreImages: async () => ({ score: 0.2, decision: 'FAIL' }),
      downloadImage: async () => PNG,
      proofDir,
    });
    expect(result).toEqual({ outcome: 'discarded', reason: 'below_threshold' });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE proof_origin = 'group'`).get() as { n: number }).n).toBe(0);
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
    seedSample(db, proofDir, 'early');
    seedSample(db, proofDir, 'late');

    const first = await ingestProofImage(db, proofImage({ msgId: 'm1' }), {
      now: () => 50,
      proofDir,
      newId: () => 'keep-id',
      scoreImages: () => passScore(),
      downloadImage: async () => PNG,
    });
    expect(first).toMatchObject({ outcome: 'recorded', taskId: 'early', submissionId: 'keep-id', closed: false });

    const bigger = Buffer.concat([PNG, Buffer.from('x')]);
    const second = await ingestProofImage(db, proofImage({ msgId: 'm2', displayName: 'An 2' }), {
      now: () => 60,
      proofDir,
      newId: () => 'should-not-use',
      scoreImages: () => passScore(),
      downloadImage: async () => bigger,
    });
    expect(second).toMatchObject({ outcome: 'recorded', taskId: 'early', submissionId: 'keep-id' });

    const rows = db.prepare(`SELECT id, task_id, uid_from, match_score FROM submissions WHERE proof_origin = 'group'`).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'keep-id', task_id: 'early', uid_from: 'u1' });
    expect(fs.readFileSync(path.join(proofDir, 'early', 'keep-id.jpg')).equals(bigger)).toBe(true);
    db.close();
  });

  it('keeps a sample proof when the same uid sends another group photo', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    dirs.push(proofDir);
    seedOpenTask(db, { caption: 'SAME CAPTION', required: 5 });
    const samplePath = path.join(proofDir, 't1', 'sample.jpg');
    fs.mkdirSync(path.dirname(samplePath), { recursive: true });
    fs.writeFileSync(samplePath, Buffer.from('sample-bytes'));
    db.prepare(
      `INSERT INTO submissions
         (id, task_id, uid_from, display_name, image_url, stored_path, match_score, created_at, proof_origin)
       VALUES ('sample-id', 't1', 'u1', 'Admin', 'sample://admin', ?, 1, 10, 'sample')`
    ).run(samplePath);

    const second = await ingestProofImage(db, proofImage({ msgId: 'm2' }), {
      now: () => 60,
      proofDir,
      scoreImages: () => passScore(),
      downloadImage: async () => PNG,
    });
    expect(second).toEqual({ outcome: 'skipped', reason: 'already_submitted' });
    expect(fs.readFileSync(samplePath).toString()).toBe('sample-bytes');
    const row = db.prepare(`SELECT id, proof_origin FROM submissions`).get() as {
      id: string;
      proof_origin: string;
    };
    expect(row).toEqual({ id: 'sample-id', proof_origin: 'sample' });
    db.close();
  });

  it('does not score an unmapped group and does not claim processed_messages', async () => {
    const db = openDb();
    seedOpenTask(db, { zca: 'zgr-known' });
    const result = await ingestProofImage(db, proofImage({ threadId: 'zgr-unknown' }), {
      downloadImage: async () => PNG,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'unmapped_or_closed' });
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
    expect(photo.isLinkCard).toBe(false);
    expect(photo.href).toBe('https://cdn.example/a.jpg');
    expect(photo.msgId).toBe('p1');
    expect(photo.uidFrom).toBe('u1');

    const undownload = normalizeZcaInbound({
      type: 1,
      threadId: 'zgr-1',
      data: {
        msgId: 'p2',
        uidFrom: 'u1',
        dName: 'An',
        msgType: 'chat.photo.undownload',
        content: {
          params: JSON.stringify({ href: 'https://photo-stal-23.zdn.vn/gr/jpg/x/a.jpg' }),
        },
      },
    });
    expect(undownload.hasImage).toBe(true);
    expect(undownload.isLinkCard).toBe(false);
    expect(undownload.href).toBe('https://photo-stal-23.zdn.vn/gr/jpg/x/a.jpg');

    const album = normalizeZcaInbound({
      type: 1,
      threadId: 'zgr-1',
      data: {
        msgId: 'p3',
        uidFrom: 'u1',
        dName: 'An',
        msgType: 'chat.photo',
        content: [{ href: 'https://zpsocial-f54-org.zadn.vn/file', type: 'photo' }],
      },
    });
    expect(album.hasImage).toBe(true);
    expect(album.href).toBe('https://zpsocial-f54-org.zadn.vn/file');
  });

  it('treats photo-stal and zadn hosts as Zalo media', () => {
    expect(isZaloMediaHost('photo-stal-23.zdn.vn')).toBe(true);
    expect(isZaloMediaHost('zpsocial-f54-org.zadn.vn')).toBe(true);
    expect(isImageHref('https://zpsocial-f54-org.zadn.vn/file')).toBe(true);
    expect(isZaloMediaHost('cdn.example')).toBe(false);
  });

  it('treats chat.link preview cards as not screenshots and does not score them', () => {
    const card = normalizeZcaInbound({
      type: 1,
      threadId: 'zgr-1',
      data: {
        msgId: 'l1',
        uidFrom: 'u1',
        dName: 'An',
        msgType: 'chat.link',
        content: {
          href: 'https://www.facebook.com/share/v/1FS7f9MknZ/',
          thumb: 'https://scontent.xx.fbcdn.net/preview.jpg',
          title: 'video',
          type: 'recommend',
        },
      },
    });
    expect(card.hasImage).toBe(false);
    expect(card.isLinkCard).toBe(true);
  });

  it('handleZcaMessage skips link preview cards (not proof)', async () => {
    const db = openDb();
    seedOpenTask(db, { required: 1, link: 'https://www.facebook.com/share/v/1FS7f9MknZ/' });
    const runtime = new WorkerRuntime({
      db,
      loginPort: {
        login: async () => undefined,
        loginQR: async () => ({ cookie: [], imei: 'i', userAgent: 'ua' }),
        startMessageLoop: () => undefined,
        stopMessageLoop: () => undefined,
      } as unknown as ZcaLoginPort,
      now: () => 1_000,
      getAdminChatId: () => 'admin',
      getPublicBaseUrl: () => 'https://example.test',
    });
    const handled = runtime.handleZcaMessage({
      threadId: 'zgr-1',
      isGroup: true,
      text: '',
      displayName: 'An',
      hasImage: false,
      isLinkCard: true,
      shareHref: 'https://www.facebook.com/share/v/1FS7f9MknZ/',
      msgId: 'card-1',
      uidFrom: 'u4',
    });
    expect(handled.proof).toBe(false);
    expect(handled.job).toBeUndefined();
    db.close();
  });

  it('falls back to thumb when href fails and sends session cookies', async () => {
    const hrefFail = await downloadImageBytes('https://cdn.example/href.jpg', {
      fetchImpl: (async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch,
    });
    expect(hrefFail).toBeNull();

    const cookie = cookieHeaderFromCredentials([{ name: 'zpw', value: 'abc' }]);
    expect(cookie).toBe('zpw=abc');

    const cookies: Array<string | undefined> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      cookies.push(headers?.Cookie);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => PNG,
      };
    }) as unknown as typeof fetch;
    await downloadImageBytes('https://photo-stal-23.zdn.vn/gr/jpg/x/a.jpg', {
      cookieHeader: cookie,
      fetchImpl,
    });
    await downloadImageBytes('https://zpsocial-f54-org.zadn.vn/file', {
      cookieHeader: cookie,
      fetchImpl,
    });
    await downloadImageBytes('https://cdn.example/a.jpg', { cookieHeader: cookie, fetchImpl });
    expect(cookies).toEqual(['zpw=abc', 'zpw=abc', undefined]);

    const db = openDb();
    seedOpenTask(db);
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-proof-'));
    dirs.push(proofDir);
    seedSample(db, proofDir);
    const urls: string[] = [];
    const result = await ingestProofImage(
      db,
      proofImage({ href: 'https://cdn.example/href.jpg', thumb: 'https://cdn.example/thumb.jpg' }),
      {
        proofDir,
        scoreImages: () => passScore(),
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
    seedSample(db, proofDir);
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
      scoreImages: () => passScore(),
      downloadImage: async () => PNG,
      kickReport: vi.fn().mockResolvedValue(undefined),
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
    expect(handled.proof).toBe(true);
    const job = await handled.job;
    expect(job).toMatchObject({ outcome: 'recorded', closed: true });
    expect(runtime.isLoggedIn()).toBe(false);
    expect(logout).toHaveBeenCalled();
    expect(fs.existsSync(path.join(sessionDir, 'zca-session.json'))).toBe(true);
    db.close();
  });
});
