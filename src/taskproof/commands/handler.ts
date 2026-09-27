/**
 * handler.ts
 *
 * Official bot nhận lệnh task-proof.
 * /task /tasks /nhac /huy /dong /quet: chat riêng 1-1 với admin.
 * /lienket vẫn gõ trong nhóm. Worker (OCR, nhắc, báo cáo) không đổi.
 */

import { ZaloClient } from '../../core/zaloClient';
import { getDatabase } from '../../store';
import {
  GROUP_COMMAND_HINT,
  LIENKET_IN_GROUP_HINT,
  NO_LINKED_GROUPS_HINT,
  PRIVATE_NOT_ADMIN_HINT,
  LinkedGroup,
  cancelOpenGroupPicks,
  completePickByIndex,
  createGroupPick,
  formatPickerMessage,
  formatVnDeadline,
  getOpenGroupPickForAdmin,
  listLinkedGroups,
  placeTaskInGroup,
  resolveGroupChoice,
  updateOpenPickCaption,
} from '../groupPick';
import { cancelTask, completeTask } from '../lifecycle';
import { kickTaskCompletionReport, TaskReportResult } from '../report';
import { getTaskproofSetting } from '../settings';
import {
  formatTasksListReply,
  insertNewTask,
  InsertedTask,
  InsertTaskInput,
  listOpenTasks,
  TaskListRow,
} from '../tasks';
import { historyFetchCount } from '../quet';
import {
  postEnsureListening,
  postLinkGroup,
  postMaybeStop,
  postOcrDebug,
  postRemind,
  postScanHistory,
  EnsureListeningResponse,
} from '../workerClient';
import {
  clearSamplePending,
  downloadSampleImage,
  getOpenSample,
  SAMPLE_ASK_REPLY,
  SAMPLE_DOWNLOAD_FAIL_REPLY,
  SAMPLE_EMPTY_OCR_REPLY,
  SAMPLE_NEED_PHOTO_REPLY,
  SAMPLE_OCR_FAIL_REPLY,
  saveAwaitingSample,
  updateSampleCaption,
  writeAcceptedSample,
} from '../sampleCaption';
import { parseTaskproofCommand } from './parser';
import { isUnsupportedEvent, redactSecrets } from './payload';
import { getTaskByExactShortCode, TaskShortCodeRow } from './shortCode';
import { ParseCommandResult, ParsedTaskFields, WebhookInbound } from './types';

export { SAMPLE_ASK_REPLY, SAMPLE_EMPTY_OCR_REPLY, SAMPLE_OCR_FAIL_REPLY, SAMPLE_NEED_PHOTO_REPLY };

export {
  GROUP_COMMAND_HINT,
  LIENKET_IN_GROUP_HINT,
  NO_LINKED_GROUPS_HINT,
  PRIVATE_NOT_ADMIN_HINT,
} from '../groupPick';

