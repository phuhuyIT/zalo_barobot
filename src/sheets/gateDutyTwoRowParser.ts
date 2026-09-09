/**
 * gateDutyTwoRowParser.ts
 *
 * Bộ parser cho tiểu đội chính (header_style: two_row_merged).
 * Quy tắc nghiệp vụ (Mục 2.1a & Quy tắc mã nguồn #6):
 * - Tìm kiếm vị trí hàng tiêu đề động thông qua từ khóa "Ngày", TUYỆT ĐỐI không fix cứng số hàng/cột.
 * - Hàng chứa "Ngày" là Header Row 1, cột chứa "Ngày" là Date Column.
 * - Hàng ngay dưới là Header Row 2. Dữ liệu bắt đầu từ hàng ngay sau đó.
 * - Tìm dòng "Đơn vị:" ở các hàng phía trên Header Row 1.
 * - Ghép 2 dòng tiêu đề:
 *   + Cột gộp dọc (Header 1 có tên, Header 2 rỗng): giữ nguyên tên Header 1.
 *   + Cột gộp ngang (Header 1 trải dài nhiều cột như "Đi tuần", Header 2 có "Ca 1", "Ca 2"):
 *     forward-fill giá trị Header 1 sang phải để ghép thành "Đi tuần - Ca 1", "Đi tuần - Ca 2".
 *   + Theo yêu cầu làm rõ của Admin:
 *     1. Bỏ qua các cột nằm trước cột "Ngày" (ví dụ cột "Thứ").
 *     2. Dừng quét tiêu đề nhiệm vụ khi gặp cột hoàn toàn rỗng.
 *     3. Bỏ qua các ô phân công có giá trị rỗng hoặc placeholder ('-', 'N/A').
 */

import { DailyDuty, DutyTask } from '../types';
import { isPlaceholderOrEmpty, normalizeDate } from './dateUtils';

export interface ColumnHeader {
  index: number;
  name: string;
}

export interface ParsedTwoRowLayout {
  headerRow1Index: number;
  headerRow2Index: number;
  dateColIndex: number;
  unit?: string;
  taskColumns: ColumnHeader[];
}

/**
 * Phân tích cấu trúc bảng tính và định vị các cột nhiệm vụ.
 */
export function detectTwoRowLayout(rows: any[][]): ParsedTwoRowLayout {
  let headerRow1Index = -1;
  let dateColIndex = -1;

  // 1. Quét tìm hàng chứa ô "Ngày"
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const val = String(row[c] || '').trim().toLowerCase();
      if (val === 'ngày') {
        headerRow1Index = r;
        dateColIndex = c;
        break;
      }
    }
    if (headerRow1Index !== -1) break;
  }

  if (headerRow1Index === -1 || dateColIndex === -1) {
    throw new Error("Không tìm thấy ô mốc 'Ngày' trong bảng tính (two_row_merged).");
  }

  const headerRow2Index = headerRow1Index + 1;
  const row1 = rows[headerRow1Index] || [];
  const row2 = rows[headerRow2Index] || [];

  // 2. Tìm dòng Đơn vị: ở các hàng phía trên headerRow1
  let unit: string | undefined = undefined;
  for (let r = 0; r < headerRow1Index; r++) {
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

  // 3. Ghép tiêu đề cột nhiệm vụ (chỉ xét các cột SAU cột "Ngày")
  const taskColumns: ColumnHeader[] = [];
  let lastH1 = '';
  const maxCol = Math.max(row1.length, row2.length);

  for (let c = dateColIndex + 1; c < maxCol; c++) {
    const h1 = String(row1[c] || '').trim();
    const h2 = String(row2[c] || '').trim();

    if (h1 === '' && h2 === '') {
      // Gặp cột hoàn toàn rỗng -> dừng quét theo yêu cầu làm rõ #2
      break;
    }

    let combinedName = '';
    if (h1 !== '') {
      lastH1 = h1;
      if (h2 !== '') {
        combinedName = `${h1} - ${h2}`;
      } else {
        combinedName = h1;
      }
    } else {
      // h1 rỗng nhưng h2 có dữ liệu -> forward-fill lastH1
      if (lastH1 !== '' && h2 !== '') {
        combinedName = `${lastH1} - ${h2}`;
      } else {
        // Không có tiêu đề hợp lệ để ghép -> dừng quét
        break;
      }
    }

    taskColumns.push({ index: c, name: combinedName });
  }

  return {
    headerRow1Index,
    headerRow2Index,
    dateColIndex,
    unit,
    taskColumns,
  };
}

/**
 * Phân tích dữ liệu lịch trực cho ngày cụ thể (targetDate theo dạng DD/MM/YYYY).
 */
export function parseGateDutyTwoRow(
  rows: any[][],
  targetDate: string
): DailyDuty | null {
  const layout = detectTwoRowLayout(rows);
  const normalizedTarget = normalizeDate(targetDate);
  if (!normalizedTarget) {
    throw new Error(`Định dạng targetDate không hợp lệ: ${targetDate}`);
  }

  // Quét các hàng dữ liệu (bắt đầu từ hàng sau Header 2)
  const dataStartIndex = layout.headerRow2Index + 1;
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
        isOvernight: false,
        tasks,
      };
    }
  }

  // Không tìm thấy dữ liệu cho ngày này
  return null;
}
