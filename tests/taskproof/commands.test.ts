import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { configureSqliteConnection, initTables, setDatabase } from '../../src/store';
import { initTaskproofTables } from '../../src/taskproof/store';
import {
  collectHttpUrls,
  extractWebhookInbound,
  formatParseReply,
  generateShortCode,
  getTaskByExactShortCode,
  GROUP_COMMAND_HINT,
  handleTaskproofCommand,
  NO_LINKED_GROUPS_HINT,
  PREVIEW_CARD_HINT,
  PRIVATE_NOT_ADMIN_HINT,
  resetPreviewHintThrottle,
  isExactShortCode,
  looksLikeTaskproofCommand,
  parseDeadlineToUtcMs,
  parseTaskproofCommand,
  redactSecrets,
  TASK_NOT_FACEBOOK,
  TASK_USAGE,
  UNFURL_FAIL_REPLY,
  UNFURL_PENDING_REPLY,
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

const ADMIN = 'admin_dm';

function adminMessage(text: string, extra: Record<string, unknown> = {}): WebhookInbound {
  return inboundFrom({
    message: {
      text,
      chat: { id: ADMIN, chat_type: 'PRIVATE' },
      from: { id: ADMIN },
      message_id: 'm1',
      ...extra,
    },
  });
}

const ONE_GROUP = [
  { official_chat_id: 'group_task', zca_group_id: 'zca-1', display_name: 'Phú Huy' },
];

function createdTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1',
    short_code: 'ABC123',
    official_chat_id: 'group_task',
    zca_group_id: 'zca-1',
    report_group_id: 'rep',
    required_count: 1,
    deadline: Date.UTC(2026, 8, 19, 11, 0, 0),
    status: 'collecting' as const,
    ...overrides,
  };
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

    it('rejects /task with no URL and no labeled fields', () => {
      const parsed = parseTaskproofCommand(textMessage('/task'));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok && parsed.found) {
        expect(parsed.error).toBe(TASK_USAGE);
      }
    });

    it('rejects a non-Facebook URL without Caption and does not unfurl', () => {
      const parsed = parseTaskproofCommand(textMessage('/task https://example.com/x'));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok && parsed.found) {
        expect(parsed.error).toBe(TASK_NOT_FACEBOOK);
      }
    });

    it('accepts /task <facebook_url> for unfurl without Caption or HanChot', () => {
      const parsed = parseTaskproofCommand(
        textMessage('/task xem giúp https://www.facebook.com/share/v/1FS7f9MknZ/ gấp')
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.link).toBe('https://www.facebook.com/share/v/1FS7f9MknZ/');
        expect(parsed.fields.caption).toBe('');
        expect(parsed.fields.needsUnfurl).toBe(true);
        expect(parsed.fields.deadlineUtcMs).toBeNull();
        expect(parsed.fields.requiredCount).toBeNull();
      }
    });

    it('does not use Zalo card caption as reference_text when unfurling', () => {
      const inbound = inboundFrom({
        message: {
          text: '/task https://www.facebook.com/page/posts/123456789',
          caption: 'Zalo preview title that must not become OCR caption',
          chat: { id: ADMIN, chat_type: 'PRIVATE' },
          from: { id: ADMIN },
        },
      });
      const parsed = parseTaskproofCommand(inbound);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.needsUnfurl).toBe(true);
        expect(parsed.fields.caption).toBe('');
      }
    });

    it('keeps typed Caption and defaults HanChot when omitted', () => {
      const parsed = parseTaskproofCommand(
        textMessage('/task Link: https://example.com/x Caption: hi typed by hand')
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.command === 'task') {
        expect(parsed.fields.caption).toBe('hi typed by hand');
        expect(parsed.fields.needsUnfurl).toBe(false);
        expect(parsed.fields.deadlineUtcMs).toBeNull();
      }
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
    let db: Database.Database;

    beforeEach(() => {
      resetPreviewHintThrottle();
      db = new Database(':memory:');
      configureSqliteConnection(db);
      initTables(db);
      initTaskproofTables(db);
      setDatabase(db);
    });

    afterEach(() => {
      setDatabase(null);
      db.close();
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

    it('hints on admin 1-1 preview cards and ignores stranger DMs and /gui', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const adminCard = inboundFrom({
        event_name: 'message.unsupported.received',
        message: {
          text: '',
          chat: { id: ADMIN, chat_type: 'PRIVATE' },
          from: { id: ADMIN },
        },
      });
      expect(
        await handleTaskproofCommand(adminCard, {
          sendMessage,
          getAdminChatId: () => ADMIN,
          now: () => 1_000,
        })
      ).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(ADMIN, PREVIEW_CARD_HINT);

      sendMessage.mockClear();
      const stranger = inboundFrom({
        event_name: 'message.unsupported.received',
        message: {
          text: '',
          chat: { id: 'c9ee', chat_type: 'PRIVATE' },
          from: { id: 'c9ee' },
        },
      });
      expect(await handleTaskproofCommand(stranger, { sendMessage, getAdminChatId: () => ADMIN })).toBe(
        false
      );
      expect(await handleTaskproofCommand(textMessage('/gui'), { sendMessage })).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('inserts /task from admin 1-1 into the only linked group and posts the link there', async () => {
      const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm' });
      const insertTask = vi.fn().mockReturnValue(createdTask());
      const ensureListening = vi.fn().mockResolvedValue({ status: 200, state: 'listening', raw: {} });
      const handledTask = await handleTaskproofCommand(adminMessage(TASK_BASE), {
        sendMessage,
        insertTask,
        ensureListening,
        getAdminChatId: () => ADMIN,
        listLinkedGroups: () => ONE_GROUP,
      });
      expect(handledTask).toBe(true);
      expect(insertTask).toHaveBeenCalledOnce();
      expect(insertTask.mock.calls[0][0].officialChatId).toBe('group_task');
      expect(ensureListening).toHaveBeenCalledWith('uuid-1');
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls[0][0]).toBe('group_task');
      expect(sendMessage.mock.calls[0][1]).toBe(
        'https://example.com/post\nCác đồng chí thực hiện nhé!'
      );
      expect(sendMessage.mock.calls[1][0]).toBe(ADMIN);
      expect(sendMessage.mock.calls[1][1]).toContain('Đã tạo task ABC123');
      expect(sendMessage.mock.calls[1][1]).toContain('Phú Huy');

      sendMessage.mockClear();
      const handledGui = await handleTaskproofCommand(textMessage('/gui'), { sendMessage });
      expect(handledGui).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('asks /lienket when no group is linked yet and does not insert', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const insertTask = vi.fn();
      await handleTaskproofCommand(adminMessage(TASK_BASE), {
        sendMessage,
        insertTask,
        getAdminChatId: () => ADMIN,
        listLinkedGroups: () => [],
      });
      expect(insertTask).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toBe(NO_LINKED_GROUPS_HINT);
    });

    it('keeps the /task row and does not fail silently when the worker is down', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const insertTask = vi.fn().mockReturnValue(createdTask({ id: 'uuid-3', short_code: 'DWN001' }));
      await handleTaskproofCommand(adminMessage(TASK_BASE), {
        sendMessage,
        insertTask,
        getAdminChatId: () => ADMIN,
        listLinkedGroups: () => ONE_GROUP,
        ensureListening: async () => {
          throw new Error('fetch failed');
        },
      });
      expect(insertTask).toHaveBeenCalledOnce();
      const adminReply = sendMessage.mock.calls.find((call) => call[0] === ADMIN)?.[1] as string;
      expect(adminReply).toContain('Đã tạo task DWN001');
      expect(adminReply).toMatch(/Worker không chạy/);
      expect(adminReply).toMatch(/\/gui vẫn dùng được/);
    });

    it('lists /tasks from DB across groups and does not wake the worker', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const ensureListening = vi.fn();
      const handled = await handleTaskproofCommand(adminMessage('/tasks'), {
        sendMessage,
        ensureListening,
        getAdminChatId: () => ADMIN,
        listTasks: () => [
          {
            id: 't1',
            short_code: 'ABC123',
            official_chat_id: 'group_task',
            zca_group_id: null,
            report_group_id: 'rep',
            link: 'https://facebook.com/posts/abc',
            reference_text: 'cap',
            required_count: 2,
            deadline: 1,
            status: 'collecting',
            created_at: 1,
            remind_count: 0,
            reminded_at: null,
            reported_at: null,
            submitted_count: 1,
            group_display_name: 'Phú Huy',
          },
          {
            id: 't2',
            short_code: 'DONE01',
            official_chat_id: 'group_task',
            zca_group_id: 'zca-1',
            report_group_id: 'rep',
            link: 'https://facebook.com/posts/done',
            reference_text: 'cap',
            required_count: 2,
            deadline: 1,
            status: 'completed',
            created_at: 2,
            remind_count: 0,
            reminded_at: null,
            reported_at: 3,
            submitted_count: 2,
            group_display_name: 'Phú Huy',
          },
        ],
      });
      expect(handled).toBe(true);
      expect(ensureListening).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toContain('ABC123');
      expect(sendMessage.mock.calls[0][1]).toContain('https://facebook.com/posts/abc');
      expect(sendMessage.mock.calls[0][1]).toContain('đang thu');
      expect(sendMessage.mock.calls[0][1]).toContain('1/2');
      expect(sendMessage.mock.calls[0][1]).not.toContain('DONE01');
    });

    it('redirects group /task to 1-1 and rejects stranger DMs', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const insertTask = vi.fn();
      const groupHandled = await handleTaskproofCommand(textMessage(TASK_BASE), {
        sendMessage,
        insertTask,
        getAdminChatId: () => ADMIN,
      });
      expect(groupHandled).toBe(true);
      expect(insertTask).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toBe(GROUP_COMMAND_HINT);

      sendMessage.mockClear();
      const stranger = inboundFrom({
        message: {
          text: TASK_BASE,
          chat: { id: 'user_private', chat_type: 'PRIVATE' },
          from: { id: 'user_private' },
        },
      });
      const handled = await handleTaskproofCommand(stranger, {
        sendMessage,
        insertTask,
        getAdminChatId: () => ADMIN,
      });
      expect(handled).toBe(true);
      expect(insertTask).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toBe(PRIVATE_NOT_ADMIN_HINT);
    });

    it('sends picker links when several groups are linked, then binds on reply', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const insertTask = vi.fn().mockReturnValue(
        createdTask({ official_chat_id: 'group_b', zca_group_id: 'zca-b' })
      );
      const groups = [
        { official_chat_id: 'group_a', zca_group_id: 'zca-a', display_name: 'Nhóm A' },
        { official_chat_id: 'group_b', zca_group_id: 'zca-b', display_name: 'Nhóm B' },
      ];
      await handleTaskproofCommand(adminMessage(TASK_BASE), {
        sendMessage,
        insertTask,
        ensureListening: async () => ({ status: 200, state: 'listening', raw: {} }),
        getAdminChatId: () => ADMIN,
        listLinkedGroups: () => groups,
        publicBaseUrl: () => 'https://public.example',
        now: () => 1_000,
      });
      expect(insertTask).not.toHaveBeenCalled();
      const picker = sendMessage.mock.calls[0][1] as string;
      expect(picker).toContain('Nhóm A');
      expect(picker).toContain('Nhóm B');
      expect(picker).toMatch(/https:\/\/public\.example\/taskproof\/pick\/[a-f0-9]+\/1/);
      expect(picker).toMatch(/https:\/\/public\.example\/taskproof\/pick\/[a-f0-9]+\/2/);

      sendMessage.mockClear();
      const replied = await handleTaskproofCommand(adminMessage('2'), {
        sendMessage,
        insertTask,
        ensureListening: async () => ({ status: 200, state: 'listening', raw: {} }),
        getAdminChatId: () => ADMIN,
        now: () => 2_000,
      });
      expect(replied).toBe(true);
      expect(insertTask).toHaveBeenCalledOnce();
      expect(insertTask.mock.calls[0][0].officialChatId).toBe('group_b');
      expect(sendMessage.mock.calls[0][0]).toBe('group_b');
      expect(sendMessage.mock.calls[0][1]).toContain('https://example.com/post');
    });

    it('unfurls /task <facebook_url> then inserts; fail does not insert', async () => {
      const sendMessage = vi.fn().mockResolvedValue({});
      const insertTask = vi.fn().mockReturnValue(createdTask({ required_count: 12 }));
      const fb = 'https://www.facebook.com/share/v/1FS7f9MknZ/';
      await handleTaskproofCommand(adminMessage(`/task ${fb}`), {
        sendMessage,
        insertTask,
        ensureListening: async () => ({ status: 200, state: 'listening', raw: {} }),
        getAdminChatId: () => ADMIN,
        listLinkedGroups: () => ONE_GROUP,
        enqueueUnfurl: (job) => job(),
        unfurlFacebook: async () => ({
          ok: true,
          caption: 'Lydia Hallie ky su Anthropic chia se ve AI Agent',
          canonicalUrl: 'https://www.facebook.com/page/posts/99',
          source: 'og:description',
        }),
      });
      expect(sendMessage.mock.calls[0][1]).toBe(UNFURL_PENDING_REPLY);
      expect(insertTask).toHaveBeenCalledOnce();
      expect(insertTask.mock.calls[0][0].referenceText).toMatch(/Lydia Hallie/);
      expect(insertTask.mock.calls[0][0].link).toBe('https://www.facebook.com/page/posts/99');
      expect(insertTask.mock.calls[0][0].officialChatId).toBe('group_task');

      sendMessage.mockClear();
      insertTask.mockClear();
      await handleTaskproofCommand(adminMessage(`/task ${fb}`), {
        sendMessage,
        insertTask,
        getAdminChatId: () => ADMIN,
        listLinkedGroups: () => ONE_GROUP,
        enqueueUnfurl: (job) => job(),
        unfurlFacebook: async () => ({ ok: false }),
      });
      expect(insertTask).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls.some((call) => call[1] === UNFURL_FAIL_REPLY)).toBe(true);
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