export interface TaskproofCommandDeps {
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
  ensureListening?: (taskId?: string) => Promise<EnsureListeningResponse>;
  linkGroup?: (
    officialChatId: string,
    zcaGroupId?: string
  ) => Promise<{ status: number; json: Record<string, unknown> }>;
  remind?: (taskId: string) => Promise<{ status: number; json: Record<string, unknown> }>;
  scanHistory?: (
    taskId: string,
    count: number,
    replyChatId: string
  ) => Promise<{ status: number; json: Record<string, unknown> }>;
  lookupTask?: (shortCode: string) => TaskShortCodeRow | null;
  cancelTask?: (taskId: string) => boolean;
  completeTask?: (taskId: string) => boolean;
  kickReport?: (taskId: string) => Promise<TaskReportResult[]>;
  insertTask?: (input: InsertTaskInput) => InsertedTask;
  listTasks?: () => TaskListRow[];
  listLinkedGroups?: () => LinkedGroup[];
  getAdminChatId?: () => string;
  publicBaseUrl?: () => string;
  now?: () => number;
  downloadSampleImage?: (url: string) => Promise<Buffer | null>;
  ocrSampleImage?: (image: Buffer) => Promise<string>;
  maybeStop?: () => Promise<unknown>;
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

function defaultCompleteTask(taskId: string): boolean {
  return completeTask(getDatabase(), taskId);
}

function defaultKickReport(taskId: string): Promise<TaskReportResult[]> {
  return kickTaskCompletionReport(taskId);
}

function defaultInsertTask(input: InsertTaskInput): InsertedTask {
  return insertNewTask(input);
}

function defaultListTasks(): TaskListRow[] {
  return listOpenTasks();
}

function defaultAdminChatId(): string {
  return (getTaskproofSetting('admin_official_chat_id') || '').trim();
}

function defaultListLinkedGroups(): LinkedGroup[] {
  return listLinkedGroups();
}

export function formatParseReply(inbound: WebhookInbound): string | null {
  const parsed = parseTaskproofCommand(inbound);
  if (!parsed.found) return null;
  if (!parsed.ok) return parsed.error;

  switch (parsed.command) {
    case 'task': {
      const soLuong = parsed.fields.requiredCount === null ? 'mặc định' : String(parsed.fields.requiredCount);
      const baoCao = parsed.fields.reportGroupId || 'mặc định';
      const han =
        parsed.fields.deadlineUtcMs && parsed.fields.deadlineUtcMs > 0
          ? `${formatVnDeadline(parsed.fields.deadlineUtcMs)} (Asia/Ho_Chi_Minh)`
          : 'mặc định (1 giờ sau khi tạo)';
      return [
        'Lệnh /task hợp lệ.',
        `• Link: ${parsed.fields.link}`,
        `• Caption: ${parsed.fields.caption || '(ảnh mẫu)'}`,
        `• Số lượng: ${soLuong}`,
        `• Hạn chót: ${han}`,
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
    case 'quet':
      return `Lệnh /quet hợp lệ. Mã: ${parsed.shortCode}. Số tin: ${parsed.count}.`;
    case 'lienket':
      return parsed.method === 'A'
        ? 'Lệnh /lienket hợp lệ (cách A).'
        : `Lệnh /lienket hợp lệ (cách B). zca_group_id=${parsed.zcaGroupId}`;
    default:
      return null;
  }
}

export function isPrivateChat(inbound: WebhookInbound): boolean {
  if (inbound.chatType === 'PRIVATE') return true;
  if (inbound.chatType === 'GROUP') return false;
  return Boolean(inbound.chatId && inbound.senderId && inbound.chatId === inbound.senderId);
}

function isAdminDm(inbound: WebhookInbound, adminId: string): boolean {
  return Boolean(adminId && isPrivateChat(inbound) && inbound.chatId === adminId);
}

/** Option B: Zalo ẩn /task sau thẻ xem trước — nhắc gửi lại văn bản 1-1, không đánh thức worker. */
export const PREVIEW_CARD_HINT =
  'Zalo đổi tin thành thẻ xem trước nên bot không đọc được lệnh. Gửi lại /task dạng văn bản thuần trong chat riêng 1-1 với bot (tắt xem trước, hoặc để Link sang tin sau).';

export const PREVIEW_HINT_THROTTLE_MS = 5 * 60 * 1000;

const lastPreviewHintAt = new Map<string, number>();

export function resetPreviewHintThrottle(): void {
  lastPreviewHintAt.clear();
}

function shouldSendPreviewHint(chatId: string, now: number): boolean {
  const prev = lastPreviewHintAt.get(chatId);
  if (prev !== undefined && now - prev < PREVIEW_HINT_THROTTLE_MS) return false;
  lastPreviewHintAt.set(chatId, now);
  return true;
}

async function maybeHintPreviewCard(
  inbound: WebhookInbound,
  deps: TaskproofCommandDeps
): Promise<boolean> {
  if (!isUnsupportedEvent(inbound.eventName)) return false;
  if (!inbound.chatId) return false;
  const now = deps.now ?? Date.now;
  if (!shouldSendPreviewHint(inbound.chatId, now())) return true;
  try {
    await deps.sendMessage(inbound.chatId, PREVIEW_CARD_HINT);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] Không gửi được gợi ý thẻ xem trước:', msg);
  }
  return true;
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
  if (error === 'unlinked' || (status === 409 && error === 'unlinked')) {
    return `Nhóm chưa liên kết. Gõ /lienket trong nhóm đó rồi /nhac ${code}.`;
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
      `Nhóm chưa liên kết. Gõ /lienket trong nhóm đó rồi /nhac ${code}.`
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

function quetReply(
  code: string,
  count: number,
  status: number,
  json: Record<string, unknown>
): string {
  const n = historyFetchCount(count);
  const error = typeof json.error === 'string' ? json.error : '';
  if (status === 404 || error === 'task not found') {
    return `Không tìm thấy mã ${code}.`;
  }
  if (error === 'unlinked' || (status === 409 && error === 'unlinked')) {
    return `Nhóm chưa liên kết. Gõ /lienket trong nhóm đó rồi /quet ${code}.`;
  }
  if (status >= 400 && /cancelled|completed/.test(error)) {
    return `Task ${code} đã đóng hoặc hủy, không quét.`;
  }
  if (error === 'already_scanning' || json.state === 'already_scanning') {
    return `Đang quét ${code} rồi. Đợi tin kết quả.`;
  }
  if (!error && (status === 202 || json.state === 'scanning')) {
    return `Đang quét ${n} tin gần nhất cho mã ${code}… Kết quả sẽ gửi sau.`;
  }
  if (status >= 400) {
    return `Không quét được ${code}${error ? `: ${error}` : ''}.`;
  }
  return `Đang quét ${n} tin gần nhất cho mã ${code}… Kết quả sẽ gửi sau.`;
}

async function handleQuet(
  inbound: WebhookInbound,
  parsed: { shortCode: string; count: number },
  deps: TaskproofCommandDeps
): Promise<void> {
  const lookupTask = deps.lookupTask ?? defaultLookupTask;
  const ensureListening = deps.ensureListening ?? (() => postEnsureListening());
  const scanHistory = deps.scanHistory ?? postScanHistory;
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
    await deps.sendMessage(inbound.chatId, `Task ${code} đã đóng hoặc hủy, không quét.`);
    return;
  }
  if (!task.zca_group_id) {
    await deps.sendMessage(
      inbound.chatId,
      `Nhóm chưa liên kết. Gõ /lienket trong nhóm đó rồi /quet ${code}.`
    );
    return;
  }

  let listen: EnsureListeningResponse;
  try {
    listen = await ensureListening();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] /quet ensure-listening lỗi:', msg);
    await deps.sendMessage(
      inbound.chatId,
      'Worker không chạy. /gui vẫn dùng được. Thử lại /quet sau.'
    );
    return;
  }

  if (listen.status >= 400) {
    await deps.sendMessage(
      inbound.chatId,
      `Không quét được. ${loginHint(listen)} Gõ /quet ${code} lại sau khi đăng nhập.`
    );
    return;
  }
  if (listen.state === 'qr_required') {
    await deps.sendMessage(
      inbound.chatId,
      `QR đang gửi admin. Quét xong hãy gõ /quet ${code} lại.`
    );
    return;
  }

  let result: { status: number; json: Record<string, unknown> };
  try {
    result = await scanHistory(task.id, parsed.count, inbound.chatId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] /quet scan-history lỗi:', msg);
    await deps.sendMessage(inbound.chatId, `Không gọi được worker để quét ${code}. Thử lại /quet.`);
    return;
  }

  await deps.sendMessage(inbound.chatId, quetReply(code, parsed.count, result.status, result.json));
}

function placeDeps(deps: TaskproofCommandDeps): {
  sendMessage: TaskproofCommandDeps['sendMessage'];
  insertTask: TaskproofCommandDeps['insertTask'];
  ensureListening: TaskproofCommandDeps['ensureListening'];
} {
  return {
    sendMessage: deps.sendMessage,
    insertTask: deps.insertTask ?? defaultInsertTask,
    ensureListening: deps.ensureListening,
  };
}

async function placeOrPickGroups(
  fields: ParsedTaskFields,
  inbound: WebhookInbound,
  deps: TaskproofCommandDeps,
  opts: { alwaysAsk?: boolean } = {}
): Promise<void> {
  const groups = (deps.listLinkedGroups ?? defaultListLinkedGroups)();
  if (groups.length === 0) {
    await deps.sendMessage(inbound.chatId, NO_LINKED_GROUPS_HINT);
    return;
  }

  if (groups.length === 1 && !opts.alwaysAsk) {
    await placeTaskInGroup(fields, groups[0], inbound.chatId, placeDeps(deps));
    return;
  }

  const now = (deps.now ?? Date.now)();
  const pick = createGroupPick({
    adminChatId: inbound.chatId,
    fields,
    groups,
    now,
  });
  const base = deps.publicBaseUrl?.() ?? '';
  await deps.sendMessage(
    inbound.chatId,
    formatPickerMessage(pick, base || undefined, { sample: Boolean(opts.alwaysAsk) })
  );
}

function inboundPhotoUrl(inbound: WebhookInbound): string {
  if ((inbound.photo || '').trim()) return inbound.photo.trim();
  const attachments = inbound.message.attachments;
  if (!Array.isArray(attachments)) return '';
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const payload =
      rec.payload && typeof rec.payload === 'object' ? (rec.payload as Record<string, unknown>) : null;
    const url = String(rec.url || rec.photo || (payload && (payload.url || payload.href)) || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  return '';
}

function isSampleImageMessage(inbound: WebhookInbound): boolean {
  if (inbound.eventName.trim().toLowerCase() === 'message.image.received') return true;
  return Boolean(inboundPhotoUrl(inbound));
}

async function ocrSampleBuffer(image: Buffer, deps: TaskproofCommandDeps): Promise<string> {
  if (deps.ocrSampleImage) return deps.ocrSampleImage(image);
  const result = await postOcrDebug(image);
  if (result.status !== 200 || result.json.success === false) {
    const error = typeof result.json.error === 'string' ? result.json.error : `ocr_http_${result.status}`;
    throw new Error(error);
  }
  return typeof result.json.text === 'string' ? result.json.text : '';
}

async function sendSamplePicker(
  inbound: WebhookInbound,
  caption: string,
  deps: TaskproofCommandDeps
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const pending = getOpenSample(inbound.chatId, now);
  if (!pending) return;
  const existing = getOpenGroupPickForAdmin(inbound.chatId, now);
  if (existing) {
    const updated = updateOpenPickCaption(inbound.chatId, caption, now);
    if (!updated) return;
    const base = deps.publicBaseUrl?.() ?? '';
    await deps.sendMessage(inbound.chatId, formatPickerMessage(updated, base || undefined, { sample: true }));
    return;
  }
  await placeOrPickGroups(
    {
      link: pending.link,
      caption,
      requiredCount: pending.requiredCount,
      deadlineUtcMs: pending.deadline > 0 ? pending.deadline : null,
      reportGroupId: pending.reportGroupId,
      needsSampleImage: false,
    },
    inbound,
    deps,
    { alwaysAsk: true }
  );
}

async function acceptSamplePhoto(
  inbound: WebhookInbound,
  deps: TaskproofCommandDeps
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const pending = getOpenSample(inbound.chatId, now);
  if (!pending) {
    await deps.sendMessage(inbound.chatId, 'Hết hạn chờ ảnh mẫu. Gõ /task <link> lại.');
    return;
  }
  const photoUrl = inboundPhotoUrl(inbound);
  if (!photoUrl) {
    await deps.sendMessage(inbound.chatId, SAMPLE_DOWNLOAD_FAIL_REPLY);
    return;
  }
  let downloaded: Awaited<ReturnType<typeof downloadSampleImage>>;
  try {
    downloaded = await downloadSampleImage(photoUrl, deps.downloadSampleImage);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] Tải ảnh mẫu lỗi:', msg);
    await deps.sendMessage(inbound.chatId, SAMPLE_DOWNLOAD_FAIL_REPLY);
    return;
  }
  if (!downloaded.ok) {
    await deps.sendMessage(inbound.chatId, downloaded.reply);
    return;
  }
  let caption = '';
  try {
    caption = (await ocrSampleBuffer(downloaded.image, deps)).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] OCR ảnh mẫu lỗi:', msg);
    await deps.sendMessage(inbound.chatId, SAMPLE_OCR_FAIL_REPLY);
    return;
  }
  if (!caption) {
    await deps.sendMessage(inbound.chatId, SAMPLE_EMPTY_OCR_REPLY);
    return;
  }
  const saved = writeAcceptedSample(inbound.chatId, downloaded.image, caption, photoUrl, now);
  if (!saved) {
    await deps.sendMessage(inbound.chatId, 'Hết hạn chờ ảnh mẫu. Gõ /task <link> lại.');
    return;
  }
  await sendSamplePicker(inbound, caption, deps);
}

async function handleTaskCreate(
  inbound: WebhookInbound,
  parsed: Extract<ParseCommandResult, { ok: true; command: 'task' }>,
  deps: TaskproofCommandDeps
): Promise<void> {
  const fields = parsed.fields;
  const now = (deps.now ?? Date.now)();
  cancelOpenGroupPicks(inbound.chatId);
  clearSamplePending(inbound.chatId);

  if (fields.needsSampleImage && !fields.caption) {
    const groups = (deps.listLinkedGroups ?? defaultListLinkedGroups)();
    if (groups.length === 0) {
      await deps.sendMessage(inbound.chatId, NO_LINKED_GROUPS_HINT);
      return;
    }
    saveAwaitingSample({
      adminChatId: inbound.chatId,
      link: fields.link,
      requiredCount: fields.requiredCount,
      deadline: fields.deadlineUtcMs && fields.deadlineUtcMs > 0 ? fields.deadlineUtcMs : 0,
      reportGroupId: fields.reportGroupId,
      now,
    });
    if (isSampleImageMessage(inbound) && inboundPhotoUrl(inbound)) {
      await acceptSamplePhoto(inbound, deps);
      return;
    }
    await deps.sendMessage(inbound.chatId, SAMPLE_ASK_REPLY);
    return;
  }

  await placeOrPickGroups(fields, inbound, deps);
}

async function maybeReviseSample(
  inbound: WebhookInbound,
  deps: TaskproofCommandDeps
): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const pending = getOpenSample(inbound.chatId, now);
  if (!pending) return false;
  if (isSampleImageMessage(inbound)) {
    await acceptSamplePhoto(inbound, deps);
    return true;
  }
  const text = (inbound.commandText || inbound.text || '').trim();
  if (!text || text.startsWith('/')) return false;
  if (!pending.caption || !pending.imagePath) {
    await deps.sendMessage(inbound.chatId, SAMPLE_NEED_PHOTO_REPLY);
    return true;
  }
  const pick = getOpenGroupPickForAdmin(inbound.chatId, now);
  if (pick && resolveGroupChoice(text, pick.groups)) return false;
  const updated = updateSampleCaption(inbound.chatId, text, now);
  if (!updated) return false;
  await sendSamplePicker(inbound, text, deps);
  return true;
}

