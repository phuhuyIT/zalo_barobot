import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import { handleTaskproofCommand } from '../../src/taskproof/commands';
import { extractWebhookInbound } from '../../src/taskproof/commands/payload';
import { ingestProofImage } from '../../src/taskproof/worker/proofIngest';
import { WorkerRuntime } from '../../src/taskproof/worker/runtime';
import {
  historyWasTruncated,
  scanGroupHistoryForTask,
  selectLookbackImages,
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
        ocrImage: async () => 'chrome UI TEST TASK PROOF OCR xem them',
        downloadImage: async () => PNG,
      }
    );
    expect(summary).toMatchObject({ recorded: 1, scanned: 1, closed: false });
    const rows = db.prepare(`SELECT task_id FROM submissions`).all() as Array<{ task_id: string }>;
    expect(rows).toEqual([{ task_id: 't1' }]);
    db.close();
  });

  it('rematches a photo that live ingest already marked processed below threshold', async () => {
    const db = openDb();
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-'));
    dirs.push(proofDir);
    seedOpenTask(db, { id: 'old', code: 'OLD001', caption: 'BAI CU' });

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
        ocrImage: async () => 'TEST TASK PROOF OCR dung caption moi',
        downloadImage: async () => PNG,
      }
    );
    expect(live).toEqual({ outcome: 'discarded', reason: 'below_threshold' });

    seedOpenTask(db, { id: 't1', code: 'ABC123', caption: 'TEST TASK PROOF OCR' });
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
        ocrImage: async () => 'TEST TASK PROOF OCR dung caption moi',
        downloadImage: async () => PNG,
      }
    );
    expect(summary.recorded).toBe(1);
    const row = db.prepare(`SELECT task_id, uid_from FROM submissions`).get() as {
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

    const ocrImage = vi.fn(async () => 'TEST TASK PROOF OCR');
    const summary = await scanGroupHistoryForTask(
      db,
      {
        taskId: 't1',
        shortCode: 'ABC123',
        zcaGroupId: 'zgr-1',
        count: 5,
        messages: [inboundImage({ ts: 8 * 60 * 1000 })],
      },
      { proofDir, ocrImage, downloadImage: async () => PNG }
    );
    expect(summary.skipped).toBe(1);
    expect(ocrImage).not.toHaveBeenCalled();
    db.close();
  });

  it('runtime fetch + OCR posts scan-result and can close quota', async () => {
    const db = openDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quet-rt-'));
    dirs.push(dir);
    seedOpenTask(db, { required: 1 });
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
      ocrImage: async () => 'TEST TASK PROOF OCR',
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

  describe('official bot /quet', () => {
    it('ensure-listening then scan-history with count and reply chat', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const ensureListening = vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} });
      const scanHistory = vi.fn().mockResolvedValue({ status: 202, json: { state: 'scanning' } });
      const handled = await handleTaskproofCommand(groupText('/quet abc123 20'), {
        sendMessage,
        ensureListening,
        scanHistory,
        lookupTask: (code) =>
          code === 'ABC123'
            ? { id: 'task-1', short_code: 'ABC123', status: 'collecting', zca_group_id: 'zgr-1' }
            : null,
      });
      expect(handled).toBe(true);
      expect(ensureListening).toHaveBeenCalledOnce();
      expect(scanHistory).toHaveBeenCalledWith('task-1', 20, 'off_group');
      expect(sendMessage.mock.calls[0][1]).toMatch(/Đang quét 20 tin/);
    });

    it('does not call worker when the worker is down', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const scanHistory = vi.fn();
      await handleTaskproofCommand(groupText('/quet ABC123'), {
        sendMessage,
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
