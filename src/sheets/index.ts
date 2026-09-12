/**
 * sheets/index.ts
 *
 * Tầng giao tiếp dữ liệu Google Sheets (Sheet Reader Layer).
 * Tách biệt hoàn toàn khỏi Formatter và Zalo Client theo kiến trúc Mục 4.
 */

import { DailyDuty, HeaderStyle, LeaveEntry, LeaveRoster } from '../types';
import { readSheetTab } from './sheetsClient';
import { parseGateDutyTwoRow } from './gateDutyTwoRowParser';
import { parseGateDutySingleRow } from './gateDutySingleRowParser';
import { parseLeaveRoster, resolveTargetLeaveEntry } from './leaveRosterParser';

export * from './dateUtils';
export * from './gateDutyTwoRowParser';
export * from './gateDutySingleRowParser';
export * from './leaveRosterParser';
export * from './leaveStats';
export * from './sheetsClient';

/**
 * Đọc và phân tích lịch trực cổng theo tab và kiểu header.
 */
export async function fetchDutySchedule(
  spreadsheetId: string,
  tabName: string,
  headerStyle: HeaderStyle,
  targetDate: string
): Promise<DailyDuty | null> {
  const rows = await readSheetTab(spreadsheetId, tabName);

  if (headerStyle === 'two_row_merged') {
    return parseGateDutyTwoRow(rows, targetDate);
  } else if (headerStyle === 'single_row') {
    return parseGateDutySingleRow(rows, targetDate);
  } else {
    throw new Error(`Kiểu header không được hỗ trợ: ${headerStyle}`);
  }
}

/**
 * Đọc và phân tích lịch tranh thủ.
 */
export async function fetchLeaveRoster(
  spreadsheetId: string,
  tabName: string,
  targetDateOrRef?: string | Date
): Promise<{ unit?: string; entry: LeaveEntry | null; fullRoster: LeaveRoster }> {
  const rows = await readSheetTab(spreadsheetId, tabName);
  const fullRoster = parseLeaveRoster(rows);
  const entry = resolveTargetLeaveEntry(fullRoster.entries, targetDateOrRef);

  return {
    unit: fullRoster.unit,
    entry,
    fullRoster,
  };
}
