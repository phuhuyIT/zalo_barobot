/**
 * Nhận lệnh `doi`, lưu thay ca, và gửi lại lịch nếu khung giờ đã tới hoặc lịch đã gửi.
 */

import Database from 'better-sqlite3';
import { getRecipientChatId } from '../config';
import { getEffectiveScheduleConfig } from '../core/sendSchedule';
import { ZaloClient, ZaloTextStyle } from '../core/zaloClient';
import { readSheetTab, updateSheetCell } from '../sheets/sheetsClient';
import { getVietnamTimeParts } from '../sheets/dateUtils';
import { getPatrolMembers } from '../patrol/repository';
import { columnHeaders, findChoColumns, isChoCell, matchShiftColumn, readShiftColumns } from './columns';
import { parseConfirmWord, parseDoiMessage } from './parser';
import { dutyDateForSquad, minutesOf, sendTimeForSquad } from './prepare';
import {
  clearPendingChanges,
  findReportByMessageId,
  getExternalDutyConfig,
  getPendingChanges,
  listExternalDutyReports,
  PendingChange,
  resolvePartnerChatId,
  saveExternalDutyReport,
  savePendingChanges,
} from './repository';
import { ExternalDutyConfig, ExternalSquad, ShiftColumn } from './types';

export interface DoiCommandPayload {
  text: string;
  chatId: string;
  senderId: string;
  messageId?: string;
}

export interface DoiCommandResult {
  handled: boolean;
  success: boolean;
  ignoredReason?: string;
  reply?: string;
  sentScheduleKeys?: string[];
}

export interface DoiCommandOptions {
  now?: Date;
  database?: Database.Database;
  zaloClient?: ZaloClient;
  rowsBySquad?: Partial<Record<ExternalSquad, unknown[][]>>;
  skipSend?: boolean;
}

const MAX_COMMAND_LENGTH = 2000;

function canEdit(senderId: string, config: ExternalDutyConfig): boolean {
  return senderId === config.partnerLeaderUserId || config.extraEditorIds.includes(senderId);
}

function squadLabel(squad: ExternalSquad): string {
  return squad === 'main' ? 'Tiểu đội 2' : 'Tiểu đội culi';
}

/** Câu bot tự viết được gửi nguyên. Lỗi từ Google chỉ còn một câu cố định. */
function visibleError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const safe =
    message.includes('Editor') ||
    message.startsWith('Không có dòng') ||
    message.startsWith('Không tìm thấy') ||
    message.startsWith('Chưa cấu hình') ||
    message.startsWith('Không ghi được Google Sheet');
  if (safe) return message;
  console.error('[ExternalDuty]', message);
  return fallback;
}

async function loadRows(
  squad: ExternalSquad,
  options: DoiCommandOptions
): Promise<unknown[][]> {
  const provided = options.rowsBySquad?.[squad];
  if (provided) return provided;
  const scheduleKey = squad === 'main' ? 'main_duty' : 'culi_duty';
  const effective = getEffectiveScheduleConfig(scheduleKey);
  const spreadsheetId = process.env.GOOGLE_SHEET_ID || '';
  if (!spreadsheetId || !effective.effectiveTabName) {
    throw new Error('Chưa cấu hình Google Sheet cho lịch trực.');
  }
  return readSheetTab(spreadsheetId, effective.effectiveTabName);
}

async function readDutyRow(
  squad: ExternalSquad,
  date: string,
  options: DoiCommandOptions
): Promise<{ rowIndex: number; columns: ShiftColumn[]; tabName: string }> {
  const scheduleKey = squad === 'main' ? 'main_duty' : 'culi_duty';
  const effective = getEffectiveScheduleConfig(scheduleKey);
  const tabName = effective.effectiveTabName || '';
  if (!tabName) throw new Error('Chưa cấu hình Google Sheet để ghi tên.');
  const rows = await loadRows(squad, options);
  const headerStyle = effective.squad?.header_style || 'two_row_merged';
  const read = readShiftColumns(rows, headerStyle, date);
  if (!read.found || read.rowIndex === undefined) {
    throw new Error(`Không có dòng ngày ${date} trên lịch ${squadLabel(squad)}.`);
  }
  return { rowIndex: read.rowIndex, columns: read.columns, tabName };
}

