require("dotenv").config();
const ZaloBot = require("node-zalo-bot");

const token = process.env.ZALO_BOT_TOKEN;
if (!token) {
  console.error("❌ Lỗi: Chưa cấu hình ZALO_BOT_TOKEN trong file .env");
  process.exit(1);
}

console.log("🚀 Đang khởi động bot ở chế độ Polling...");
console.log("👉 Hãy vào nhóm Zalo (hoặc chat riêng với bot) và gửi 1 tin nhắn bất kỳ (ví dụ: 'hello').");
console.log("👉 Nhấn Ctrl + C để dừng khi đã lấy được Chat ID.\n");

const bot = new ZaloBot(token, {
  polling: true,
});

// Xử lý tin nhắn đến
bot.on("message", (msg) => {
  const chatId = msg.chat ? msg.chat.id : msg.from?.id;
  const chatName = msg.chat?.title || msg.chat?.name || msg.from?.name || "Tin nhắn riêng";

  console.log("========================================");
  console.log(`📩 Nhận tin nhắn từ: ${chatName}`);
  console.log(`🆔 CHAT ID: ${chatId}`);
  console.log(`💬 Nội dung: "${msg.text}"`);
  console.log("========================================\n");

  // Phản hồi lại tin nhắn
  if (chatId) {
    bot.sendMessage(chatId, `✅ Đã nhận! Chat ID của bạn/nhóm là: ${chatId}`);
  }
});