import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { configureSqliteConnection, initTables, setDatabase } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import {
  completePickByIndex,
  createGroupPick,
  formatGroupTaskPost,
  formatPickerMessage,
  getOpenGroupPickForAdmin,
  placeTaskInGroup,
  resolveGroupChoice,
} from '../../src/taskproof/groupPick';
import { createTaskproofInternalRouter } from '../../src/taskproof/internal';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  configureSqliteConnection(db);
  initTables(db);
  initTaskproofTables(db);
  return db;
}

const GROUPS = [
  { official_chat_id: 'g_a', zca_group_id: 'z_a', display_name: 'Nhóm A' },
  { official_chat_id: 'g_b', zca_group_id: 'z_b', display_name: 'Nhóm B' },
];

const FIELDS = {
  link: 'https://example.com/share',
  caption: 'Caption here',
  requiredCount: 2,
  deadlineUtcMs: Date.UTC(2026, 8, 19, 11, 0, 0),
  reportGroupId: '',
};

describe('task-proof 1-1 group picker', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb();
    setDatabase(db);
  });

  afterEach(() => {
    setDatabase(null);
    db.close();
  });

  it('formats picker links and resolves a numeric reply', () => {
    const pick = createGroupPick(
      {
        adminChatId: 'admin_dm',
        fields: FIELDS,
        groups: GROUPS,
        token: 'abc123tokentokenabc123tokentoken',
        now: 1_000,
      },
      db
    );
    const text = formatPickerMessage(pick, 'https://public.example');
    expect(text).toContain('Nhóm A');
    expect(text).toContain('Nhóm B');
    expect(text).toContain('https://public.example/taskproof/pick/abc123tokentokenabc123tokentoken/1');
    expect(text).toContain('https://public.example/taskproof/pick/abc123tokentokenabc123tokentoken/2');
    expect(resolveGroupChoice('2', GROUPS)?.official_chat_id).toBe('g_b');
    expect(resolveGroupChoice('Nhóm A', GROUPS)?.official_chat_id).toBe('g_a');
    expect(resolveGroupChoice('9', GROUPS)).toBeNull();
  });

  it('posts the share link into the chosen group', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const created = await placeTaskInGroup(FIELDS, GROUPS[0], 'admin_dm', {
      sendMessage,
      insertTask: () => ({
        id: 'uuid-1',
        short_code: 'ABC123',
        official_chat_id: 'g_a',
        zca_group_id: 'z_a',
        report_group_id: 'rep',
        required_count: 2,
        deadline: FIELDS.deadlineUtcMs,
        status: 'collecting',
      }),
      ensureListening: async () => ({ status: 200, state: 'listening', raw: {} }),
    });
    expect(created.short_code).toBe('ABC123');
    expect(sendMessage.mock.calls[0][0]).toBe('g_a');
    expect(sendMessage.mock.calls[0][1]).toBe(
      'https://example.com/share\nCác đồng chí thực hiện nhé!'
    );
    expect(sendMessage.mock.calls[0][1]).toBe(formatGroupTaskPost(created, FIELDS));
    expect(sendMessage.mock.calls[1][0]).toBe('admin_dm');
  });

  it('GET pick URL consumes the token and does not require INTERNAL_API_KEY', async () => {
    db.prepare(
      `INSERT INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at)
       VALUES ('g_a', 'z_a', 'Nhóm A', 1)`
    ).run();
    const pick = createGroupPick(
      {
        adminChatId: 'admin_dm',
        fields: FIELDS,
        groups: GROUPS,
        token: 'deadbeefdeadbeefdeadbeefdeadbeef',
      },
      db
    );
    const sendMessage = vi.fn().mockResolvedValue({});
    const app = express();
    app.use(
      createTaskproofInternalRouter({
        sendMessage,
        ensureListening: async () => ({ status: 200, state: 'listening', raw: {} }),
      })
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const res = await fetch(
      `http://127.0.0.1:${port}/taskproof/pick/${pick.token}/1`
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toMatch(/Đã gửi/i);
    expect(html).toMatch(/ABC123|Nhiệm vụ|[A-Z0-9]{6}/);
    expect(sendMessage.mock.calls[0][0]).toBe('g_a');
    expect(sendMessage.mock.calls[0][1]).toContain('https://example.com/share');
    expect(getOpenGroupPickForAdmin('admin_dm', Date.now(), db)).toBeNull();

    const again = await fetch(`http://127.0.0.1:${port}/taskproof/pick/${pick.token}/1`);
    expect(again.status).toBe(409);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('completePickByIndex rejects a stale index', async () => {
    const pick = createGroupPick(
      {
        adminChatId: 'admin_dm',
        fields: FIELDS,
        groups: GROUPS,
        now: 1_000,
      },
      db
    );
    const result = await completePickByIndex(
      pick.token,
      9,
      { sendMessage: async () => ({}) },
      1_500,
      db
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });
});