async function locatePendingCell(
  item: PendingChange,
  options: DoiCommandOptions
): Promise<{ ok: true; tabName: string; rowIndex: number; colIndex: number } | { ok: false; message: string }> {
  let read: { rowIndex: number; columns: ShiftColumn[]; tabName: string };
  try {
    read = await readDutyRow(item.squad, item.date, options);
  } catch (err: unknown) {
    return { ok: false, message: visibleError(err, `Không đọc được sheet ${squadLabel(item.squad)}.`) };
  }
  const column = read.columns.find((col) => col.name === item.shiftKey);
  if (!column) {
    return { ok: false, message: `Không còn thấy cột ${item.shiftLabel} ngày ${item.date}. Chưa ghi.` };
  }
  if (column.raw !== item.previous) {
    const current = column.raw || 'ô trống';
    return {
      ok: false,
      message: `Ca ${item.caNumber} ${item.alias} trên sheet hiện là "${current}". Chưa ghi đè. Gửi lại lệnh nếu vẫn muốn đổi.`,
    };
  }
  return { ok: true, tabName: read.tabName, rowIndex: read.rowIndex, colIndex: column.colIndex };
}

export async function handleDoiCommand(
  payload: DoiCommandPayload,
  options: DoiCommandOptions = {}
): Promise<DoiCommandResult> {
  const text = (payload.text || '').trim();
  const config = getExternalDutyConfig(options.database);
  const confirm = parseConfirmWord(text);
  const parsed = confirm ? null : parseDoiMessage(text, config, getPatrolMembers(options.database));
  if (!confirm && parsed && !parsed.ok && parsed.notCommand) {
    return { handled: false, success: false };
  }
  if (!confirm && !parsed) {
    return { handled: false, success: false };
  }
  if (!config.partnerLeaderUserId) {
    return { handled: true, success: false, ignoredReason: 'not_configured' };
  }

  const senderId = (payload.senderId || '').trim();
  const chatId = (payload.chatId || '').trim();
  if (!canEdit(senderId, config)) {
    return { handled: true, success: false, ignoredReason: 'unauthorized_sender' };
  }

  const partnerChatId = resolvePartnerChatId(options.database);
  const direct = Boolean(chatId && chatId === senderId);
  const partnerGroup = Boolean(partnerChatId && chatId === partnerChatId);
  if (!direct && !partnerGroup) {
    const reply = 'Lệnh doi chỉ nhận trong chat riêng với bot hoặc trong nhóm đối tác.';
    await replyTo(options.zaloClient, chatId, reply);
    return { handled: true, success: false, ignoredReason: 'unauthorized_group', reply };
  }

  if (text.length > MAX_COMMAND_LENGTH) {
    const reply = 'Lệnh quá dài.';
    await replyTo(options.zaloClient, chatId, reply);
    return { handled: true, success: false, reply };
  }

  const messageId = (payload.messageId || '').trim();
  if (messageId && findReportByMessageId(messageId, options.database)) {
    return { handled: true, success: true, ignoredReason: 'duplicate_message' };
  }

  const now = options.now || new Date();
  if (confirm) {
    return answerPendingChange(confirm, senderId, chatId, messageId, text, now, options);
  }
  if (!parsed || !parsed.ok) {
    const error = parsed && !parsed.ok ? parsed.error : 'Cú pháp không hợp lệ';
    await replyTo(options.zaloClient, chatId, `⚠️ ${error}`);
    return { handled: true, success: false, reply: error };
  }

  const lines: string[] = [];
  const touched = new Set<ExternalSquad>();
  const pending: PendingChange[] = [];
  let failed = false;

  for (const line of parsed.lines) {
    const date = dutyDateForSquad(line.squad, now);
    let columns;
    let rowIndex = -1;
    let tabName = '';
    try {
      const read = await readDutyRow(line.squad, date, options);
      columns = read.columns;
      rowIndex = read.rowIndex;
      tabName = read.tabName;
    } catch (err: unknown) {
      lines.push(visibleError(err, `Không đọc được sheet ${squadLabel(line.squad)}.`));
      failed = true;
      continue;
    }

    const matched = matchShiftColumn(columns, line.shiftQuery);
    if (!matched.ok) {
      const headers = columnHeaders(columns).map((name) => `- ${name}`).join('\n');
      lines.push(
        matched.reason === 'many'
          ? `Ca "${line.shiftQuery}" khớp nhiều cột. Gửi đúng một tên cột:\n${headers}`
          : `Không thấy ca "${line.shiftQuery}". Các cột ngày ${date}:\n${headers}`
      );
      failed = true;
      continue;
    }

    const cellValue = line.cleared ? '' : line.names.join(', ');
    const spreadsheetId = (process.env.GOOGLE_SHEET_ID || '').trim();
    if (!spreadsheetId || !tabName) {
      lines.push('Chưa cấu hình Google Sheet để ghi tên.');
      failed = true;
      continue;
    }
    const replacingSomeone = !matched.column.empty && !isChoCell(matched.column.raw);
    if (replacingSomeone) {
      pending.push({
        squad: line.squad,
        date,
        shiftKey: matched.column.name,
        shiftLabel: matched.column.name,
        caNumber: matched.column.caNumber || 0,
        alias: line.squad === 'main' ? config.aliasMain : config.aliasCuli,
        names: line.names,
        cleared: line.cleared,
        previous: matched.column.raw,
        rowIndex,
        colIndex: matched.column.colIndex,
        tabName,
      });
      continue;
    }
    try {
      await updateSheetCell(spreadsheetId, tabName, rowIndex, matched.column.colIndex, cellValue);
    } catch (err: unknown) {
      lines.push(visibleError(err, 'Không ghi được Google Sheet. Thử lại sau.'));
      failed = true;
      continue;
    }

    saveExternalDutyReport(
      {
        date,
        squad: line.squad,
        shiftKey: matched.column.name,
        shiftLabel: matched.column.name,
        names: line.names,
        cleared: line.cleared,
        rawMessage: text,
        messageId,
        senderId,
      },
      options.database
    );
    touched.add(line.squad);
    const shown = line.cleared ? 'ô trống' : cellValue;
    const squadName = squadLabel(line.squad);
    const sendAt = sendTimeForSquad(line.squad);
    const dueNow = minutesOf(getVietnamTimeParts(now).timeHM) >= minutesOf(sendAt);
    lines.push(
      `Đã xếp ${squadName}, ngày ${date}, ${matched.column.name}: ${shown}. Đã ghi vào Google Sheet.${dueNow ? '' : ` Sẽ gửi lúc ${sendAt}.`}`
    );
  }

  if (pending.length > 0) {
    savePendingChanges(senderId, chatId, pending, options.database);
    for (const item of pending) {
      const next = item.cleared ? 'ô trống' : item.names.join(', ');
      lines.push(`Bạn đổi ca ${item.caNumber} ${item.alias} từ ${item.previous} sang ${next} phải không`);
    }
    lines.push('Trả lời đúng hoặc không.');
  } else {
    clearPendingChanges(senderId, chatId, options.database);
  }

  const sentScheduleKeys = await sendTouchedSquads(touched, now, lines, options);
  const reply = lines.join('\n');
  if (reply) await replyTo(options.zaloClient, chatId, reply);
  return {
    handled: true,
    success: !failed && (touched.size > 0 || pending.length > 0),
    reply,
    sentScheduleKeys,
  };
}

