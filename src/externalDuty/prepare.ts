/**
 * Đọc lịch đã ghi trên sheet. Ca còn chữ "Chờ" thì chưa gửi.
 */

import { DailyDuty, DutyTask, HeaderStyle } from '../types';
import { formatDateDMY, getVietnamTimeParts, parseDMYToDate } from '../sheets/dateUtils';
import { findChoColumns, isChoCell, readShiftColumns } from './columns';
import { listExternalDutyReports } from './repository';
import { ExternalDutyReport, ExternalSquad, ShiftColumn } from './types';
import Database from 'better-sqlite3';

export const MAIN_SEND_TIME = '20:00';
export const CULI_SEND_TIME = '19:30';

export function addDaysDMY(dmy: string, days: number): string {
  const parsed = parseDMYToDate(dmy);
  if (!parsed) return dmy;
  parsed.setDate(parsed.getDate() + days);
  return formatDateDMY(parsed);
}

/** Ngày trên sheet mà lệnh `doi` của tiểu đội này đang nhắm tới. */
export function dutyDateForSquad(squad: ExternalSquad, now: Date = new Date()): string {
  const today = getVietnamTimeParts(now).dateDMY;
  if (squad === 'main') return addDaysDMY(today, 1);
  return today;
}

export function minutesOf(timeHM: string): number {
  const [h, m] = timeHM.split(':').map(Number);
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

export function sendTimeForSquad(squad: ExternalSquad): string {
  return squad === 'main' ? MAIN_SEND_TIME : CULI_SEND_TIME;
}

function caFromLabel(label: string): number | null {
  const match = label.match(/^ca\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

/** Ca 3 (một hoặc nhiều tên, hoặc 0) hoặc đúng một tên ở Ca 2. Ca 2 hai người không tính. */
export function isGateSatisfied(reports: ExternalDutyReport[]): boolean {
  const ca3 = reports.find((report) => caFromLabel(report.shiftLabel) === 3);
  if (ca3 && (ca3.cleared || ca3.names.length >= 1)) return true;
  const ca2 = reports.find((report) => caFromLabel(report.shiftLabel) === 2);
  return Boolean(ca2 && !ca2.cleared && ca2.names.length === 1);
}

export interface PreparedDuty {
  duty: DailyDuty | null;
  held: boolean;
  holdReason: string;
  includePartner: boolean;
  partnerMissing: boolean;
  openCuli: ShiftColumn | null;
  openCuliCount: number;
}

export function prepareDutyFromRows(input: {
  squad: ExternalSquad;
  headerStyle: HeaderStyle;
  rows: unknown[][];
  lookupDate: string;
  reports: ExternalDutyReport[];
  partnerChatId: string;
  isOvernight: boolean;
}): PreparedDuty {
  let columns: ShiftColumn[] = [];
  let unit: string | undefined;
  let found = false;
  try {
    const read = readShiftColumns(input.rows, input.headerStyle, input.lookupDate);
    columns = read.columns;
    unit = read.unit;
    found = read.found;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      duty: null,
      held: true,
      holdReason: `Không đọc được lịch ngày ${input.lookupDate}: ${message}`,
      includePartner: false,
      partnerMissing: false,
      openCuli: null,
      openCuliCount: 0,
    };
  }

  if (!found) {
    return {
      duty: null,
      held: true,
      holdReason: `Không có dữ liệu lịch trực cổng cho ngày ${input.lookupDate}`,
      includePartner: false,
      partnerMissing: false,
      openCuli: null,
      openCuliCount: 0,
    };
  }

  const tasks = mergeTasks(columns, input.reports);
  const duty: DailyDuty = {
    date: input.lookupDate,
    unit,
    isOvernight: input.isOvernight,
    tasks,
  };
  const waiting = findChoColumns(columns).filter((col) => !reportFills(input.reports, col.name));
  const squadName = input.squad === 'main' ? 'Tiểu đội 2' : 'Tiểu đội culi';
  const shared = input.reports.some((report) => !report.cleared && report.names.length > 0);

  if (waiting.length > 0) {
    const labels = waiting.map((col) => col.name).join(', ');
    return {
      duty,
      held: true,
      holdReason: `Còn ca chưa xếp (${labels}) ngày ${input.lookupDate} ở ${squadName}. Lịch chưa được gửi.`,
      includePartner: false,
      partnerMissing: false,
      openCuli: waiting[0] || null,
      openCuliCount: waiting.length,
    };
  }
  if (shared && !input.partnerChatId) {
    return {
      duty,
      held: true,
      holdReason: 'Chưa cấu hình Chat ID nhóm đối tác. Không gửi lịch cho cả hai nhóm.',
      includePartner: true,
      partnerMissing: true,
      openCuli: null,
      openCuliCount: 0,
    };
  }
  return {
    duty,
    held: false,
    holdReason: '',
    includePartner: shared,
    partnerMissing: false,
    openCuli: null,
    openCuliCount: 0,
  };
}

function reportFills(reports: ExternalDutyReport[], shiftKey: string): boolean {
  return reports.some((report) => report.shiftKey === shiftKey && !report.cleared && report.names.length > 0);
}

function mergeTasks(columns: ShiftColumn[], reports: ExternalDutyReport[]): DutyTask[] {
  const tasks: DutyTask[] = [];
  for (const col of columns) {
    const report = reports.find((item) => item.shiftKey === col.name);
    if (report && !report.cleared && report.names.length > 0) {
      tasks.push({
        taskName: col.name,
        assignee: report.names.join(', '),
        parentTask: col.parentName,
        subTask: col.subName,
      });
      continue;
    }
    if (!col.empty && !isChoCell(col.raw)) {
      tasks.push({
        taskName: col.name,
        assignee: col.raw,
        parentTask: col.parentName,
        subTask: col.subName,
      });
    }
  }
  return tasks;
}

export function loadReports(
  date: string,
  squad: ExternalSquad,
  database?: Database.Database
): ExternalDutyReport[] {
  return listExternalDutyReports(date, squad, database);
}

export function previousAssignee(column: ShiftColumn): string {
  return column.empty ? '(trống)' : column.raw;
}
