/**
 * webhook.ts
 *
 * Tầng Webhook Channel nhận tin nhắn từ Zalo Bot Platform (F3).
 * Xử lý lệnh chat /gui trong nhóm Zalo:
 * - Xác định chat_id của nhóm gửi lệnh.
 * - Tìm tất cả schedule_key có nhóm đó trong danh sách người nhận.
 * - Gửi lại đúng các lịch liên quan đến nhóm đó (Mục 5.2).
 */

import { Router, Request, Response } from 'express';
import { getConfig, getRecipientChatId } from '../config';
import { sendSchedule, getEffectiveScheduleConfig } from '../core';

export const webhookRouter = Router();

webhookRouter.post('/webhook/zalo', async (req: Request, res: Response) => {
  // 1. Xác thực webhook secret token qua header (Mục 6.2 & Quy tắc #7)
  const webhookSecret = process.env.ZALO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const receivedSecret =
      req.headers['x-bot-secret-token'] ||
      req.headers['x-zalo-bot-secret-token'] ||
      req.headers['secret_token'];

    if (receivedSecret !== webhookSecret) {
      console.warn('[Webhook] Nhận request với secret token không hợp lệ.');
      res.status(403).json({ error: 'Unauthorized secret token' });
      return;
    }
  }

  // Trả về 200 OK ngay lập tức cho Zalo Bot Platform
  res.status(200).json({ ok: true });

  // 2. Phân tích nội dung tin nhắn đến (xử lý bất đồng bộ trong background)
  try {
    const body = req.body || {};
    const message = body.message || body;
    const text = (message.text || '').trim();
    const chatId = String(
      message.chat?.id || message.chat_id || message.from?.id || ''
    ).trim();

    if (!chatId || !text) {
      return;
    }

    console.log(`[Webhook] Nhận tin nhắn từ chat_id: ${chatId}, text: "${text}"`);

    // Kiểm tra lệnh /gui hoặc /send
    if (text.startsWith('/gui') || text.startsWith('/send')) {
      const config = getConfig();

      // Tìm các schedule có chat_id này trong danh sách recipients
      const matchedSchedules: { scheduleKey: string; recipientKey: string }[] = [];

      for (const s of config.schedules) {
        const { effectiveRecipients } = getEffectiveScheduleConfig(s.key);
        for (const rKey of effectiveRecipients) {
          const mappedChatId = getRecipientChatId(rKey, config);
          if (mappedChatId === chatId) {
            matchedSchedules.push({ scheduleKey: s.key, recipientKey: rKey });
          }
        }
      }

      if (matchedSchedules.length === 0) {
        console.log(`[Webhook] Không tìm thấy lịch nào được gán cho chat_id ${chatId}`);
        return;
      }

      console.log(
        `[Webhook] Kích hoạt gửi lại ${matchedSchedules.length} lịch cho chat_id ${chatId}:`,
        matchedSchedules.map((m) => m.scheduleKey)
      );

      // Gửi tuần tự từng schedule liên quan (Quy tắc #13)
      for (const item of matchedSchedules) {
        try {
          await sendSchedule(item.scheduleKey, {
            recipientKey: item.recipientKey,
            isAutomated: false, // Do người dùng gọi -> gửi ngay, không chặn bởi idempotency
          });
        } catch (err: any) {
          console.error(
            `[Webhook] Lỗi gửi schedule ${item.scheduleKey} cho chat ${chatId}:`,
            err.message
          );
        }
      }
    }
  } catch (error: any) {
    console.error('[Webhook] Lỗi xử lý cập nhật tin nhắn Zalo:', error.message);
  }
});
