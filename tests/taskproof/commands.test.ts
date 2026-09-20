import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import {
  collectHttpUrls,
  extractWebhookInbound,
  formatParseReply,
  generateShortCode,
  getTaskByExactShortCode,
  handleTaskproofCommand,
  PREVIEW_CARD_HINT,
  resetPreviewHintThrottle,
  isExactShortCode,
  looksLikeTaskproofCommand,
  parseDeadlineToUtcMs,
  parseTaskproofCommand,
  redactSecrets,
} from '../../src/taskproof/commands';
import { WebhookInbound } from '../../src/taskproof/commands/types';

function inboundFrom(body: unknown): WebhookInbound {
  const inbound = extractWebhookInbound(body);
  if (!inbound) throw new Error('expected inbound');
  return inbound;
}

function textMessage(text: string, extra: Record<string, unknown> = {}): WebhookInbound {
  return inboundFrom({
    message: {
      text,
      chat: { id: 'group_task', chat_type: 'GROUP' },
      from: { id: 'manager_1' },
      message_id: 'm1',
      ...extra,
    },
  });
}

const TASK_BASE = `/task
Link: https://example.com/post
Caption: Bao cao tuan
HanChot: 19/09/2026 18:00`;

describe('task-proof command parsers (Step 3)', () => {
  describe('payload shapes', () => {
    it('reads the current { message } envelope used by /gui tests', () => {
      const inbound = inboundFrom({
        message: { text: '/tasks', chat: { id: 'group_123' }, from: { id: 'user_1' } },
      });
      expect(inbound.chatId).toBe('group_123');
      expect(inbound.commandText).toBe('/tasks');
      expect(parseTaskproofCommand(inbound)).toMatchObject({ ok: true, command: 'tasks' });
    });

    it('reads official { ok, result: { event_name, message } } envelope', () => {
      const inbound = inboundFrom({
        ok: true,
        result: {
          event_name: 'message.text.received',
          message: {
            text: '/tasks',
            chat: { id: 'off_group', chat_type: 'GROUP' },
            from: { id: 'u1' },
            message_id: 'mid',
          },
        },
      });
      expect(inbound.eventName).toBe('message.text.received');
      expect(inbound.chatId).toBe('off_group');
      expect(parseTaskproofCommand(inbound)).toMatchObject({ ok: true, command: 'tasks' });
    });

    it('uses caption when text is empty (image + caption)', () => {
      const inbound = inboundFrom({
        event_name: 'message.image.received',
        message: {
          caption: TASK_BASE,
          photo: 'https://cdn.example/photo.jpg',
          chat: { id: 'group_task', chat_type: 'GROUP' },
          from: { id: 'manager_1' },
        },
      });
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.link).toBe('https://example.com/post');
        expect(parsed.fields.caption).toBe('Bao cao tuan');
      }
    });

    it('does not use the image photo URL as Link', () => {
      const inbound = inboundFrom({
        event_name: 'message.image.received',
        message: {
          caption: '/task Caption: only HanChot: 19/09/2026 18:00',
          photo: 'https://cdn.example/photo.jpg',
          chat: { id: 'group_task', chat_type: 'GROUP' },
        },
      });
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok && parsed.found) {
        expect(parsed.error).toMatch(/Link/);
      }
    });

    it('recovers /task from unsupported preview-card metadata when nested text exists', () => {
      const inbound = inboundFrom({
        ok: true,
        result: {
          event_name: 'message.unsupported.received',
          message: {
            text: '',
            chat: { id: 'group_task', chat_type: 'GROUP' },
            preview: {
              title: '/task Caption: Bao cao tuan HanChot: 19/09/2026 18:00',
              href: 'https://www.facebook.com/share/v/1FS7f9MknZ/',
            },
          },
        },
      });
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.link).toBe('https://www.facebook.com/share/v/1FS7f9MknZ/');
        expect(parsed.fields.caption).toBe('Bao cao tuan');
      }
    });

    it('does not treat empty unsupported cards as a command (Zalo dropped the text)', () => {
      const inbound = inboundFrom({
        ok: true,
        result: {
          event_name: 'message.unsupported.received',
          message: {
            text: '',
            chat: { id: 'group_task', chat_type: 'GROUP' },
          },
        },
      });
      expect(parseTaskproofCommand(inbound)).toMatchObject({ found: false });
    });

    it('takes fallback URL from preview-card metadata', () => {
      const inbound = inboundFrom({
        message: {
          text: '/task Caption: the caption HanChot: 19/09/2026 18:00',
          chat: { id: 'group_task', chat_type: 'GROUP' },
          preview: { href: 'https://zalo.me/preview-card' },
        },
      });
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.link).toBe('https://zalo.me/preview-card');
      }
    });

    it('takes a URL pasted in the command text when Link: is missing', () => {
      const inbound = textMessage(
        '/task Caption: hello https://example.com/in-text HanChot: 19/09/2026 18:00'
      );
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.link).toBe('https://example.com/in-text');
      }
    });

    it('parses the real Facebook share message (Hanchot casing + trailing slash)', () => {
      const inbound = textMessage(`/task
Caption: Bao cao tuan
Hanchot: 19/08/2026 18:00
Link: https://www.facebook.com/share/v/1FS7f9MknZ/`);
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.caption).toBe('Bao cao tuan');
        expect(parsed.fields.link).toBe('https://www.facebook.com/share/v/1FS7f9MknZ/');
        expect(parsed.fields.deadlineUtcMs).toBe(Date.UTC(2026, 7, 19, 11, 0, 0));
      }
    });

    it('reads official envelope when result is an array or message is a JSON string', () => {
      const asArray = inboundFrom({
        ok: true,
        result: [
          {
            event_name: 'message.text.received',
            message: {
              text: '/tasks',
              chat: { id: 'g_arr', chat_type: 'GROUP' },
            },
          },
        ],
      });
      expect(asArray.chatId).toBe('g_arr');
      expect(parseTaskproofCommand(asArray).ok).toBe(true);

      const asString = inboundFrom({
        ok: true,
        result: {
          event_name: 'message.text.received',
          message: JSON.stringify({
            text: '/tasks',
            chat: { id: 'g_str', chat_type: 'GROUP' },
          }),
        },
      });
      expect(asString.chatId).toBe('g_str');

      const rawJson = inboundFrom(
        JSON.stringify({
          message: { text: '/tasks', chat: { id: 'g_raw' }, from: { id: 'u' } },
        })
      );
      expect(rawJson.chatId).toBe('g_raw');
    });

    it('recovers /task from nested preview metadata when message.text is empty', () => {
      const inbound = inboundFrom({
        event_name: 'message.text.received',
        message: {
          text: '',
          chat: { id: 'group_task', chat_type: 'GROUP' },
          preview: {
            description: `/task
Caption: Bao cao tuan
Hanchot: 19/08/2026 18:00
Link: https://www.facebook.com/share/v/1FS7f9MknZ/`,
          },
        },
      });
      expect(inbound.commandText).toMatch(/\/task/);
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
    });
  });

  describe('/task fields', () => {
    it('accepts any field order', () => {
      const inbound = textMessage(
        '/task HanChot: 19/09/2026 18:00 Caption: hello Link: https://example.com/a SoLuong: 4 BaoCao: report_1'
      );
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.link).toBe('https://example.com/a');
        expect(parsed.fields.caption).toBe('hello');
        expect(parsed.fields.requiredCount).toBe(4);
        expect(parsed.fields.reportGroupId).toBe('report_1');
        expect(parsed.fields.deadlineUtcMs).toBe(Date.UTC(2026, 8, 19, 11, 0, 0));
      }
    });

    it('accepts bullet styles', () => {
      const inbound = textMessage(`/task
- Link: https://example.com/b
* Caption: bullet caption
• SoLuong: 2
1. HanChot: 2026-09-19 18:00
+ BaoCao: g_report`);
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.link).toBe('https://example.com/b');
        expect(parsed.fields.caption).toBe('bullet caption');
        expect(parsed.fields.requiredCount).toBe(2);
        expect(parsed.fields.reportGroupId).toBe('g_report');
      }
    });

    it('defaults SoLuong and BaoCao when omitted', () => {
      const inbound = textMessage(TASK_BASE);
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.requiredCount).toBeNull();
        expect(parsed.fields.reportGroupId).toBe('');
      }
    });

    it('requires Caption and HanChot', () => {
      const missingCaption = parseTaskproofCommand(
        textMessage('/task Link: https://example.com/x HanChot: 19/09/2026 18:00')
      );
      expect(missingCaption.ok).toBe(false);

      const missingDeadline = parseTaskproofCommand(
        textMessage('/task Link: https://example.com/x Caption: hi')
      );
      expect(missingDeadline.ok).toBe(false);
    });

    it('does not treat /gui or tuantra as task-proof', () => {
      expect(looksLikeTaskproofCommand('/gui')).toBe(false);
      expect(looksLikeTaskproofCommand('/send')).toBe(false);
      expect(parseTaskproofCommand(textMessage('tuantra Nguyen Van A')).found).toBe(false);
      expect(parseTaskproofCommand(textMessage('/id')).found).toBe(false);
    });
  });

  describe('VN timezone deadlines', () => {
    it('stores DD/MM/YYYY HH:mm as UTC epoch (VN = UTC+7)', () => {
      expect(parseDeadlineToUtcMs('19/09/2026 18:00')).toBe(Date.UTC(2026, 8, 19, 11, 0, 0));
    });

    it('stores HH:mm DD/MM/YYYY', () => {
      expect(parseDeadlineToUtcMs('18:00 19/09/2026')).toBe(Date.UTC(2026, 8, 19, 11, 0, 0));
    });

    it('stores YYYY-MM-DD HH:mm', () => {
      expect(parseDeadlineToUtcMs('2026-09-19 18:00')).toBe(Date.UTC(2026, 8, 19, 11, 0, 0));
    });

    it('round-trips wall time in Asia/Ho_Chi_Minh', () => {
      const inbound = textMessage(TASK_BASE);
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      const reply = formatParseReply(inbound);
      expect(reply).toContain('19/09/2026 18:00');
      expect(reply).toContain('Asia/Ho_Chi_Minh');
    });

    it('rejects invalid calendar dates', () => {
      expect(parseDeadlineToUtcMs('31/02/2026 18:00')).toBeNull();
      expect(parseDeadlineToUtcMs('19/09/2026 24:00')).toBeNull();
    });
  });

  describe('exact short_code', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(':memory:');
      configureSqliteConnection(db);
      initTables(db);
      initTaskproofTables(db);
    });

    afterEach(() => {
      db.close();
    });

    it('accepts /quet with default 5 messages and optional count', () => {
      const def = parseTaskproofCommand(textMessage('/quet abc123'));
      expect(def).toMatchObject({ ok: true, command: 'quet', shortCode: 'ABC123', count: 5 });
      const twenty = parseTaskproofCommand(textMessage('/quet ABC123 20'));
      expect(twenty).toMatchObject({ ok: true, command: 'quet', count: 20 });
      const fifty = parseTaskproofCommand(textMessage('/quet ABC123 50'));
      expect(fifty).toMatchObject({ ok: true, command: 'quet', count: 50 });
      expect(parseTaskproofCommand(textMessage('/quet')).ok).toBe(false);
      expect(parseTaskproofCommand(textMessage('/quet ABC123 0')).ok).toBe(false);
      expect(parseTaskproofCommand(textMessage('/quet ABC123 51')).ok).toBe(false);
      expect(parseTaskproofCommand(textMessage('/quet ABC123 200')).ok).toBe(false);
      expect(parseTaskproofCommand(textMessage('/quet ABC123 20p')).ok).toBe(false);
      expect(parseTaskproofCommand(textMessage('/quet ABC123 15 phút')).ok).toBe(false);
      expect(parseTaskproofCommand(textMessage('/quet ABC123 abc')).ok).toBe(false);
      expect(looksLikeTaskproofCommand('/quet ABC123')).toBe(true);
    });

    it('accepts /nhac /dong /huy with exact 6-char code', () => {
      for (const cmd of ['nhac', 'dong', 'huy'] as const) {
        const parsed = parseTaskproofCommand(textMessage(`/${cmd} abc123`));
        expect(parsed.ok).toBe(true);
        if (parsed.ok && (parsed.command === 'nhac' || parsed.command === 'dong' || parsed.command === 'huy')) {
          expect(parsed.shortCode).toBe('ABC123');
        }
      }
    });

    it('rejects UUID and extra tokens', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const parsed = parseTaskproofCommand(textMessage(`/nhac ${uuid}`));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok && parsed.found) {
        expect(parsed.error).toMatch(/UUID/i);
      }
      expect(parseTaskproofCommand(textMessage('/dong ABC123 extra')).ok).toBe(false);
      expect(isExactShortCode(uuid.slice(0, 6))).toBe(true);
      expect(isExactShortCode(uuid)).toBe(false);
    });

    it('looks up by exact short_code, not UUID prefix', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      db.prepare(
        `INSERT INTO tasks (id, short_code, official_chat_id, report_group_id,
          link, reference_text, required_count, deadline, status, created_at)
         VALUES (?, ?, 'off_1', 'rep_1', 'https://x', 'c', 1, 0, 'collecting', 0)`
      ).run(uuid, 'ABC123');

      expect(getTaskByExactShortCode(db, 'ABC123')?.id).toBe(uuid);
      expect(getTaskByExactShortCode(db, 'abc123')?.short_code).toBe('ABC123');
      expect(getTaskByExactShortCode(db, uuid)).toBeNull();
      expect(getTaskByExactShortCode(db, uuid.slice(0, 6))).toBeNull();
      expect(getTaskByExactShortCode(db, uuid.slice(0, 8))).toBeNull();
    });

    it('does not generate short_code from a UUID prefix', () => {
      const uuid = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';
      const code = generateShortCode(() => Buffer.from([0, 1, 2, 3, 4, 5]));
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
      expect(code).not.toBe(uuid.slice(0, 6).toUpperCase());
      expect(code).toBe('ABCDEF');
    });
  });

  describe('/lienket and /tasks', () => {
    it('parses method A and method B', () => {
      const a = parseTaskproofCommand(textMessage('/lienket'));
      expect(a).toMatchObject({ ok: true, command: 'lienket', method: 'A', zcaGroupId: null });
      const b = parseTaskproofCommand(textMessage('/lienket zca_thread_99'));
      expect(b).toMatchObject({
        ok: true,
        command: 'lienket',
        method: 'B',
        zcaGroupId: 'zca_thread_99',
      });
    });

    it('parses /tasks with no args only', () => {
      expect(parseTaskproofCommand(textMessage('/tasks')).ok).toBe(true);
      expect(parseTaskproofCommand(textMessage('/tasks extra')).ok).toBe(false);
    });
  });

  describe('handler routing', () => {
    beforeEach(() => {
      resetPreviewHintThrottle();
    });

    it('hints to resend /task as plain text when Zalo sends an empty preview card', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const inbound = inboundFrom({
        event_name: 'message.unsupported.received',
        message: {
          text: '',
          chat: { id: 'group_task', chat_type: 'GROUP' },
          from: { id: 'manager_1' },
        },
      });
      const handled = await handleTaskproofCommand(inbound, {
        sendMessage,
        now: () => 1_000,
      });
      expect(handled).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith('group_task', PREVIEW_CARD_HINT);

      sendMessage.mockClear();
      const again = await handleTaskproofCommand(inbound, {
        sendMessage,
        now: () => 60_000,
      });
      expect(again).toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('does not hint on unsupported private chats or on /gui', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const priv = inboundFrom({
        event_name: 'message.unsupported.received',
        message: {
          text: '',
          chat: { id: 'c9ee', chat_type: 'PRIVATE' },
          from: { id: 'c9ee' },
        },
      });
      expect(await handleTaskproofCommand(priv, { sendMessage })).toBe(false);
      expect(await handleTaskproofCommand(textMessage('/gui'), { sendMessage })).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('inserts /task, replies with short_code, and does not swallow /gui', async () => {
      const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm' });
      const insertTask = vi.fn().mockReturnValue({
        id: 'uuid-1',
        short_code: 'ABC123',
        official_chat_id: 'group_task',
        zca_group_id: 'zca-1',
        report_group_id: 'rep',
        required_count: 1,
        deadline: 1,
        status: 'collecting',
      });
      const ensureListening = vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} });
      const handledTask = await handleTaskproofCommand(textMessage(TASK_BASE), {
        sendMessage,
        insertTask,
        ensureListening,
      });
      expect(handledTask).toBe(true);
      expect(insertTask).toHaveBeenCalledOnce();
      expect(ensureListening).toHaveBeenCalledWith('uuid-1');
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][1]).toContain('Đã tạo task ABC123');
      expect(sendMessage.mock.calls[0][1]).toContain('https://example.com/post');
      expect(sendMessage.mock.calls[0][1]).not.toMatch(/chưa liên kết/);

      sendMessage.mockClear();
      const handledGui = await handleTaskproofCommand(textMessage('/gui'), { sendMessage });
      expect(handledGui).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('tells the manager to /lienket when the group is unmapped', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      await handleTaskproofCommand(textMessage(TASK_BASE), {
        sendMessage,
        insertTask: () => ({
          id: 'uuid-2',
          short_code: 'UNL001',
          official_chat_id: 'group_task',
          zca_group_id: null,
          report_group_id: '',
          required_count: 1,
          deadline: 1,
          status: 'collecting',
        }),
        ensureListening: async () => ({ status: 200, state: 'listening', raw: {} }),
      });
      expect(sendMessage.mock.calls[0][1]).toMatch(/chưa liên kết/);
      expect(sendMessage.mock.calls[0][1]).toMatch(/\/lienket/);
    });

    it('keeps the /task row and does not fail silently when the worker is down', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const insertTask = vi.fn().mockReturnValue({
        id: 'uuid-3',
        short_code: 'DWN001',
        official_chat_id: 'group_task',
        zca_group_id: 'zca-1',
        report_group_id: 'rep',
        required_count: 1,
        deadline: 1,
        status: 'collecting',
      });
      await handleTaskproofCommand(textMessage(TASK_BASE), {
        sendMessage,
        insertTask,
        ensureListening: async () => {
          throw new Error('fetch failed');
        },
      });
      expect(insertTask).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][1]).toContain('Đã tạo task DWN001');
      expect(sendMessage.mock.calls[0][1]).toMatch(/Worker không chạy/);
      expect(sendMessage.mock.calls[0][1]).toMatch(/\/gui vẫn dùng được/);
    });

    it('lists /tasks from DB and does not wake the worker', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const ensureListening = vi.fn();
      const handled = await handleTaskproofCommand(textMessage('/tasks'), {
        sendMessage,
        ensureListening,
        listTasks: () => [
          {
            id: 't1',
            short_code: 'ABC123',
            official_chat_id: 'group_task',
            zca_group_id: null,
            report_group_id: 'rep',
            link: 'https://x',
            reference_text: 'cap',
            required_count: 2,
            deadline: 1,
            status: 'collecting',
            created_at: 1,
            remind_count: 0,
            reminded_at: null,
            reported_at: null,
            submitted_count: 1,
          },
        ],
      });
      expect(handled).toBe(true);
      expect(ensureListening).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toContain('ABC123');
      expect(sendMessage.mock.calls[0][1]).toContain('1/2');
      expect(sendMessage.mock.calls[0][1]).toMatch(/chưa liên kết nhóm/);
    });

    it('rejects private-chat /task', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const inbound = inboundFrom({
        message: {
          text: TASK_BASE,
          chat: { id: 'user_private', chat_type: 'PRIVATE' },
          from: { id: 'user_private' },
        },
      });
      const handled = await handleTaskproofCommand(inbound, { sendMessage });
      expect(handled).toBe(true);
      expect(sendMessage.mock.calls[0][1]).toMatch(/nhóm nhiệm vụ/);
    });

    it('redacts secrets when logging a missing Link payload', () => {
      const redacted = redactSecrets({
        INTERNAL_API_KEY: 'real-secret',
        message: { text: '/task', nested_token: 'abc' },
      });
      expect(redacted).toEqual({
        INTERNAL_API_KEY: '[redacted]',
        message: { text: '/task', nested_token: '[redacted]' },
      });
    });
  });

  describe('collectHttpUrls', () => {
    it('walks nested preview / attachments / entities', () => {
      const urls = collectHttpUrls({
        attachments: [{ payload: { url: 'https://cdn.example/a' } }],
        entities: [{ type: 'url', url: 'https://example.com/e' }],
      });
      expect(urls).toEqual(expect.arrayContaining(['https://cdn.example/a', 'https://example.com/e']));
    });
  });
});
