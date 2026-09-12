/**
 * dateUtils.ts
 *
 * Xử lý chuẩn hóa định dạng ngày tháng và logic xác định ngày cần lấy lịch (lookup_date).
 * Tuân thủ quy tắc nghiệp vụ trong mục 5.1 và quy tắc #8 (comment tiếng Việt).
 */

// Đảm bảo múi giờ mặc định luôn là Giờ Việt Nam (Asia/Ho_Chi_Minh, UTC+7)
process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

/**
 * Lấy các thành phần thời gian chuẩn theo múi giờ Việt Nam (Asia/Ho_Chi_Minh).
 */
export function getVietnamTimeParts(d: Date = new Date()): {
  hours: number;
  minutes: number;
  seconds: number;
  day: number;
  month: number;
  year: number;
  dateDMY: string;
  timeHM: string;
} {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(d);
  let hours = 0, minutes = 0, seconds = 0, day = 0, month = 0, year = 0;
  for (const p of parts) {
    if (p.type === 'hour') hours = Number(p.value);
    if (p.type === 'minute') minutes = Number(p.value);
    if (p.type === 'second') seconds = Number(p.value);
    if (p.type === 'day') day = Number(p.value);
    if (p.type === 'month') month = Number(p.value);
    if (p.type === 'year') year = Number(p.value);
  }
  const dateDMY = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  const timeHM = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return { hours, minutes, seconds, day, month, year, dateDMY, timeHM };
}

/**
 * Kiểm tra một chuỗi có phải là placeholder rỗng hay không (-, --, N/A, khoảng trắng, ...).
 * Theo yêu cầu làm rõ của Admin: Bỏ qua các giá trị như '-', 'N/A'.
 */
export function isPlaceholderOrEmpty(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  const s = String(val).trim();
  if (s === '') return true;
  const lower = s.toLowerCase();
  return ['-', '--', '---', 'n/a', 'na', 'none', 'x', 'k', 'ko', 'không', 'khong', 'trống', 'chưa có'].includes(lower);
}

/**
 * Chuẩn hóa giá trị ngày từ Google Sheets (có thể là chuỗi dd/mm/yyyy, yyyy-mm-dd, dd/mm/yy, dd/mm, hoặc số serial của Excel)
 * về chuỗi chuẩn 'DD/MM/YYYY'.
 */
export function normalizeDate(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;

  // 1. Trường hợp là chuỗi ngày dạng yyyy-mm-dd
  const ymdMatch = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, '0');
    const day = ymdMatch[3].padStart(2, '0');
    return `${day}/${month}/${year}`;
  }

  // 2. Trường hợp là chuỗi ngày dạng dd/mm/yyyy hoặc dd/mm/yy hoặc dd/mm (kể cả có tiền tố như Thứ 6, 28/08)
  const dmyMatch = s.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    let year = dmyMatch[3];
    if (!year) {
      year = String(new Date().getFullYear());
    } else if (year.length === 2) {
      year = `20${year}`;
    }
    return `${day}/${month}/${year}`;
  }

  // 3. Trường hợp là số serial của Excel (ví dụ 46266 hoặc 46266.0)
  const num = Number(s);
  if (!isNaN(num) && num > 30000 && num < 60000) {
    // Excel epoch tính từ ngày 30/12/1899 (bù trừ lỗi năm nhuận 1900 của Lotus 1-2-3)
    const utcDays = Math.floor(num - 25569);
    const dateObj = new Date(utcDays * 86400 * 1000);
    const day = String(dateObj.getUTCDate()).padStart(2, '0');
    const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const year = String(dateObj.getUTCFullYear());
    return `${day}/${month}/${year}`;
  }

  return null;
}

/**
 * Chuyển đổi Date object sang định dạng 'DD/MM/YYYY'.
 */
export function formatDateDMY(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear());
  return `${day}/${month}/${year}`;
}

/**
 * Phân tích chuỗi 'DD/MM/YYYY' thành Date object (00:00:00 local time).
 */
export function parseDMYToDate(dmy: string): Date | null {
  const normalized = normalizeDate(dmy);
  if (!normalized) return null;
  const [d, m, y] = normalized.split('/').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Xác định ngày cần lấy dữ liệu (lookup_date) theo quy tắc nghiệp vụ mục 5.1 & yêu cầu tùy chỉnh:
 *
 * 1. Tiểu đội trực ban ngày có cấu hình gửi trước vào tối hôm trước (sendNextDay = true, ví dụ Tiểu đội 2 gửi lúc 21:00 tối):
 *    - Quy tắc:
 *        Nếu thời gian hiện tại >= next_day_cutover_time (ví dụ >= 20:00 hoặc 21:00):
 *        -> lookup_date = ngày mai (now + 1 ngày).
 *        Nếu thời gian hiện tại < next_day_cutover_time (ví dụ sáng/chiều 08:00 - 19:59):
 *        -> lookup_date = ngày hôm nay (now).
 *        Ví dụ: Lúc 21:00 Thứ Hai -> lookup_date = Thứ Ba (gửi lịch ngày mai).
 *               Lúc 08:00 Thứ Ba (admin bấm gửi lại trên web do đổi ca đột xuất) -> lookup_date = Thứ Ba (gửi lịch hôm nay).
 *               Lúc 21:00 Thứ Ba -> lookup_date = Thứ Tư.
 *
 * 2. Tiểu đội có ca trực đêm qua ngày (overnight = true, ví dụ tiểu đội culi trực 23h hôm nay đến 5h30 sáng hôm sau):
 *    - Cột ngày trên Sheet ghi ngày BẮT ĐẦU ca trực.
 *    - Khi hệ thống tự động gửi lúc 5:30 sáng, nó phải gửi ca trực cho TỐI HÔM NAY (chuẩn bị tới).
 *    - Quy tắc:
 *        Nếu thời gian hiện tại < cutover_time (ví dụ < 05:30): lookup_date = ngày hôm qua.
 *        Nếu thời gian hiện tại >= cutover_time (ví dụ >= 05:30): lookup_date = ngày hôm nay.
 *        Ví dụ: 05:30 Thứ Ba -> không nhỏ hơn 05:30 -> lookup_date = Thứ Ba (tối nay trực).
 *
 * 3. Tiểu đội trực ban ngày thông thường: lookup_date = ngày hôm nay.
 */
export function resolveLookupDate(
  now: Date,
  isOvernight: boolean = false,
  cutoverTime: string = '05:30',
  sendNextDay: boolean = false
): string {
  // 1. Trường hợp gửi trước lịch ngày mai (sendNextDay = true):
  // Luôn hướng đến ngày mai (now + 1 ngày) để bất kể khi nào chạy (ở mốc 21:00 hay test thủ công),
  // hệ thống đều nhắm tới lịch của ngày mai.
  if (sendNextDay) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return formatDateDMY(tomorrow);
  }

  // 2. Trường hợp ca trực đêm qua ngày (culi)
  if (isOvernight) {
    const [cutHour, cutMinute] = cutoverTime.split(':').map(Number);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const cutoverMinutes = cutHour * 60 + cutMinute;

    if (currentMinutes < cutoverMinutes) {
      // Trước giờ cutover -> ca trực đang diễn ra thuộc về ngày hôm qua
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return formatDateDMY(yesterday);
    } else {
      // Từ giờ cutover trở đi -> ca trực tối nay sắp diễn ra (thuộc về ngày hôm nay)
      return formatDateDMY(now);
    }
  }

  // 3. Mặc định: ngày hôm nay
  return formatDateDMY(now);
}
