/**
 * scheduler.ts
 *
 * Tầng Scheduler quản lý tự động gửi lịch (F1) và nhắc nhở Admin (F6).
 * Sử dụng node-cron để lên lịch linh hoạt.
 * Hỗ trợ:
 * - refreshSchedules(): Hủy và đăng ký lại jobs ngay tại runtime khi Admin đổi cấu hình (F9).
 * - Nhắc nhở trước giờ gửi (Heads-up) và cảnh báo sau giờ gửi nếu chưa gửi (F6).
 * - Endpoint /internal/run-due-jobs làm lớp bảo vệ thứ 2 cho Railway Cron Job (Mục 6.3).
 */

import cron, { ScheduledTask } from 'node-cron';
import { Router, Request, Response } from 'express';
import { getConfig, getRecipientChatId } from '../config';
import { getEffectiveScheduleConfig, sendSchedule } from '../core';
import { hasSentToday, saveLastMessage } from '../store';
import { ZaloClient } from '../core/zaloClient';
import { formatDateDMY, resolveLookupDate, getVietnamTimeParts } from '../sheets/dateUtils';

export const schedulerRouter = Router();

// Lưu trữ các cron task đang chạy để có thể cancel / refresh
const activeCronTasks: ScheduledTask[] = [];

/**
 * Kiểm tra xem công việc có đến hạn gửi lúc này không theo múi giờ Việt Nam.
 */
function isTimeMatching(targetTimeStr: string, now: Date): boolean {
  const [targetH, targetM] = targetTimeStr.split(':').map(Number);
  const vn = getVietnamTimeParts(now);
  return vn.hours === targetH && vn.minutes === targetM;
}

/**
 * Tính toán giờ nhắc nhở trước N phút.
 */
