/**
 * commands/index.ts
 *
 * Module lệnh task-proof (official bot). webhook.ts chỉ extract + route.
 */

export { extractWebhookInbound, collectHttpUrls, redactSecrets, parseWebhookBody } from './payload';
export { parseTaskproofCommand, parseDeadlineToUtcMs, looksLikeTaskproofCommand } from './parser';
export {
  generateShortCode,
  getTaskByExactShortCode,
  isExactShortCode,
  isUuid,
  normalizeShortCode,
} from './shortCode';
export { handleTaskproofCommand, formatParseReply } from './handler';
export type { WebhookInbound, ParseCommandResult, ParsedTaskFields, TaskproofCommandName } from './types';
