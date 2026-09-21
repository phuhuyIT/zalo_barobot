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
export {
  parseTaskproofCommand,
  parseDeadlineToUtcMs,
  looksLikeTaskproofCommand,
  TASK_USAGE,
  TASK_NOT_FACEBOOK,
} from './parser';
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
  isPrivateChat,
  PREVIEW_CARD_HINT,
  UNFURL_FAIL_REPLY,
  UNFURL_PENDING_REPLY,
  resetPreviewHintThrottle,
  GROUP_COMMAND_HINT,
  LIENKET_IN_GROUP_HINT,
  NO_LINKED_GROUPS_HINT,
  PRIVATE_NOT_ADMIN_HINT,
} from './handler';
export type { WebhookInbound, ParseCommandResult, ParsedTaskFields, TaskproofCommandName } from './types';