async function answerPendingChange(
  answer: 'yes' | 'no',
  senderId: string,
  chatId: string,
  messageId: string,
  text: string,
  now: Date,
  options: DoiCommandOptions
): Promise<DoiCommandResult> {
  const pending = getPendingChanges(senderId, chatId, options.database);
  if (pending.length === 0) {
    return { handled: false, success: false };
  }
  if (answer === 'no') {
    clearPendingChanges(senderId, chatId, options.database);
    const reply = 'Đã giữ nguyên, không đổi ca.';
    await replyTo(options.zaloClient, chatId, reply);
    return { handled: true, success: true, reply, sentScheduleKeys: [] };
  }

  const lines: string[] = [];
  const touched = new Set<ExternalSquad>();
  const failedItems: PendingChange[] = [];
  let failed = false;
  const spreadsheetId = (process.env.GOOGLE_SHEET_ID || '').trim();
  for (const item of pending) {
    const cellValue = item.cleared ? '' : item.names.join(', ');
    if (!spreadsheetId) {
      lines.push('Chưa cấu hình Google Sheet để ghi tên.');
      failedItems.push(item);
      failed = true;
      continue;
    }
    const located = await locatePendingCell(item, options);
    if (!located.ok) {
      lines.push(located.message);
      failedItems.push(item);
      failed = true;
      continue;
    }
    try {
      await updateSheetCell(spreadsheetId, located.tabName, located.rowIndex, located.colIndex, cellValue);
    } catch (err: unknown) {
      lines.push(visibleError(err, 'Không ghi được Google Sheet. Thử lại sau.'));
      failedItems.push(item);
      failed = true;
      continue;
    }
    saveExternalDutyReport(
      {
        date: item.date,
        squad: item.squad,
        shiftKey: item.shiftKey,
        shiftLabel: item.shiftLabel,
        names: item.names,
        cleared: item.cleared,
        rawMessage: text,
        messageId,
        senderId,
      },
      options.database
    );
    touched.add(item.squad);
    lines.push(`Đã đổi ca ${item.caNumber} ${item.alias} từ ${item.previous} sang ${cellValue || 'ô trống'}. Đã ghi vào Google Sheet.`);
  }
  if (failedItems.length > 0) savePendingChanges(senderId, chatId, failedItems, options.database);
  else clearPendingChanges(senderId, chatId, options.database);
  const sentScheduleKeys = await sendTouchedSquads(touched, now, lines, options);
  const reply = lines.join('\n');
  if (reply) await replyTo(options.zaloClient, chatId, reply);
  return { handled: true, success: !failed, reply, sentScheduleKeys };
}