function subtractMinutesFromTime(timeStr: string, minutesToSubtract: number): string | null {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMinutes = h * 60 + m - minutesToSubtract;
  if (totalMinutes < 0) return null; // Nếu rơi vào ngày hôm trước thì bỏ qua theo mục 5.5a
  const newH = Math.floor(totalMinutes / 60);
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

/**
 * Hàm kiểm tra và chạy tất cả các jobs đến hạn (dùng chung cho cả Cron nội bộ và Railway Cron).
 */
export async function runDueJobs(now: Date = new Date()): Promise<{
  schedulesRun: string[];
  remindersRun: string[];
}> {
  const config = getConfig();
  const schedulesRun: string[] = [];
  const remindersRun: string[] = [];

  const vn = getVietnamTimeParts(now);
  const adminChatId = getRecipientChatId('admin', config);
  const zalo = new ZaloClient();

  // 1. Kiểm tra các schedule tự động (F1)
  for (const s of config.schedules) {
    const effective = getEffectiveScheduleConfig(s.key);
    if (!effective.effectiveEnabled || !effective.effectiveSendTime) {
      continue;
    }

    if (isTimeMatching(effective.effectiveSendTime, now)) {
      console.log(`[Scheduler] 🚀 [${vn.timeHM} VN] Đến giờ gửi tự động cho schedule '${s.key}' (${effective.effectiveSendTime})`);
      try {
        await sendSchedule(s.key, { isAutomated: true });
        schedulesRun.push(s.key);
      } catch (err: any) {
        console.error(`[Scheduler] ❌ Lỗi gửi schedule '${s.key}':`, err.message);
      }
    }
  }

  // 2. Kiểm tra các nhắc nhở Admin (F6)
  if (adminChatId) {
    for (const rem of config.reminders) {
      const schedule = config.schedules.find((s) => s.key === rem.schedule_key);
      if (!schedule) continue;

      const effective = getEffectiveScheduleConfig(rem.schedule_key);
      if (!effective.effectiveEnabled) continue;

      const nowDmy = formatDateDMY(now);
      const isOvernight = Boolean(effective.squad?.overnight);
      const cutoverTime = effective.squad?.cutover_time || '05:30';
      const lookupDate = resolveLookupDate(now, isOvernight, cutoverTime, effective.effectiveSendNextDay);

      // 2a. Nhắc nhở TRƯỚC giờ gửi (Heads-up)
      if (effective.effectiveSendTime && rem.remind_before_send_minutes) {
        const remindTime = subtractMinutesFromTime(
          effective.effectiveSendTime,
          rem.remind_before_send_minutes
        );

        if (remindTime && isTimeMatching(remindTime, now)) {
          const reminderKey = `reminder_before_${rem.schedule_key}`;
          const alreadyReminded = hasSentToday(reminderKey, adminChatId, nowDmy);

          if (!alreadyReminded) {
            const msg = `⏰ Còn ${rem.remind_before_send_minutes} phút nữa là hệ thống tự động gửi lịch "${schedule.label}". Giờ gửi dự kiến: ${effective.effectiveSendTime}. Hãy kiểm tra và cập nhật Google Sheet nếu có thay đổi nhé!`;
            try {
              await zalo.sendMessage(adminChatId, msg);
              saveLastMessage(reminderKey, adminChatId, `rem_${Date.now()}`, nowDmy);
              remindersRun.push(reminderKey);
              console.log(`[Scheduler] Đã gửi nhắc nhở trước giờ gửi cho Admin: ${rem.schedule_key}`);
            } catch (err: any) {
              console.error(`[Scheduler] Lỗi gửi nhắc nhở trước:`, err.message);
            }
          }
        }
      }

      // 2b. Cảnh báo SAU giờ gửi nếu chưa gửi thành công (Failure alert)
      if (rem.remind_if_not_sent_by && isTimeMatching(rem.remind_if_not_sent_by, now)) {
        const alertKey = `alert_failed_${rem.schedule_key}`;
        const alreadyAlerted = hasSentToday(alertKey, adminChatId, nowDmy);

        // Kiểm tra xem lịch đã gửi thành công hôm nay chưa
        const firstRecipientChat = getRecipientChatId(schedule.recipients[0], config);
        const hasSent = hasSentToday(rem.schedule_key, firstRecipientChat, lookupDate);

        if (!hasSent && !alreadyAlerted) {
          const alertMsg = `⚠️ CẢNH BÁO: Đã qua mốc ${rem.remind_if_not_sent_by} nhưng lịch "${schedule.label}" vẫn CHƯA ĐƯỢC GỬI THÀNH CÔNG hôm nay! Vui lòng kiểm tra lại hệ thống và Google Sheet!`;
          try {
            await zalo.sendMessage(adminChatId, alertMsg);
            saveLastMessage(alertKey, adminChatId, `alert_${Date.now()}`, nowDmy);
            remindersRun.push(alertKey);
            console.log(`[Scheduler] Đã gửi cảnh báo quá hạn cho Admin: ${rem.schedule_key}`);
          } catch (err: any) {
            console.error(`[Scheduler] Lỗi gửi cảnh báo quá hạn:`, err.message);
          }
        }
      }
    }
  }

  return { schedulesRun, remindersRun };
}

/**
 * Khởi động hệ thống scheduler.
 * Chạy cron kiểm tra mỗi phút 1 lần để quét các sự kiện đến hạn.
 */
export function startScheduler(): void {
  stopScheduler();

  const vn = getVietnamTimeParts();
  console.log(`[Scheduler] ⏰ Internal scheduler đã khởi động (Múi giờ: Asia/Ho_Chi_Minh).`);
  console.log(`[Scheduler] 🕒 Giờ hiện tại (VN): ${vn.timeHM} ngày ${vn.dateDMY}`);

  const config = getConfig();
  for (const s of config.schedules) {
    const effective = getEffectiveScheduleConfig(s.key);
    if (effective.effectiveEnabled && effective.effectiveSendTime) {
      console.log(`[Scheduler] 📌 Lịch '${s.key}': tự động gửi lúc ${effective.effectiveSendTime} (VN)`);
    }
  }

  // Chạy mỗi phút 1 lần ('* * * * *')
  const task = cron.schedule('* * * * *', async () => {
    try {
      await runDueJobs(new Date());
    } catch (err: any) {
      console.error('[Scheduler] ❌ Lỗi thực thi runDueJobs:', err.message);
    }
  });

  activeCronTasks.push(task);
  console.log('[Scheduler] ✅ Scheduler đã sẵn sàng chạy ngầm mỗi phút.');
}

/**
 * Dừng tất cả các cron tasks đang chạy.
 */
export function stopScheduler(): void {
  for (const t of activeCronTasks) {
    t.stop();
  }
  activeCronTasks.length = 0;
}

/**
 * Hủy và đăng ký lại scheduler khi cấu hình thay đổi (F9).
 */
export function refreshSchedules(): void {
  console.log('[Scheduler] Làm mới danh sách công việc scheduler (F9)...');
  startScheduler();
}

/**
 * Endpoint POST /internal/run-due-jobs
 * Lớp bảo vệ thứ 2: Được Railway Cron Job gọi định kỳ (ví dụ mỗi 5 phút)
 * để đảm bảo không bị miss lịch nếu tiến trình chính bị gián đoạn (Mục 6.3).
 */
schedulerRouter.post('/internal/run-due-jobs', async (req: Request, res: Response) => {
  const expectedKey = process.env.INTERNAL_API_KEY;
  if (expectedKey) {
    const receivedKey =
      req.headers['x-internal-key'] ||
      req.headers['authorization']?.replace('Bearer ', '') ||
      req.query.key;

    if (receivedKey !== expectedKey) {
      res.status(403).json({ error: 'Unauthorized internal API key' });
      return;
    }
  }

  try {
    const result = await runDueJobs(new Date());
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
