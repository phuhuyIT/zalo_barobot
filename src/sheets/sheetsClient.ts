/**
 * sheetsClient.ts
 *
 * Client kết nối Google Sheets API. Đọc và ghi một ô khi lệnh doi đổi người trực.
 * Hỗ trợ credentials qua file JSON (GOOGLE_APPLICATION_CREDENTIALS)
 * hoặc qua chuỗi JSON trong biến môi trường (GOOGLE_SERVICE_ACCOUNT_JSON).
 */

import { google, sheets_v4 } from 'googleapis';
import fs from 'fs';
import path from 'path';

let cachedSheetsClient: sheets_v4.Sheets | null = null;

/** Đọc và ghi. Quyền Viewer trên spreadsheet không đủ cho lệnh doi. */
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export function getSheetsClient(): sheets_v4.Sheets {
  if (cachedSheetsClient) {
    return cachedSheetsClient;
  }

  let auth: InstanceType<typeof google.auth.GoogleAuth>;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: [SHEETS_SCOPE],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Lỗi parse GOOGLE_SERVICE_ACCOUNT_JSON: ${msg}`, { cause: err });
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credPath = path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (!fs.existsSync(credPath)) {
      throw new Error(`File Google Service Account không tồn tại tại: ${credPath}`);
    }
    auth = new google.auth.GoogleAuth({
      keyFile: credPath,
      scopes: [SHEETS_SCOPE],
    });
  } else {
    // Dự phòng mặc định của Google Cloud SDK
    auth = new google.auth.GoogleAuth({
      scopes: [SHEETS_SCOPE],
    });
  }

  cachedSheetsClient = google.sheets({ version: 'v4', auth });
  return cachedSheetsClient;
}

/**
 * Đọc toàn bộ dữ liệu của một tab từ Google Sheet với range động.
 * Sử dụng valueRenderOption: 'FORMATTED_VALUE' để nhận giá trị đã được format theo bảng tính.
 */
export async function readSheetTab(
  spreadsheetId: string,
  tabName: string
): Promise<unknown[][]> {
  const sheets = getSheetsClient();

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'`,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    return (res.data.values as unknown[][]) || [];
  } catch (error: unknown) {
    const errObj = error as { code?: number; message?: string } | undefined;
    if (errObj?.code === 404 || errObj?.message?.includes('Unable to parse range')) {
      throw new Error(`Không tìm thấy tab sheet '${tabName}' hoặc Spreadsheet ID không tồn tại.`, {
        cause: error,
      });
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Lỗi khi đọc Google Sheet tab '${tabName}': ${msg}`, { cause: error });
  }
}

/** Cột 0 → A, cột 4 → E. */
export function columnIndexToA1(colIndex: number): string {
  let n = colIndex + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

const SHEET_WRITE_FAILED = 'Không ghi được Google Sheet. Thử lại sau.';

/** 403 nghĩa là spreadsheet chưa chia sẻ quyền Editor cho service account. */
export function toSheetWriteError(error: unknown, tabName: string, a1: string): Error {
  const errObj = error as { code?: number; status?: number; message?: string; response?: { status?: number } };
  const status = errObj?.code || errObj?.status || errObj?.response?.status;
  if (status === 403) {
    return new Error(
      'Không ghi được Google Sheet. Hãy chia sẻ quyền Người chỉnh sửa (Editor) cho service account của bot.',
      { cause: error }
    );
  }
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[Sheets] Ghi ô ${a1} trên tab '${tabName}' thất bại:`, msg);
  return new Error(SHEET_WRITE_FAILED, { cause: error });
}

/**
 * Ghi một ô dưới dạng văn bản. value rỗng nghĩa là xóa nội dung ô đó.
 * RAW giữ nguyên tên người trực, không biến `=` hoặc ngày thành công thức.
 */
export async function updateSheetCell(
  spreadsheetId: string,
  tabName: string,
  rowIndex: number,
  colIndex: number,
  value: string
): Promise<void> {
  const sheets = getSheetsClient();
  const a1 = `${columnIndexToA1(colIndex)}${rowIndex + 1}`;
  const safeTab = tabName.replace(/'/g, "''");
  const range = `'${safeTab}'!${a1}`;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  } catch (error: unknown) {
    throw toSheetWriteError(error, tabName, a1);
  }
}
