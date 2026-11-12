/**
 * sendSchedule.ts
 *
 * CORE ENGINE: send_schedule() & preview_schedule()
 * Nơi DUY NHẤT xử lý logic gửi tin và xóa tin nhắn cũ (Kiến trúc Mục 4 & Quy tắc #3).
 * Mọi kênh kích hoạt (Cron F1/F6, Web F2/F5, Webhook F3) đều gọi vào đây.
 */

import { getConfig, getRecipientChatId, getScheduleConfig, getSquadConfig } from '../config';
import { fetchDutySchedule, fetchLeaveRoster, fetchLeaveStats } from '../sheets';
import { resolveLookupDate, formatDateDMY, getVietnamTimeParts, parseDMYToDate } from '../sheets/dateUtils';
import { formatMessage } from '../formatters';
import { ZaloClient } from './zaloClient';
import {
  getLastMessageId,
  hasSentToday,
  saveLastMessage,
  appendSendHistory,
  getRuntimeConfigOverride,
} from '../store';
import { ScheduleConfig, SquadConfig } from '../types';
import { readSheetTab } from '../sheets/sheetsClient';
import { isExternalDutyEnabled, resolvePartnerChatId } from '../externalDuty/repository';
import { loadReports, prepareDutyFromRows } from '../externalDuty/prepare';

export interface RecipientSendResult {
  recipientKey: string;
  chatId: string;
  success: boolean;
  messageId?: string;
  error?: string;
  oldMessageDeleted: boolean;
  skippedDueToIdempotency?: boolean;
}

export interface SendScheduleResult {
  scheduleKey: string;
  label: string;
  lookupDate: string;
  results: RecipientSendResult[];
  held?: boolean;
  holdReason?: string;
}

export interface BuiltScheduleMessage {
  text: string;
  lookupDate: string;
  effectiveTabName: string;
  held?: boolean;
  holdReason?: string;
  includePartner?: boolean;
}

export interface SendScheduleOptions {
  recipientKey?: string; // Nếu chỉ định, chỉ gửi cho người này
  isAutomated?: boolean; // Nếu là tự động (Cron), kiểm tra idempotency
  targetDate?: string; // Ghi đè ngày cụ thể (nếu cần)
  zaloClient?: ZaloClient; // Cho phép mock trong unit test
}

/**
 * Lấy thông tin cấu hình thực tế (đã áp dụng runtime overrides từ F9 & F12).
 */
export function getEffectiveScheduleConfig(scheduleKey: string): {
  schedule: ScheduleConfig;
  squad?: SquadConfig;
  effectiveTabName: string;
  effectiveSendTime: string | null;
  effectiveEnabled: boolean;
  effectiveSendNextDay: boolean;
  effectiveRecipients: string[];
} {
  const config = getConfig();
  const schedule = getScheduleConfig(scheduleKey, config);
  if (!schedule) {
    throw new Error(`Không tìm thấy cấu hình schedule với key '${scheduleKey}'`);
  }

  const squad = getSquadConfig(schedule.squad, config);

  // Lấy runtime override cho squad hoặc schedule
  const squadOverride = schedule.squad ? getRuntimeConfigOverride(schedule.squad) : null;
  const scheduleOverride = getRuntimeConfigOverride(schedule.key);

  // Thứ tự ưu tiên Tên Tab Google Sheet:
  // 1. Runtime override của chính schedule (nếu có)
  // 2. Tên sheet_tab khai báo riêng của schedule trong YAML (ví dụ: "Lịch tranh thủ tiểu đội 2")
  // 3. Runtime override của squad (nếu có)
  // 4. Tên sheet_tab_gate_duty mặc định của squad trong YAML
  const effectiveTabName =
    scheduleOverride?.sheet_tab_gate_duty ||
    schedule.sheet_tab ||
    squadOverride?.sheet_tab_gate_duty ||
    squad?.sheet_tab_gate_duty ||
    '';

  const effectiveSendTime =
    scheduleOverride?.auto_send_time !== undefined
      ? scheduleOverride.auto_send_time
      : schedule.auto_send_time;

  const effectiveEnabled =
    scheduleOverride?.enabled !== undefined
      ? scheduleOverride.enabled
      : schedule.enabled;

  const effectiveSendNextDay =
    scheduleOverride?.send_next_day !== undefined
      ? scheduleOverride.send_next_day
      : schedule.send_next_day !== undefined
      ? schedule.send_next_day
      : schedule.type === 'leave_roster' || schedule.type === 'leave_roster_stats'
      ? false
      : squadOverride?.send_next_day !== undefined
      ? squadOverride.send_next_day
      : Boolean(squad?.send_next_day);

  const effectiveRecipients =
    scheduleOverride?.recipients !== undefined
      ? scheduleOverride.recipients
      : schedule.recipients;

  return {
    schedule,
    squad,
    effectiveTabName,
    effectiveSendTime,
    effectiveEnabled,
    effectiveSendNextDay,
    effectiveRecipients,
  };
}

