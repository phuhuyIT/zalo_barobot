/**
 * web.ts
 *
 * Tầng Web Channel cung cấp API cho Dashboard, Xem trước (F10),
 * Gửi lại (F2, F5), Cấu hình runtime (F9), và Lịch sử gửi (F11).
 */

import { Router, Request, Response } from 'express';
import { getConfig, getRecipientChatId } from '../config';
import {
  buildScheduleMessage,
  getEffectiveScheduleConfig,
  sendSchedule,
} from '../core';
import {
  getRecentSendHistory,
  saveRuntimeConfigOverride,
  getLastMessageId,
  getLastMessageInfo,
  getDatabase,
  getAllRecipients,
  getRecipient,
  saveRecipient,
  deleteRecipient,
  resetScheduleSentStatus,
  clearWebhookLog,
} from '../store';
import { fetchLeaveStats, getVietnamTimeParts } from '../sheets';
import { RuntimeConfigOverride } from '../types';
import {
  getPatrolMembers,
  addPatrolMember,
  updatePatrolMember,
  deletePatrolMember,
  getPatrolDailyStatus,
  getAllPatrolDailyStatusForDate,
  getPatrolSummaryStatus,
  getPatrolSiteConfigs,
  getPatrolSiteConfig,
  savePatrolSiteConfig,
  runPatrolReminders,
  handlePatrolCommand,
  resetPatrolDailyStatus,
  getSquad1LeaderUserId,
  getPatrolGroupId,
} from '../patrol';

let schedulerRefreshCallback: (() => void) | null = null;

export function registerSchedulerRefreshCallback(cb: () => void): void {
  schedulerRefreshCallback = cb;
}

export const webRouter = Router();

/**
 * GET /api/schedules - Danh sách tất cả schedule và trạng thái hiện tại
 */
