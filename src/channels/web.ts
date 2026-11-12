/**
 * web.ts
 *
 * Tầng Web Channel cung cấp API cho Dashboard, Xem trước (F10),
 * Gửi lại (F2, F5), Cấu hình runtime (F9), và Lịch sử gửi (F11).
 */

import { Router, Request, Response } from 'express';
import { rejectCrossOriginWrite } from './auth';
import { getConfig, getRecipientChatId } from '../config';
import {
  buildScheduleMessage,
  getEffectiveScheduleConfig,
  sendSchedule,
} from '../core';
import {
  getRecentSendHistory,
  saveRuntimeConfigOverride,
  getLastMessageInfo,
  getDatabase,
  getAllRecipients,
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
  listPatrolReporterStatuses,
  getSite1SecondLeaderUserId,
  runPatrolReminders,
  handlePatrolCommand,
  resetPatrolDailyStatus,
  getSquad1LeaderUserId,
  getPatrolGroupId,
  getPlatoonLeaderChatId,
  buildPatrolOverviewMessage,
} from '../patrol';
import {
  buildPartnerNotice,
  ExternalDutyConfigError,
  getExternalDutyConfig,
  saveExternalDutyConfig,
  sendPartnerAlertNow,
} from '../externalDuty';

let schedulerRefreshCallback: (() => void) | null = null;

export function registerSchedulerRefreshCallback(cb: () => void): void {
  schedulerRefreshCallback = cb;
}

export const webRouter = Router();
webRouter.use(rejectCrossOriginWrite);

/**
 * Xử lý và format lỗi tập trung cho các router của Web API.
 */
function handleRouteError(res: Response, error: unknown, statusCode = 500): void {
  const message = error instanceof Error ? error.message : String(error);
  res.status(statusCode).json({ success: false, error: message });
}

/**
 * GET /api/schedules - Danh sách tất cả schedule và trạng thái hiện tại
 */
