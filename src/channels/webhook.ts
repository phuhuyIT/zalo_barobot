/**
 * webhook.ts
 *
 * Tầng Webhook Channel nhận tin nhắn từ Zalo Bot Platform (F3).
 * Xử lý lệnh chat /gui trong nhóm Zalo:
 * - Xác định chat_id của nhóm gửi lệnh.
 * - Tìm tất cả schedule_key có nhóm đó trong danh sách người nhận.
 * - Gửi lại đúng các lịch liên quan đến nhóm đó (Mục 5.2).
 */

import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { getConfig, getRecipientChatId } from '../config';
import { sendSchedule, getEffectiveScheduleConfig } from '../core';
import { ZaloClient } from '../core/zaloClient';
import { handlePatrolCommand } from '../patrol';

export const webhookRouter = Router();

function appendWebhookLog(line: string) {
  try {
    const logPath = path.resolve(process.cwd(), 'data/webhook.log');
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch (err: unknown) {
    console.error('[Webhook] Lỗi ghi log webhook:', err);
  }
}

webhookRouter.post('/webhook/zalo', async (req: Request, res: Response) => {
  appendWebhookLog(`REQ: ${req.ip} | User-Agent: ${req.headers['user-agent']} | Body: ${JSON.stringify(req.body)}`);
  console.log('[Webhook] Incoming request from:', req.ip, 'User-Agent:', req.headers['user-agent']);

  // Sanitize headers để không log secret token hoặc authorization (Quy tắc bảo mật)
  const safeHeaders: Record<string, unknown> = { ...req.headers };
  delete safeHeaders['authorization'];
  delete safeHeaders['x-bot-secret-token'];
  delete safeHeaders['x-zalo-bot-secret-token'];
  delete safeHeaders['x-telegram-bot-api-secret-token'];
  delete safeHeaders['x-secret-token'];
  delete safeHeaders['secret-token'];
  delete safeHeaders['secret_token'];
  console.log('[Webhook] Headers:', JSON.stringify(safeHeaders));
  console.log('[Webhook] Body:', JSON.stringify(req.body));

  // 1. Xác thực webhook secret token qua header (Mục 6.2 & Quy tắc #7)
  const webhookSecret = process.env.ZALO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const receivedSecret =
      req.headers['x-bot-secret-token'] ||
      req.headers['x-zalo-bot-secret-token'] ||
      req.headers['x-telegram-bot-api-secret-token'] ||
      req.headers['x-secret-token'] ||
      req.headers['secret-token'] ||
      req.headers['secret_token'];

    // Nếu Zalo gửi request có secret token nhưng không khớp:
    if (receivedSecret && receivedSecret !== webhookSecret) {
      console.warn('[Webhook] Nhận request với secret token không hợp lệ (mismatch)');
      res.status(403).json({ error: 'Unauthorized secret token' });
      return;
    }

    if (!receivedSecret) {
      console.warn('[Webhook Warning] Không tìm thấy secret token trong header.');
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

    const senderId = String(
      message.from?.id || message.sender?.id || message.user_id || body.sender?.id || body.from?.id || chatId
    ).trim();
    const messageId = String(
      message.message_id || message.msg_id || body.message_id || message.id || ''
    ).trim();

    appendWebhookLog(`PARSED: text="${text}" | chatId="${chatId}" | senderId="${senderId}" | msgId="${messageId}"`);

    // Lệnh hỗ trợ kiểm tra định danh: /id hoặc /myid
    if (text === '/id' || text === '/myid') {
      const zalo = new ZaloClient();
      try {
        await zalo.sendMessage(
          chatId,
          `🆔 Thông tin định danh Zalo của bạn:\n• Chat ID (Nhóm/Chat): ${chatId}\n• User ID của bạn: ${senderId}`
        );
      } catch (err: any) {
        console.error('[Webhook] Lỗi gửi phản hồi /id:', err.message);
      }
      return;
    }

    // 2a. Kiểm tra lệnh đi tuần: tuantra <tên 1> [tên 2] (kể cả có @mention bot hoặc /tuantra)
    if (/(?:^|\s|\/)tuantra(?:\s*[\+:]|\s+|$)/i.test(text)) {
      appendWebhookLog(`PROCESSING PATROL COMMAND: "${text}" from senderId="${senderId}" in chatId="${chatId}"`);
      try {
        const patrolRes = await handlePatrolCommand({
          text,
          chatId,
          senderId,
          messageId,
        });
        appendWebhookLog(`PATROL RESULT: ${JSON.stringify(patrolRes)}`);
      } catch (pErr: any) {
        appendWebhookLog(`PATROL ERROR: ${pErr.message}`);
        console.error('[Webhook] Lỗi xử lý lệnh tuantra:', pErr);
      }
      return;
    }

    // 2b. Kiểm tra lệnh /gui hoặc /send
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
