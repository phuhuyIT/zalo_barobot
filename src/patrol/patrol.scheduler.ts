/**
 * patrol.scheduler.ts
 *
 * Quản lý lịch nhắc nhở nộp lịch đi tuần cho Tiểu đội trưởng 1 lúc 06:30, 06:35, 06:40.
 * Tuân thủ nghiêm ngặt các mục 16, 17, 18, 19, 20, 21, 22, 23 và Test 8 - 13.
 */

import Database from 'better-sqlite3';
import { ZaloClient } from '../core/zaloClient';
import { getVietnamTimeParts } from '../sheets';
import {
  getPatrolDailyStatus,
  updatePatrolReminder,
} from './patrol.repository';
import { getSquad1LeaderUserId, getPatrolGroupId } from './patrol.service';

export interface PatrolReminderResult {
  triggered: boolean;
  date: string;
  time: string;
  reminderCount: number;
  reason?: string;
  sentChatId?: string;
}

const REMINDER_SCHEDULE_TIMES = ['06:30', '06:35', '06:40'];
const MAX_REMINDERS = 3;

/**
 * Kiểm tra và thực hiện gửi nhắc nhở nếu đến giờ và chưa nộp lịch.
 */
export async function runPatrolReminders(
  now: Date = new Date(),
  options?: {
    zaloClient?: ZaloClient;
    database?: Database.Database;
    overrideTimeHM?: string; // Cho phép giả lập giờ kiểm tra trong manual test mode
  }
): Promise<PatrolReminderResult> {
  const vn = getVietnamTimeParts(now);
  const currentTime = options?.overrideTimeHM || vn.timeHM; // "HH:MM"
  const todayDmy = vn.dateDMY; // "DD/MM/YYYY"

  // 1. Kiểm tra xem thời điểm hiện tại có phải là 06:30, 06:35, hoặc 06:40 không
  if (!REMINDER_SCHEDULE_TIMES.includes(currentTime)) {
    return {
      triggered: false,
      date: todayDmy,
      time: currentTime,
      reminderCount: 0,
      reason: `Thời gian hiện tại (${currentTime}) không thuộc các mốc nhắc nhở (06:30, 06:35, 06:40)`,
    };
  }

  // 2. Đọc trạng thái trong ngày từ SQLite (Bảo vệ an toàn khi khởi động lại ứng dụng)
  const status = getPatrolDailyStatus(todayDmy, options?.database);

  // 3. Nếu Tiểu đội trưởng 1 đã nộp lịch hợp lệ hôm nay -> DỪNG ngay tất cả nhắc nhở
  if (status?.submitted) {
    console.log(
      `[Patrol] Reminder stopped because schedule was received for ${todayDmy}.`
    );
    return {
      triggered: false,
      date: todayDmy,
      time: currentTime,
      reminderCount: status.reminderCount,
      reason: 'Tiểu đội trưởng 1 đã nộp lịch hôm nay. Dừng gửi nhắc nhở.',
    };
  }

  const currentCount = status?.reminderCount || 0;

  // 4. Nếu đã đủ tối đa 3 lần nhắc nhở -> DỪNG (Tuyệt đối không gửi lần 4 lúc 06:45)
  if (currentCount >= MAX_REMINDERS) {
    console.log(
      `[Patrol] Đã đạt tối đa ${MAX_REMINDERS} lần nhắc nhở hôm nay (${todayDmy}). Dừng gửi.`
    );
    return {
      triggered: false,
      date: todayDmy,
      time: currentTime,
      reminderCount: currentCount,
      reason: 'Đã đạt giới hạn tối đa 3 lần nhắc nhở.',
    };
  }

  // 5. Kiểm tra Idempotency: Nếu mốc giờ này đã được gửi nhắc nhở rồi thì không gửi lại
  if (status?.lastReminderAt === currentTime) {
    console.log(
      `[Patrol] Bỏ qua nhắc nhở lúc ${currentTime} vì đã gửi trước đó (Idempotency).`
    );
    return {
      triggered: false,
      date: todayDmy,
      time: currentTime,
      reminderCount: currentCount,
      reason: 'Nhắc nhở cho mốc giờ này đã được gửi thành công.',
    };
  }

  // 6. Xác định người nhận nhắc nhở: Gửi trực tiếp cho Tiểu đội trưởng 1 qua chat riêng
  const squad1LeaderId = getSquad1LeaderUserId();
  const patrolGroupId = getPatrolGroupId();
  const recipientChatId = squad1LeaderId || patrolGroupId;

  if (!recipientChatId) {
    console.warn(
      `[Patrol] Không thể gửi nhắc nhở: Chưa cấu hình TIUDOI_1_LEADER_USER_ID hoặc PATROL_GROUP_ID.`
    );
    return {
      triggered: false,
      date: todayDmy,
      time: currentTime,
      reminderCount: currentCount,
      reason: 'Chưa cấu hình người nhận nhắc nhở.',
    };
  }

  const nextReminderCount = currentCount + 1;
  const reminderMessage =
    `⏰ Nhắc nhở (Lần ${nextReminderCount}/${MAX_REMINDERS})\n\n` +
    `Tiểu đội trưởng Tiểu đội 1 chưa nộp lịch đi tuần hôm nay (${todayDmy}).\n\n` +
    `Vui lòng sử dụng cú pháp:\ntuantra <tên>\nhoặc:\ntuantra <tên 1> <tên 2>`;

  const zalo = options?.zaloClient || new ZaloClient();

  try {
    console.log(
      `[Patrol] Đang gửi nhắc nhở #${nextReminderCount} tới ${recipientChatId} lúc ${currentTime}...`
    );
    await zalo.sendMessage(recipientChatId, reminderMessage);

    // 7. Cập nhật trạng thái số lần nhắc nhở vào SQLite ngay lập tức
    updatePatrolReminder(
      {
        date: todayDmy,
        groupId: patrolGroupId || recipientChatId,
        leaderUserId: squad1LeaderId || recipientChatId,
        reminderCount: nextReminderCount,
        lastReminderAt: currentTime,
      },
      options?.database
    );

    console.log(
      `[Patrol]\nReminder #${nextReminderCount} sent\nDate: ${todayDmy}\nTime: ${currentTime}`
    );

    return {
      triggered: true,
      date: todayDmy,
      time: currentTime,
      reminderCount: nextReminderCount,
      sentChatId: recipientChatId,
    };
  } catch (err: any) {
    console.error(`[Patrol] Lỗi gửi nhắc nhở #${nextReminderCount}:`, err.message);
    return {
      triggered: false,
      date: todayDmy,
      time: currentTime,
      reminderCount: currentCount,
      reason: `Gửi tin nhắn thất bại: ${err.message}`,
    };
  }
}