async function sendTouchedSquads(
  touched: Set<ExternalSquad>,
  now: Date,
  lines: string[],
  options: DoiCommandOptions
): Promise<string[]> {
  const sentScheduleKeys: string[] = [];
  if (options.skipSend || touched.size === 0) return sentScheduleKeys;
  const { sendSchedule } = await import('../core/sendSchedule');
  const { hasSentToday } = await import('../store');
  for (const squad of touched) {
    const date = dutyDateForSquad(squad, now);
    const scheduleKey = squad === 'main' ? 'main_duty' : 'culi_duty';
    const due = minutesOf(getVietnamTimeParts(now).timeHM) >= minutesOf(sendTimeForSquad(squad));
    const primaryKey = squad === 'main' ? 'squad_main' : 'squad_culi';
    const primaryChat = getRecipientChatId(primaryKey);
    const already = primaryChat ? hasSentToday(scheduleKey, primaryChat, date, options.database) : false;
    if (!due && !already) continue;
    const result = await sendSchedule(scheduleKey, {
      targetDate: date,
      zaloClient: options.zaloClient,
      isAutomated: false,
    });
    if (result.held) {
      lines.push(result.holdReason || 'Lịch vẫn đang chờ đủ người.');
    } else if (result.results.some((item) => item.success && !item.skippedDueToIdempotency)) {
      sentScheduleKeys.push(scheduleKey);
      lines.push(`Đã gửi lại lịch ngày ${date}.`);
    }
  }
  return sentScheduleKeys;
}

async function replyTo(zalo: ZaloClient | undefined, chatId: string, text: string): Promise<void> {
  if (!chatId || !text) return;
  const client = zalo || new ZaloClient();
  try {
    await client.sendMessage(chatId, text);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ExternalDuty] Không gửi được phản hồi:', message);
  }
}

export interface PartnerNotice {
  text: string;
  styles: ZaloTextStyle[];
  previewHtml: string;
  gateDate: string;
  culiDate: string;
  gateMissing: boolean;
  culiMissing: boolean;
  culiUnreadable: boolean;
}

const ALERT_HIGHLIGHT: string[] = ['b', 'c_db342e'];

