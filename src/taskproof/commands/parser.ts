/**
 * parser.ts
 *
 * Phân tích /task /tasks /nhac /lienket /dong /huy /quet.
 * Thứ tự field tùy ý; hạn chót theo tường Asia/Ho_Chi_Minh, lưu UTC epoch ms.
 * short_code phải đúng 6 [A-Z0-9] — không nhận UUID.
 */

import {
  firstFacebookPostUrl,
  parseFacebookPostUrl,
} from './facebookUrl';
import {
  parseQuetCount,
  QUET_DEFAULT_COUNT,
  QUET_MAX_COUNT,
  QUET_MIN_COUNT,
} from '../quet';
import { collectHttpUrls, isImageOrStickerEvent } from './payload';
import { isUuid, normalizeShortCode } from './shortCode';
import { ParseCommandResult, ParsedTaskFields, TaskproofCommandName, WebhookInbound } from './types';

export const TASK_USAGE = '/task <link bài Facebook>';
export const TASK_NOT_FACEBOOK =
  'Link không phải bài Facebook. Dùng /task <link facebook.com/...> hoặc flow cũ kèm Caption: ...';

const COMMAND_NAMES: TaskproofCommandName[] = [
  'tasks',
  'task',
  'nhac',
  'lienket',
  'dong',
  'huy',
  'quet',
];

type FieldLabel = 'Link' | 'Caption' | 'SoLuong' | 'HanChot' | 'BaoCao';

const FIELD_PATTERN =
  '(?:Link|Caption|So\\s*Luong|Số\\s*Lượng|SoLuong|Han\\s*Chot|Hạn\\s*Chót|HanChot|Bao\\s*Cao|Báo\\s*Cáo|BaoCao)';

const FIELD_RE = new RegExp(
  `(?:^|[\\s\\n\\r])(?:[-*•+]\\s*)?(?:\\d+[.)]\\s*)?(${FIELD_PATTERN})\\s*[:=]`,
  'gi'
);

function canonicalFieldLabel(raw: string): FieldLabel | null {
  const norm = (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/đ/g, 'd');
  if (norm === 'link') return 'Link';
  if (norm === 'caption') return 'Caption';
  if (norm === 'soluong') return 'SoLuong';
  if (norm === 'hanchot') return 'HanChot';
  if (norm === 'baocao') return 'BaoCao';
  return null;
}

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function stripLeadingMention(text: string): string {
  return (text || '')
    .replace(/^@[\w\s\u00C0-\u1EF9.]+?(?=\s+\/)/u, '')
    .trim();
}

function detectCommand(rawText: string): { command: TaskproofCommandName; rest: string } | null {
  const cleaned = stripLeadingMention(rawText).replace(/^\uFEFF/, '');
  if (!cleaned.trim()) return null;
  // /tasks trước /task. Cho phép lệnh sau vài dòng (Zalo thẻ xem trước).
  for (const command of COMMAND_NAMES) {
    const re = new RegExp(`(?:^|[\\n\\r])[ \\t]*(/${command})(?=\\s|$)`, 'im');
    const match = re.exec(cleaned);
    if (!match) continue;
    const token = match[1];
    const tokenStart = match.index + match[0].length - token.length;
    return { command, rest: cleaned.slice(tokenStart + token.length).trim() };
  }
  return null;
}