/**
 * Xây dựng nội dung tin nhắn cho schedule (dùng chung cho cả gửi thật và Preview F10).
 * Đảm bảo Preview giống 100% nội dung gửi thực tế.
 */
export async function buildScheduleMessage(
  scheduleKey: string,
  targetDate?: string
): Promise<BuiltScheduleMessage> {
  const { schedule, squad, effectiveTabName, effectiveSendNextDay, effectiveRecipients } =
    getEffectiveScheduleConfig(scheduleKey);

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    throw new Error('Biến môi trường GOOGLE_SHEET_ID chưa được cấu hình.');
  }

  if (!effectiveTabName) {
    throw new Error(`Chưa cấu hình tên tab Google Sheet cho schedule '${scheduleKey}'.`);
  }

  // 1. Xác định ngày cần lấy dữ liệu (lookup_date)
  const now = new Date();
  const isOvernight = Boolean(squad?.overnight);
  const cutoverTime = squad?.cutover_time || '05:30';

  const nextDayCutover = squad?.next_day_cutover_time || schedule.next_day_cutover_time || '20:00';

  let lookupDate: string;
  if (targetDate === 'today') {
    lookupDate = getVietnamTimeParts(now).dateDMY;
  } else if (targetDate === 'tomorrow') {
    const today = getVietnamTimeParts(now).dateDMY;
    const parsed = parseDMYToDate(today);
    if (parsed) {
      parsed.setDate(parsed.getDate() + 1);
      lookupDate = formatDateDMY(parsed);
    } else {
      lookupDate = today;
    }
  } else if (targetDate) {
    lookupDate = targetDate;
  } else {
    lookupDate = resolveLookupDate(now, isOvernight, cutoverTime, effectiveSendNextDay, nextDayCutover);
  }

  // 2. Đọc dữ liệu từ Sheet tùy theo loại schedule
  let text: string;
  if (schedule.type === 'leave_roster') {
    const leaveData = await fetchLeaveRoster(spreadsheetId, effectiveTabName, lookupDate);
    if (!leaveData || !leaveData.entry) {
      throw new Error(`Không có dữ liệu lịch tranh thủ cho ngày ${lookupDate}`);
    }
    text = formatMessage(schedule.type, leaveData, lookupDate);
  } else if (schedule.type === 'leave_roster_stats') {
    const leaveStatsData = await fetchLeaveStats(spreadsheetId, effectiveTabName);
    text = formatMessage(schedule.type, leaveStatsData, lookupDate);
  } else if (
    (scheduleKey === 'main_duty' || scheduleKey === 'culi_duty') &&
    isExternalDutyEnabled()
  ) {
    const headerStyle = squad?.header_style || 'two_row_merged';
    const rows = await readSheetTab(spreadsheetId, effectiveTabName);
    const squadKey = scheduleKey === 'culi_duty' ? 'culi' : 'main';
    const wantsPartner = effectiveRecipients.includes('squad_partner');
    const prepared = prepareDutyFromRows({
      squad: squadKey,
      headerStyle,
      rows,
      lookupDate,
      reports: loadReports(lookupDate, squadKey),
      // partnerChatId chỉ để chặn gửi khi lịch có nhóm đối tác mà chưa có Chat ID.
      partnerChatId: wantsPartner ? resolvePartnerChatId() : 'not-required',
      isOvernight: Boolean(squad?.overnight),
    });
    if (prepared.held) {
      return {
        text: prepared.holdReason,
        lookupDate,
        effectiveTabName,
        held: true,
        holdReason: prepared.holdReason,
        includePartner: false,
      };
    }
    if (!prepared.duty || prepared.duty.tasks.length === 0) {
      throw new Error(`Không có dữ liệu lịch trực cổng cho ngày ${lookupDate}`);
    }
    text = formatMessage(schedule.type, prepared.duty, lookupDate);
    return {
      text,
      lookupDate,
      effectiveTabName,
      held: false,
    };
  } else {
    const headerStyle = squad?.header_style || 'two_row_merged';
    const dutyData = await fetchDutySchedule(spreadsheetId, effectiveTabName, headerStyle, lookupDate);
    if (!dutyData || !dutyData.tasks || dutyData.tasks.length === 0) {
      throw new Error(`Không có dữ liệu lịch trực cổng cho ngày ${lookupDate}`);
    }
    text = formatMessage(schedule.type, dutyData, lookupDate);
  }

  return {
    text,
    lookupDate,
    effectiveTabName,
  };
}

