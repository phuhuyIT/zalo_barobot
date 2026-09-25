/**
 * reminders.ts
 *
 * Thuật toán nhắc (Section 8.4). Gửi đúng một tin:
 *   0 missing → không gửi
 *   ít người + text ngắn → mention từng uid
 *   quá MAX_MENTIONS_PER_MESSAGE hoặc quá MAX_REMINDER_TEXT_LEN → một @all (uid -1)
 * Không tách nhiều tin mention. Timer tự động chạy khi worker đang listen.
 *
 * @all vs từng người: mention từng uid khi vừa một tin; @all khi không vừa.
 */

import { shouldAutoRemind } from '../lifecycle';
import { CachedMember, stripMemberId } from './memberCache';
import { ZcaMention } from './zcaAdapter';

export { shouldAutoRemind };

export const ALL_MENTION_UID = '-1';

export type ReminderKind = 'none' | 'mentions' | 'all' | 'generic';

export interface ReminderPlan {
  kind: ReminderKind;
  msg: string;
  mentions: ZcaMention[];
  missingCount: number;
}

export function collectExcludeUids(opts: {
  officialBotUid?: string;
  zcaOwnUid?: string;
  liveOwnId?: string;
  extra?: string[];
}): Set<string> {
  const out = new Set<string>();
  for (const value of [opts.officialBotUid, opts.zcaOwnUid, opts.liveOwnId, ...(opts.extra || [])]) {
    const id = (value || '').trim();
    if (!id) continue;
    out.add(id);
    const stripped = stripMemberId(id);
    if (stripped) out.add(stripped);
  }
  return out;
}

export function computeMissing(
  members: CachedMember[],
  submittedUids: Iterable<string>,
  exclude: Set<string>
): CachedMember[] {
  const submitted = new Set([...submittedUids].map((id) => id.trim()).filter(Boolean));
  return members.filter((member) => {
    if (!member.user_id) return false;
    if (exclude.has(member.user_id) || exclude.has(stripMemberId(member.user_id))) return false;
    if (submitted.has(member.user_id)) return false;
    return true;
  });
}

function mentionLabel(name: string): string {
  const cleaned = (name || '').trim() || 'thành viên';
  return `@${cleaned}`;
}

function buildMentionsMessage(missing: CachedMember[], shortCode: string, link?: string): {
  msg: string;
  mentions: ZcaMention[];
} {
  const mentions: ZcaMention[] = [];
  const tokens: string[] = [];
  let pos = 0;
  for (const member of missing) {
    const token = mentionLabel(member.display_name);
    if (tokens.length > 0) pos += 1; // space
    mentions.push({ pos, len: token.length, uid: member.user_id });
    tokens.push(token);
    pos += token.length;
  }
  const suffix = link
    ? `chưa nộp minh chứng cho bài viết ${link}`
    : `chưa nộp minh chứng ${shortCode}.`;
  const msg = `${tokens.join(' ')} ${suffix}`;
  return { msg, mentions };
}

function buildAllMessage(missingCount: number, shortCode: string, link?: string): {
  msg: string;
  mentions: ZcaMention[];
} {
  const token = '@all';
  const suffix = link
    ? `Còn ${missingCount} người chưa nộp minh chứng cho bài viết ${link}`
    : `Còn ${missingCount} người chưa nộp minh chứng ${shortCode}.`;
  return {
    msg: `${token} ${suffix}`,
    mentions: [{ pos: 0, len: token.length, uid: ALL_MENTION_UID }],
  };
}

export function planReminder(opts: {
  missing: CachedMember[];
  shortCode: string;
  maxMentions: number;
  maxTextLen: number;
  cacheAvailable: boolean;
  link?: string;
}): ReminderPlan {
  const { missing, shortCode, maxMentions, maxTextLen, cacheAvailable, link } = opts;

  if (!cacheAvailable) {
    const taskRef = link ? `bài viết ${link}` : `task ${shortCode}`;
    return {
      kind: 'generic',
      msg: `Nhắc nộp minh chứng cho ${taskRef}. Không lấy được danh sách thành viên — đưa tài khoản phụ làm phó nhóm (hoặc tắt khóa xem thành viên) rồi /nhac lại.`,
      mentions: [],
      missingCount: 0,
    };
  }

  if (missing.length === 0) {
    return { kind: 'none', msg: '', mentions: [], missingCount: 0 };
  }

  const perPerson = buildMentionsMessage(missing, shortCode, link);
  const fits =
    missing.length <= maxMentions && perPerson.msg.length <= maxTextLen;

  if (fits) {
    return {
      kind: 'mentions',
      msg: perPerson.msg,
      mentions: perPerson.mentions,
      missingCount: missing.length,
    };
  }

  const all = buildAllMessage(missing.length, shortCode, link);
  return {
    kind: 'all',
    msg: all.msg,
    mentions: all.mentions,
    missingCount: missing.length,
  };
}

