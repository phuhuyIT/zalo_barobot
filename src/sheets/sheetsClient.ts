/**
 * sheetsClient.ts
 *
 * Client kết nối Google Sheets API với quyền chỉ đọc (Viewer).
 * Hỗ trợ credentials qua file JSON (GOOGLE_APPLICATION_CREDENTIALS)
 * hoặc qua chuỗi JSON trong biến môi trường (GOOGLE_SERVICE_ACCOUNT_JSON).
 */

import { google, sheets_v4 } from 'googleapis';
import fs from 'fs';
import path from 'path';

let cachedSheetsClient: sheets_v4.Sheets | null = null;

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
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
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
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else {
    // Dự phòng mặc định của Google Cloud SDK
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
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
