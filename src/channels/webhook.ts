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
import { handleDoiCommand } from '../externalDuty';
import {
  extractWebhookInbound,
  handleTaskproofCommand,
  isUnsupportedEvent,
  redactSecrets,
} from '../taskproof/commands';
import { timingSafeCompare } from '../taskproof/http/internalAuth';

export const webhookRouter = Router();

const WEBHOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

function appendWebhookLog(line: string) {
  try {
    const logPath = path.resolve(process.cwd(), 'data/webhook.log');
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    try {
      const size = fs.statSync(logPath).size;
      if (size >= WEBHOOK_LOG_MAX_BYTES) {
        fs.renameSync(logPath, `${logPath}.1`);
      }
    } catch {
      // file chưa có
    }
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch (err: unknown) {
    console.error('[Webhook] Lỗi ghi log webhook:', err);
  }
}

webhookRouter.post('/webhook/zalo', async (req: Request, res: Response) => {
  // 1. Xác thực webhook secret token qua header hoặc URL query (Mục 6.2 & Quy tắc #7)
  const webhookSecret = (process.env.ZALO_WEBHOOK_SECRET || '').trim();
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && !webhookSecret) {
    console.warn('[Webhook] Production bắt buộc ZALO_WEBHOOK_SECRET.');
    appendWebhookLog(`REJECTED: ${req.ip} | Reason: missing ZALO_WEBHOOK_SECRET in production`);
    res.status(403).json({ success: false, error: 'Unauthorized: webhook secret is not configured' });
    return;
  }
  if (webhookSecret) {
    const rawSecret =
      req.headers['x-bot-api-secret-token'] ||
      req.headers['x-bot-secret-token'] ||
      req.headers['x-zalo-bot-secret-token'] ||
      req.headers['x-telegram-bot-api-secret-token'] ||
      req.headers['x-secret-token'] ||
      req.headers['secret-token'] ||
      req.headers['secret_token'] ||
      req.headers['x-bot-token'] ||
      (typeof req.headers['authorization'] === 'string' && req.headers['authorization'].startsWith('Bearer ')
        ? req.headers['authorization'].slice(7)
        : undefined) ||
      (typeof req.query?.secret_token === 'string' ? req.query.secret_token : undefined) ||
      (typeof req.query?.secret === 'string' ? req.query.secret : undefined) ||
      (typeof req.query?.token === 'string' ? req.query.token : undefined);

    const receivedSecret = typeof rawSecret === 'string' ? rawSecret : Array.isArray(rawSecret) ? rawSecret[0] : '';

    if (receivedSecret) {
      if (!timingSafeCompare(receivedSecret, webhookSecret)) {
        console.warn('[Webhook] Từ chối request do secret token không khớp (mismatch)');
        appendWebhookLog(`REJECTED: ${req.ip} | Reason: secret token mismatch`);
        res.status(403).json({ success: false, error: 'Unauthorized secret token' });
        return;
      }
    } else {
      const enforceSecret = process.env.ZALO_WEBHOOK_ENFORCE_SECRET === 'true' || isProduction;
      if (enforceSecret) {
        console.warn('[Webhook] Từ chối request do thiếu secret token');
        appendWebhookLog(`REJECTED: ${req.ip} | Reason: missing secret token`);
        res.status(403).json({ success: false, error: 'Unauthorized: missing secret token' });
        return;
      }
      console.warn(
        '[Webhook Warning] Không tìm thấy secret token trong header hoặc URL query. Đang tiếp tục xử lý (Zalo Bot không luôn gửi kèm header secret token).'
      );
    }
  }

  // Ghi log metadata an toàn (không ghi thông tin nhạy cảm/PII)
  appendWebhookLog(`REQ: ${req.ip} | User-Agent: ${req.headers['user-agent']} | Event: message received`);
  console.log('[Webhook] Incoming request from:', req.ip);

  // Trả về 200 OK ngay lập tức cho Zalo Bot Platform
  res.status(200).json({ ok: true });

  // 2. Phân tích nội dung tin nhắn đến (xử lý bất đồng bộ trong background)
  try {
    const rawBody = (req as { rawBody?: string }).rawBody;
    const body =
      typeof req.body === 'string' && req.body.trim()
        ? req.body
        : req.body && typeof req.body === 'object' && Object.keys(req.body as object).length > 0
          ? req.body
          : rawBody || req.body;
    const inbound = extractWebhookInbound(body);
    const text = (inbound?.text || inbound?.commandText || '').trim();
    const chatId = (inbound?.chatId || '').trim();

    if (!chatId) {
      const preview = JSON.stringify(redactSecrets(body ?? rawBody ?? req.body) ?? {}).slice(0, 2000);
      appendWebhookLog(
        `NO_CHAT content-type=${req.headers['content-type'] || ''} keys=${Object.keys((typeof req.body === 'object' && req.body) || {}).join(',')} payload=${preview}`
      );
      console.warn('[Webhook] Bỏ qua vì không đọc được chat.id. payload=', preview);
      return;
    }

    console.log(`[Webhook] Nhận tin nhắn từ chat_id: ${chatId}, text: "${text || inbound?.caption || ''}"`);

    const senderId = (inbound?.senderId || chatId).trim();
    const messageId = (inbound?.messageId || '').trim();

    appendWebhookLog(
      `PARSED: text="${text.slice(0, 300)}" | chatId="${chatId}" | senderId="${senderId}" | msgId="${messageId}" | event="${inbound?.eventName || ''}" | chatType="${inbound?.chatType || '?'}"`
    );

    if (inbound && isUnsupportedEvent(inbound.eventName) && !inbound.commandText) {
      const preview = JSON.stringify(redactSecrets(body ?? rawBody ?? req.body) ?? {}).slice(0, 2000);
      appendWebhookLog(`UNSUPPORTED empty commandText payload=${preview}`);
    }

    // Lệnh task-proof: parser nằm ở src/taskproof/commands — webhook chỉ route.
    // /gui, /id, tuantra không đi vào nhánh này.
    if (inbound) {
      try {
        const handled = await handleTaskproofCommand(inbound);
        if (handled) {
          appendWebhookLog(`TASKPROOF COMMAND handled in chatId="${chatId}"`);
          return;
        }
      } catch (tpErr: unknown) {
        const msg = tpErr instanceof Error ? tpErr.message : String(tpErr);
        appendWebhookLog(`TASKPROOF ERROR: ${msg}`);
        console.error('[Webhook] Lỗi xử lý lệnh task-proof:', tpErr);
      }
    }

    if (!text) {
      return;
    }

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

    // 2a0. Xếp hoặc đổi ca: a2 ca1 <tên>, rồi đúng / không
    try {
      const doiRes = await handleDoiCommand({ text, chatId, senderId, messageId });
      if (doiRes.handled) {
        appendWebhookLog(
          `DUTY COMMAND: senderId="${senderId}" handled=${doiRes.handled} success=${doiRes.success} reason="${doiRes.ignoredReason || ''}"`
        );
        return;
      }
    } catch (doiErr: unknown) {
      const msg = doiErr instanceof Error ? doiErr.message : String(doiErr);
      appendWebhookLog(`DUTY ERROR: ${msg}`);
      console.error('[Webhook] Lỗi xử lý lệnh xếp ca:', doiErr);
    }

    // 2a. Kiểm tra lệnh đi tuần: tuantra <tên 1> [tên 2] (kể cả có @mention bot hoặc /tuantra)
    if (/(?:^|\s|\/)tuantra(?:\s*[+:]|\s+|$)/i.test(text)) {
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
