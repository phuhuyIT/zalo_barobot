/**
 * scripts/resetAll.ts
 *
 * Script dọn dẹp toàn bộ log và trạng thái hệ thống để chuẩn bị môi trường test sạch sẽ:
 * - Xóa trạng thái tuần tra (Trụ sở 1, Trụ sở 2, báo cáo tổng hợp)
 * - Xóa trạng thái chống gửi trùng (last_message) và lịch sử gửi lịch (send_history)
 * - Xóa file data/webhook.log
 *
 * Cách dùng:
 *   npx tsx scripts/resetAll.ts        # Mặc định: reset toàn bộ trạng thái trong ngày hôm nay
 *   npx tsx scripts/resetAll.ts --all  # Xóa toàn bộ lịch sử các ngày
 */

import 'dotenv/config';
import { getDatabase, resetScheduleSentStatus, clearWebhookLog } from '../src/store';
import { resetPatrolDailyStatus } from '../src/patrol';
import { getVietnamTimeParts } from '../src/sheets/dateUtils';

function parseArgs() {
  const args = process.argv.slice(2);
  const isAll = args.includes('--all');
  let targetDate = getVietnamTimeParts(new Date()).dateDMY;

  for (const arg of args) {
    if (arg.startsWith('--date=')) {
      targetDate = arg.split('=')[1]?.trim();
    }
  }

  return { isAll, targetDate };
}

function main() {
  const { isAll, targetDate } = parseArgs();
  const db = getDatabase();

  console.log('============================================================');
  console.log('🧹 [RESET ALL] Đặt lại toàn bộ trạng thái hệ thống để test');
  console.log('============================================================');

  if (isAll) {
    console.log('📌 Chế độ: TOÀN BỘ LỊCH SỬ HỆ THỐNG');
    const patrolRes = resetPatrolDailyStatus(undefined, undefined, db);
    const schedRes = resetScheduleSentStatus(undefined, undefined, db);

    console.log(`✅ [Tuần tra] Đã xóa ${patrolRes.deletedDaily} bản ghi ca tuần, ${patrolRes.deletedSummary} bản ghi tổng hợp.`);
    console.log(`✅ [Lịch trực] Đã xóa ${schedRes.deletedLastMessage} bản ghi last_message, ${schedRes.deletedHistory} bản ghi lịch sử gửi.`);
  } else {
    console.log(`📌 Ngày mục tiêu: ${targetDate}`);
    const patrolRes = resetPatrolDailyStatus(targetDate, undefined, db);
    const schedRes = resetScheduleSentStatus(targetDate, undefined, db);

    console.log(`✅ [Tuần tra] Đã xóa ${patrolRes.deletedDaily} bản ghi ca tuần, ${patrolRes.deletedSummary} bản ghi tổng hợp ngày ${targetDate}.`);
    console.log(`✅ [Lịch trực] Đã xóa ${schedRes.deletedLastMessage} bản ghi last_message ngày ${targetDate}.`);
  }

  clearWebhookLog();
  console.log(`✅ [Log File] Đã dọn dẹp file data/webhook.log`);

  console.log('============================================================');
  console.log('🎉 Hệ thống đã sẵn sàng 100% để bạn test:');
  console.log('  👉 Test gửi lịch trực ban & culi (Cron/Web)');
  console.log('  👉 Test lệnh tuantra Trụ sở 1 & Trụ sở 2');
  console.log('  👉 Test nhắc nhở nộp lịch tuần tra');
  console.log('============================================================');
}

main();
