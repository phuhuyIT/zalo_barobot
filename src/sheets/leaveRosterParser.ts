/**
 * leaveRosterParser.ts
 *
 * Bộ parser cho lịch tranh thủ (leave roster).
 * Quy tắc nghiệp vụ (Mục 2.2 & Làm rõ của Admin):
 * - Tìm hàng tiêu đề có ô chứa "Ngày".
 * - Đọc các hàng dữ liệu cho đến khi gặp hàng hoàn toàn rỗng.
 * - Phân loại danh sách người đi tranh thủ (onLeave) và người mất lượt (missedTurn).
 * - Bỏ qua các ô rỗng hoặc placeholder ('-', 'N/A').
 * - Hàm resolveTargetLeaveEntry: chọn hàng tương ứng với tuần/cuối tuần hiện tại hoặc sắp tới.
 */

import { LeaveEntry, LeaveRoster } from '../types';
import { isPlaceholderOrEmpty, normalizeDate, parseDMYToDate } from './dateUtils';

export function parseLeaveRoster(rows: any[][]): LeaveRoster {
  let headerRowIndex = -1;
  let dateColIndex = -1;

  // 1. Quét tìm hàng chứa ô "Ngày"
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const val = String(row[c] || '').trim().toLowerCase();
      if (val === 'ngày') {
        headerRowIndex = r;
        dateColIndex = c;
        break;
      }
    }
    if (headerRowIndex !== -1) break;
  }

  if (headerRowIndex === -1 || dateColIndex === -1) {
    throw new Error("Không tìm thấy ô mốc 'Ngày' trong bảng tính Lịch tranh thủ.");
  }

  const headerRow = rows[headerRowIndex] || [];

  // 2. Tìm dòng Đơn vị: ở các hàng phía trên headerRow (nếu có)
  let unit: string | undefined = undefined;
  for (let r = 0; r < headerRowIndex; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const val = String(row[c] || '').trim();
      if (val.toLowerCase().startsWith('đơn vị:')) {
        unit = val;
        break;
      }
    }
    if (unit) break;
  }

  // 3. Thu thập danh sách cột sau cột "Ngày"
  const colHeaders: { index: number; name: string }[] = [];
  let lastHeader = '';
  for (let c = dateColIndex + 1; c < headerRow.length; c++) {
    const h = String(headerRow[c] || '').trim();
    if (h !== '') {
      lastHeader = h;
      colHeaders.push({ index: c, name: h });
    } else if (lastHeader !== '') {
      // Ô tiêu đề bị merge ngang trên Google Sheets
      colHeaders.push({ index: c, name: lastHeader });
    }
  }

  // 4. Đọc các hàng dữ liệu (bỏ qua hàng hoàn toàn rỗng hoặc không có ngày)
  const entries: LeaveEntry[] = [];
  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const isRowEmpty = row.every((cell) => String(cell || '').trim() === '');
    if (isRowEmpty) {
      continue;
    }

    const dateVal = row[dateColIndex];
    const normalizedDate = normalizeDate(dateVal);
    if (!normalizedDate) continue;

    const onLeave: string[] = [];
    const missedTurn: string[] = [];
    const rawColumns: Record<string, string> = {};

    for (const col of colHeaders) {
      const cellVal = row[col.index];
      if (!isPlaceholderOrEmpty(cellVal)) {
        // Hỗ trợ trường hợp ô chứa nhiều tên (ngăn cách bởi dấu phẩy, chấm phẩy hoặc xuống dòng)
        const names = String(cellVal)
          .split(/[\n,;]+/)
          .map((n) => n.trim())
          .filter((n) => n && !isPlaceholderOrEmpty(n));

        const headerLower = col.name.toLowerCase();
        const isMissed =
          headerLower.includes('mất lượt') ||
          headerLower.includes('mat luot') ||
          headerLower.includes('bù gác') ||
          headerLower.includes('bu gac');

        for (const name of names) {
          rawColumns[col.name] = name;
          if (isMissed) {
            missedTurn.push(name);
          } else {
            onLeave.push(name);
          }
        }
      }
    }

    entries.push({
      date: normalizedDate,
      onLeave,
      missedTurn,
      rawColumns,
    });
  }

  return {
    unit,
    entries,
  };
}

/**
 * Chọn hàng lịch tranh thủ tương ứng với ngày mục tiêu hoặc tuần hiện tại/sắp tới.
 * Theo yêu cầu làm rõ #4 của Admin:
 * "gửi hàng tương ứng với tuần/cuối tuần hiện tại hoặc sắp tới".
 */
export function resolveTargetLeaveEntry(
  entries: LeaveEntry[],
  targetDateOrRef?: string | Date
): LeaveEntry | null {
  if (entries.length === 0) return null;

  if (typeof targetDateOrRef === 'string') {
    const normalized = normalizeDate(targetDateOrRef);
    if (normalized) {
      const exactMatch = entries.find((e) => e.date === normalized);
      if (exactMatch) return exactMatch;
    }
  }

  const refDate =
    targetDateOrRef instanceof Date
      ? targetDateOrRef
      : typeof targetDateOrRef === 'string'
      ? parseDMYToDate(targetDateOrRef) || new Date()
      : new Date();

  // Reset time về 00:00:00 để so sánh ngày
  const refTime = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate()).getTime();

  // 1. Tìm các hàng có ngày >= refTime (sắp tới hoặc hôm nay)
  const upcomingEntries = entries
    .map((e) => ({ entry: e, time: parseDMYToDate(e.date)?.getTime() || 0 }))
    .filter((item) => item.time >= refTime)
    .sort((a, b) => a.time - b.time);

  if (upcomingEntries.length > 0) {
    return upcomingEntries[0].entry;
  }

  // 2. Nếu không có ngày nào trong tương lai -> lấy hàng gần nhất trong quá khứ (hàng cuối cùng)
  return entries[entries.length - 1];
}
