import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import { handleTaskproofCommand } from '../../src/taskproof/commands';
import { extractWebhookInbound } from '../../src/taskproof/commands/payload';
import { WorkerRuntime } from '../../src/taskproof/worker/runtime';
import { shouldScoreZcaGroup } from '../../src/taskproof/worker/groupMap';
import { ZcaLoginPort } from '../../src/taskproof/worker/zcaAdapter';

function inboundFrom(body: unknown) {
  const inbound = extractWebhookInbound(body);
  if (!inbound) throw new Error('expected inbound');
  return inbound;
}

function groupText(text: string, chatId = 'off_group') {
  return inboundFrom({
    message: {
      text,
      chat: { id: chatId, chat_type: 'GROUP' },
      from: { id: 'manager_1' },
    },
  });
}

function openDb(): Database.Database {
  const db = new Database(':memory:');
  configureSqliteConnection(db);
  initTables(db);
  initTaskproofTables(db);
  return db;
}

const muteLogin: ZcaLoginPort = {
  login: async () => undefined,
  loginQR: async () => ({ cookie: [], imei: 'i', userAgent: 'ua' }),
};

describe('task-proof /lienket (Step 6)', () => {
  it('method A opens a 2-minute window and does not wait on QR', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const ensureListening = vi.fn().mockResolvedValue({ status: 200, state: 'qr_required', raw: {} });
    const linkGroup = vi.fn().mockResolvedValue({
      status: 200,
      json: { pending: true, expires_at: Date.now() + 120_000 },
    });

    const started = Date.now();
    const handled = await handleTaskproofCommand(groupText('/lienket'), {
      sendMessage,
      ensureListening,
      linkGroup,
    });
    expect(Date.now() - started).toBeLessThan(200);
    expect(handled).toBe(true);
    expect(linkGroup).toHaveBeenCalledWith('off_group', undefined);
    expect(sendMessage.mock.calls[0][1]).toMatch(/2 phút/);
    expect(sendMessage.mock.calls[0][1]).toMatch(/ok/);
    expect(sendMessage.mock.calls[0][1]).toMatch(/QR/);
  });

  it('method B writes both ids immediately', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const ensureListening = vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} });
    const linkGroup = vi.fn().mockResolvedValue({
      status: 200,
      json: { official_chat_id: 'off_group', zca_group_id: 'zgr-abc' },
    });

    await handleTaskproofCommand(groupText('/lienket zgr-abc'), {
      sendMessage,
      ensureListening,
      linkGroup,
    });
    expect(linkGroup).toHaveBeenCalledWith('off_group', 'zgr-abc');
    expect(sendMessage.mock.calls[0][1]).toBe('Đã liên kết: zgr-abc');
  });

  it('surfaces a mapping conflict without overwriting', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const linkGroup = vi.fn().mockResolvedValue({
      status: 409,
      json: { error: 'official_chat_id already mapped to zgr-old' },
    });
    await handleTaskproofCommand(groupText('/lienket zgr-new'), {
      sendMessage,
      ensureListening: async () => ({ status: 200, state: 'listening', raw: {} }),
      linkGroup,
    });
    expect(sendMessage.mock.calls[0][1]).toMatch(/already mapped/);
  });

  it('does not swallow /gui', async () => {
    const sendMessage = vi.fn();
    const handled = await handleTaskproofCommand(groupText('/gui'), { sendMessage });
    expect(handled).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('method A: next non-command group message captures threadId and fills tasks', async () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at)
       VALUES ('t1', 'ABC123', 'off_group', NULL, 'rep', 'https://x', 'cap', 1, 0, 'collecting', 0)`
    ).run();

    const linkResults: Array<Record<string, unknown>> = [];
    const runtime = new WorkerRuntime({
      db,
      loginPort: muteLogin,
      now: () => 1_000,
      getLinkPendingMs: () => 120_000,
      postLinkResult: async (body) => {
        linkResults.push(body);
      },
    });

    const opened = runtime.linkGroup('off_group');
    expect(opened.body.pending).toBe(true);

    const skipped = runtime.handleZcaMessage({
      threadId: 'zgr-wrong',
      isGroup: true,
      text: '/task hello',
      displayName: 'Bot',
      hasImage: false,
    });
    expect(skipped.linked).toBe(false);

    const dm = runtime.handleZcaMessage({
      threadId: 'user-1',
      isGroup: false,
      text: 'ok',
      displayName: 'A',
      hasImage: false,
    });
    expect(dm.linked).toBe(false);

    const captured = runtime.handleZcaMessage({
      threadId: 'zgr-real',
      isGroup: true,
      text: 'ok',
      displayName: 'Nhóm nhiệm vụ',
      hasImage: false,
    });
    expect(captured.linked).toBe(true);
    expect(linkResults[0]).toMatchObject({
      ok: true,
      official_chat_id: 'off_group',
      zca_group_id: 'zgr-real',
    });

    const map = db
      .prepare(`SELECT zca_group_id FROM group_id_map WHERE official_chat_id = 'off_group'`)
      .get() as { zca_group_id: string };
    expect(map.zca_group_id).toBe('zgr-real');
    const task = db.prepare(`SELECT zca_group_id FROM tasks WHERE id = 't1'`).get() as {
      zca_group_id: string;
    };
    expect(task.zca_group_id).toBe('zgr-real');
    db.close();
  });

  it('times out with link-result failure when no group message arrives', async () => {
    const db = openDb();
    let fire: (() => void) | undefined;
    const linkResults: Array<Record<string, unknown>> = [];
    const runtime = new WorkerRuntime({
      db,
      loginPort: muteLogin,
      now: () => 0,
      getLinkPendingMs: () => 50,
      scheduleTimeout: (fn) => {
        fire = fn;
        return () => undefined;
      },
      postLinkResult: async (body) => {
        linkResults.push(body);
      },
    });
    runtime.linkGroup('off_group');
    expect(runtime.hasPendingLink()).toBe(true);
    fire?.();
    expect(runtime.hasPendingLink()).toBe(false);
    expect(linkResults[0]).toMatchObject({ ok: false, official_chat_id: 'off_group' });
    db.close();
  });

  it('does not score an unmapped group', () => {
    const db = openDb();
    expect(shouldScoreZcaGroup(db, 'zgr-unknown')).toBe(false);

    db.prepare(
      `INSERT INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at)
       VALUES ('off', 'zgr-known', 'G', 1)`
    ).run();
    expect(shouldScoreZcaGroup(db, 'zgr-known')).toBe(false);

    db.prepare(
      `INSERT INTO tasks (id, short_code, official_chat_id, zca_group_id, report_group_id,
        link, reference_text, required_count, deadline, status, created_at)
       VALUES ('t1', 'ABC123', 'off', 'zgr-known', 'rep', 'https://x', 'c', 1, 0, 'collecting', 0)`
    ).run();
    expect(shouldScoreZcaGroup(db, 'zgr-known')).toBe(true);

    const runtime = new WorkerRuntime({ db, loginPort: muteLogin });
    const img = runtime.handleZcaMessage({
      threadId: 'zgr-unknown',
      isGroup: true,
      text: '',
      displayName: 'x',
      hasImage: true,
    });
    expect(img.proof).toBe(false);
    db.close();
  });

  it('method B is idempotent for the same pair and rejects a conflicting pair', () => {
    const db = openDb();
    const runtime = new WorkerRuntime({ db, loginPort: muteLogin, now: () => 1 });
    expect(runtime.linkGroup('off_1', 'zgr-a').httpStatus).toBe(200);
    expect(runtime.linkGroup('off_1', 'zgr-a').httpStatus).toBe(200);
    expect(runtime.linkGroup('off_1', 'zgr-b').httpStatus).toBe(409);
    expect(runtime.linkGroup('off_2', 'zgr-a').httpStatus).toBe(409);
    db.close();
  });
});
