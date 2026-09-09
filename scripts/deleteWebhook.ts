import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

async function run() {
  const token = process.env.ZALO_BOT_TOKEN;
  if (!token) {
    console.error('Vui lòng cấu hình ZALO_BOT_TOKEN trong .env');
    process.exit(1);
  }

  const baseUrl = process.env.ZALO_BASE_URL || 'https://bot-api.zapps.me';
  console.log('Đang hủy Webhook với Zalo Bot để chuyển lại sang chế độ Polling...');

  const res = await axios.post(`${baseUrl}/bot${token}/deleteWebhook`);
  console.log('✅ Hủy Webhook thành công:', res.data);
}

run().catch((err) => {
  console.error('❌ Lỗi hủy Webhook:', err.response?.data || err.message);
  process.exit(1);
});