async function maybeHandlePickReply(
  inbound: WebhookInbound,
  deps: TaskproofCommandDeps
): Promise<boolean> {
  const text = (inbound.commandText || inbound.text || '').trim();
  if (!text || text.startsWith('/')) return false;
  const now = (deps.now ?? Date.now)();
  const pick = getOpenGroupPickForAdmin(inbound.chatId, now);
  if (!pick) return false;
  const group = resolveGroupChoice(text, pick.groups);
  if (!group) {
    await deps.sendMessage(
      inbound.chatId,
      'Không khớp nhóm. Bấm link trong tin trước, hoặc trả lời đúng số thứ tự.'
    );
    return true;
  }
  const index1 = pick.groups.findIndex((row) => row.official_chat_id === group.official_chat_id) + 1;
  const result = await completePickByIndex(
    pick.token,
    index1,
    {
      sendMessage: deps.sendMessage,
      insertTask: deps.insertTask ?? defaultInsertTask,
      ensureListening: deps.ensureListening,
    },
    now
  );
  if (!result.ok) {
    await deps.sendMessage(inbound.chatId, result.body);
  }
  return true;
}

async function handleTasksList(
  inbound: WebhookInbound,
  deps: TaskproofCommandDeps
): Promise<void> {
  const list = deps.listTasks ?? defaultListTasks;
  const rows = list();
  await deps.sendMessage(inbound.chatId, formatTasksListReply(rows));
}

