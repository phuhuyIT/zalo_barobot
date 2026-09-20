/**
 * handler.ts
 *
 * Official bot nhận lệnh task-proof.
 * /lienket gọi worker (Section 8.10). Webhook không chờ QR.
 * /nhac: exact short_code → ensure-listening → remind (Section 8.4).
 * /huy: exact short_code → cancelled, không report, xóa proofs (Section 8.11).
 * /task /tasks /dong bước này vẫn parse-ack (insert T1 / report T6 = bước sau).
 */

import { ZaloClient } from '../../core/zaloClient';
import { getVietnamTimeParts } from '../../sheets/dateUtils';
import { getDatabase } from '../../store';
import { cancelTask } from '../lifecycle';
import { postEnsureListening, postLinkGroup, postRemind, EnsureListeningResponse } from '../workerClient';
import { parseTaskproofCommand } from './parser';
import { redactSecrets } from './payload';
import { getTaskByExactShortCode, TaskShortCodeRow } from './shortCode';
import { ParseCommandResult, WebhookInbound } from './types';

export interface TaskproofCommandDeps {
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
  ensureListening?: () => Promise<EnsureListeningResponse>;
  linkGroup?: (
    officialChatId: string,
    zcaGroupId?: string
  ) => Promise<{ status: number; json: Record<string, unknown> }>;
  remind?: (taskId: string) => Promise<{ status: number; json: Record<string, unknown> }>;
  lookupTask?: (shortCode: string) => TaskShortCodeRow | null;
  cancelTask?: (taskId: string) => boolean;
}

function defaultSendMessage(chatId: string, text: string): Promise<unknown> {
  const zalo = new ZaloClient();
  return zalo.sendMessage(chatId, text);
}

function defaultLookupTask(shortCode: string): TaskShortCodeRow | null {
  return getTaskByExactShortCode(getDatabase(), shortCode);
}

function defaultCancelTask(taskId: string): boolean {
  return cancelTask(getDatabase(), taskId);
}

function formatVnDeadline(utcMs: number): string {
  const parts = getVietnamTimeParts(new Date(utcMs));
  return `${parts.dateDMY} ${parts.timeHM}`;
}

export function formatParseReply(inbound: WebhookInbound): string | null {
  const parsed = parseTaskproofCommand(inbound);
  if (!parsed.found) return null;
  if (!parsed.ok) return parsed.error;

  switch (parsed.command) {
    case 'task': {
      const soLuong = parsed.fields.requiredCount === null ? 'mặc định' : String(parsed.fields.requiredCount);
      const baoCao = parsed.fields.reportGroupId || 'mặc định';
      return [
        'Lệnh /task hợp lệ.',
        `• Link: ${parsed.fields.link}`,
        `• Caption: ${parsed.fields.caption}`,
        `• Số lượng: ${soLuong}`,
        `• Hạn chót: ${formatVnDeadline(parsed.fields.deadlineUtcMs)} (Asia/Ho_Chi_Minh)`,
        `• Báo cáo: ${baoCao}`,
      ].join('\n');
    }
    case 'tasks':
      return 'Lệnh /tasks hợp lệ.';
    case 'nhac':
      return `Lệnh /nhac hợp lệ. Mã: ${parsed.shortCode}`;
    case 'dong':
      return `Lệnh /dong hợp lệ. Mã: ${parsed.shortCode}`;
    case 'huy':
      return `Lệnh /huy hợp lệ. Mã: ${parsed.shortCode}`;
    case 'lienket':
      return parsed.method === 'A'
        ? 'Lệnh /lienket hợp lệ (cách A).'
        : `Lệnh /lienket hợp lệ (cách B). zca_group_id=${parsed.zcaGroupId}`;
    default:
      return null;
  }
}

function isPrivateChat(inbound: WebhookInbound): boolean {
  return inbound.chatType === 'PRIVATE';
}

function loginHint(listen: EnsureListeningResponse): string {
  if (listen.state === 'qr_required') {
    return 'QR đang gửi admin. Quét xong hãy gõ `ok` trong nhóm này.';
  }
  if (listen.status >= 400) {
    return `Worker chưa đăng nhập zca-js (${listen.state}${listen.error ? `: ${listen.error}` : ''}).`;
  }
  return '';
}

