/**
 * index.ts
 *
 * Điểm khởi động chính của hệ thống Zalo Barobot.
 * Tích hợp Express Web Server, Zalo Webhook, và Scheduler trong 1 tiến trình Node duy nhất.
 */

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { basicAuthMiddleware } from './channels/auth';
import { webRouter, registerSchedulerRefreshCallback } from './channels/web';
import { webhookRouter } from './channels/webhook';
import { schedulerRouter, startScheduler, stopScheduler, refreshSchedules } from './channels/scheduler';
import { getDatabase, closeDatabase } from './store';
import { loadConfig } from './config';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Khởi tạo Database và nạp cấu hình ban đầu
getDatabase();
loadConfig();

// Middleware parse JSON và URL-encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Endpoint health check (không cần auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Gắn Webhook của Zalo (có cơ chế secret token riêng, không qua Basic Auth)
app.use(webhookRouter);

// Gắn Internal Scheduler endpoint (dành cho Railway Cron)
app.use(schedulerRouter);

// Bảo vệ Web UI và các API nội bộ bằng Basic Auth
app.use(basicAuthMiddleware);

// Phục vụ file tĩnh của Web UI từ thư mục public
app.use(express.static(path.resolve(process.cwd(), 'public')));

// Gắn các API điều khiển Web UI
app.use(webRouter);

// Đăng ký callback làm mới scheduler khi cấu hình thay đổi từ Web UI (F9)
registerSchedulerRefreshCallback(refreshSchedules);

// Khởi động server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`=============================================`);
  console.log(`🤖 Zalo Barobot đang chạy trên cổng ${PORT}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook/zalo`);
  console.log(`=============================================`);

  // Khởi động Scheduler
  startScheduler();
});

// Xử lý tắt ứng dụng an toàn (Graceful Shutdown)
function handleShutdown(signal: string) {
  console.log(`\nNhận tín hiệu ${signal}. Đang đóng ứng dụng an toàn...`);
  stopScheduler();
  server.close(() => {
    closeDatabase();
    console.log('Đã đóng server và kết nối database. Tạm biệt!');
    process.exit(0);
  });
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
