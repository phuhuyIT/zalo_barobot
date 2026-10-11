/**
 * notifyAdmin.ts
 *
 * Gửi cảnh báo tới admin qua official bot (cùng kênh nhắc F6).
 * Supervisor không gọi Zalo API trực tiếp — hai identity Zalo không
 * dùng chung client (Section 2).
 */

import { getRecipientChatId } from '../../config';
import { ZaloClient } from '../../core/zaloClient';

export interface WorkerDownInfo {
  code: number | null;
  signal: string | null;
}

export interface NotifyAdminDeps {
  sendMessage?: (chatId: string, text: string) => Promise<unknown>;
  getAdminChatId?: () => string;
}

export function formatWorkerDownMessage(info: WorkerDownInfo): string {
  const codePart = info.code === null || info.code === undefined ? 'unknown' : String(info.code);
  const signalPart = info.signal ? `, signal=${info.signal}` : '';
  return (
    `⚠️ Task-proof worker đã dừng (exit ${codePart}${signalPart}).\n` +
    `Bot chính vẫn chạy — /gui không bị ảnh hưởng.\n` +
    `Hãy kiểm tra process worker (cổng 3001, chỉ localhost).`
  );
}

export async function notifyAdminWorkerDown(
  info: WorkerDownInfo,
  deps: NotifyAdminDeps = {}
): Promise<{ sent: boolean; reason?: string }> {
  const getAdminChatId = deps.getAdminChatId ?? (() => getRecipientChatId('admin'));
  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    console.warn('[TaskProof] worker-down: chưa có admin chat id, chỉ ghi log.');
    return { sent: false, reason: 'missing_admin_chat_id' };
  }

  const send =
    deps.sendMessage ??
    ((chatId: string, text: string) => new ZaloClient().sendMessage(chatId, text));

  try {
    await send(adminChatId, formatWorkerDownMessage(info));
    return { sent: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] worker-down: gửi Zalo thất bại:', msg);
    return { sent: false, reason: msg };
  }
}
