/**
 * scripts/resetPatrol.ts
 *
 * Script xóa log và trạng thái nộp lịch tuần tra (Trụ sở 1, Trụ sở 2, tin nhắn tổng hợp)
 * để phục vụ kiểm thử lại các tính năng nộp lịch và nhắc nhở.
 *
 * Cách dùng:
 *   npx tsx scripts/resetPatrol.ts               # Mặc định: reset trạng thái hôm nay của tất cả các site
 *   npx tsx scripts/resetPatrol.ts --site=site_1 # Chỉ reset Trụ sở 1 (Tân Phước Khánh)
 *   npx tsx scripts/resetPatrol.ts --site=site_2 # Chỉ reset Trụ sở 2 (Thạnh Hội)
 *   npx tsx scripts/resetPatrol.ts --all         # Reset toàn bộ lịch sử các ngày
 *   npx tsx scripts/resetPatrol.ts --date=16/09/2026 # Reset ngày cụ thể
 */

import 'dotenv/config';
import { getDatabase } from '../src/store';
import { resetPatrolDailyStatus, getPatrolSiteConfigs } from '../src/patrol';
import { getVietnamTimeParts } from '../src/sheets/dateUtils';

function parseArgs() {
  const args = process.argv.slice(2);
  let isAll = false;
  let siteKey: string | undefined;
  let targetDate: string | undefined;

  for (const arg of args) {
    if (arg === '--all') {
      isAll = true;
    } else if (arg.startsWith('--site=')) {
      siteKey = arg.split('=')[1]?.trim();
    } else if (arg.startsWith('--date=')) {
      targetDate = arg.split('=')[1]?.trim();
    }
  }

  if (!isAll && !targetDate) {
    targetDate = getVietnamTimeParts(new Date()).dateDMY;
  }

  return { isAll, siteKey, targetDate };
}

function main() {
  const { isAll, siteKey, targetDate } = parseArgs();
  const db = getDatabase();

  console.log('------------------------------------------------------------');
  console.log('🧹 [RESET PATROL] Bắt đầu xóa log & trạng thái tuần tra...');
  console.log('------------------------------------------------------------');

  if (isAll) {
    console.log('📌 Phạm vi: TOÀN BỘ LỊCH SỬ CÁC NGÀY');
    const res = resetPatrolDailyStatus(undefined, undefined, db);
    console.log(`✅ Đã xóa ${res.deletedDaily} bản ghi nộp lịch tuần tra.`);
    console.log(`✅ Đã xóa ${res.deletedSummary} bản ghi báo cáo tổng hợp.`);
  } else {
    console.log(`📌 Ngày mục tiêu: ${targetDate}`);
    if (siteKey) {
      console.log(`📌 Trụ sở mục tiêu: ${siteKey}`);
      const res = resetPatrolDailyStatus(targetDate, siteKey, db);
      console.log(`✅ Đã xóa ${res.deletedDaily} bản ghi nộp lịch của ${siteKey} ngày ${targetDate}.`);
    } else {
      console.log(`📌 Áp dụng cho: Cả 2 Trụ sở và Báo cáo tổng hợp`);
      const res = resetPatrolDailyStatus(targetDate, undefined, db);
      console.log(`✅ Đã xóa ${res.deletedDaily} bản ghi nộp lịch các site ngày ${targetDate}.`);
      console.log(`✅ Đã xóa ${res.deletedSummary} bản ghi báo cáo tổng hợp ngày ${targetDate}.`);
    }
  }

  console.log('------------------------------------------------------------');
  console.log('🎉 Hoàn tất! Bạn có thể bắt đầu test lại:');
  console.log('  1. Gửi lệnh `tuantra ...` hoặc `tuantra 0` từ Trụ sở 1 / Trụ sở 2');
  console.log('  2. Test chạy nhắc nhở nộp lịch qua Web UI hoặc CLI');
  console.log('  3. Quan sát quy trình chờ đủ 2 địa bàn & gửi Trung đội trưởng');
  console.log('------------------------------------------------------------');
}

main();
