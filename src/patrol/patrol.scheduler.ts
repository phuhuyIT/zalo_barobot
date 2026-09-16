import Database from 'better-sqlite3';
import { ZaloClient } from '../core/zaloClient';
import { getVietnamTimeParts } from '../sheets';
import {
  getPatrolDailyStatus,
  updatePatrolReminder,
  getPatrolSiteConfigs,
} from './patrol.repository';
import { getSquad1LeaderUserId, getPatrolGroupId } from './patrol.service';

export interface PatrolReminderResult {
  triggered: boolean;
  date: string;
  time: string;
  reminderCount: number;
  siteKey?: string;
  reason?: string;
  sentChatId?: string;
  siteResults?: Array<{
    siteKey: string;
    triggered: boolean;
    reminderCount: number;
    sentChatId?: string;
    reason?: string;
  }>;
}

const DEFAULT_REMINDER_SCHEDULE_TIMES = ['06:30', '06:35', '06:40'];
const DEFAULT_MAX_REMINDERS = 3;

/**
 * Kiểm tra và thực hiện gửi nhắc nhở nếu đến giờ và chưa nộp lịch cho từng site độc lập.
 */
export async function runPatrolReminders(
  now: Date = new Date(),
  options?: {
    zaloClient?: ZaloClient;
    database?: Database.Database;
    overrideTimeHM?: string; // Cho phép giả lập giờ kiểm tra trong manual test mode
    targetSiteKey?: string; // Cho phép kiểm tra riêng một site cụ thể
  }
): Promise<PatrolReminderResult> {
  const vn = getVietnamTimeParts(now);
  const currentTime = options?.overrideTimeHM || vn.timeHM; // "HH:MM"
  const todayDmy = vn.dateDMY; // "DD/MM/YYYY"

  let sites = getPatrolSiteConfigs(options?.database).filter((s) => s.enabled);
  if (options?.targetSiteKey) {
    sites = sites.filter((s) => s.siteKey === options.targetSiteKey);
  }

  // Fallback nếu chưa có site nào trong DB
  if (sites.length === 0) {
    const s1Leader = getSquad1LeaderUserId();
    const s1Group = getPatrolGroupId();
    if (s1Leader || s1Group) {
      sites = [
        {
          siteKey: 'site_1',
          displayName: 'Trụ sở 1 (Tân Phước Khánh)',
          leaderUserId: s1Leader,
          chatId: s1Group,
          mergeWithSheet: true,
          reminderTimes: DEFAULT_REMINDER_SCHEDULE_TIMES,
          maxReminders: DEFAULT_MAX_REMINDERS,
          enabled: true,
        },
      ];
    }
  }

  const siteResults: Array<{
    siteKey: string;
    triggered: boolean;
    reminderCount: number;
    sentChatId?: string;
    reason?: string;
  }> = [];

  const zalo = options?.zaloClient || new ZaloClient();

  for (const site of sites) {
    const reminderTimes =
      site.reminderTimes && site.reminderTimes.length > 0
        ? site.reminderTimes
        : DEFAULT_REMINDER_SCHEDULE_TIMES;
    const maxReminders = site.maxReminders || DEFAULT_MAX_REMINDERS;

    // 1. Kiểm tra xem thời điểm hiện tại có phải là mốc giờ nhắc nhở của site này không
    if (!reminderTimes.includes(currentTime)) {
      siteResults.push({
        siteKey: site.siteKey,
        triggered: false,
        reminderCount: 0,
        reason: `Thời gian hiện tại (${currentTime}) không thuộc các mốc nhắc nhở của ${site.displayName} (${reminderTimes.join(', ')})`,
      });
      continue;
    }

    // 2. Đọc trạng thái trong ngày từ SQLite
    const status = getPatrolDailyStatus(todayDmy, site.siteKey, options?.database);

    // 3. Nếu site này đã nộp lịch hợp lệ (hoặc đã báo nghỉ) -> DỪNG ngay tất cả nhắc nhở
    if (status?.submitted) {
      console.log(
        `[Patrol] Reminder stopped because schedule was received for ${site.displayName} on ${todayDmy}.`
      );
      siteResults.push({
        siteKey: site.siteKey,
        triggered: false,
        reminderCount: status.reminderCount,
        reason: `${site.displayName} đã nộp lịch hôm nay. Dừng gửi nhắc nhở.`,
      });
      continue;
    }

    const currentCount = status?.reminderCount || 0;

    // 4. Nếu đã đủ tối đa số lần nhắc nhở -> DỪNG
    if (currentCount >= maxReminders) {
      console.log(
        `[Patrol] ${site.displayName} đã đạt tối đa ${maxReminders} lần nhắc nhở hôm nay (${todayDmy}). Dừng gửi.`
      );
      siteResults.push({
        siteKey: site.siteKey,
        triggered: false,
        reminderCount: currentCount,
        reason: `Đã đạt giới hạn tối đa ${maxReminders} lần nhắc nhở cho ${site.displayName}.`,
      });
      continue;
    }

    // 5. Kiểm tra Idempotency: Nếu mốc giờ này đã được gửi nhắc nhở rồi thì không gửi lại
    if (status?.lastReminderAt === currentTime) {
      console.log(
        `[Patrol] Bỏ qua nhắc nhở lúc ${currentTime} cho ${site.displayName} vì đã gửi trước đó (Idempotency).`
      );
      siteResults.push({
        siteKey: site.siteKey,
        triggered: false,
        reminderCount: currentCount,
        reason: `Nhắc nhở cho mốc giờ này của ${site.displayName} đã được gửi thành công.`,
      });
      continue;
    }

    // 6. Xác định người nhận nhắc nhở: Gửi trực tiếp cho người phụ trách qua chat riêng hoặc nhóm
    const recipientChatId =
      site.leaderUserId ||
      site.chatId ||
      (site.siteKey === 'site_1' ? getSquad1LeaderUserId() || getPatrolGroupId() : '');

    if (!recipientChatId) {
      console.warn(
        `[Patrol] Không thể gửi nhắc nhở: Chưa cấu hình người nhận cho ${site.displayName}.`
      );
      siteResults.push({
        siteKey: site.siteKey,
        triggered: false,
        reminderCount: currentCount,
        reason: `Chưa cấu hình người nhận nhắc nhở cho ${site.displayName}.`,
      });
      continue;
    }

    const nextReminderCount = currentCount + 1;
    const reminderMessage =
      `⏰ Nhắc nhở nộp lịch tuần tra (Lần ${nextReminderCount}/${maxReminders})\n\n` +
      `Người phụ trách ${site.displayName} chưa nộp lịch đi tuần hôm nay (${todayDmy}).\n\n` +
      `Vui lòng sử dụng cú pháp:\n` +
      `tuantra <tên 1>, <tên 2>\n` +
      `hoặc đa ca:\n` +
      `tuantra\nCa 1: <tên>\nCa 2: <tên>\n` +
      `hoặc báo nghỉ nếu không có ca tuần:\n` +
      `tuantra 0 / tuantra nghi / tuantra none`;

    try {
      console.log(
        `[Patrol] Đang gửi nhắc nhở #${nextReminderCount} tới ${recipientChatId} cho ${site.displayName} lúc ${currentTime}...`
      );
      await zalo.sendMessage(recipientChatId, reminderMessage);

      // 7. Cập nhật trạng thái số lần nhắc nhở vào SQLite ngay lập tức
      updatePatrolReminder(
        {
          date: todayDmy,
          siteKey: site.siteKey,
          groupId: site.chatId || recipientChatId,
          leaderUserId: site.leaderUserId || recipientChatId,
          reminderCount: nextReminderCount,
          lastReminderAt: currentTime,
        },
        options?.database
      );

      console.log(
        `[Patrol]\nReminder #${nextReminderCount} sent for ${site.displayName}\nDate: ${todayDmy}\nTime: ${currentTime}`
      );

      siteResults.push({
        siteKey: site.siteKey,
        triggered: true,
        reminderCount: nextReminderCount,
        sentChatId: recipientChatId,
      });
    } catch (err: any) {
      console.error(`[Patrol] Lỗi gửi nhắc nhở #${nextReminderCount} cho ${site.displayName}:`, err.message);
      siteResults.push({
        siteKey: site.siteKey,
        triggered: false,
        reminderCount: currentCount,
        reason: `Gửi tin nhắn thất bại: ${err.message}`,
      });
    }
  }

  const triggeredSites = siteResults.filter((r) => r.triggered);
  const isTriggered = triggeredSites.length > 0;

  return {
    triggered: isTriggered,
    date: todayDmy,
    time: currentTime,
    reminderCount: triggeredSites[0]?.reminderCount || 0,
    siteKey: triggeredSites[0]?.siteKey,
    sentChatId: triggeredSites[0]?.sentChatId,
    reason: isTriggered ? undefined : siteResults[0]?.reason || 'Không có nhắc nhở nào được kích hoạt',
    siteResults,
  };
}
