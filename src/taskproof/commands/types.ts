/**
 * types.ts
 *
 * Kiểu lệnh task-proof trên official bot.
 * official_chat_id = webhook chat.id (cùng convention /gui).
 * zca_group_id không lấy từ webhook — chỉ có sau /lienket.
 */

export type TaskproofCommandName =
  | 'task'
  | 'tasks'
  | 'nhac'
  | 'lienket'
  | 'dong'
  | 'huy'
  | 'quet';

export interface WebhookInbound {
  eventName: string;
  text: string;
  caption: string;
  /** text, nếu trống thì caption — dùng để đọc lệnh (thẻ xem trước / ảnh kèm caption). */
  commandText: string;
  chatId: string;
  chatType: string;
  senderId: string;
  messageId: string;
  url: string;
  photo: string;
  message: Record<string, unknown>;
  rawBody: unknown;
}

export interface ParsedTaskFields {
  link: string;
  caption: string;
  requiredCount: number | null;
  /** null = default_deadline_offset_ms lúc insert. */
  deadlineUtcMs: number | null;
  reportGroupId: string;
  /** true: official bot unfurl Facebook, không dùng caption thẻ Zalo. */
  needsUnfurl?: boolean;
}

export type ParseCommandResult =
  | { ok: true; found: true; command: 'task'; fields: ParsedTaskFields }
  | { ok: true; found: true; command: 'tasks' }
  | { ok: true; found: true; command: 'nhac' | 'dong' | 'huy'; shortCode: string }
  | { ok: true; found: true; command: 'quet'; shortCode: string; count: number }
  | { ok: true; found: true; command: 'lienket'; method: 'A'; zcaGroupId: null }
  | { ok: true; found: true; command: 'lienket'; method: 'B'; zcaGroupId: string }
  | { ok: false; found: false }
  | { ok: false; found: true; command?: TaskproofCommandName; error: string };
