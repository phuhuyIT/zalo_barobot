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
  getDatabase,
} from '../store';
import { RuntimeConfigOverride } from '../types';

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
      const recipientsInfo = s.recipients.map((rKey) => {
        const chatId = getRecipientChatId(rKey, config);
        const lastMsg = db
          .prepare(
            `SELECT message_id, sent_date, updated_at FROM last_message WHERE schedule_key = ? AND chat_id = ?`
          )
          .get(s.key, chatId) as any;

        return {
          recipientKey: rKey,
          chatId,
          lastSentDate: lastMsg?.sent_date || null,
          lastUpdatedAt: lastMsg?.updated_at || null,
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
      };
    });

    const schedules = config.schedules.map((s) => {
      const effective = getEffectiveScheduleConfig(s.key);
      return {
        key: s.key,
        label: s.label,
        squad: s.squad,
        defaultSendTime: s.auto_send_time,
        effectiveSendTime: effective.effectiveSendTime,
        defaultEnabled: s.enabled,
        effectiveEnabled: effective.effectiveEnabled,
        effectiveTab: effective.effectiveTabName,
      };
    });

    res.json({ success: true, squads, schedules });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/config - Lưu ghi đè cấu hình runtime (F9)
 */
webRouter.post('/api/config', (req: Request, res: Response) => {
  try {
    const { squads, schedules } = req.body || {};

    if (squads && Array.isArray(squads)) {
      for (const sq of squads) {
        if (sq.key && sq.sheetTab !== undefined) {
          saveRuntimeConfigOverride(sq.key, {
            sheet_tab_gate_duty: String(sq.sheetTab).trim(),
          });
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
