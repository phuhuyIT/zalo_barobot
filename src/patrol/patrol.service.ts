/**
 * patrol.service.ts
 *
 * Nghiệp vụ xử lý lệnh đi tuần từ Tiểu đội trưởng 1 và tổng hợp báo cáo gửi Trung đội trưởng.
 * Tái sử dụng các module hạ tầng có sẵn: Google Sheets, ZaloClient, SQLite Store, DateUtils.
 */

import Database from 'better-sqlite3';
import { ZaloClient } from '../core/zaloClient';
import { getEffectiveScheduleConfig } from '../core';
import { fetchDutySchedule, getVietnamTimeParts } from '../sheets';
import {
  getPatrolDailyStatus,
  savePatrolSubmission,
  getPatrolMembers,
} from './patrol.repository';
import { parsePatrolCommand } from './patrol.parser';
import { PatrolCommandPayload, PatrolCommandResult } from './patrol.types';
import { getRecipientChatId, getConfig } from '../config';

/**
 * Lấy cấu hình User ID của Tiểu đội trưởng 1.
 */
export function getSquad1LeaderUserId(): string {
  return (
    process.env.TIUDOI_1_LEADER_USER_ID ||
    process.env.TIEU_DOI_1_LEADER_USER_ID ||
    process.env.SQUAD_1_LEADER_USER_ID ||
    ''
  ).trim();
}

/**
 * Lấy cấu hình Chat ID của nhóm đi tuần (PATROL_GROUP_ID).
 */
export function getPatrolGroupId(): string {
  return (
    process.env.PATROL_GROUP_ID ||
    process.env.PATROL_CHAT_ID ||
    ''
  ).trim();
}

/**
 * Lấy Chat ID của Trung đội trưởng nhận báo cáo.
 */
export function getPlatoonLeaderChatId(): string {
  const envId = (process.env.PLATOON_LEADER_CHAT_ID || '').trim();

  if (envId) return envId;

  // Tra cứu từ recipients trong config
  try {
    return getRecipientChatId('platoon_leader') || '';
  } catch (_) {
    return '';
  }
}

/**
 * Kiểm tra xem 2 mảng chuỗi có giống hệt nhau không.
 */
function areArraysEqual(arr1: string[], arr2: string[]): boolean {
  if (arr1.length !== arr2.length) return false;
  return arr1.every((val, idx) => val === arr2[idx]);
}

/**
 * Xây dựng nội dung tin nhắn báo cáo lịch đi tuần tổng hợp cho Trung đội trưởng.
 */
export function buildCombinedPatrolMessage(
  targetDate: string,
  squad1Members: string[],
  mySquadPatrolTasks: { taskName: string; assignee: string; subTask?: string }[]
): string {
  const lines: string[] = [];
  lines.push(`📋 LỊCH ĐI TUẦN TRA NGÀY ${targetDate}`);
  lines.push('');

  lines.push('Tiểu đội 1:');
  for (const name of squad1Members) {
    lines.push(`- ${name}`);
  }

  lines.push('');
  lines.push('Tiểu đội 2:');
  for (const t of mySquadPatrolTasks) {
    if (t.subTask) {
      lines.push(`- ${t.subTask}: ${t.assignee}`);
    } else {
      lines.push(`- ${t.taskName}: ${t.assignee}`);
    }
  }

  return lines.join('\n');
}

/**
 * Lấy danh sách ca đi tuần của Tiểu đội mình (Tiểu đội 2) từ Google Sheets cho ngày hôm nay.
 */
export async function fetchMySquadPatrolTasks(targetDate: string): Promise<
  { taskName: string; assignee: string; subTask?: string }[]
> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    throw new Error('Biến môi trường GOOGLE_SHEET_ID chưa được cấu hình.');
  }

  // Tái sử dụng cấu hình tab và parser của schedule 'patrol_summary' hoặc 'main_duty'
  let effectiveTabName = '';
  let headerStyle: 'two_row_merged' | 'single_row' = 'two_row_merged';

  try {
    const effective = getEffectiveScheduleConfig('patrol_summary');
    effectiveTabName = effective.effectiveTabName;
    headerStyle = effective.squad?.header_style || 'two_row_merged';
  } catch (_) {
    try {
      const effective = getEffectiveScheduleConfig('main_duty');
      effectiveTabName = effective.effectiveTabName;
      headerStyle = effective.squad?.header_style || 'two_row_merged';
    } catch (e: any) {
      throw new Error(`Không thể xác định cấu hình tab Tiểu đội 2: ${e.message}`);
    }
  }

  const dutyData = await fetchDutySchedule(
    spreadsheetId,
    effectiveTabName,
    headerStyle,
    targetDate
  );

  if (!dutyData || !dutyData.tasks || dutyData.tasks.length === 0) {
    return [];
  }

  // Lọc riêng các nhiệm vụ đi tuần / tuần tra theo quy ước sẵn có trong patrolOnlyFormatter
  const patrolTasks = dutyData.tasks.filter((t) => {
    const fullName = `${t.parentTask || ''} ${t.taskName}`.toLowerCase();
    return fullName.includes('đi tuần') || fullName.includes('tuần tra');
  });

  return patrolTasks.map((t) => ({
    taskName: t.taskName,
    assignee: t.assignee,
    subTask: t.subTask,
  }));
}

