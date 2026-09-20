/**
 * commands/index.ts
 *
 * Module lệnh task-proof (official bot). webhook.ts chỉ extract + route.
 */

export {
  extractWebhookInbound,
  collectHttpUrls,
  redactSecrets,
  parseWebhookBody,
  isUnsupportedEvent,
} from './payload';
export { parseTaskproofCommand, parseDeadlineToUtcMs, looksLikeTaskproofCommand } from './parser';
export {
  parseQuetCount,
  QUET_DEFAULT_COUNT,
  formatScanResultReply,
} from '../quet';
export {
  generateShortCode,
  getTaskByExactShortCode,
  isExactShortCode,
  isUuid,
  normalizeShortCode,
} from './shortCode';
export {
  handleTaskproofCommand,
  formatParseReply,
  PREVIEW_CARD_HINT,
  resetPreviewHintThrottle,
} from './handler';
export type { WebhookInbound, ParseCommandResult, ParsedTaskFields, TaskproofCommandName } from './types';