async function handleLienket(
  inbound: WebhookInbound,
  parsed: Extract<ParseCommandResult, { ok: true; command: 'lienket' }>,
  deps: TaskproofCommandDeps
): Promise<void> {
  const ensureListening = deps.ensureListening ?? (() => postEnsureListening());
  const linkGroup = deps.linkGroup ?? postLinkGroup;

  let listen: EnsureListeningResponse;
  try {
    listen = await ensureListening();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] ensure-listening lỗi:', msg);
    await deps.sendMessage(
      inbound.chatId,
      'Worker không chạy. /gui vẫn dùng được. Thử lại /lienket sau.'
    );
    return;
  }

  if (parsed.method === 'A' && listen.status >= 400) {
    await deps.sendMessage(
      inbound.chatId,
      `Không mở được cửa liên kết. ${loginHint(listen)} Gõ /lienket lại sau khi đăng nhập.`
    );
    return;
  }

  let link: { status: number; json: Record<string, unknown> };
  try {
    link = await linkGroup(
      inbound.chatId,
      parsed.method === 'B' ? parsed.zcaGroupId : undefined
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] link-group lỗi:', msg);
    await deps.sendMessage(
      inbound.chatId,
      'Không gọi được worker để liên kết nhóm. Thử lại /lienket.'
    );
    return;
  }

  if (link.status >= 400) {
    const err = typeof link.json.error === 'string' ? link.json.error : `HTTP ${link.status}`;
    await deps.sendMessage(inbound.chatId, `Không liên kết được: ${err}`);
    return;
  }

  if (parsed.method === 'A') {
    const lines = [
      'Đang mở liên kết 2 phút.',
      'Gõ `ok` trong nhóm này (tài khoản phụ zca-js phải ở trong nhóm).',
    ];
    const hint = loginHint(listen);
    if (hint) lines.push(hint);
    await deps.sendMessage(inbound.chatId, lines.join('\n'));
    return;
  }

  const zca = typeof link.json.zca_group_id === 'string' ? link.json.zca_group_id : parsed.zcaGroupId;
  await deps.sendMessage(inbound.chatId, `Đã liên kết: ${zca}`);
}

function remindReply(code: string, status: number, json: Record<string, unknown>): string {
  const error = typeof json.error === 'string' ? json.error : '';
  if (status === 404 || error === 'task not found') {
    return `Không tìm thấy mã ${code}.`;
  }
  if (error === 'unlinked' || status === 409 && error === 'unlinked') {
    return `Nhóm chưa liên kết. Gõ /lienket trong nhóm này rồi /nhac ${code}.`;
  }
  if (status >= 400 && /cancelled|completed/.test(error)) {
    return `Task ${code} đã đóng hoặc hủy, không nhắc.`;
  }
  if (status >= 400) {
    return `Không nhắc được ${code}${error ? `: ${error}` : ''}.`;
  }

  const kind = typeof json.kind === 'string' ? json.kind : '';
  const missing = typeof json.missing_count === 'number' ? json.missing_count : 0;
  const reminded = json.reminded === true;

  if (kind === 'none' || (!reminded && kind === 'none')) {
    return `Không còn thành viên nào cần nhắc cho mã ${code}.`;
  }
  if (!reminded && (error === 'qr_required' || json.state === 'qr_required')) {
    return `QR đang gửi admin. Quét xong hãy gõ /nhac ${code} lại.`;
  }
  if (!reminded) {
    return `Chưa gửi được nhắc ${code}${error ? `: ${error}` : ''}.`;
  }
  if (kind === 'all') {
    return `Đã gửi @all — còn ${missing} người chưa nộp (${code}).`;
  }
  if (kind === 'generic') {
    return `Đã gửi nhắc trong nhóm (không lấy được danh sách thành viên). Mã ${code}.`;
  }
  return `Đã nhắc ${missing} người chưa nộp (${code}).`;
}

