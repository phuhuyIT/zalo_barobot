/**
 * health.ts
 *
 * Step 11: nếu worker chết trong khi còn task liên kết collecting|overdue,
 * job định kỳ của official bot báo admin_official_chat_id.
 * Crash worker không được kéo sập /gui (supervisor đã tách process).
 */

import Database from 'better-sqlite3';
import { getRecipientChatId } from '../config';
import { ZaloClient } from '../core/zaloClient';
import { getDatabase } from '../store';
import { getWorkerOrigin } from './env';
import { countLinkedOpenTasks } from './lifecycle';
import { getTaskproofSetting } from './settings';
import { listMissingTaskproofTables } from './store';

export interface WorkerHealthDeps {
  probe?: () => Promise<boolean>;
  sendMessage?: (chatId: string, text: string) => Promise<unknown>;
  getAdminChatId?: () => string;
  now?: () => number;
  throttleMs?: number;
  lastNotifiedAt?: { value: number };
}

const lastNotified = { value: 0 };

export function formatWorkerDownOpenTasksMessage(openCount: number): string {
  return (
    `⚠️ Task-proof worker không chạy trong khi còn ${openCount} task liên kết đang mở.\n` +
    `OCR / nhắc /lienket sẽ dừng. Bot chính vẫn chạy — /gui không bị ảnh hưởng.\n` +
    `Hãy kiểm tra process worker (cổng 3001, chỉ localhost).`
  );
}

export async function probeWorkerHealth(
  origin: string = getWorkerOrigin(),
  timeoutMs = 2500
): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Chỉ báo khi worker down VÀ còn task liên kết mở. Có throttle để không spam mỗi phút.
 */
export async function notifyIfWorkerDownWithOpenTasks(
  database?: Database.Database,
  deps: WorkerHealthDeps = {}
): Promise<{ notified: boolean; reason?: string; openCount?: number }> {
  const db = database || getDatabase();
  try {
    if (listMissingTaskproofTables(db).length > 0) {
      return { notified: false, reason: 'tables_missing' };
    }
  } catch {
    return { notified: false, reason: 'tables_missing' };
  }

  const openCount = countLinkedOpenTasks(db);
  if (openCount <= 0) {
    return { notified: false, reason: 'no_linked_open_tasks', openCount: 0 };
  }

  const up = deps.probe ? await deps.probe() : await probeWorkerHealth();
  if (up) {
    return { notified: false, reason: 'worker_up', openCount };
  }

  const now = deps.now ?? Date.now;
  const throttleMs = deps.throttleMs ?? getTaskproofSetting('reminder_interval_ms', db);
  const stamp = deps.lastNotifiedAt ?? lastNotified;
  if (stamp.value && now() - stamp.value < throttleMs) {
    return { notified: false, reason: 'throttled', openCount };
  }

  const getAdminChatId =
    deps.getAdminChatId ??
    (() => getTaskproofSetting('admin_official_chat_id', db) || getRecipientChatId('admin') || '');
  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    console.warn('[TaskProof] health: worker down + task mở nhưng chưa có admin chat id.');
    return { notified: false, reason: 'missing_admin_chat_id', openCount };
  }

  const send =
    deps.sendMessage ??
    ((chatId: string, text: string) => new ZaloClient().sendMessage(chatId, text));

  try {
    await send(adminChatId, formatWorkerDownOpenTasksMessage(openCount));
    stamp.value = now();
    return { notified: true, openCount };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] health: gửi Zalo thất bại:', msg);
    return { notified: false, reason: msg, openCount };
  }
}