function isValidYmd(year: number, month: number, day: number): boolean {
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/**
 * Đọc giờ tường Việt Nam, đổi sang UTC epoch ms. VN không DST (UTC+7).
 */
export function parseDeadlineToUtcMs(raw: string): number | null {
  const s = raw.trim().replace(/\s+/g, ' ');

  const dmyHm = s.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s+(\d{1,2}):(\d{2})$/
  );
  const hmDmy = s.match(
    /^(\d{1,2}):(\d{2})\s+(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/
  );
  const ymdHm = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/
  );

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;

  if (dmyHm) {
    day = Number(dmyHm[1]);
    month = Number(dmyHm[2]);
    year = Number(dmyHm[3]);
    hour = Number(dmyHm[4]);
    minute = Number(dmyHm[5]);
  } else if (hmDmy) {
    hour = Number(hmDmy[1]);
    minute = Number(hmDmy[2]);
    day = Number(hmDmy[3]);
    month = Number(hmDmy[4]);
    year = Number(hmDmy[5]);
  } else if (ymdHm) {
    year = Number(ymdHm[1]);
    month = Number(ymdHm[2]);
    day = Number(ymdHm[3]);
    hour = Number(ymdHm[4]);
    minute = Number(ymdHm[5]);
  } else {
    return null;
  }

  if (!isValidYmd(year, month, day)) return null;
  if (hour > 23 || minute > 59) return null;

  return Date.UTC(year, month - 1, day, hour, minute, 0) - VN_OFFSET_MS;
}