async function handleNhac(
  inbound: WebhookInbound,
  parsed: { shortCode: string },
  deps: TaskproofCommandDeps
): Promise<void> {
  const lookupTask = deps.lookupTask ?? defaultLookupTask;
  const ensureListening = deps.ensureListening ?? (() => postEnsureListening());
  const remind = deps.remind ?? postRemind;
  const code = parsed.shortCode;

  const task = lookupTask(code);
  if (!task) {
    await deps.sendMessage(
      inbound.chatId,
      `Không tìm thấy mã ${code}. Mã phải đúng 6 ký tự [A-Z0-9], không dùng UUID.`
    );
    return;
  }
  if (task.status !== 'collecting' && task.status !== 'overdue') {
    await deps.sendMessage(inbound.chatId, `Task ${code} đã đóng hoặc hủy, không nhắc.`);
    return;
  }
  if (!task.zca_group_id) {
    await deps.sendMessage(
      inbound.chatId,
      `Nhóm chưa liên kết. Gõ /lienket trong nhóm này rồi /nhac ${code}.`
    );
    return;
  }

  let listen: EnsureListeningResponse;
  try {
    listen = await ensureListening();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] /nhac ensure-listening lỗi:', msg);
    await deps.sendMessage(
      inbound.chatId,
      'Worker không chạy. /gui vẫn dùng được. Thử lại /nhac sau.'
    );
    return;
  }

  if (listen.status >= 400) {
    await deps.sendMessage(
      inbound.chatId,
      `Không nhắc được. ${loginHint(listen)} Gõ /nhac ${code} lại sau khi đăng nhập.`
    );
    return;
  }

  let result: { status: number; json: Record<string, unknown> };
  try {
    result = await remind(task.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] /nhac remind lỗi:', msg);
    await deps.sendMessage(inbound.chatId, `Không gọi được worker để nhắc ${code}. Thử lại /nhac.`);
    return;
  }

  await deps.sendMessage(inbound.chatId, remindReply(code, result.status, result.json));
}

async function handleHuy(
  inbound: WebhookInbound,
  parsed: { shortCode: string },
  deps: TaskproofCommandDeps
): Promise<void> {
  const lookupTask = deps.lookupTask ?? defaultLookupTask;
  const doCancel = deps.cancelTask ?? defaultCancelTask;
  const code = parsed.shortCode;

  const task = lookupTask(code);
  if (!task) {
    await deps.sendMessage(
      inbound.chatId,
      `Không tìm thấy mã ${code}. Mã phải đúng 6 ký tự [A-Z0-9], không dùng UUID.`
    );
    return;
  }
  if (task.status !== 'collecting' && task.status !== 'overdue') {
    await deps.sendMessage(inbound.chatId, `Task ${code} đã đóng hoặc hủy trước đó.`);
    return;
  }

  const ok = doCancel(task.id);
  if (!ok) {
    await deps.sendMessage(inbound.chatId, `Không hủy được ${code}.`);
    return;
  }
  await deps.sendMessage(
    inbound.chatId,
    `Đã hủy task ${code}. Không gửi báo cáo. Worker sẽ dừng nếu không còn task liên kết mở.`
  );
}

/**
 * @returns true nếu đây là lệnh task-proof (kể cả khi parse lỗi) — webhook không đi tiếp /gui.
 */
export async function handleTaskproofCommand(
  inbound: WebhookInbound,
  deps: TaskproofCommandDeps = { sendMessage: defaultSendMessage }
): Promise<boolean> {
  if (isPrivateChat(inbound)) {
    const parsed = parseTaskproofCommand(inbound);
    if (!parsed.found) return false;
    try {
      await deps.sendMessage(
        inbound.chatId,
        'Gõ lệnh task-proof trong nhóm nhiệm vụ, không chat riêng với bot.'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskProof] Không gửi được phản hồi lệnh (private):', msg);
    }
    return true;
  }

  const parsed = parseTaskproofCommand(inbound);
  if (!parsed.found) return false;
  if (!parsed.ok && parsed.command === 'task' && /Không đọc được Link/.test(parsed.error)) {
    console.warn(
      '[TaskProof] /task thiếu Link — payload đã che secret:',
      JSON.stringify(redactSecrets(inbound.rawBody))
    );
  }

  if (parsed.ok && parsed.command === 'lienket') {
    if (!inbound.chatId) return true;
    await handleLienket(inbound, parsed, deps);
    return true;
  }

  if (parsed.ok && parsed.command === 'nhac') {
    if (!inbound.chatId) return true;
    await handleNhac(inbound, parsed, deps);
    return true;
  }

  if (parsed.ok && parsed.command === 'huy') {
    if (!inbound.chatId) return true;
    await handleHuy(inbound, parsed, deps);
    return true;
  }

  const reply = formatParseReply(inbound);
  if (reply === null) return false;

  if (!inbound.chatId) return true;

  try {
    await deps.sendMessage(inbound.chatId, reply);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] Không gửi được phản hồi lệnh:', msg);
    throw err;
  }
  return true;
}
