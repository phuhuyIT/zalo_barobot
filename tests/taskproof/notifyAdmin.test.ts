import { describe, it, expect, vi } from 'vitest';
import {
  formatWorkerDownMessage,
  notifyAdminWorkerDown,
} from '../../src/taskproof/notifyAdmin';

describe('notifyAdminWorkerDown (Step 1)', () => {
  it('formats a message that says /gui still works', () => {
    const text = formatWorkerDownMessage({ code: 1, signal: null });
    expect(text).toContain('exit 1');
    expect(text).toContain('/gui không bị ảnh hưởng');
  });

  it('sends to the admin chat id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'm1' });
    const result = await notifyAdminWorkerDown(
      { code: 1, signal: 'SIGKILL' },
      { sendMessage, getAdminChatId: () => 'admin_chat_1' }
    );
    expect(result.sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0]).toBe('admin_chat_1');
    expect(sendMessage.mock.calls[0][1]).toContain('signal=SIGKILL');
  });

  it('does not throw when admin chat id is missing', async () => {
    const sendMessage = vi.fn();
    const result = await notifyAdminWorkerDown(
      { code: 1, signal: null },
      { sendMessage, getAdminChatId: () => '' }
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('missing_admin_chat_id');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not throw when Zalo send fails', async () => {
    const result = await notifyAdminWorkerDown(
      { code: 1, signal: null },
      {
        getAdminChatId: () => 'admin_chat_1',
        sendMessage: async () => {
          throw new Error('network down');
        },
      }
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('network down');
  });
});
