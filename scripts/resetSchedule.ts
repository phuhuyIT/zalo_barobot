/**
 * scripts/resetSchedule.ts
 *
 * Script xóa log và trạng thái đã gửi trong ngày của Lịch trực ban / Culi (bảng last_message & send_history)
 * để kiểm tra tính năng gửi tự động (Cron Scheduler) mà không bị cơ chế chống gửi trùng (Idempotency) chặn lại.
 *
 * Cách dùng:
 *   npx tsx scripts/resetSchedule.ts                 # Mặc định: reset trạng thái đã gửi hôm nay của tất cả các lịch
 *   npx tsx scripts/resetSchedule.ts --key=main_duty # Chỉ reset lịch trực ban cổng chính
 *   npx tsx scripts/resetSchedule.ts --key=culi_duty # Chỉ reset lịch trực ban culi
 *   npx tsx scripts/resetSchedule.ts --all           # Xóa toàn bộ lịch sử gửi (last_message & send_history)
 *   npx tsx scripts/resetSchedule.ts --date=16/09/2026 # Reset ngày cụ thể
 */

import 'dotenv/config';
import { getDatabase, resetScheduleSentStatus, clearWebhookLog } from '../src/store';
import { getVietnamTimeParts } from '../src/sheets/dateUtils';

function parseArgs() {
  const args = process.argv.slice(2);
  let isAll = false;
  let scheduleKey: string | undefined;
  let targetDate: string | undefined;

  for (const arg of args) {
    if (arg === '--all') {
      isAll = true;
    } else if (arg.startsWith('--key=')) {
      scheduleKey = arg.split('=')[1]?.trim();
    } else if (arg.startsWith('--date=')) {
      targetDate = arg.split('=')[1]?.trim();
    }
  }

  if (!isAll && !targetDate) {
    targetDate = getVietnamTimeParts(new Date()).dateDMY;
  }

  return { isAll, scheduleKey, targetDate };
}

function main() {
  const { isAll, scheduleKey, targetDate } = parseArgs();
  const db = getDatabase();

  console.log('------------------------------------------------------------');
  console.log('🧹 [RESET SCHEDULE] Bắt đầu xóa log & trạng thái gửi lịch...');
  console.log('------------------------------------------------------------');

  if (isAll) {
    console.log('📌 Phạm vi: TOÀN BỘ LỊCH SỬ GỬI TIN & LAST_MESSAGE');
    const res = resetScheduleSentStatus(undefined, undefined, db);
    console.log(`✅ Đã xóa ${res.deletedLastMessage} bản ghi last_message.`);
    console.log(`✅ Đã xóa ${res.deletedHistory} bản ghi send_history.`);
  } else {
    console.log(`📌 Ngày mục tiêu: ${targetDate}`);
    if (scheduleKey) {
      console.log(`📌 Lịch mục tiêu: ${scheduleKey}`);
      const res = resetScheduleSentStatus(targetDate, scheduleKey, db);
      console.log(`✅ Đã xóa ${res.deletedLastMessage} bản ghi last_message của lịch ${scheduleKey} ngày ${targetDate}.`);
    } else {
      console.log(`📌 Áp dụng cho: Tất cả các lịch trực ban`);
      const res = resetScheduleSentStatus(targetDate, undefined, db);
      console.log(`✅ Đã xóa ${res.deletedLastMessage} bản ghi last_message ngày ${targetDate}.`);
    }
  }

  // Dọn dẹp cả file log webhook nếu có
  clearWebhookLog();
  console.log(`✅ Đã xóa trắng file log: data/webhook.log`);

  console.log('------------------------------------------------------------');
  console.log('🎉 Hoàn tất! Cơ chế Idempotency đã được mở:');
  console.log('  1. Bạn có thể test gửi lại lịch trực ban qua Cron Scheduler');
  console.log('  2. Bạn có thể bấm gửi từ Web UI với chế độ tự động');
  console.log('------------------------------------------------------------');
}

main();
