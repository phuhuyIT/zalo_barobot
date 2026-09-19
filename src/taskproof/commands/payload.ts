/**
 * payload.ts
 *
 * Đọc inbound webhook Official Bot Platform.
 * Hai envelope:
 *   - { message } — payload hiện tại của /gui và tests
 *   - { ok, result: { event_name, message } } — docs bot.zapps.me
 *
 * Thẻ xem trước / caption: không chỉ đọc message.text.
 * message.unsupported.received không phải lệnh /task hợp lệ.
 */

import { WebhookInbound } from './types';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * Zalo Java client đôi khi gửi result/message là JSON string, hoặc result là mảng 1 phần tử.
 */
export function coerceRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return coerceRecord(JSON.parse(trimmed) as unknown);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(value) && value.length > 0) {
    return coerceRecord(value[0]);
  }
  return asRecord(value);
}

function pickMessage(body: Record<string, unknown>): {
  eventName: string;
  message: Record<string, unknown>;
} {
  const result = coerceRecord(body.result);
  if (result) {
    const nested = coerceRecord(result.message);
    return {
      eventName: asString(result.event_name || body.event_name),
      message: nested || result,
    };
  }
  const topMessage = coerceRecord(body.message);
  if (topMessage) {
    return {
      eventName: asString(body.event_name),
      message: topMessage,
    };
  }
  return {
    eventName: asString(body.event_name),
    message: body,
  };
}

const COMMAND_IN_TEXT = /\/(?:tasks|task|nhac|lienket|dong|huy)\b/i;

function findCommandString(value: unknown, depth = 0): string {
  if (depth > 6) return '';
  if (typeof value === 'string') {
    const unescaped = value.includes('\\n') ? value.replace(/\\n/g, '\n').replace(/\\"/g, '"') : value;
    return COMMAND_IN_TEXT.test(unescaped) ? unescaped.trim() : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCommandString(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  const rec = asRecord(value);
  if (!rec) return '';
  for (const key of ['text', 'caption', 'content', 'description', 'title', 'body']) {
    const found = findCommandString(rec[key], depth + 1);
    if (found) return found;
  }
  for (const nested of Object.values(rec)) {
    const found = findCommandString(nested, depth + 1);
    if (found) return found;
  }
  return '';
}

/**
 * Lấy chat.id / from.id theo convention webhook hiện tại (/gui).
 */
export function parseWebhookBody(rawBody: unknown): Record<string, unknown> | null {
  if (typeof rawBody === 'string') {
    return coerceRecord(rawBody) || (rawBody.trim() ? { text: rawBody } : null);
  }
  return coerceRecord(rawBody);
}

export function extractWebhookInbound(rawBody: unknown): WebhookInbound | null {
  const body = parseWebhookBody(rawBody);
  if (!body) return null;

  const { eventName, message } = pickMessage(body);
  const chat = coerceRecord(message.chat) || coerceRecord(body.chat);
  const from =
    coerceRecord(message.from) ||
    coerceRecord(message.sender) ||
    coerceRecord(body.sender) ||
    coerceRecord(body.from);

  const text = asString(message.text).trim();
  const caption = asString(message.caption).trim();
  const recovered = findCommandString(message) || findCommandString(body);
  const commandText = (text || caption || recovered).trim();

  const chatId = asString(
    (chat && (chat.id || chat.group_id || chat.chat_id)) ||
      message.chat_id ||
      message.group_id ||
      body.chat_id ||
      (from && from.id) ||
      ''
  ).trim();

  const senderId = asString(
    (from && from.id) || message.user_id || (chat && chat.id) || chatId
  ).trim();

  const messageId = asString(
    message.message_id || message.msg_id || message.id || body.message_id
  ).trim();

  return {
    eventName: eventName.trim(),
    text,
    caption,
    commandText,
    chatId,
    chatType: asString((chat && (chat.chat_type || chat.type)) || '').trim().toUpperCase(),
    senderId,
    messageId,
    url: asString(message.url).trim(),
    photo: asString(message.photo || message.photo_url).trim(),
    message,
    rawBody,
  };
}

const SECRET_KEY = /token|password|secret|authorization|api[_-]?key/i;

/**
 * Thu thập URL http(s) trên object tin nhắn (thẻ xem trước, attachments, entities).
 * Bỏ key giống secret — log payload khi thiếu Link không được lộ token.
 */
export function collectHttpUrls(value: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > 5 || acc.length > 20) return acc;
  if (typeof value === 'string') {
    const matches = value.match(/https?:\/\/[^\s<>"'\\]+/gi);
    if (matches) {
      for (const url of matches) {
        const cleaned = url.replace(/[),.;]+$/, '');
        if (!acc.includes(cleaned)) acc.push(cleaned);
      }
    }
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHttpUrls(item, acc, depth + 1);
    return acc;
  }
  const rec = asRecord(value);
  if (!rec) return acc;
  for (const [key, nested] of Object.entries(rec)) {
    if (SECRET_KEY.test(key)) continue;
    collectHttpUrls(nested, acc, depth + 1);
  }
  return acc;
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return SECRET_KEY.test(value) ? '[redacted]' : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  const rec = asRecord(value);
  if (!rec) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(rec)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactSecrets(nested);
  }
  return out;
}

export function isUnsupportedEvent(eventName: string): boolean {
  return eventName.trim().toLowerCase() === 'message.unsupported.received';
}

export function isImageOrStickerEvent(eventName: string): boolean {
  const name = eventName.trim().toLowerCase();
  return (
    name === 'message.image.received' ||
    name === 'message.sticker.received' ||
    name === 'message.voice.received'
  );
}
