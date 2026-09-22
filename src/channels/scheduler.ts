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
import { getDatabase, hasSentToday, saveLastMessage } from '../store';
import { ZaloClient } from '../core/zaloClient';
import { formatDateDMY, resolveLookupDate, getVietnamTimeParts } from '../sheets/dateUtils';
import { runPatrolReminders } from '../patrol';
import { getInternalApiKey } from '../taskproof/env';
import { notifyIfWorkerDownWithOpenTasks } from '../taskproof/health';
import { readInternalKey, timingSafeCompare } from '../taskproof/internalAuth';
import { cancelStaleTasks } from '../taskproof/lifecycle';
import { reportUnreportedCompletedTasks, TaskReportResult } from '../taskproof/report';
import { pruneTaskproofEphemeral } from '../taskproof/store';

export const schedulerRouter = Router();

// Lưu trữ các cron task đang chạy để có thể cancel / refresh
const activeCronTasks: ScheduledTask[] = [];

/** Cửa sổ bắt kịp (phút) khi cron Railway trễ hơn mốc HH:MM. */
export const AUTO_SEND_CATCHUP_MINUTES = 10;

/**
 * Kiểm tra xem công việc có đến hạn gửi lúc này không theo múi giờ Việt Nam.
 * windowMinutes > 0: từ đúng mốc đến window phút sau (bắt kịp cron trễ).
 */
export function isTimeMatching(targetTimeStr: string, now: Date, windowMinutes = 0): boolean {
  const [targetH, targetM] = targetTimeStr.split(':').map(Number);
  if (!Number.isFinite(targetH) || !Number.isFinite(targetM)) return false;
  const vn = getVietnamTimeParts(now);
  const nowMin = vn.hours * 60 + vn.minutes;
  const targetMin = targetH * 60 + targetM;
  if (windowMinutes <= 0) {
    return nowMin === targetMin;
  }
  let diff = nowMin - targetMin;
  if (diff < 0) diff += 24 * 60;
  return diff >= 0 && diff <= windowMinutes;
}

/**
 * Tính khoảng cách phút từ timeA đến timeB trong chu kỳ 24h (HH:MM -> HH:MM).
 */
function getMinutesDifference(fromTime: string, toTime: string): number {
  const [fromHours, fromMinutes] = fromTime.split(':').map(Number);
  const [toHours, toMinutes] = toTime.split(':').map(Number);
  let diff = (toHours * 60 + toMinutes) - (fromHours * 60 + fromMinutes);
  if (diff < 0) diff += 24 * 60;
  return diff;
}

/**
 * Tính toán giờ cộng thêm N phút (HH:MM).
 */
