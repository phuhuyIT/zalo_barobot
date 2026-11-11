/**
 * Lưu cấu hình tiểu đội đối tác và từng dòng `doi` (ngày, tiểu đội, cột ca).
 * Không dùng bảng tuần tra.
 */

import Database from 'better-sqlite3';
import { getRecipientChatId } from '../config';
import { getDatabase, getRecipient, safeJsonParse } from '../store';
import { ExternalDutyConfig, ExternalDutyReport, ExternalSquad } from './types';

const initializedDbs = new WeakSet<Database.Database>();

const DEFAULT_REMINDERS = ['17:00', '17:45'];
const MAX_ID_LENGTH = 80;
const MAX_EXTRA_EDITORS = 20;
const MAX_REMINDER_SLOTS = 10;
const ALIAS_PATTERN = /^[\p{L}\p{N}]{1,20}$/u;
const REMINDER_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ExternalDutyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalDutyConfigError';
  }
}

export function ensureExternalDutyTables(database: Database.Database): void {
  if (initializedDbs.has(database)) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS external_duty_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      partner_leader_user_id TEXT NOT NULL DEFAULT '',
      extra_editor_ids TEXT NOT NULL DEFAULT '[]',
      partner_chat_id TEXT NOT NULL DEFAULT '',
      alias_main TEXT NOT NULL DEFAULT 'a2',
      alias_culi TEXT NOT NULL DEFAULT 'culi',
      reminder_times TEXT NOT NULL DEFAULT '["17:00","17:45"]',
      max_reminders INTEGER NOT NULL DEFAULT 2,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_duty_reports (
      date TEXT NOT NULL,
      squad TEXT NOT NULL,
      shift_key TEXT NOT NULL,
      shift_label TEXT NOT NULL,
      names_json TEXT NOT NULL,
      cleared INTEGER NOT NULL DEFAULT 0,
      raw_message TEXT,
      message_id TEXT,
      sender_id TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (date, squad, shift_key)
    );

    CREATE TABLE IF NOT EXISTS external_duty_pending (
      sender_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      items_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (sender_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS external_duty_reminders (
      date TEXT NOT NULL,
      slot TEXT NOT NULL,
      reminder_count INTEGER NOT NULL DEFAULT 0,
      last_reminder_slot TEXT,
      admin_warned INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, slot)
    );
  `);
  initializedDbs.add(database);
}

export function getExternalDutyDb(database?: Database.Database): Database.Database {
  const db = database || getDatabase();
  ensureExternalDutyTables(db);
  return db;
}

function rowToConfig(row: {
  partner_leader_user_id: string;
  extra_editor_ids: string;
  partner_chat_id: string;
  alias_main: string;
  alias_culi: string;
  reminder_times: string;
  max_reminders: number;
} | undefined): ExternalDutyConfig {
  const reminders = safeJsonParse<string[]>(row?.reminder_times, DEFAULT_REMINDERS);
  const extra = safeJsonParse<string[]>(row?.extra_editor_ids, []);
  const envLeader = (process.env.PARTNER_LEADER_USER_ID || '').trim();
  const envChat = (process.env.SQUAD_PARTNER_CHAT_ID || '').trim();
  return {
    partnerLeaderUserId: (row?.partner_leader_user_id || '').trim() || envLeader,
    extraEditorIds: extra.map((id) => String(id).trim()).filter(Boolean),
    partnerChatId: (row?.partner_chat_id || '').trim() || envChat,
    aliasMain: (row?.alias_main || '').trim() || 'a2',
    aliasCuli: (row?.alias_culi || '').trim() || 'culi',
    reminderTimes: reminders.length > 0 ? reminders : DEFAULT_REMINDERS,
    maxReminders: row?.max_reminders || 2,
  };
}

export function getExternalDutyConfig(database?: Database.Database): ExternalDutyConfig {
  const db = getExternalDutyDb(database);
  const row = db.prepare(`SELECT * FROM external_duty_config WHERE id = 1`).get() as
    | {
        partner_leader_user_id: string;
        extra_editor_ids: string;
        partner_chat_id: string;
        alias_main: string;
        alias_culi: string;
        reminder_times: string;
        max_reminders: number;
      }
    | undefined;
  return rowToConfig(row);
}

export function isExternalDutyEnabled(database?: Database.Database): boolean {
  return Boolean(getExternalDutyConfig(database).partnerLeaderUserId);
}

export function resolvePartnerChatId(database?: Database.Database): string {
  const config = getExternalDutyConfig(database);
  if (config.partnerChatId) return config.partnerChatId;
  try {
    const stored = getRecipient('squad_partner', database);
    if (stored?.chat_id) return stored.chat_id;
  } catch {
    // DB chưa sẵn
  }
  try {
    const fromYaml = getRecipientChatId('squad_partner');
    if (fromYaml && fromYaml !== 'squad_partner') return fromYaml;
  } catch {
    // Config chưa nạp
  }
  return '';
}

function storedConfigRow(database: Database.Database): {
  partner_leader_user_id: string;
  extra_editor_ids: string;
  partner_chat_id: string;
  alias_main: string;
  alias_culi: string;
  reminder_times: string;
  max_reminders: number;
} | undefined {
  return database.prepare(`SELECT * FROM external_duty_config WHERE id = 1`).get() as
    | {
        partner_leader_user_id: string;
        extra_editor_ids: string;
        partner_chat_id: string;
        alias_main: string;
        alias_culi: string;
        reminder_times: string;
        max_reminders: number;
      }
    | undefined;
}

export function saveExternalDutyConfig(
  input: Partial<ExternalDutyConfig>,
  database?: Database.Database
): ExternalDutyConfig {
  const db = getExternalDutyDb(database);
  const row = storedConfigRow(db);
  const leader =
    input.partnerLeaderUserId !== undefined
      ? input.partnerLeaderUserId.trim()
      : row?.partner_leader_user_id || '';
  const chat =
    input.partnerChatId !== undefined ? input.partnerChatId.trim() : row?.partner_chat_id || '';
  const extra =
    input.extraEditorIds !== undefined
      ? input.extraEditorIds.map((id) => id.trim()).filter(Boolean)
      : safeJsonParse<string[]>(row?.extra_editor_ids, []);
  const aliasMain = (input.aliasMain !== undefined ? input.aliasMain : row?.alias_main || 'a2').trim();
  const aliasCuli = (input.aliasCuli !== undefined ? input.aliasCuli : row?.alias_culi || 'culi').trim();
  const reminders =
    input.reminderTimes !== undefined
      ? input.reminderTimes
      : safeJsonParse<string[]>(row?.reminder_times, DEFAULT_REMINDERS);
  const maxReminders = input.maxReminders !== undefined ? input.maxReminders : row?.max_reminders || 2;
  assertExternalDutyConfig({ leader, chat, extra, aliasMain, aliasCuli, reminders, maxReminders });

  db.prepare(
    `INSERT INTO external_duty_config (
       id, partner_leader_user_id, extra_editor_ids, partner_chat_id,
       alias_main, alias_culi, reminder_times, max_reminders, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       partner_leader_user_id = excluded.partner_leader_user_id,
       extra_editor_ids = excluded.extra_editor_ids,
       partner_chat_id = excluded.partner_chat_id,
       alias_main = excluded.alias_main,
       alias_culi = excluded.alias_culi,
       reminder_times = excluded.reminder_times,
       max_reminders = excluded.max_reminders,
       updated_at = excluded.updated_at`
  ).run(
    leader,
    JSON.stringify(extra),
    chat,
    aliasMain,
    aliasCuli,
    JSON.stringify(reminders),
    maxReminders,
    new Date().toISOString()
  );
  return getExternalDutyConfig(db);
}

function assertExternalDutyConfig(input: {
  leader: string;
  chat: string;
  extra: string[];
  aliasMain: string;
  aliasCuli: string;
  reminders: string[];
  maxReminders: number;
}): void {
  if (input.leader.length > MAX_ID_LENGTH || input.chat.length > MAX_ID_LENGTH) {
    throw new ExternalDutyConfigError('User ID hoặc Chat ID quá dài.');
  }
  if (input.extra.length > MAX_EXTRA_EDITORS || input.extra.some((id) => id.length > MAX_ID_LENGTH)) {
    throw new ExternalDutyConfigError('Danh sách user được đổi ca quá dài.');
  }
  if (!ALIAS_PATTERN.test(input.aliasMain) || !ALIAS_PATTERN.test(input.aliasCuli)) {
    throw new ExternalDutyConfigError('Alias chỉ gồm chữ và số, tối đa 20 ký tự, không có dấu cách.');
  }
  if (input.aliasMain.toLowerCase() === input.aliasCuli.toLowerCase()) {
    throw new ExternalDutyConfigError('Hai alias phải khác nhau.');
  }
  if (
    input.reminders.length === 0 ||
    input.reminders.length > MAX_REMINDER_SLOTS ||
    input.reminders.some((time) => !REMINDER_TIME_PATTERN.test(time))
  ) {
    throw new ExternalDutyConfigError('Giờ nhắc phải là HH:MM, ví dụ 17:00.');
  }
  if (!Number.isInteger(input.maxReminders) || input.maxReminders < 1 || input.maxReminders > MAX_REMINDER_SLOTS) {
    throw new ExternalDutyConfigError('Số lần nhắc tối đa từ 1 đến 10.');
  }
}

function mapReport(row: {
  date: string;
  squad: string;
  shift_key: string;
  shift_label: string;
  names_json: string;
  cleared: number;
  raw_message: string | null;
  message_id: string | null;
  sender_id: string;
  submitted_at: string;
}): ExternalDutyReport {
  return {
    date: row.date,
    squad: row.squad === 'culi' ? 'culi' : 'main',
    shiftKey: row.shift_key,
    shiftLabel: row.shift_label,
    names: safeJsonParse<string[]>(row.names_json, []),
    cleared: row.cleared === 1,
    rawMessage: row.raw_message || '',
    messageId: row.message_id || '',
    senderId: row.sender_id,
    submittedAt: row.submitted_at,
  };
}

export function listExternalDutyReports(
  date: string,
  squad: ExternalSquad,
  database?: Database.Database
): ExternalDutyReport[] {
  const db = getExternalDutyDb(database);
  const rows = db
    .prepare(
      `SELECT * FROM external_duty_reports WHERE date = ? AND squad = ? ORDER BY shift_key`
    )
    .all(date, squad) as Parameters<typeof mapReport>[0][];
  return rows.map(mapReport);
}

export function findReportByMessageId(
  messageId: string,
  database?: Database.Database
): ExternalDutyReport | null {
  if (!messageId) return null;
  const db = getExternalDutyDb(database);
  const row = db
    .prepare(`SELECT * FROM external_duty_reports WHERE message_id = ? LIMIT 1`)
    .get(messageId) as Parameters<typeof mapReport>[0] | undefined;
  return row ? mapReport(row) : null;
}

export function saveExternalDutyReport(
  report: Omit<ExternalDutyReport, 'submittedAt'> & { submittedAt?: string },
  database?: Database.Database
): void {
  const db = getExternalDutyDb(database);
  db.prepare(
    `INSERT INTO external_duty_reports (
       date, squad, shift_key, shift_label, names_json, cleared,
       raw_message, message_id, sender_id, submitted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, squad, shift_key) DO UPDATE SET
       shift_label = excluded.shift_label,
       names_json = excluded.names_json,
       cleared = excluded.cleared,
       raw_message = excluded.raw_message,
       message_id = excluded.message_id,
       sender_id = excluded.sender_id,
       submitted_at = excluded.submitted_at`
  ).run(
    report.date,
    report.squad,
    report.shiftKey,
    report.shiftLabel,
    JSON.stringify(report.names),
    report.cleared ? 1 : 0,
    report.rawMessage,
    report.messageId,
    report.senderId,
    report.submittedAt || new Date().toISOString()
  );
}

export interface ReminderMark {
  date: string;
  slot: 'gate' | 'culi';
  reminderCount: number;
  lastReminderSlot: string;
  adminWarned: boolean;
}

export function getReminderMark(
  date: string,
  slot: 'gate' | 'culi',
  database?: Database.Database
): ReminderMark {
  const db = getExternalDutyDb(database);
  const row = db
    .prepare(`SELECT * FROM external_duty_reminders WHERE date = ? AND slot = ?`)
    .get(date, slot) as
    | {
        date: string;
        slot: string;
        reminder_count: number;
        last_reminder_slot: string | null;
        admin_warned: number;
      }
    | undefined;
  return {
    date,
    slot,
    reminderCount: row?.reminder_count || 0,
    lastReminderSlot: row?.last_reminder_slot || '',
    adminWarned: row?.admin_warned === 1,
  };
}

export interface PendingChange {
  squad: ExternalSquad;
  date: string;
  shiftKey: string;
  shiftLabel: string;
  caNumber: number;
  alias: string;
  names: string[];
  cleared: boolean;
  previous: string;
  rowIndex: number;
  colIndex: number;
  tabName: string;
}

export function getPendingChanges(
  senderId: string,
  chatId: string,
  database?: Database.Database
): PendingChange[] {
  const db = getExternalDutyDb(database);
  const row = db
    .prepare(`SELECT items_json FROM external_duty_pending WHERE sender_id = ? AND chat_id = ?`)
    .get(senderId, chatId) as { items_json: string } | undefined;
  return safeJsonParse<PendingChange[]>(row?.items_json, []);
}

export function savePendingChanges(
  senderId: string,
  chatId: string,
  items: PendingChange[],
  database?: Database.Database
): void {
  const db = getExternalDutyDb(database);
  db.prepare(
    `INSERT INTO external_duty_pending (sender_id, chat_id, items_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sender_id, chat_id) DO UPDATE SET
       items_json = excluded.items_json,
       created_at = excluded.created_at`
  ).run(senderId, chatId, JSON.stringify(items), new Date().toISOString());
}

export function clearPendingChanges(
  senderId: string,
  chatId: string,
  database?: Database.Database
): void {
  const db = getExternalDutyDb(database);
  db.prepare(`DELETE FROM external_duty_pending WHERE sender_id = ? AND chat_id = ?`).run(senderId, chatId);
}

export function saveReminderMark(mark: ReminderMark, database?: Database.Database): void {
  const db = getExternalDutyDb(database);
  db.prepare(
    `INSERT INTO external_duty_reminders (date, slot, reminder_count, last_reminder_slot, admin_warned)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date, slot) DO UPDATE SET
       reminder_count = excluded.reminder_count,
       last_reminder_slot = excluded.last_reminder_slot,
       admin_warned = excluded.admin_warned`
  ).run(mark.date, mark.slot, mark.reminderCount, mark.lastReminderSlot, mark.adminWarned ? 1 : 0);
}
