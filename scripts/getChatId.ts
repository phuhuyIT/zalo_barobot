/**
 * scripts/getChatId.ts
 *
 * Script hỗ trợ lấy Chat ID của cá nhân hoặc nhóm Zalo bằng chế độ Polling qua REST API.
 * Không phụ thuộc vào thư viện bên ngoài đã ngừng bảo trì (node-zalo-bot).
 */

import dotenv from 'dotenv';
import axios from 'axios';
import { ZaloClient } from '../src/core/zaloClient';

dotenv.config();

const token = process.env.ZALO_BOT_TOKEN;
if (!token) {
  console.error('❌ Lỗi: Chưa cấu hình ZALO_BOT_TOKEN trong file .env');
  process.exit(1);
}

const baseUrl = (process.env.ZALO_BASE_URL || 'https://bot-api.zapps.me').replace(/\/$/, '');
const zalo = new ZaloClient(token, baseUrl);

console.log('============================================================');
console.log('🚀 Đang khởi động bot ở chế độ Polling để lấy Chat ID...');
console.log('👉 Hãy vào nhóm Zalo (hoặc chat riêng với bot) và gửi 1 tin nhắn bất kỳ (ví dụ: "hello" hoặc "/id").');
console.log('👉 Nhấn Ctrl + C để dừng khi đã lấy được Chat ID.');
console.log('============================================================\n');

let lastUpdateId = 0;
let isRunning = true;

async function pollUpdates() {
  while (isRunning) {
    try {
      const response = await axios.get(`${baseUrl}/bot${token}/getUpdates`, {
        params: {
          offset: lastUpdateId + 1,
          timeout: 20,
        },
        timeout: 25000,
      });

      const data = response.data;
      if (data && data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          if (update.update_id) {
            lastUpdateId = Math.max(lastUpdateId, Number(update.update_id));
          }

          const message = update.message || update;
          const chatId = String(message.chat?.id || message.chat_id || message.from?.id || '').trim();
          const chatName = message.chat?.title || message.chat?.name || message.from?.name || 'Tin nhắn riêng';
          const text = message.text || '';
          const senderId = String(message.from?.id || message.sender?.id || '').trim();

          if (chatId) {
            console.log('========================================');
            console.log(`📩 Nhận tin nhắn từ: ${chatName}`);
            console.log(`🆔 CHAT ID: ${chatId}`);
            if (senderId) {
              console.log(`👤 USER ID: ${senderId}`);
            }
            console.log(`💬 Nội dung: "${text}"`);
            console.log('========================================\n');

            try {
              await zalo.sendMessage(chatId, `✅ Đã nhận! Chat ID của bạn/nhóm là: ${chatId}`);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[getChatId] Không thể phản hồi tin nhắn: ${msg}`);
            }
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Gặp lỗi kết nối/timeout thì chờ 3s rồi thử lại
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n🛑 Đã dừng tiến trình lấy Chat ID.');
  isRunning = false;
  process.exit(0);
});

pollUpdates();
