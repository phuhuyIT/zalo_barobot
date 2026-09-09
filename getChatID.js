const ZaloBot = require("node-zalo-bot");

const bot = new ZaloBot("3580052352266717043:JmdlpnyqfOlfgbTteDveeFbFDPGgrZIDiPmSzwduTeVmcruRuoVLlxMukjdPLQTC", {
  polling: true,
});

// Xử lý tin nhắn đến
bot.on("message", (msg) => {
  const chatId = msg.chat.id;

  // Phản hồi lại tin nhắn
  bot.sendMessage(chatId, `Bạn vừa nói: ${msg.text}`);
  console.log(chatId);
});