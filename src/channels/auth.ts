/**
 * auth.ts
 *
 * Middleware xác thực Basic Auth bảo vệ Web UI và các API nội bộ.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * So sánh an toàn hai chuỗi để chống tấn công timing-attack.
 */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function basicAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Cho phép webhook của Zalo và internal cron endpoint có cơ chế xác thực riêng
  if (
    req.path.startsWith('/webhook') ||
    req.path.startsWith('/internal') ||
    req.path === '/health'
  ) {
    return next();
  }

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const isProduction = process.env.NODE_ENV === 'production';

  // Trong production, bắt buộc phải đổi mật khẩu mặc định
  if (isProduction && (!configuredPassword || configuredPassword === 'change_this_password' || configuredPassword === 'barobot123')) {
    console.error('❌ LỖI BẢO MẬT: Môi trường Production bắt buộc phải cấu hình ADMIN_PASSWORD khác mật khẩu mặc định.');
    res.status(500).json({ success: false, error: 'Server security misconfiguration: default admin password is not allowed in production.' });
    return;
  }

  const expectedPassword = configuredPassword || 'change_this_password';

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Zalo Barobot Admin"');
    res.status(401).json({ success: false, error: 'Yêu cầu xác thực tài khoản quản trị.' });
    return;
  }

  const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
  const colonIndex = credentials.indexOf(':');
  const username = colonIndex !== -1 ? credentials.substring(0, colonIndex) : credentials;
  const password = colonIndex !== -1 ? credentials.substring(colonIndex + 1) : '';

  const isUsernameValid = timingSafeCompare(username, adminUsername);
  const isPasswordValid = timingSafeCompare(password, expectedPassword);

  if (isUsernameValid && isPasswordValid) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Zalo Barobot Admin"');
  res.status(401).json({ success: false, error: 'Tài khoản hoặc mật khẩu không chính xác.' });
}