function extractLabeledFields(body: string): Partial<Record<FieldLabel, string>> {
  const fields: Partial<Record<FieldLabel, string>> = {};
  const matches: Array<{ label: FieldLabel; labelStart: number; valueStart: number }> = [];

  FIELD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FIELD_RE.exec(body)) !== null) {
    const found = match;
    const canonical = canonicalFieldLabel(found[1]);
    if (!canonical) continue;
    matches.push({
      label: canonical,
      labelStart: found.index,
      valueStart: found.index + found[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].labelStart : body.length;
    fields[matches[i].label] = body.slice(matches[i].valueStart, end).trim();
  }

  return fields;
}

function firstUrlInText(text: string): string {
  const matches = text.match(/https?:\/\/[^\s<>"'\\]+/gi);
  if (!matches || matches.length === 0) return '';
  return matches[0].replace(/[),.;]+$/, '');
}

function resolveTaskLink(
  labeledLink: string | undefined,
  commandText: string,
  inbound: WebhookInbound
): string {
  if (labeledLink && /^https?:\/\//i.test(labeledLink.trim())) {
    return labeledLink.trim();
  }
  if (labeledLink && labeledLink.trim()) {
    const fromLabel = firstUrlInText(labeledLink);
    if (fromLabel) return fromLabel;
  }

  const fromBody = firstUrlInText(commandText);
  if (fromBody) return fromBody;

  if (!isImageOrStickerEvent(inbound.eventName)) {
    if (/^https?:\/\//i.test(inbound.url)) return inbound.url;
    if (/^https?:\/\//i.test(inbound.photo)) return inbound.photo;
  }

  const nested = collectHttpUrls(inbound.message).filter((url) => {
    if (isImageOrStickerEvent(inbound.eventName)) {
      if (url === inbound.photo || url === inbound.url) return false;
    }
    return true;
  });
  return nested[0] || '';
}

function facebookUrlFromInbound(inbound: WebhookInbound): string {
  const fromUrl = parseFacebookPostUrl(inbound.url);
  if (fromUrl) return fromUrl.href;
  for (const candidate of collectHttpUrls(inbound.message)) {
    if (isImageOrStickerEvent(inbound.eventName)) {
      if (candidate === inbound.photo) continue;
    }
    const parsed = parseFacebookPostUrl(candidate);
    if (parsed) return parsed.href;
  }
  return '';
}

type OptionalNumberParse =
  | { ok: true; value: number | null }
  | { ok: false; found: true; command: 'task'; error: string };

function parseOptionalDeadline(deadlineRaw: string): OptionalNumberParse {
  if (!deadlineRaw) return { ok: true, value: null };
  const deadlineUtcMs = parseDeadlineToUtcMs(deadlineRaw);
  if (deadlineUtcMs === null) {
    return {
      ok: false,
      found: true,
      command: 'task',
      error:
        'HanChot không hợp lệ. Dùng `DD/MM/YYYY HH:mm`, `HH:mm DD/MM/YYYY` hoặc `YYYY-MM-DD HH:mm` (giờ Việt Nam).',
    };
  }
  return { ok: true, value: deadlineUtcMs };
}

function parseOptionalSoLuong(soLuongRaw: string): OptionalNumberParse {
  if (!soLuongRaw) return { ok: true, value: null };
  const parsed = Number.parseInt(soLuongRaw, 10);
  if (!/^\d+$/.test(soLuongRaw) || parsed < 1) {
    return {
      ok: false,
      found: true,
      command: 'task',
      error: 'SoLuong phải là số nguyên ≥ 1.',
    };
  }
  return { ok: true, value: parsed };
}

function parseTaskFields(rest: string, inbound: WebhookInbound): ParseCommandResult {
  const labeled = extractLabeledFields(rest);
  const commandText = inbound.commandText || rest;
  const labeledCaption = (labeled.Caption || '').trim();
  const deadlineRaw = (labeled.HanChot || '').trim();
  const soLuongRaw = (labeled.SoLuong || '').trim();
  const reportGroupId = (labeled.BaoCao || '').trim();
  const hasOldFields = Boolean(
    labeled.Caption || labeled.Link || labeled.SoLuong || labeled.HanChot || labeled.BaoCao
  );

  const facebookUrl =
    (labeled.Link && parseFacebookPostUrl(labeled.Link)?.href) ||
    firstFacebookPostUrl(labeled.Link || '') ||
    firstFacebookPostUrl(commandText) ||
    facebookUrlFromInbound(inbound);

  const anyLink = resolveTaskLink(labeled.Link, commandText, inbound);

  const deadline = parseOptionalDeadline(deadlineRaw);
  if (!deadline.ok) return deadline;
  const soLuong = parseOptionalSoLuong(soLuongRaw);
  if (!soLuong.ok) return soLuong;

  if (labeledCaption) {
    if (!anyLink) {
      return {
        ok: false,
        found: true,
        command: 'task',
        error:
          'Không đọc được Link. Thêm `Link: https://...` hoặc dán URL vào lệnh (kể cả khi Zalo đổi thành thẻ xem trước).',
      };
    }
    const fields: ParsedTaskFields = {
      link: anyLink,
      caption: labeledCaption,
      requiredCount: soLuong.value,
      deadlineUtcMs: deadline.value,
      reportGroupId,
      needsSampleImage: false,
    };
    return { ok: true, found: true, command: 'task', fields };
  }

  if (facebookUrl) {
    const fields: ParsedTaskFields = {
      link: facebookUrl,
      caption: '',
      requiredCount: soLuong.value,
      deadlineUtcMs: deadline.value,
      reportGroupId,
      needsSampleImage: true,
    };
    return { ok: true, found: true, command: 'task', fields };
  }

  if (anyLink) {
    return {
      ok: false,
      found: true,
      command: 'task',
      error: TASK_NOT_FACEBOOK,
    };
  }

  if (hasOldFields) {
    return {
      ok: false,
      found: true,
      command: 'task',
      error:
        'Không đọc được Link. Thêm `Link: https://...` hoặc dán URL vào lệnh (kể cả khi Zalo đổi thành thẻ xem trước).',
    };
  }

  return {
    ok: false,
    found: true,
    command: 'task',
    error: TASK_USAGE,
  };
}

function parseShortCodeCommand(
  command: 'nhac' | 'dong' | 'huy',
  rest: string
): ParseCommandResult {
  if (!rest) {
    return {
      ok: false,
      found: true,
      command,
      error: `Thiếu mã task. Dùng \`/${command} ABC123\` (đúng 6 ký tự A–Z/0–9, không dùng UUID).`,
    };
  }
  const token = rest.split(/\s+/)[0];
  if (rest.split(/\s+/).filter(Boolean).length > 1) {
    return {
      ok: false,
      found: true,
      command,
      error: `/${command} chỉ nhận đúng một mã 6 ký tự.`,
    };
  }
  if (isUuid(token)) {
    return {
      ok: false,
      found: true,
      command,
      error: 'Không dùng UUID. Mã task là đúng 6 ký tự [A-Z0-9], không phải đoạn đầu UUID.',
    };
  }
  const shortCode = normalizeShortCode(token);
  if (!shortCode) {
    return {
      ok: false,
      found: true,
      command,
      error: 'Mã task phải đúng 6 ký tự [A-Z0-9] (ví dụ ABC123). Không khớp prefix UUID.',
    };
  }
  return { ok: true, found: true, command, shortCode };
}

function parseQuet(rest: string): ParseCommandResult {
  if (!rest) {
    return {
      ok: false,
      found: true,
      command: 'quet',
      error: 'Thiếu mã task. Dùng `/quet ABC123` hoặc `/quet ABC123 20` (số tin, mặc định 5).',
    };
  }
  const parts = rest.split(/\s+/).filter(Boolean);
  const token = parts[0];
  if (isUuid(token)) {
    return {
      ok: false,
      found: true,
      command: 'quet',
      error: 'Không dùng UUID. Mã task là đúng 6 ký tự [A-Z0-9], không phải đoạn đầu UUID.',
    };
  }
  const shortCode = normalizeShortCode(token);
  if (!shortCode) {
    return {
      ok: false,
      found: true,
      command: 'quet',
      error: 'Mã task phải đúng 6 ký tự [A-Z0-9] (ví dụ ABC123). Không khớp prefix UUID.',
    };
  }
  if (parts.length === 1) {
    return { ok: true, found: true, command: 'quet', shortCode, count: QUET_DEFAULT_COUNT };
  }
  const count = parseQuetCount(parts.slice(1).join(' '));
  if (count === null) {
    return {
      ok: false,
      found: true,
      command: 'quet',
      error: 'Số tin không hợp lệ. Ví dụ: `/quet ABC123`, `/quet ABC123 20` (1–50 tin, mặc định 5).',
    };
  }
  if (count < QUET_MIN_COUNT || count > QUET_MAX_COUNT) {
    return {
      ok: false,
      found: true,
      command: 'quet',
      error: `Số tin từ ${QUET_MIN_COUNT} đến ${QUET_MAX_COUNT}.`,
    };
  }
  return { ok: true, found: true, command: 'quet', shortCode, count };
}

function parseLienket(rest: string): ParseCommandResult {
  if (!rest) {
    return { ok: true, found: true, command: 'lienket', method: 'A', zcaGroupId: null };
  }
  const token = rest.split(/\s+/)[0].trim();
  if (!token || rest.split(/\s+/).filter(Boolean).length > 1) {
    return {
      ok: false,
      found: true,
      command: 'lienket',
      error: 'Cách B: `/lienket <zca_group_id>` — một id, không thêm tham số.',
    };
  }
  return { ok: true, found: true, command: 'lienket', method: 'B', zcaGroupId: token };
}

/**
 * Phân tích lệnh task-proof từ inbound webhook đã extract.
 */
export function parseTaskproofCommand(inbound: WebhookInbound): ParseCommandResult {
  // Spec 8.1: thẻ xem trước — lấy lệnh + URL từ metadata nếu còn.
  // Official Bot Platform gửi message.unsupported.received + text rỗng khi
  // Zalo đổi cả tin /task + Facebook URL thành card: không phục hồi được thì found=false.
  const detected = detectCommand(inbound.commandText);
  if (!detected) return { ok: false, found: false };

  switch (detected.command) {
    case 'task':
      return parseTaskFields(detected.rest, inbound);
    case 'tasks':
      if (detected.rest) {
        return {
          ok: false,
          found: true,
          command: 'tasks',
          error: '/tasks không nhận tham số.',
        };
      }
      return { ok: true, found: true, command: 'tasks' };
    case 'nhac':
    case 'dong':
    case 'huy':
      return parseShortCodeCommand(detected.command, detected.rest);
    case 'quet':
      return parseQuet(detected.rest);
    case 'lienket':
      return parseLienket(detected.rest);
    default:
      return { ok: false, found: false };
  }
}

export function looksLikeTaskproofCommand(text: string): boolean {
  return detectCommand(text) !== null;
}
