/**
 * gateDutySingleRowParser.ts
 *
 * Bộ parser cho tiểu đội culi / trực ca đêm (header_style: single_row).
 * Quy tắc nghiệp vụ (Mục 2.1b & Quy tắc #6, #8):
 * - Chỉ có 1 hàng tiêu đề duy nhất, định vị động thông qua ô có giá trị "Ngày".
 * - Cột chứa "Ngày" là cột ngày tháng. Dữ liệu bắt đầu từ hàng ngay sau đó.
 * - Tìm dòng "Đơn vị:" ở các hàng phía trên hàng tiêu đề.
 * - Các cột nhiệm vụ nằm sau cột "Ngày". Khi gặp cột có tiêu đề rỗng thì dừng lại ngay lập tức
 *   để không đọc vào bảng danh sách phụ (như STT, Danh sách quân số trực ở bên phải).
 * - Bỏ qua các ô có giá trị rỗng hoặc placeholder ('-', 'N/A').
 */

import { DailyDuty, DutyTask } from '../types';
import { isPlaceholderOrEmpty, normalizeDate } from './dateUtils';
import { ColumnHeader } from './gateDutyTwoRowParser';

export interface ParsedSingleRowLayout {
  headerRowIndex: number;
  dateColIndex: number;
  unit?: string;
  taskColumns: ColumnHeader[];
}

/**
 * Phân tích cấu trúc bảng tính single_row.
 */
export function detectSingleRowLayout(rows: any[][]): ParsedSingleRowLayout {
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
    throw new Error("Không tìm thấy ô mốc 'Ngày' trong bảng tính (single_row).");
  }

  const headerRow = rows[headerRowIndex] || [];

  // 2. Tìm dòng Đơn vị: ở các hàng phía trên headerRow
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

  // 3. Quét các cột nhiệm vụ nằm sau cột "Ngày", dừng khi gặp cột có tiêu đề rỗng
  const taskColumns: ColumnHeader[] = [];
  for (let c = dateColIndex + 1; c < headerRow.length; c++) {
    const colName = String(headerRow[c] || '').trim();
    if (colName === '') {
      // Gặp cột rỗng -> dừng ngay để tránh đọc các bảng phụ (như STT, Danh sách bên phải)
      break;
    }
    taskColumns.push({ index: c, name: colName });
  }

  return {
    headerRowIndex,
    dateColIndex,
    unit,
    taskColumns,
  };
}

/**
 * Phân tích dữ liệu lịch trực ca đêm của tiểu đội culi cho ngày cụ thể.
 */
export function parseGateDutySingleRow(
  rows: any[][],
  targetDate: string
): DailyDuty | null {
  const layout = detectSingleRowLayout(rows);
  const normalizedTarget = normalizeDate(targetDate);
  if (!normalizedTarget) {
    throw new Error(`Định dạng targetDate không hợp lệ: ${targetDate}`);
  }

  // Quét các hàng dữ liệu (bắt đầu từ hàng ngay sau Header)
  const dataStartIndex = layout.headerRowIndex + 1;
  for (let r = dataStartIndex; r < rows.length; r++) {
    const row = rows[r] || [];
    const dateVal = row[layout.dateColIndex];
    const normalizedRowDate = normalizeDate(dateVal);

    if (normalizedRowDate === normalizedTarget) {
      const tasks: DutyTask[] = [];

      for (const col of layout.taskColumns) {
        const rawAssignee = row[col.index];
        if (!isPlaceholderOrEmpty(rawAssignee)) {
          tasks.push({
            taskName: col.name,
            assignee: String(rawAssignee).trim(),
          });
        }
      }

      return {
        date: normalizedTarget,
        unit: layout.unit,
        isOvernight: true,
        tasks,
      };
    }
  }

  return null;
}