webRouter.get('/api/schedules', async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    const db = getDatabase();

    const schedulesStatus = config.schedules.map((s) => {
      const effective = getEffectiveScheduleConfig(s.key);

      // Lấy thông tin gửi gần nhất cho từng recipient
      const recipientsInfo = effective.effectiveRecipients.map((rKey) => {
        const recipient = getRecipient(rKey, db);
        const chatId = recipient?.chat_id || getRecipientChatId(rKey, config);
        const displayName = recipient?.display_name || rKey;
        const lastMsg = getLastMessageInfo(s.key, chatId, db);

        return {
          recipientKey: rKey,
          displayName,
          chatId,
          lastSentDate: lastMsg?.sentDate || null,
          lastUpdatedAt: lastMsg?.updatedAt || null,
        };
      });

      return {
        key: s.key,
        label: s.label,
        squad: s.squad,
        type: s.type,
        effectiveTabName: effective.effectiveTabName,
        effectiveSendTime: effective.effectiveSendTime,
        effectiveEnabled: effective.effectiveEnabled,
        effectiveSendNextDay: effective.effectiveSendNextDay,
        recipients: recipientsInfo,
      };
    });

    res.json({ success: true, schedules: schedulesStatus });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/schedules/:key/preview - Xem trước tin nhắn sẽ gửi (F10)
 */
webRouter.post('/api/schedules/:key/preview', async (req: Request, res: Response) => {
  try {
    const key = String(req.params.key);
    const { targetDate } = req.body || {};

    const preview = await buildScheduleMessage(key, targetDate);
    res.json({
      success: true,
      text: preview.text,
      lookupDate: preview.lookupDate,
      effectiveTabName: preview.effectiveTabName,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/schedules/:key/send - Gửi lịch theo yêu cầu (F2, F5)
 */
webRouter.post('/api/schedules/:key/send', async (req: Request, res: Response) => {
  try {
    const key = String(req.params.key);
    const { recipientKey, targetDate } = req.body || {};

    // Gửi thủ công từ Web UI -> isAutomated: false (không chặn bởi idempotency)
    const result = await sendSchedule(key, {
      recipientKey,
      targetDate,
      isAutomated: false,
    });

    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/config - Lấy thông tin cấu hình và các ghi đè runtime
 */
webRouter.get('/api/config', (req: Request, res: Response) => {
  try {
    const config = getConfig();
    const squads = Object.entries(config.squads).map(([key, sq]) => {
      const effective = getEffectiveScheduleConfig(
        config.schedules.find((s) => s.squad === key)?.key || ''
      );
      return {
        key,
        displayName: sq.display_name,
        headerStyle: sq.header_style,
        overnight: Boolean(sq.overnight),
        cutoverTime: sq.cutover_time,
        defaultTab: sq.sheet_tab_gate_duty,
        effectiveTab: effective.effectiveTabName || sq.sheet_tab_gate_duty,
        defaultSendNextDay: Boolean(sq.send_next_day),
        effectiveSendNextDay: effective.effectiveSendNextDay,
      };
    });

    const recipients = getAllRecipients();
    const schedules = config.schedules.map((s) => {
      const effective = getEffectiveScheduleConfig(s.key);
      const defaultTab = s.sheet_tab || (s.squad && config.squads[s.squad]?.sheet_tab_gate_duty) || '';
      return {
        key: s.key,
        label: s.label,
        squad: s.squad,
        type: s.type,
        defaultTab,
        effectiveTab: effective.effectiveTabName,
        defaultSendTime: s.auto_send_time,
        effectiveSendTime: effective.effectiveSendTime,
        defaultEnabled: s.enabled,
        effectiveEnabled: effective.effectiveEnabled,
        defaultSendNextDay: Boolean(s.send_next_day),
        effectiveSendNextDay: effective.effectiveSendNextDay,
        defaultRecipients: s.recipients,
        effectiveRecipients: effective.effectiveRecipients,
      };
    });

    res.json({ success: true, squads, schedules, recipients });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/config - Lưu ghi đè cấu hình runtime (F9 & F12)
 */
webRouter.post('/api/config', (req: Request, res: Response) => {
  try {
    const { squads, schedules } = req.body || {};

    if (squads && Array.isArray(squads)) {
      for (const sq of squads) {
        if (sq.key) {
          const override: RuntimeConfigOverride = {};
          if (sq.sheetTab !== undefined) {
            override.sheet_tab_gate_duty = String(sq.sheetTab).trim();
          }
          if (sq.sendNextDay !== undefined) {
            override.send_next_day = Boolean(sq.sendNextDay);
          }
          saveRuntimeConfigOverride(sq.key, override);
        }
      }
    }

    if (schedules && Array.isArray(schedules)) {
      for (const s of schedules) {
        if (s.key) {
          const override: RuntimeConfigOverride = {};
          if (s.autoSendTime !== undefined) {
            override.auto_send_time = s.autoSendTime ? String(s.autoSendTime).trim() : null;
          }
          if (s.enabled !== undefined) {
            override.enabled = Boolean(s.enabled);
          }
          if (s.sheetTab !== undefined) {
            override.sheet_tab_gate_duty = String(s.sheetTab).trim();
          }
          if (s.sendNextDay !== undefined) {
            override.send_next_day = Boolean(s.sendNextDay);
          }
          if (s.recipients !== undefined && Array.isArray(s.recipients)) {
            override.recipients = s.recipients.map((r: any) => String(r).trim()).filter(Boolean);
          }
          saveRuntimeConfigOverride(s.key, override);
        }
      }
    }

    // Kích hoạt cập nhật lại các cron jobs ngay lập tức (F9)
    if (schedulerRefreshCallback) {
      schedulerRefreshCallback();
    }

    res.json({ success: true, message: 'Cấu hình đã được lưu thành công.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/recipients - Lấy danh sách tất cả người nhận và các lịch đang gán (F12)
 */
webRouter.get('/api/recipients', (req: Request, res: Response) => {
  try {
    const config = getConfig();
    const recipients = getAllRecipients();

    // Tính xem từng recipient đang được gán cho các schedule nào
    const data = recipients.map((r) => {
      const assignedSchedules = config.schedules
        .filter((s) => {
          const effective = getEffectiveScheduleConfig(s.key);
          return effective.effectiveRecipients.includes(r.key);
        })
        .map((s) => ({
          key: s.key,
          label: s.label,
        }));

      return {
        ...r,
        assignedSchedules,
      };
    });

    res.json({ success: true, recipients: data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/recipients - Thêm người nhận mới (F12)
 */
webRouter.post('/api/recipients', (req: Request, res: Response) => {
  try {
    const { key, display_name, chat_id } = req.body || {};
    if (!key || !display_name || !chat_id) {
      res.status(400).json({
        success: false,
        error: 'Vui lòng cung cấp đầy đủ: Mã (key), Tên hiển thị (display_name), và Chat ID (chat_id).',
      });
      return;
    }

    const cleanKey = String(key).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    saveRecipient({
      key: cleanKey,
      display_name: String(display_name).trim(),
      chat_id: String(chat_id).trim(),
    });

    res.json({
      success: true,
      message: `Đã lưu người nhận '${cleanKey}' thành công.`,
      recipient: {
        key: cleanKey,
        display_name: String(display_name).trim(),
        chat_id: String(chat_id).trim(),
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/recipients/:key - Cập nhật thông tin người nhận (F12)
 */
webRouter.put('/api/recipients/:key', (req: Request, res: Response) => {
  try {
    const key = String(req.params.key).trim();
    const { display_name, chat_id } = req.body || {};
    if (!display_name || !chat_id) {
      res.status(400).json({
        success: false,
        error: 'Vui lòng cung cấp đầy đủ Tên hiển thị và Chat ID.',
      });
      return;
    }

    saveRecipient({
      key,
      display_name: String(display_name).trim(),
      chat_id: String(chat_id).trim(),
    });

    res.json({
      success: true,
      message: `Đã cập nhật thông tin người nhận '${key}'.`,
      recipient: {
        key,
        display_name: String(display_name).trim(),
        chat_id: String(chat_id).trim(),
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/recipients/:key - Xóa người nhận (F12)
 * Tự động gỡ khỏi các schedule đang gán để tránh lỗi rác.
 */
webRouter.delete('/api/recipients/:key', (req: Request, res: Response) => {
  try {
    const key = String(req.params.key).trim();
    const result = deleteRecipient(key);
    res.json({
      success: true,
      message: `Đã xóa người nhận '${key}' thành công.`,
      affectedSchedules: result.affectedSchedules,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/leave-stats - Thống kê tần suất tranh thủ (F13)
 */
webRouter.get('/api/leave-stats', async (req: Request, res: Response) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) {
      throw new Error('Biến môi trường GOOGLE_SHEET_ID chưa được cấu hình.');
    }

    let tabName = req.query.tabName ? String(req.query.tabName).trim() : '';
    if (!tabName) {
      const config = getConfig();
      const leaveSchedule =
        config.schedules.find((s) => s.key === 'leave_stats') ||
        config.schedules.find((s) => s.key === 'squad_leave');

      if (leaveSchedule) {
        tabName = getEffectiveScheduleConfig(leaveSchedule.key).effectiveTabName;
      }
    }

    if (!tabName) {
      tabName = 'Lịch tranh thủ tiểu đội 2';
    }

    const data = await fetchLeaveStats(spreadsheetId, tabName);
    res.json({
      success: true,
      tabName,
      data,
      scheduleKey: 'leave_stats',
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/history - Lấy danh sách lịch sử gửi (F11)
 */
webRouter.get('/api/history', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const history = getRecentSendHistory(limit);
    res.json({ success: true, history });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * ====================================================================
 * TÍNH NĂNG ĐI TUẦN TIỂU ĐỘI 1 (PATROL API)
 * ====================================================================
 */

/**
 * GET /api/patrol/members - Lấy danh sách thành viên Tiểu đội 1
 */
webRouter.get('/api/patrol/members', (req: Request, res: Response) => {
  try {
    const members = getPatrolMembers();
    res.json({ success: true, members });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/patrol/members - Thêm thành viên Tiểu đội 1
 */
webRouter.post('/api/patrol/members', (req: Request, res: Response) => {
  try {
    const { fullName, aliases } = req.body || {};
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      res.status(400).json({ success: false, error: 'Họ tên thành viên là bắt buộc.' });
      return;
    }

    const member = addPatrolMember(fullName, Array.isArray(aliases) ? aliases : []);
    res.json({ success: true, member });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/patrol/members/:id - Cập nhật thông tin thành viên Tiểu đội 1
 */
webRouter.put('/api/patrol/members/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const { fullName, aliases } = req.body || {};
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      res.status(400).json({ success: false, error: 'Họ tên thành viên là bắt buộc.' });
      return;
    }

    const updated = updatePatrolMember(id, fullName, Array.isArray(aliases) ? aliases : []);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Không tìm thấy thành viên để cập nhật.' });
      return;
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/patrol/members/:id - Xóa thành viên Tiểu đội 1
 */
webRouter.delete('/api/patrol/members/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const deleted = deletePatrolMember(id);
    res.json({ success: true, deleted });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/patrol/sites - Lấy danh sách cấu hình các site đi tuần
 */
webRouter.get('/api/patrol/sites', (req: Request, res: Response) => {
  try {
    const sites = getPatrolSiteConfigs();
    res.json({ success: true, sites });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/patrol/sites/:siteKey - Cập nhật cấu hình site đi tuần (F13 & two sites)
 */
webRouter.put('/api/patrol/sites/:siteKey', (req: Request, res: Response) => {
  try {
    const siteKey = String(req.params.siteKey);
    const {
      displayName,
      leaderUserId,
      chatId,
      mergeWithSheet,
      reminderTimes,
      maxReminders,
      enabled,
    } = req.body || {};

    const updated = savePatrolSiteConfig({
      siteKey,
      displayName,
      leaderUserId,
      chatId,
      mergeWithSheet,
      reminderTimes,
      maxReminders,
      enabled,
    });

    res.json({ success: true, site: updated });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/patrol/status - Lấy trạng thái đi tuần của ngày hôm nay (hoặc targetDate)
 */
webRouter.get('/api/patrol/status', (req: Request, res: Response) => {
  try {
    const targetDate = (req.query.date as string) || getVietnamTimeParts().dateDMY;
    const sites = getPatrolSiteConfigs();
    const dailyStatuses = getAllPatrolDailyStatusForDate(targetDate);
    const summaryStatus = getPatrolSummaryStatus(targetDate);
    const site1Status = getPatrolDailyStatus(targetDate, 'site_1');

    res.json({
      success: true,
      date: targetDate,
      status: site1Status || {
        date: targetDate,
        siteKey: 'site_1',
        submitted: false,
        reminderCount: 0,
        selectedMembers: [],
        shifts: [],
        status: 'pending',
      },
      sites,
      dailyStatuses,
      summaryStatus,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/patrol/test-reminders - Giả lập kiểm tra nhắc nhở tại mốc giờ (06:30, 06:35, 06:40)
 */
webRouter.post('/api/patrol/test-reminders', async (req: Request, res: Response) => {
  try {
    const { time, siteKey } = req.body || {};
    const result = await runPatrolReminders(new Date(), {
      overrideTimeHM: time || '06:30',
      targetSiteKey: siteKey || undefined,
    });
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/patrol/simulate-command - Giả lập nhận lệnh tuantra từ người báo cáo
 */
webRouter.post('/api/patrol/simulate-command', async (req: Request, res: Response) => {
  try {
    const { text, senderId, chatId, messageId, siteKey } = req.body || {};

    let effectiveSender = senderId;
    let effectiveChat = chatId;

    if (!effectiveSender) {
      if (siteKey === 'site_2') {
        const s2Config = getPatrolSiteConfig('site_2');
        effectiveSender = s2Config?.leaderUserId || process.env.SITE_2_LEADER_USER_ID || 'site2_leader_test';
        effectiveChat = s2Config?.chatId || process.env.SITE_2_PATROL_GROUP_ID || effectiveSender;
      } else {
        const s1Config = getPatrolSiteConfig('site_1');
        effectiveSender = s1Config?.leaderUserId || getSquad1LeaderUserId() || 'squad1_leader_test';
        effectiveChat = s1Config?.chatId || getPatrolGroupId() || effectiveSender;
      }
    }

    const result = await handlePatrolCommand({
      text: text || 'tuantra',
      senderId: effectiveSender,
      chatId: effectiveChat || effectiveSender,
      messageId: messageId || `sim_${Date.now()}`,
    });

    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/patrol/reset - Đặt lại trạng thái nộp lịch tuần tra để test lại
 */
webRouter.post('/api/patrol/reset', (req: Request, res: Response) => {
  try {
    const targetDate = (req.body?.date as string) || getVietnamTimeParts().dateDMY;
    const siteKey = req.body?.siteKey ? String(req.body.siteKey) : undefined;

    const result = resetPatrolDailyStatus(targetDate, siteKey);
    res.json({
      success: true,
      message: `Đã đặt lại trạng thái tuần tra ngày ${targetDate} thành công.`,
      result,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/system/reset-all - Đặt lại toàn bộ trạng thái nộp lịch & lịch sử hôm nay
 */
webRouter.post('/api/system/reset-all', (req: Request, res: Response) => {
  try {
    const targetDate = (req.body?.date as string) || getVietnamTimeParts().dateDMY;
    const isAll = Boolean(req.body?.isAll);

    const patrolRes = resetPatrolDailyStatus(isAll ? undefined : targetDate, undefined);
    const schedRes = resetScheduleSentStatus(isAll ? undefined : targetDate, undefined);
    clearWebhookLog();

    res.json({
      success: true,
      message: `Đã đặt lại toàn bộ trạng thái kiểm thử thành công.`,
      patrol: patrolRes,
      schedule: schedRes,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