/**
 * HÀM GỬI LỊCH DUY NHẤT TRONG HỆ THỐNG (send_schedule).
 */
export async function sendSchedule(
  scheduleKey: string,
  options: SendScheduleOptions = {}
): Promise<SendScheduleResult> {
  const { schedule, effectiveRecipients } = getEffectiveScheduleConfig(scheduleKey);
  const zalo = options.zaloClient || new ZaloClient();

  // 1. Xây dựng tin nhắn
  const built = await buildScheduleMessage(scheduleKey, options.targetDate);
  const { text, lookupDate } = built;

  if (built.held) {
    await warnExternalHold(zalo, scheduleKey, lookupDate, built.holdReason || 'Lịch đang chờ người trực.');
    return {
      scheduleKey,
      label: schedule.label,
      lookupDate,
      results: [],
      held: true,
      holdReason: built.holdReason,
    };
  }

  // 2. Chỉ gửi đúng các nhóm đã lưu trên lịch. Không tự thêm nhóm đối tác.
  const recipientKeys = options.recipientKey ? [options.recipientKey] : [...effectiveRecipients];

  const results: RecipientSendResult[] = [];

  // 3. Gửi tuần tự cho từng recipient (quy tắc #13: gửi từng người độc lập, không broadcast gộp)
  for (const rKey of recipientKeys) {
    const chatId = getRecipientChatId(rKey);
    if (!chatId) {
      console.error(`[sendSchedule] Không tìm thấy chat_id cho recipient '${rKey}'`);
      results.push({
        recipientKey: rKey,
        chatId: '',
        success: false,
        error: `Không tìm thấy chat_id cho recipient '${rKey}'`,
        oldMessageDeleted: false,
      });
      continue;
    }

    // 3a. Kiểm tra idempotency nếu là gửi tự động
    if (options.isAutomated && hasSentToday(scheduleKey, chatId, lookupDate)) {
      console.log(
        `[sendSchedule] Bỏ qua ${scheduleKey} tới ${chatId} vì đã gửi hôm nay (${lookupDate})`
      );
      results.push({
        recipientKey: rKey,
        chatId,
        success: true,
        skippedDueToIdempotency: true,
        oldMessageDeleted: false,
      });
      continue;
    }

    // 3b. Xóa tin nhắn cũ (F4 - best effort)
    let oldMessageDeleted = false;
    const oldMessageId = getLastMessageId(scheduleKey, chatId);
    if (oldMessageId) {
      oldMessageDeleted = await zalo.deleteMessage(chatId, oldMessageId);
    }

    // 3c. Gửi tin nhắn mới
    try {
      const sendRes = await zalo.sendMessage(chatId, text);
      const newMessageId = sendRes.messageId;

      // Lưu tin nhắn mới vào SQLite
      saveLastMessage(scheduleKey, chatId, newMessageId, lookupDate);

      // Ghi lịch sử thành công (F11)
      appendSendHistory({
        timestamp: new Date().toISOString(),
        schedule_key: scheduleKey,
        chat_id: chatId,
        result: 'success',
        old_message_deleted: oldMessageDeleted,
      });

      results.push({
        recipientKey: rKey,
        chatId,
        success: true,
        messageId: newMessageId,
        oldMessageDeleted,
      });
    } catch (sendErr: unknown) {
      const errorMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      console.error(
        `[sendSchedule] Lỗi gửi schedule ${scheduleKey} tới chat ${chatId}:`,
        errorMsg
      );

      // Ghi lịch sử thất bại (F11)
      appendSendHistory({
        timestamp: new Date().toISOString(),
        schedule_key: scheduleKey,
        chat_id: chatId,
        result: 'failure',
        error: errorMsg,
        old_message_deleted: oldMessageDeleted,
      });

      results.push({
        recipientKey: rKey,
        chatId,
        success: false,
        error: errorMsg,
        oldMessageDeleted,
      });
    }
  }

  return {
    scheduleKey,
    label: schedule.label,
    lookupDate,
    results,
  };
}

async function warnExternalHold(
  zalo: ZaloClient,
  scheduleKey: string,
  lookupDate: string,
  reason: string
): Promise<void> {
  const adminId = getRecipientChatId('admin');
  if (!adminId || adminId === 'admin') return;
  const key = `external_hold_${scheduleKey}`;
  if (hasSentToday(key, adminId, lookupDate)) return;
  try {
    await zalo.sendMessage(adminId, `⚠️ ${reason}`);
    saveLastMessage(key, adminId, `hold_${Date.now()}`, lookupDate);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sendSchedule] Không gửi được cảnh báo giữ lịch:', message);
  }
}