webRouter.get('/api/schedules', async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    const db = getDatabase();

    // Tối ưu hóa N+1: Lấy trước toàn bộ danh sách recipients vào bộ nhớ
    const allRecipientsList = getAllRecipients(db);
    const recipientMap = new Map(allRecipientsList.map((r) => [r.key, r]));

    const schedulesStatus = config.schedules.map((s) => {
      const effective = getEffectiveScheduleConfig(s.key);

      // Lấy thông tin gửi gần nhất cho từng recipient
      const recipientsInfo = effective.effectiveRecipients.map((rKey) => {
        const recipient = recipientMap.get(rKey);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
            const timeVal = s.autoSendTime ? String(s.autoSendTime).trim() : null;
            if (timeVal && !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeVal)) {
              res.status(400).json({ success: false, error: `Giờ tự động gửi không hợp lệ (phải theo chuẩn HH:MM 00:00 - 23:59): ${timeVal}` });
              return;
            }
            override.auto_send_time = timeVal;
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
            override.recipients = s.recipients.map((r: unknown) => String(r).trim()).filter(Boolean);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

/**
 * GET /api/patrol/sites - Lấy danh sách cấu hình các site đi tuần
 */
webRouter.get('/api/patrol/sites', (req: Request, res: Response) => {
  try {
    const sites = getPatrolSiteConfigs();
    const platoonLeaderChatId = getPlatoonLeaderChatId();
    res.json({ success: true, sites, platoonLeaderChatId });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

/**
 * GET /api/patrol/platoon-leader - Lấy chat ID Trung đội trưởng nhận báo cáo tổng hợp
 */
webRouter.get('/api/patrol/platoon-leader', (req: Request, res: Response) => {
  try {
    const chatId = getPlatoonLeaderChatId();
    res.json({ success: true, chatId });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

/**
 * PUT /api/patrol/platoon-leader - Cập nhật chat ID Trung đội trưởng nhận báo cáo tổng hợp
 */
webRouter.put('/api/patrol/platoon-leader', (req: Request, res: Response) => {
  try {
    const { chatId } = req.body || {};
    if (chatId === undefined || chatId === null) {
      return res.status(400).json({ success: false, error: 'chatId is required' });
    }
    const cleanChatId = String(chatId).trim();
    saveRecipient({
      key: 'platoon_leader',
      display_name: 'Trung đội trưởng',
      chat_id: cleanChatId,
    });
    res.json({ success: true, chatId: cleanChatId });
  } catch (error: unknown) {
    handleRouteError(res, error);
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
      leaderUserId2,
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
      leaderUserId2,
      chatId,
      mergeWithSheet,
      reminderTimes,
      maxReminders,
      enabled,
    });

    res.json({ success: true, site: updated });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

/**
 * GET /api/patrol/overview?date=DD/MM/YYYY - Lịch đi tuần cả ngày cho thẻ Tổng quan.
 */
webRouter.get('/api/patrol/overview', async (req: Request, res: Response) => {
  try {
    const date = String(req.query.date || getVietnamTimeParts().dateDMY);
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
      res.status(400).json({ success: false, error: 'Ngày phải là DD/MM/YYYY.' });
      return;
    }
    const text = await buildPatrolOverviewMessage(date);
    res.json({ success: true, date, text });
  } catch (error: unknown) {
    handleRouteError(res, error);
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
    const reporterStatuses = listPatrolReporterStatuses(targetDate);
    const summaryStatus = getPatrolSummaryStatus(targetDate);
    const site1Status = getPatrolDailyStatus(targetDate, 'site_1');
    const platoonLeaderChatId = getPlatoonLeaderChatId();

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
      reporterStatuses,
      summaryStatus,
      platoonLeaderChatId,
    });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

/**
 * GET /api/external-duty - Cấu hình tiểu đội đối tác và nội dung nhắc sắp gửi.
 */
webRouter.get('/api/external-duty', async (req: Request, res: Response) => {
  try {
    const config = getExternalDutyConfig();
    let previewText = '';
    let previewHtml = '';
    let previewError = '';
    try {
      const notice = await buildPartnerNotice(new Date());
      previewText = notice.text;
      previewHtml = notice.previewHtml;
    } catch (err: unknown) {
      console.error('[ExternalDuty] Không tạo được bản xem trước:', err);
      previewError = 'Không tạo được nội dung nhắc.';
    }
    res.json({
      success: true,
      config: {
        ...config,
        extraEditorIdsText: config.extraEditorIds.join('\n'),
        reminderTimesInput: config.reminderTimes.join(', '),
      },
      previewText,
      previewHtml,
      previewError,
    });
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

/**
 * PUT /api/external-duty - Lưu user id, nhóm đối tác, alias và giờ nhắc.
 */
webRouter.put('/api/external-duty', (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const extraRaw = body.extraEditorIds ?? body.extraEditorIdsText ?? '';
    const extraEditorIds = Array.isArray(extraRaw)
      ? extraRaw.map((id: unknown) => String(id).trim()).filter(Boolean)
      : String(extraRaw)
          .split(/[\n,]/)
          .map((id) => id.trim())
          .filter(Boolean);
    const reminderRaw = body.reminderTimes ?? body.reminderTimesInput ?? '';
    const reminderTimes = Array.isArray(reminderRaw)
      ? reminderRaw.map((time: unknown) => String(time).trim()).filter(Boolean)
      : String(reminderRaw)
          .split(',')
          .map((time) => time.trim())
          .filter(Boolean);
    const maxReminders = Number(body.maxReminders);
    const saved = saveExternalDutyConfig({
      partnerLeaderUserId: body.partnerLeaderUserId !== undefined ? String(body.partnerLeaderUserId) : undefined,
      extraEditorIds,
      partnerChatId: body.partnerChatId !== undefined ? String(body.partnerChatId) : undefined,
      aliasMain: body.aliasMain !== undefined ? String(body.aliasMain) : undefined,
      aliasCuli: body.aliasCuli !== undefined ? String(body.aliasCuli) : undefined,
      reminderTimes: reminderTimes.length > 0 ? reminderTimes : undefined,
      maxReminders: body.maxReminders !== undefined && body.maxReminders !== '' ? maxReminders : undefined,
    });
    if (saved.partnerChatId) {
      saveRecipient({
        key: 'squad_partner',
        display_name: 'Tiểu đội đối tác',
        chat_id: saved.partnerChatId,
      });
    }
    res.json({ success: true, config: saved });
  } catch (error: unknown) {
    if (error instanceof ExternalDutyConfigError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    handleRouteError(res, error);
  }
});

/**
 * POST /api/external-duty/test-alert - Gửi thử nội dung nhắc tới tiểu đội trưởng đối tác.
 */
webRouter.post('/api/external-duty/test-alert', async (req: Request, res: Response) => {
  try {
    const result = await sendPartnerAlertNow();
    if (!result.sent) {
      const message =
        result.reason === 'no_leader'
          ? 'Chưa có User ID tiểu đội trưởng đối tác.'
          : result.reason === 'cooldown'
            ? 'Vừa gửi nhắc thử. Đợi một lát rồi thử lại.'
            : 'Không gửi được nhắc. Thử lại sau.';
      return res.status(400).json({ success: false, error: message, result });
    }
    res.json({ success: true, result });
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

/**
 * POST /api/patrol/simulate-command - Giả lập nhận lệnh tuantra từ người báo cáo
 */
webRouter.post('/api/patrol/simulate-command', async (req: Request, res: Response) => {
  try {
    const { text, senderId, chatId, messageId, siteKey, reporterSlot } = req.body || {};

    let effectiveSender = senderId;
    let effectiveChat = chatId;
    const slot = Number(reporterSlot) === 2 ? 2 : 1;

    if (!effectiveSender) {
      if (siteKey === 'site_2') {
        const s2Config = getPatrolSiteConfig('site_2');
        effectiveSender = s2Config?.leaderUserId || process.env.SITE_2_LEADER_USER_ID || 'site2_leader_test';
        effectiveChat = s2Config?.chatId || process.env.SITE_2_PATROL_GROUP_ID || effectiveSender;
      } else {
        const s1Config = getPatrolSiteConfig('site_1');
        if (slot === 2) {
          effectiveSender =
            s1Config?.leaderUserId2 ||
            getSite1SecondLeaderUserId() ||
            'squad1_leader_2_test';
        } else {
          effectiveSender = s1Config?.leaderUserId || getSquad1LeaderUserId() || 'squad1_leader_test';
        }
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
  } catch (error: unknown) {
    handleRouteError(res, error);
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
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

/**
 * POST /api/system/reset-all - Đặt lại toàn bộ trạng thái nộp lịch & lịch sử hôm nay
 */
webRouter.post('/api/system/reset-all', (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({ success: false, error: 'reset-all is disabled in production' });
    return;
  }
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
  } catch (error: unknown) {
    handleRouteError(res, error);
  }
});