async function handleDong(
  inbound: WebhookInbound,
  parsed: { shortCode: string },
  deps: TaskproofCommandDeps
): Promise<void> {
  const lookupTask = deps.lookupTask ?? defaultLookupTask;
  const doComplete = deps.completeTask ?? defaultCompleteTask;
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

  const ok = doComplete(task.id);
  if (!ok) {
    await deps.sendMessage(inbound.chatId, `Không đóng được ${code}.`);
    return;
  }

  const kickReport = deps.kickReport ?? defaultKickReport;
  let reported = false;
  try {
    const results = await kickReport(task.id);
    reported = results.some((row) => row.reported && row.error !== 'already_reported');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TaskProof] /dong kick báo cáo ${code} lỗi:`, msg);
  }

  await deps.sendMessage(
    inbound.chatId,
    reported
      ? `Đã đóng task ${code}. Đã gửi báo cáo với minh chứng đã nộp.`
      : `Đã đóng task ${code}. Báo cáo chưa gửi được, sẽ thử lại sau.`
  );
  const maybeStop = deps.maybeStop ?? postMaybeStop;
  void Promise.resolve(maybeStop()).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[TaskProof] /dong maybe-stop:', msg);
  });
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
  const maybeStop = deps.maybeStop ?? postMaybeStop;
  void Promise.resolve(maybeStop()).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[TaskProof] /huy maybe-stop:', msg);
  });
}

async function sendSafe(
  deps: TaskproofCommandDeps,
  chatId: string,
  text: string
): Promise<void> {
  try {
    await deps.sendMessage(chatId, text);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] Không gửi được phản hồi lệnh:', msg);
    throw err;
  }
}

/**
 * @returns true nếu đây là lệnh task-proof (kể cả khi parse lỗi) — webhook không đi tiếp /gui.
 */
export async function handleTaskproofCommand(
  inbound: WebhookInbound,
  deps: TaskproofCommandDeps = { sendMessage: defaultSendMessage }
): Promise<boolean> {
  const adminId = (deps.getAdminChatId ?? defaultAdminChatId)();
  const privateChat = isPrivateChat(inbound);
  const adminDm = isAdminDm(inbound, adminId);
  const parsed = parseTaskproofCommand(inbound);

  if (!parsed.found) {
    if (adminDm) {
      try {
        if (await maybeReviseSample(inbound, deps)) return true;
        if (await maybeHandlePickReply(inbound, deps)) return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[TaskProof] pick-reply lỗi:', msg);
      }
      return maybeHintPreviewCard(inbound, deps);
    }
    return false;
  }

  if (!inbound.chatId) return true;

  if (parsed.command === 'lienket') {
    if (privateChat) {
      await sendSafe(deps, inbound.chatId, LIENKET_IN_GROUP_HINT);
      return true;
    }
    if (!parsed.ok) {
      const reply = formatParseReply(inbound);
      if (reply) await sendSafe(deps, inbound.chatId, reply);
      return true;
    }
    await handleLienket(inbound, parsed, deps);
    return true;
  }

  if (!adminDm) {
    if (privateChat) {
      await sendSafe(deps, inbound.chatId, PRIVATE_NOT_ADMIN_HINT);
      return true;
    }
    await sendSafe(deps, inbound.chatId, GROUP_COMMAND_HINT);
    return true;
  }

  if (!parsed.ok && parsed.command === 'task' && /Không đọc được Link/.test(parsed.error)) {
    console.warn(
      '[TaskProof] /task thiếu Link — payload đã che secret:',
      JSON.stringify(redactSecrets(inbound.rawBody))
    );
  }

  if (!parsed.ok) {
    const reply = formatParseReply(inbound);
    if (reply) await sendSafe(deps, inbound.chatId, reply);
    return true;
  }

  switch (parsed.command) {
    case 'task':
      await handleTaskCreate(inbound, parsed, deps);
      return true;
    case 'tasks':
      await handleTasksList(inbound, deps);
      return true;
    case 'nhac':
      await handleNhac(inbound, parsed, deps);
      return true;
    case 'quet':
      await handleQuet(inbound, parsed, deps);
      return true;
    case 'huy':
      await handleHuy(inbound, parsed, deps);
      return true;
    case 'dong':
      await handleDong(inbound, parsed, deps);
      return true;
    default:
      return false;
  }
}