function choPrompt(
  squad: ExternalSquad,
  columnName: string,
  caNumber: number | null,
  alias: string
): { line: string; ranges: Array<{ start: number; len: number }> } {
  const unit = squad === 'main' ? 'tiểu đội 2' : 'tiểu đội culi';
  const caWord = caNumber ? `ca${caNumber}` : 'ca';
  const command = `${alias} ${caWord} <tên người trực>`;
  const segments = [
    { text: columnName, highlight: true },
    { text: ' ở ', highlight: false },
    { text: unit, highlight: true },
    { text: ' đang chưa có người trực, bạn hãy xếp người trực bằng câu lệnh: ', highlight: false },
    { text: command, highlight: true },
  ];
  let line = '';
  const ranges: Array<{ start: number; len: number }> = [];
  for (const segment of segments) {
    if (segment.highlight && segment.text.length > 0) {
      ranges.push({ start: line.length, len: segment.text.length });
    }
    line += segment.text;
  }
  return { line, ranges };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderAlertPreview(text: string, styles: ZaloTextStyle[]): string {
  if (styles.length === 0) return escapeHtml(text).replace(/\n/g, '<br>');
  const marks = [...styles].sort((a, b) => a.start - b.start);
  let html = '';
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor || mark.len <= 0) continue;
    html += escapeHtml(text.slice(cursor, mark.start));
    html += `<strong style="color:#db342e">${escapeHtml(text.slice(mark.start, mark.start + mark.len))}</strong>`;
    cursor = mark.start + mark.len;
  }
  html += escapeHtml(text.slice(cursor));
  return html.replace(/\n/g, '<br>');
}

export async function buildPartnerNotice(
  now: Date = new Date(),
  options: { database?: Database.Database; rowsBySquad?: Partial<Record<ExternalSquad, unknown[][]>> } = {}
): Promise<PartnerNotice> {
  const config = getExternalDutyConfig(options.database);
  const gateDate = dutyDateForSquad('main', now);
  const culiDate = dutyDateForSquad('culi', now);
  const parts: Array<{ line: string; ranges: Array<{ start: number; len: number }> }> = [];
  let gateMissing = false;
  let culiMissing = false;
  let culiUnreadable = false;

  for (const squad of ['main', 'culi'] as const) {
    const date = squad === 'main' ? gateDate : culiDate;
    const alias = squad === 'main' ? config.aliasMain : config.aliasCuli;
    try {
      const rows = options.rowsBySquad?.[squad] || (await loadRows(squad, options));
      const scheduleKey = squad === 'main' ? 'main_duty' : 'culi_duty';
      const style = getEffectiveScheduleConfig(scheduleKey).squad?.header_style || (squad === 'main' ? 'two_row_merged' : 'single_row');
      const read = readShiftColumns(rows, style, date);
      const reports = listExternalDutyReports(date, squad, options.database);
      const waiting = findChoColumns(read.columns).filter(
        (col) => !reports.some((report) => report.shiftKey === col.name && !report.cleared && report.names.length > 0)
      );
      if (squad === 'main') gateMissing = waiting.length > 0;
      else culiMissing = waiting.length > 0;
      for (const col of waiting) {
        parts.push(choPrompt(squad, col.name, col.caNumber, alias));
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[ExternalDuty] Không đọc được lịch ${squadLabel(squad)}:`, detail);
      const unit = squad === 'main' ? 'tiểu đội 2' : 'tiểu đội culi';
      parts.push({ line: `Không đọc được lịch ${unit}.`, ranges: [] });
      if (squad === 'culi') culiUnreadable = true;
      if (squad === 'main') gateMissing = true;
      else culiMissing = true;
    }
  }

  let text = '';
  const styles: ZaloTextStyle[] = [];
  for (const part of parts) {
    const base = text.length === 0 ? 0 : text.length + 1;
    text = text.length === 0 ? part.line : `${text}\n${part.line}`;
    for (const range of part.ranges) {
      styles.push({ start: base + range.start, len: range.len, st: ALERT_HIGHLIGHT });
    }
  }
  if (!text) text = 'Đã xếp đủ các ca đang chờ.';

  return {
    text,
    styles,
    previewHtml: renderAlertPreview(text, styles),
    gateDate,
    culiDate,
    gateMissing,
    culiMissing,
    culiUnreadable,
  };
}
