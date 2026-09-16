/**
 * sheetParserUtils.ts
 *
 * Tiện ích dùng chung cho các bộ phân tích (parsers) Google Sheets.
 * Giúp tuân thủ nguyên tắc DRY (Don't Repeat Yourself) và Single Responsibility.
 */

export interface HeaderLocation {
  headerRowIndex: number;
  dateColIndex: number;
}

/**
 * Quét tìm hàng tiêu đề và cột chứa ô mốc 'Ngày' trong bảng tính.
 * Không phụ thuộc vào vị trí cố định của hàng/cột.
 */
export function findHeaderAndDateCol(
  rows: unknown[][],
  keyword: string = 'ngày'
): HeaderLocation | null {
  const targetKeyword = keyword.trim().toLowerCase();

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cellValue = String(row[c] || '').trim().toLowerCase();
      if (cellValue === targetKeyword) {
        return { headerRowIndex: r, dateColIndex: c };
      }
    }
  }

  return null;
}

/**
 * Tìm dòng "Đơn vị: ..." ở các hàng phía trên hàng tiêu đề.
 */
export function findUnitName(
  rows: unknown[][],
  beforeRowIndex: number
): string | undefined {
  for (let r = 0; r < beforeRowIndex; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cellValue = String(row[c] || '').trim();
      if (cellValue.toLowerCase().startsWith('đơn vị:')) {
        return cellValue;
      }
    }
  }

  return undefined;
}
