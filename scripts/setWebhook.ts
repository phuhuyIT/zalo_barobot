import dotenv from 'dotenv';
import { ZaloClient } from '../src/core/zaloClient';

dotenv.config();

const url = process.argv[2];
if (!url) {
  console.error('Cách dùng: npm run set-webhook <URL_PUBLIC>');
  console.error('Ví dụ: npm run set-webhook https://xxx.app.github.dev/webhook/zalo');
  process.exit(1);
}

async function run() {
  const zalo = new ZaloClient();
  const secret = process.env.ZALO_WEBHOOK_SECRET || undefined;
  console.log(`Đang đăng ký Webhook với Zalo Bot:`);
  console.log(`- URL: ${url}`);
  console.log(`- Secret Token: ${secret ? 'Đã cấu hình' : 'Để trống'}`);

  const res = await zalo.setWebhook(url, secret);
  console.log('✅ Đăng ký Webhook thành công:', res);
}

run().catch((err) => {
  console.error('❌ Lỗi khi đăng ký Webhook:', err.message);
  process.exit(1);
});