function addMinutesToTime(timeStr: string, minutesToAdd: number): string {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMinutes = (h * 60 + m + minutesToAdd) % (24 * 60);
  const newH = Math.floor(totalMinutes / 60);
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
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

let runDueJobsInFlight = false;

export function resetRunDueJobsLockForTests(): void {
  runDueJobsInFlight = false;
}

/**
 * Hàm kiểm tra và chạy tất cả các jobs đến hạn (dùng chung cho cả Cron nội bộ và Railway Cron).
 */
export async function runDueJobs(now: Date = new Date()): Promise<{
  schedulesRun: string[];
  remindersRun: string[];
  staleCancelled: string[];
  reportsSent: string[];
  workerHealthNotified: boolean;
  skipped?: boolean;
}> {
  if (runDueJobsInFlight) {
    return {
      schedulesRun: [],
      remindersRun: [],
      staleCancelled: [],
      reportsSent: [],
      workerHealthNotified: false,
      skipped: true,
    };
  }
  runDueJobsInFlight = true;
  try {
    return await runDueJobsOnce(now);
  } finally {
    runDueJobsInFlight = false;
  }
}

async function runDueJobsOnce(now: Date): Promise<{
  schedulesRun: string[];
  remindersRun: string[];
  staleCancelled: string[];
  reportsSent: string[];
  workerHealthNotified: boolean;
}> {
  const config = getConfig();
  const schedulesRun: string[] = [];
  const remindersRun: string[] = [];
  const staleCancelled: string[] = [];
  const reportsSent: string[] = [];
  let workerHealthNotified = false;

  const vn = getVietnamTimeParts(now);
  const adminChatId = getRecipientChatId('admin', config);
  const zalo = new ZaloClient();

  // 1. Kiểm tra các schedule tự động (F1)
  for (const s of config.schedules) {
    const effective = getEffectiveScheduleConfig(s.key);
    if (!effective.effectiveEnabled || !effective.effectiveSendTime) {
      continue;
    }

    if (isTimeMatching(effective.effectiveSendTime, now, AUTO_SEND_CATCHUP_MINUTES)) {
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
      const nextDayCutover =
        effective.squad?.next_day_cutover_time || effective.schedule.next_day_cutover_time || '20:00';
      const lookupDate = resolveLookupDate(
        now,
        isOvernight,
        cutoverTime,
        effective.effectiveSendNextDay,
        nextDayCutover
      );

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
      let alertTime: string | null = rem.remind_if_not_sent_by || null;

      if (effective.effectiveSendTime) {
        if (alertTime) {
          // Tính offset giữa alertTime và auto_send_time gốc
          const baseSendTime = schedule.auto_send_time;
          let offsetMinutes = 10;
          if (baseSendTime) {
            const diff = getMinutesDifference(baseSendTime, alertTime);
            // Nếu diff hợp lý (> 0 và < 12h), giữ nguyên khoảng cách offset này
            if (diff > 0 && diff < 12 * 60) {
              offsetMinutes = diff;
            }
          }
          // Nếu effectiveSendTime khác baseSendTime HOẶC alertTime cấu hình rơi vào trước/bằng effectiveSendTime:
          // Tự động dịch chuyển alertTime theo effectiveSendTime + offsetMinutes
          const currentDiff = getMinutesDifference(effective.effectiveSendTime, alertTime);
          if (effective.effectiveSendTime !== baseSendTime || currentDiff === 0 || currentDiff > 12 * 60) {
            alertTime = addMinutesToTime(effective.effectiveSendTime, offsetMinutes);
          }
        } else {
          // Mặc định cảnh báo sau 10 phút nếu chưa gửi thành công
          alertTime = addMinutesToTime(effective.effectiveSendTime, 10);
        }
      }

      if (alertTime && isTimeMatching(alertTime, now)) {
        const alertKey = `alert_failed_${rem.schedule_key}`;
        const alreadyAlerted = hasSentToday(alertKey, adminChatId, nowDmy);

        // Kiểm tra xem lịch đã gửi thành công hôm nay chưa
        const recipientKey = effective.effectiveRecipients[0] || schedule.recipients[0];
        const firstRecipientChat = getRecipientChatId(recipientKey, config);
        const hasSent = hasSentToday(rem.schedule_key, firstRecipientChat, lookupDate);

        if (!hasSent && !alreadyAlerted) {
          const alertMsg = `⚠️ CẢNH BÁO: Đã qua mốc ${alertTime} nhưng lịch "${schedule.label}" vẫn CHƯA ĐƯỢC GỬI THÀNH CÔNG hôm nay! Vui lòng kiểm tra lại hệ thống và Google Sheet!`;
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

  // 3. Kiểm tra nhắc nhở nộp lịch đi tuần Tiểu đội 1 (06:30, 06:35, 06:40)
  try {
    const patrolRes = await runPatrolReminders(now);
    if (patrolRes.triggered) {
      remindersRun.push(`patrol_reminder_${patrolRes.reminderCount}`);
    }
  } catch (err: any) {
    console.error(`[Scheduler] ❌ Lỗi thực thi runPatrolReminders:`, err.message);
  }

  try {
    pruneTaskproofEphemeral(getDatabase(), now.getTime());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Scheduler] prune task-proof bỏ qua:', msg);
  }

  // 4. Task-proof stale-cancel: collecting|overdue già hơn TASK_STALE_AFTER_MS → /huy
  try {
    const cancelled = cancelStaleTasks(getDatabase(), now.getTime());
    for (const row of cancelled) {
      staleCancelled.push(row.short_code);
      console.log(`[Scheduler] Task-proof stale → cancelled: ${row.short_code}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Scheduler] ❌ Lỗi stale-cancel task-proof:', msg);
  }

  // 5. T6 báo cáo: completed AND reported_at IS NULL — sendPhoto URL https, skip ảnh chết
  try {
    const reports: TaskReportResult[] = await reportUnreportedCompletedTasks(getDatabase());
    for (const row of reports) {
      if (row.error === 'already_reported') continue;
      if (row.reported) {
        reportsSent.push(row.shortCode);
        console.log(
          `[Scheduler] Task-proof report ${row.shortCode} → ${row.destination} (skip ${row.photosSkipped})`
        );
      } else if (row.error) {
        console.warn(`[Scheduler] Task-proof report ${row.shortCode} chưa gửi: ${row.error}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Scheduler] ❌ Lỗi báo cáo task-proof:', msg);
  }

  // 6. Step 11: worker down + còn task liên kết mở → báo admin (không kéo sập /gui)
  try {
    const health = await notifyIfWorkerDownWithOpenTasks(getDatabase());
    workerHealthNotified = health.notified;
    if (health.notified) {
      console.warn(`[Scheduler] Task-proof worker down, đã báo admin (${health.openCount} task mở).`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Scheduler] ❌ Lỗi health worker task-proof:', msg);
  }

  return { schedulesRun, remindersRun, staleCancelled, reportsSent, workerHealthNotified };
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
  const expectedKey = getInternalApiKey();
  if (!expectedKey) {
    res.status(403).json({ success: false, error: 'INTERNAL_API_KEY is not configured on the server.' });
    return;
  }

  const receivedKey = readInternalKey(req);

  if (!receivedKey || !timingSafeCompare(receivedKey, expectedKey)) {
    res.status(403).json({ success: false, error: 'Unauthorized internal API key' });
    return;
  }

  try {
    const result = await runDueJobs(new Date());
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: errorMsg });
  }
});