/**
 * Xử lý lệnh `tuantra` nhận từ Webhook.
 */
export async function handlePatrolCommand(
  payload: PatrolCommandPayload,
  options?: {
    zaloClient?: ZaloClient;
    database?: Database.Database;
    skipSheetFetchForTesting?: boolean;
    mockMySquadTasks?: { taskName: string; assignee: string; subTask?: string }[];
  }
): Promise<PatrolCommandResult> {
  const text = (payload.text || '').trim();
  const chatId = String(payload.chatId || '').trim();
  const senderId = String(payload.senderId || '').trim();
  const messageId = payload.messageId ? String(payload.messageId).trim() : undefined;

  // 1. Kiểm tra xem tin nhắn có phải lệnh tuantra không (kể cả có @mention hoặc /tuantra)
  if (!/(?:^|\s|\/)tuantra(?:\s*[\+:]|\s+|$)/i.test(text)) {
    return { handled: false, success: false };
  }

  console.log(`[Patrol] Nhận lệnh "${text}" từ sender_id: ${senderId} trong chat_id: ${chatId}`);

  const zalo = options?.zaloClient || new ZaloClient();
  const squad1LeaderId = getSquad1LeaderUserId();
  const patrolGroupId = getPatrolGroupId();
  const platoonLeaderId = getPlatoonLeaderChatId();

  // 2. Validate Sender (Chỉ chấp nhận từ Tiểu đội trưởng 1)
  if (squad1LeaderId && senderId !== squad1LeaderId) {
    console.warn(
      `[Patrol] BỎ QUA: Người gửi "${senderId}" không phải Tiểu đội trưởng 1 ("${squad1LeaderId}")`
    );
    return {
      handled: true,
      success: false,
      ignoredReason: 'unauthorized_sender',
      error: 'Sender is not the authorized Squad 1 leader',
    };
  }

  // 3. Validate Group / Chat:
  // Cho phép gửi trực tiếp tới Bot (Private chat: chatId === squad1LeaderId) hoặc trong nhóm đi tuần (chatId === patrolGroupId)
  const isDirectChat = Boolean(squad1LeaderId && chatId === squad1LeaderId);
  const isPatrolGroup = Boolean(patrolGroupId && chatId === patrolGroupId);

  if (patrolGroupId && !isDirectChat && !isPatrolGroup) {
    console.warn(
      `[Patrol] BỎ QUA: Chat/Nhóm "${chatId}" không phải chat riêng với Tiểu đội trưởng 1 hay nhóm đi tuần ("${patrolGroupId}")`
    );
    return {
      handled: true,
      success: false,
      ignoredReason: 'unauthorized_group',
      error: 'Command received from an unauthorized chat or group',
    };
  }

  // 4. Xác định ngày hôm nay theo múi giờ Việt Nam (Asia/Ho_Chi_Minh)
  const vnTime = getVietnamTimeParts(new Date());
  const todayDmy = vnTime.dateDMY; // DD/MM/YYYY

  // 5. Kiểm tra Idempotency cho messageId (tránh xử lý lặp lại do webhook retry)
  const currentDailyStatus = getPatrolDailyStatus(todayDmy, options?.database);
  if (messageId && currentDailyStatus?.messageId === messageId) {
    console.log(`[Patrol] Bỏ qua messageId trùng lặp đã xử lý trước đó: ${messageId}`);
    return {
      handled: true,
      success: true,
      ignoredReason: 'duplicate_message',
      members: currentDailyStatus.selectedMembers,
      summarySent: false,
    };
  }

  // 6. Phân tích lệnh
  const roster = getPatrolMembers(options?.database);
  const parseResult = parsePatrolCommand(text, roster);

  if (!parseResult.isValid) {
    console.warn(`[Patrol] Cú pháp không hợp lệ: ${parseResult.error}`);

    // Gửi thông báo phản hồi lỗi cú pháp về cho Tiểu đội trưởng 1 (hoặc trong nhóm)
    try {
      const errorMsg = `⚠️ ${parseResult.error}`;
      await zalo.sendMessage(chatId, errorMsg);
    } catch (err: any) {
      console.error(`[Patrol] Không thể gửi phản hồi lỗi cú pháp:`, err.message);
    }

    return {
      handled: true,
      success: false,
      error: parseResult.error,
    };
  }

  const selectedMembers = parseResult.members;
  console.log(
    `[Patrol] Đã nhận lệnh từ Tiểu đội trưởng 1\nDate: ${todayDmy}\nMembers: ${selectedMembers.join(', ')}`
  );

  // 7. Kiểm tra xem lịch có thay đổi so với lần nộp trước trong cùng ngày không
  const isScheduleChanged =
    !currentDailyStatus?.submitted ||
    !areArraysEqual(currentDailyStatus.selectedMembers, selectedMembers);

  // 8. Tải lịch đi tuần của Tiểu đội 2 (Đội mình)
  let mySquadTasks: { taskName: string; assignee: string; subTask?: string }[] = [];
  if (options?.mockMySquadTasks) {
    mySquadTasks = options.mockMySquadTasks;
  } else if (!options?.skipSheetFetchForTesting) {
    try {
      console.log(`[Patrol] Đang tải lịch đi tuần Tiểu đội 2 từ Google Sheets ngày ${todayDmy}...`);
      mySquadTasks = await fetchMySquadPatrolTasks(todayDmy);
      console.log(
        `[Patrol] Lịch Tiểu đội 2 giải quyết thành công (${mySquadTasks.length} ca):`,
        mySquadTasks.map((t) => `${t.taskName}: ${t.assignee}`).join(', ')
      );
    } catch (sheetErr: any) {
      console.error('[Patrol] PATROL SUMMARY FAILED');
      console.error('Reason: Cannot resolve current team\'s patrol schedule:', sheetErr.message);
      return {
        handled: true,
        success: false,
        error: `Cannot resolve current team's patrol schedule: ${sheetErr.message}`,
      };
    }
  }

  // 9. Xây dựng và gửi báo cáo tổng hợp cho Trung đội trưởng nếu lịch có thay đổi
  let summarySent = false;
  if (isScheduleChanged) {
    const combinedMessage = buildCombinedPatrolMessage(
      todayDmy,
      selectedMembers,
      mySquadTasks
    );

    if (platoonLeaderId) {
      console.log(`[Patrol] Đang gửi lịch tổng hợp tới Trung đội trưởng (${platoonLeaderId})...`);
      try {
        await zalo.sendMessage(platoonLeaderId, combinedMessage);
        summarySent = true;
        console.log(`[Patrol] Đã gửi thành công lịch tổng hợp tới Trung đội trưởng.`);
      } catch (sendErr: any) {
        console.error(`[Patrol] Lỗi gửi tới Trung đội trưởng:`, sendErr.message);
        return {
          handled: true,
          success: false,
          error: `Gửi lịch tới Trung đội trưởng thất bại: ${sendErr.message}`,
        };
      }
    } else {
      console.warn(`[Patrol] CẢNH BÁO: Chưa cấu hình Chat ID của Trung đội trưởng (PLATOON_LEADER_CHAT_ID).`);
    }
  } else {
    console.log(`[Patrol] Lịch không thay đổi so với bản đã nộp hôm nay, bỏ qua gửi lại cho Trung đội trưởng.`);
  }

  // 10. Lưu trạng thái nộp vào SQLite (Đánh dấu đã nộp để dừng nhắc nhở ngay lập tức)
  savePatrolSubmission(
    {
      date: todayDmy,
      groupId: chatId,
      senderId: senderId,
      leaderUserId: squad1LeaderId || senderId,
      selectedMembers,
      rawMessage: text,
      messageId: messageId,
      receivedAt: new Date().toISOString(),
    },
    options?.database
  );

  console.log(`[Patrol] Đã lưu trạng thái nộp lịch đi tuần ngày ${todayDmy} vào cơ sở dữ liệu.`);

  // 11. Gửi xác nhận phản hồi cho Tiểu đội trưởng 1 khi nộp trực tiếp qua chat riêng với Bot
  if (isDirectChat) {
    try {
      const confirmMsg =
        `✅ Đã nhận lịch đi tuần Tiểu đội 1 ngày ${todayDmy}:\n` +
        selectedMembers.map((m) => `• ${m}`).join('\n') +
        `\n\n` +
        (isScheduleChanged
          ? `Đã tổng hợp và gửi báo cáo cho Trung đội trưởng.`
          : `(Lịch không thay đổi so với bản đã nộp hôm nay).`);
      await zalo.sendMessage(chatId, confirmMsg);
      console.log(`[Patrol] Đã gửi xác nhận thành công tới Tiểu đội trưởng 1 (${chatId}).`);
    } catch (confirmErr: any) {
      console.error(`[Patrol] Lỗi gửi xác nhận lại cho người nộp:`, confirmErr.message);
    }
  }

  return {
    handled: true,
    success: true,
    members: selectedMembers,
    summarySent,
  };
}
