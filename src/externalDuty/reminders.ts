/**
 * Nhắc tiểu đội trưởng đối tác trước 18:00 nếu còn ca bắt buộc chưa có tên.
 */

import Database from 'better-sqlite3';
import { getRecipientChatId } from '../config';
import { ZaloClient } from '../core/zaloClient';
import { getVietnamTimeParts } from '../sheets/dateUtils';
import { hasSentToday, saveLastMessage } from '../store';
import { buildPartnerNotice } from './service';
import { getExternalDutyConfig, getReminderMark, isExternalDutyEnabled, saveReminderMark } from './repository';
import { dutyDateForSquad } from './prepare';
import { ExternalSquad } from './types';

const REMINDER_GRACE_MINUTES = 4;
const LIVE_ALERT_GAP_MS = 30_000;
let lastLiveAlertAt = 0;

function minutesOfDay(timeHM: string): number {
  const [h, m] = timeHM.split(':').map(Number);
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

export function reminderSlotForNow(reminderTimes: string[], currentTime: string): string | null {
  const slots = reminderTimes.filter((time) => /^\d{2}:\d{2}$/.test(time));
  if (slots.includes(currentTime)) return currentTime;
  const now = minutesOfDay(currentTime);
  let chosen: string | null = null;
  for (const slot of [...slots].sort((a, b) => minutesOfDay(a) - minutesOfDay(b))) {
    const delta = now - minutesOfDay(slot);
    if (delta > 0 && delta <= REMINDER_GRACE_MINUTES) chosen = slot;
  }
  return chosen;
}

export interface ExternalReminderResult {
  triggered: boolean;
  slotTime?: string;
  reason?: string;
}

export async function runExternalDutyReminders(
  now: Date = new Date(),
  options?: {
    zaloClient?: ZaloClient;
    database?: Database.Database;
    overrideTimeHM?: string;
    rowsBySquad?: Partial<Record<ExternalSquad, unknown[][]>>;
  }
): Promise<ExternalReminderResult> {
  if (!isExternalDutyEnabled(options?.database)) {
    return { triggered: false, reason: 'not_configured' };
  }
  const config = getExternalDutyConfig(options?.database);
  const vn = getVietnamTimeParts(now);
  const currentTime = options?.overrideTimeHM || vn.timeHM;
  const slotTime = reminderSlotForNow(config.reminderTimes, currentTime);
  if (!slotTime) return { triggered: false, reason: 'not_time' };

  const notice = await buildPartnerNotice(now, {
    database: options?.database,
    rowsBySquad: options?.rowsBySquad,
  });
  if (!notice.gateMissing && !notice.culiMissing) {
    return { triggered: false, slotTime, reason: 'complete' };
  }

  const slots: Array<'gate' | 'culi'> = [];
  if (notice.gateMissing) slots.push('gate');
  if (notice.culiMissing) slots.push('culi');

  const pending = slots.filter((slot) => {
    const date = slot === 'gate' ? notice.gateDate : notice.culiDate;
    const mark = getReminderMark(date, slot, options?.database);
    if (mark.reminderCount >= config.maxReminders) return false;
    if (mark.lastReminderSlot === slotTime) return false;
    return true;
  });
  if (pending.length === 0) return { triggered: false, slotTime, reason: 'already_reminded' };

  const leaderId = config.partnerLeaderUserId;
  if (!leaderId) return { triggered: false, slotTime, reason: 'no_leader' };

  const zalo = options?.zaloClient || new ZaloClient();
  try {
    await zalo.sendMessage(leaderId, notice.text, { textStyles: notice.styles });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ExternalDuty] Lỗi nhắc tiểu đội trưởng đối tác:', message);
    return { triggered: false, slotTime, reason: message };
  }

  for (const slot of pending) {
    const date = slot === 'gate' ? dutyDateForSquad('main', now) : dutyDateForSquad('culi', now);
    const mark = getReminderMark(date, slot, options?.database);
    saveReminderMark(
      {
        date,
        slot,
        reminderCount: mark.reminderCount + 1,
        lastReminderSlot: slotTime,
        adminWarned: mark.adminWarned,
      },
      options?.database
    );
  }

  const adminId = getRecipientChatId('admin');
  if (adminId && adminId !== 'admin' && !hasSentToday(`external_notice_${slotTime}`, adminId, vn.dateDMY, options?.database)) {
    try {
      await zalo.sendMessage(adminId, `Đã nhắc tiểu đội trưởng đối tác gửi người trực trước 18:00 (${slotTime}).`);
      saveLastMessage(`external_notice_${slotTime}`, adminId, `notice_${Date.now()}`, vn.dateDMY, options?.database);
    } catch {
      // Nhắc leader đã gửi. Cảnh báo admin là phụ.
    }
  }

  return { triggered: true, slotTime };
}

/** Gửi ngay nội dung nhắc hiện tại cho tiểu đội trưởng đối tác. Không tính vào số lần nhắc tự động. */
export async function sendPartnerAlertNow(options?: {
  zaloClient?: ZaloClient;
  database?: Database.Database;
  now?: Date;
  rowsBySquad?: Partial<Record<ExternalSquad, unknown[][]>>;
}): Promise<{ sent: boolean; reason?: string; text?: string; previewHtml?: string; leaderId?: string }> {
  const config = getExternalDutyConfig(options?.database);
  const leaderId = config.partnerLeaderUserId;
  if (!leaderId) return { sent: false, reason: 'no_leader' };

  const live = options?.now === undefined;
  const now = options?.now || new Date();
  if (live && now.getTime() - lastLiveAlertAt < LIVE_ALERT_GAP_MS) {
    return { sent: false, reason: 'cooldown' };
  }
  if (live) lastLiveAlertAt = now.getTime();

  const notice = await buildPartnerNotice(now, {
    database: options?.database,
    rowsBySquad: options?.rowsBySquad,
  });
  const zalo = options?.zaloClient || new ZaloClient();
  try {
    await zalo.sendMessage(leaderId, notice.text, { textStyles: notice.styles });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ExternalDuty] Gửi nhắc thử thất bại:', message);
    return { sent: false, reason: 'send_failed', text: notice.text, leaderId };
  }
  return { sent: true, text: notice.text, previewHtml: notice.previewHtml, leaderId };
}
