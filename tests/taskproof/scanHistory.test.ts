import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/records/store';
import { setTaskproofSetting } from '../../src/taskproof/records/settings';
import { handleTaskproofCommand } from '../../src/taskproof/commands';
import { extractWebhookInbound } from '../../src/taskproof/commands/payload';
import { ImageScore } from '../../src/taskproof/worker/imageMatch';
import { ingestProofImage } from '../../src/taskproof/worker/proofIngest';
import { WorkerRuntime } from '../../src/taskproof/worker/runtime';
import {
  historyWasTruncated,
  scanGroupHistoryForTask,
  selectLookbackImages,
  takeRecentMessages,
} from '../../src/taskproof/worker/scanHistory';
import { saveSession } from '../../src/taskproof/worker/session';
import { historyFetchCount, HISTORY_API_MAX_COUNT } from '../../src/taskproof/quet';
import {
  buildRecentGroupParams,
  capHistoryCount,
  formatHistoryApiError,
  recentGroupHosts,
  unwrapHistoryPayload,
  ZcaInboundMessage,
  ZcaLoginPort,
} from '../../src/taskproof/worker/zcaAdapter';

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
  opts: { id?: string; code?: string; caption?: string; required?: number; zca?: string } = {}
): void {
  const zca = opts.zca ?? 'zgr-1';
  db.prepare(
    `INSERT OR IGNORE INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at)
     VALUES ('off_group', ?, 'G', 1)`
  ).run(zca);
  db.prepare(
    `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
      link, reference_text, required_count, deadline, status, created_at)
     VALUES (?, ?, 'off_group', ?, 'rep', 'https://x', ?, ?, 9_999_999, 'collecting', 10)`
  ).run(opts.id ?? 't1', opts.code ?? 'ABC123', zca, opts.caption ?? 'TEST TASK PROOF OCR', opts.required ?? 5);
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

function inboundImage(overrides: Partial<ZcaInboundMessage> = {}): ZcaInboundMessage {
  return {
    threadId: 'zgr-1',
    isGroup: true,
    text: '',
    displayName: 'An',
    hasImage: true,
    msgId: 'msg-1',
    uidFrom: 'u1',
    href: 'https://cdn.example/photo.jpg',
    ts: 4_000,
    ...overrides,
  };
}

function groupText(text: string) {
  const inbound = extractWebhookInbound({
    message: {
      text,
      chat: { id: 'off_group', chat_type: 'GROUP' },
      from: { id: 'manager_1' },
    },
  });
  if (!inbound) throw new Error('expected inbound');
  return inbound;
}

const ADMIN = 'admin_dm';

function adminText(text: string) {
  const inbound = extractWebhookInbound({
    message: {
      text,
      chat: { id: ADMIN, chat_type: 'PRIVATE' },
      from: { id: ADMIN },
    },
  });
  if (!inbound) throw new Error('expected inbound');
  return inbound;
}

describe('task-proof /quet history scan', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('caps getrecentv2 count at 50 (Zalo rejects larger pages)', () => {
    expect(HISTORY_API_MAX_COUNT).toBe(50);
    expect(capHistoryCount(150)).toBe(50);
    expect(capHistoryCount(0)).toBe(50);
    expect(historyFetchCount(5)).toBe(5);
    expect(historyFetchCount(20)).toBe(20);
    expect(historyFetchCount(150)).toBe(50);
  });

  it('builds zlapi getRecentGroup params and prefers group_cloud_message host', () => {
    expect(buildRecentGroupParams('5086051736259524586', 150, 'imei-1')).toEqual({
      groupId: '5086051736259524586',
      globalMsgId: 10000000000000000,
      count: 50,
      msgIds: [],
      imei: 'imei-1',
      src: 1,
    });
    expect(
      recentGroupHosts({
        group_cloud_message: ['https://tt-group-cm.chat.zalo.me/'],
        group: ['https://tt-group-wpa.chat.zalo.me'],
      })
    ).toEqual(['https://tt-group-cm.chat.zalo.me']);
  });

  it('formats getrecentv2 Zalo errors with the API code', () => {
    const err = Object.assign(new Error('Lỗi không xác định error'), { code: 100 });
    expect(formatHistoryApiError(err)).toContain('#100');
    expect(formatHistoryApiError(err)).toContain('Lỗi không xác định');
    expect(formatHistoryApiError(err)).toContain('/nhac');
  });

  it('unwraps nested getrecentv2 payloads into groupMsgs', () => {
    expect(unwrapHistoryPayload({ groupMsgs: [{ msgId: '1' }], more: 1 })).toEqual({
      groupMsgs: [{ msgId: '1' }],
      more: 1,
    });
    expect(
      unwrapHistoryPayload({ error_code: 0, data: JSON.stringify({ groupMsgs: [{ msgId: '2' }], more: 0 }) })
    ).toEqual({ groupMsgs: [{ msgId: '2' }], more: 0 });
    expect(unwrapHistoryPayload({ msgs: [{ msgId: '3' }] }).groupMsgs).toEqual([{ msgId: '3' }]);
  });

  it('keeps only the newest requested messages when Zalo returns a larger page', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-'));
    dirs.push(proofDir);
    seedOpenTask(db, { id: 't1', caption: 'TEST TASK PROOF OCR', required: 20 });
    seedSample(db, proofDir);
    const messages = Array.from({ length: 20 }, (_, i) =>
      inboundImage({
        msgId: `m${i}`,
        uidFrom: `u${i}`,
        displayName: `N${i}`,
        ts: 1_000 + i,
      })
    );
    expect(takeRecentMessages(messages, 5).map((m) => m.msgId)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19']);

    const scoreImages = vi.fn(() => passScore());
    const summary = await scanGroupHistoryForTask(
      db,
      {
        taskId: 't1',
        shortCode: 'ABC123',
        zcaGroupId: 'zgr-1',
        count: 5,
        messages,
      },
      {
        now: () => 10 * 60 * 1000,
        proofDir,
        scoreImages,
        downloadImage: async () => PNG,
      }
    );
    expect(summary.scanned).toBe(5);
    expect(scoreImages).toHaveBeenCalledTimes(5);
    const rows = db.prepare(`SELECT uid_from FROM submissions WHERE task_id = 't1' AND proof_origin = 'group' ORDER BY uid_from`).all() as Array<{
      uid_from: string;
    }>;
    expect(rows.map((row) => row.uid_from)).toEqual(['u15', 'u16', 'u17', 'u18', 'u19']);
    db.close();
  });

  it('keeps images from the fetched page and skips link cards', () => {
    const kept = selectLookbackImages([
      inboundImage({ msgId: 'old', ts: 1_000 }),
      inboundImage({ msgId: 'ok', ts: 2_000 }),
      inboundImage({ msgId: 'card', ts: 3_000, isLinkCard: true, hasImage: false }),
      inboundImage({ msgId: 'cmd', ts: 4_000, hasImage: false, text: '/quet ABC123' }),
    ]);
    expect(kept.map((m) => m.msgId)).toEqual(['old', 'ok']);
  });

  it('flags truncation only when the 50-message cap still has more history', () => {
    expect(historyWasTruncated([inboundImage(), inboundImage()], 50, 1)).toBe(true);
    expect(historyWasTruncated(Array.from({ length: 50 }, (_, i) => inboundImage({ msgId: `m${i}` })), 50, 0)).toBe(
      true
    );
    expect(historyWasTruncated([inboundImage()], 5, 1)).toBe(false);
    expect(historyWasTruncated([inboundImage()], 50, 0)).toBe(false);
  });

  it('records a matching lookback photo for the named task only', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-'));
    dirs.push(proofDir);
    seedOpenTask(db, { id: 't1', caption: 'TEST TASK PROOF OCR' });
    seedOpenTask(db, { id: 't2', code: 'OTH001', caption: 'HOAN TOAN KHAC' });
    seedSample(db, proofDir, 't1');

    const summary = await scanGroupHistoryForTask(
      db,
      {
        taskId: 't1',
        shortCode: 'ABC123',
        zcaGroupId: 'zgr-1',
        count: 5,
        messages: [inboundImage({ ts: 8 * 60 * 1000 })],
      },
      {
        now: () => 10 * 60 * 1000,
        proofDir,
        scoreImages: () => passScore(),
        downloadImage: async () => PNG,
      }
    );
    expect(summary).toMatchObject({ recorded: 1, scanned: 1, closed: false });
    const rows = db.prepare(`SELECT task_id FROM submissions WHERE proof_origin = 'group'`).all() as Array<{ task_id: string }>;
    expect(rows).toEqual([{ task_id: 't1' }]);
    db.close();
  });

  it('rematches a photo that live ingest already marked processed below threshold', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-'));
    dirs.push(proofDir);
    seedOpenTask(db, { id: 'old', code: 'OLD001', caption: 'BAI CU' });
    seedSample(db, proofDir, 'old');

    const live = await ingestProofImage(
      db,
      {
        threadId: 'zgr-1',
        msgId: 'early-1',
        uidFrom: 'u9',
        displayName: 'Bin',
        href: 'https://cdn.example/early.jpg',
      },
      {
        proofDir,
        scoreImages: async () => ({ score: 0.2, decision: 'FAIL' }),
        downloadImage: async () => PNG,
      }
    );
    expect(live).toEqual({ outcome: 'discarded', reason: 'below_threshold' });

    seedOpenTask(db, { id: 't1', code: 'ABC123', caption: 'TEST TASK PROOF OCR' });
    seedSample(db, proofDir, 't1');
    const summary = await scanGroupHistoryForTask(
      db,
      {
        taskId: 't1',
        shortCode: 'ABC123',
        zcaGroupId: 'zgr-1',
        count: 5,
        messages: [inboundImage({ msgId: 'early-1', uidFrom: 'u9', displayName: 'Bin', ts: 8 * 60 * 1000 })],
      },
      {
        now: () => 10 * 60 * 1000,
        proofDir,
        scoreImages: () => passScore(),
        downloadImage: async () => PNG,
      }
    );
    expect(summary.recorded).toBe(1);
    const row = db.prepare(`SELECT task_id, uid_from FROM submissions WHERE proof_origin = 'group'`).get() as {
      task_id: string;
      uid_from: string;
    };
    expect(row).toEqual({ task_id: 't1', uid_from: 'u9' });
    db.close();
  });

  it('skips uids who already submitted this task', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-'));
    dirs.push(proofDir);
    seedOpenTask(db, { required: 5 });
    db.prepare(
      `INSERT INTO submissions (id, task_id, uid_from, display_name, image_url, match_score, created_at)
       VALUES ('s1', 't1', 'u1', 'An', 'https://img', 0.9, 1)`
    ).run();

    const summary = await scanGroupHistoryForTask(
      db,
      {
        taskId: 't1',
        shortCode: 'ABC123',
        zcaGroupId: 'zgr-1',
        count: 5,
        messages: [inboundImage({ ts: 8 * 60 * 1000 })],
      },
      { proofDir, downloadImage: async () => PNG }
    );
    expect(summary.skipped).toBe(1);
    db.close();
  });

  it('handles duplicate images from the same user by recording only the first one', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-'));
    dirs.push(proofDir);
    seedOpenTask(db, { id: 't1', caption: 'TEST TASK PROOF OCR', required: 5 });
    seedSample(db, proofDir);

    const summary = await scanGroupHistoryForTask(
      db,
      {
        taskId: 't1',
        shortCode: 'ABC123',
        zcaGroupId: 'zgr-1',
        count: 5,
        messages: [
          inboundImage({ msgId: 'img-1', uidFrom: 'u1', displayName: 'An', ts: 8 * 60 * 1000 }),
          inboundImage({ msgId: 'img-2', uidFrom: 'u1', displayName: 'An', ts: 9 * 60 * 1000 }),
        ],
      },
      {
        now: () => 10 * 60 * 1000,
        proofDir,
        scoreImages: () => passScore(),
        downloadImage: async () => PNG,
      }
    );

    expect(summary.scanned).toBe(2);
    expect(summary.recorded).toBe(1);
    expect(summary.skipped).toBe(1);

    const rows = db.prepare(`SELECT task_id, uid_from FROM submissions WHERE task_id = 't1' AND proof_origin = 'group'`).all() as Array<{
      task_id: string;
      uid_from: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].uid_from).toBe('u1');
    db.close();
  });

  it('filters out bot uids and uid=0 from lookback images', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-'));
    dirs.push(proofDir);
    seedOpenTask(db, { id: 't1', caption: 'TEST TASK PROOF OCR', required: 5 });
    setTaskproofSetting('zca_own_uid', 'bot_own', db);
    setTaskproofSetting('official_bot_uid', 'bot_official', db);
    setTaskproofSetting('remind_exclude_uids', ['excluded_user'], db);

    seedSample(db, proofDir);
    const scoreImages = vi.fn(() => passScore());
    const summary = await scanGroupHistoryForTask(
      db,
      {
        taskId: 't1',
        shortCode: 'ABC123',
        zcaGroupId: 'zgr-1',
        count: 10,
        messages: [
          inboundImage({ msgId: 'm-self', uidFrom: '0' }),
          inboundImage({ msgId: 'm-own', uidFrom: 'bot_own' }),
          inboundImage({ msgId: 'm-off', uidFrom: 'bot_official' }),
          inboundImage({ msgId: 'm-exc', uidFrom: 'excluded_user' }),
          inboundImage({ msgId: 'm-valid', uidFrom: 'valid_user', displayName: 'Valid' }),
        ],
      },
      {
        now: () => 10 * 60 * 1000,
        proofDir,
        scoreImages,
        downloadImage: async () => PNG,
      }
    );

    expect(summary.scanned).toBe(1);
    expect(summary.recorded).toBe(1);
    expect(scoreImages).toHaveBeenCalledTimes(1);

    const rows = db.prepare(`SELECT uid_from FROM submissions WHERE task_id = 't1' AND proof_origin = 'group'`).all() as Array<{
      uid_from: string;
    }>;
    expect(rows).toEqual([{ uid_from: 'valid_user' }]);
    db.close();
  });

  it('observes and records senders from group history scan into member cache', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-'));
    dirs.push(proofDir);
    seedOpenTask(db, { id: 't1', caption: 'TEST TASK PROOF OCR', required: 5 });
    seedSample(db, proofDir);

    const scoreImages = vi.fn(() => passScore());
    const summary = await scanGroupHistoryForTask(
      db,
      {
        taskId: 't1',
        shortCode: 'ABC123',
        zcaGroupId: 'zgr-1',
        count: 5,
        messages: [
          inboundImage({ msgId: 'm-member-1', uidFrom: '10001', displayName: 'Member 1' }),
          inboundImage({ msgId: 'm-member-2', uidFrom: '10002', displayName: 'Member 2' }),
        ],
      },
      {
        now: () => 10 * 60 * 1000,
        proofDir,
        scoreImages,
        downloadImage: async () => PNG,
      }
    );

    expect(summary.scanned).toBe(2);
    expect(summary.recorded).toBe(2);
    expect(scoreImages).toHaveBeenCalledTimes(2);

    const rows = db.prepare(`SELECT uid_from FROM submissions WHERE task_id = 't1' AND proof_origin = 'group' ORDER BY uid_from`).all() as Array<{
      uid_from: string;
    }>;
    expect(rows).toEqual([{ uid_from: '10001' }, { uid_from: '10002' }]);

    const cached = db.prepare(`SELECT user_id, display_name FROM group_members_cache WHERE zca_group_id = 'zgr-1' ORDER BY user_id`).all();
    expect(cached).toEqual([
      { user_id: '10001', display_name: 'Member 1' },
      { user_id: '10002', display_name: 'Member 2' },
    ]);
    db.close();
  });

  it('runtime handleZcaMessage ignores messages from bot or uid=0', () => {
    const db = openDb();
    seedOpenTask(db, { id: 't1', zca: 'zgr-1' });
    setTaskproofSetting('zca_own_uid', 'bot_zca', db);

    const runtime = new WorkerRuntime({
      db,
      loginPort: { login: async () => undefined, loginQR: async () => ({ cookie: [], imei: 'i', userAgent: 'ua' }) },
      now: () => 5_000,
      getSessionFilePath: () => '/dev/null',
      getAdminChatId: () => 'admin',
      getPublicBaseUrl: () => 'https://example.test',
      getProofDir: () => '/dev/null',
      downloadImage: async () => PNG,
      postScanResult: async () => ({}),
      kickReport: async () => undefined,
      scheduleInterval: () => () => undefined,
    });

    const selfRes = runtime.handleZcaMessage(inboundImage({ uidFrom: '0' }));
    expect(selfRes.proof).toBe(false);

    const botRes = runtime.handleZcaMessage(inboundImage({ uidFrom: 'bot_zca' }));
    expect(botRes.proof).toBe(false);

    const cached = db.prepare(`SELECT user_id FROM group_members_cache WHERE zca_group_id = 'zgr-1'`).all();
    expect(cached).toEqual([]);

    const validRes = runtime.handleZcaMessage(inboundImage({ uidFrom: 'valid_user', displayName: 'Valid' }));
    expect(validRes.proof).toBe(true);

    const cachedAfter = db.prepare(`SELECT user_id FROM group_members_cache WHERE zca_group_id = 'zgr-1'`).all();
    expect(cachedAfter).toEqual([{ user_id: 'valid_user' }]);

    db.close();
  });

  it('runtime fetch posts scan-result and can close quota', async () => {
    const db = openDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-rt-'));
    dirs.push(dir);
    seedOpenTask(db, { required: 1 });
    seedSample(db, dir);
    saveSession({ cookie: [], imei: 'i', userAgent: 'ua' }, path.join(dir, 'zca-session.json'));
    const postScanResult = vi.fn().mockResolvedValue({});
    const kickReport = vi.fn().mockResolvedValue(undefined);
    const port: ZcaLoginPort = {
      login: async () => undefined,
      loginQR: async () => ({ cookie: [], imei: 'i', userAgent: 'ua' }),
      getGroupChatHistory: async () => ({
        more: 0,
        messages: [inboundImage({ ts: 4_000 })],
      }),
    };
    const runtime = new WorkerRuntime({
      db,
      loginPort: port,
      now: () => 5_000,
      getSessionFilePath: () => path.join(dir, 'zca-session.json'),
      getAdminChatId: () => 'admin',
      getPublicBaseUrl: () => 'https://example.test',
      getProofDir: () => dir,
      scoreImages: () => passScore(),
      downloadImage: async () => PNG,
      postScanResult,
      kickReport,
      scheduleInterval: () => () => undefined,
    });
    await runtime.ensureListening();
    const result = await runtime.scanHistory('t1', 5, 'off_group');
    expect(result).toMatchObject({ recorded: 1, closed: true, httpStatus: 200 });
    expect(kickReport).toHaveBeenCalledWith('t1');
    expect(postScanResult).toHaveBeenCalledWith(
      expect.objectContaining({ reply_chat_id: 'off_group', recorded: 1, closed: true })
    );
    db.close();
  });

  it('runs /quet photos on the same single ingest slot as a live photo', async () => {
    const db = openDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-slot-'));
    dirs.push(dir);
    seedOpenTask(db, { required: 5 });
    seedSample(db, dir);
    saveSession({ cookie: [], imei: 'i', userAgent: 'ua' }, path.join(dir, 'zca-session.json'));
    const pending: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    let hold = true;
    const seen: string[] = [];
    const port: ZcaLoginPort = {
      login: async () => undefined,
      loginQR: async () => ({ cookie: [], imei: 'i', userAgent: 'ua' }),
      getGroupChatHistory: async () => ({
        more: 0,
        messages: [
          inboundImage({ msgId: 'a', uidFrom: 'u1', href: 'https://cdn.example/a.jpg', ts: 1 }),
          inboundImage({ msgId: 'b', uidFrom: 'u2', href: 'https://cdn.example/b.jpg', ts: 2 }),
        ],
      }),
    };
    const runtime = new WorkerRuntime({
      db,
      loginPort: port,
      now: () => 5_000,
      getSessionFilePath: () => path.join(dir, 'zca-session.json'),
      getAdminChatId: () => 'admin',
      getPublicBaseUrl: () => 'https://example.test',
      getProofDir: () => dir,
      scoreImages: () => passScore(),
      downloadImage: async (url: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seen.push(`start ${url}`);
        if (hold) await new Promise<void>((resolve) => pending.push(resolve));
        active -= 1;
        seen.push(`end ${url}`);
        return PNG;
      },
      postScanResult: async () => ({}),
      kickReport: async () => undefined,
      scheduleInterval: () => () => undefined,
    });
    await runtime.ensureListening();
    const scan = runtime.scanHistory('t1', 5, 'off_group');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(seen).toEqual(['start https://cdn.example/a.jpg']);
    const live = runtime.handleZcaMessage(
      inboundImage({ msgId: 'live', uidFrom: 'u9', href: 'https://cdn.example/live.jpg' })
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(maxActive).toBe(1);
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    await vi.waitFor(() => expect(seen.filter((row) => row.startsWith('start'))).toHaveLength(2));
    expect(seen.filter((row) => row.startsWith('start'))[1]).toBe('start https://cdn.example/live.jpg');
    expect(maxActive).toBe(1);
    hold = false;
    pending.splice(0).forEach((release) => release());
    const summary = await scan;
    if (live.job) await live.job;
    expect(maxActive).toBe(1);
    expect(summary.recorded).toBe(2);
    db.close();
  });

  describe('official bot /quet', () => {
    it('ensure-listening then scan-history with count and reply chat', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const ensureListening = vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} });
      const scanHistory = vi.fn().mockResolvedValue({ status: 202, json: { state: 'scanning' } });
      const handled = await handleTaskproofCommand(adminText('/quet abc123 20'), {
        sendMessage,
        getAdminChatId: () => ADMIN,
        ensureListening,
        scanHistory,
        lookupTask: (code) =>
          code === 'ABC123'
            ? { id: 'task-1', short_code: 'ABC123', status: 'collecting', zca_group_id: 'zgr-1' }
            : null,
      });
      expect(handled).toBe(true);
      expect(ensureListening).toHaveBeenCalledOnce();
      expect(scanHistory).toHaveBeenCalledWith('task-1', 20, ADMIN);
      expect(sendMessage.mock.calls[0][1]).toMatch(/Đang quét 20 tin/);
    });

    it('does not call worker when the worker is down', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const scanHistory = vi.fn();
      await handleTaskproofCommand(adminText('/quet ABC123'), {
        sendMessage,
        getAdminChatId: () => ADMIN,
        scanHistory,
        ensureListening: async () => {
          throw new Error('ECONNREFUSED');
        },
        lookupTask: () => ({
          id: 't1',
          short_code: 'ABC123',
          status: 'collecting',
          zca_group_id: 'zgr-1',
        }),
      });
      expect(scanHistory).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toMatch(/Worker không chạy/);
    });
  });
});
