/**
 * auth.ts
 *
 * Middleware xác thực Basic Auth bảo vệ Web UI và các API nội bộ.
 */

import { Request, Response, NextFunction } from 'express';

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
  const expectedPassword = process.env.ADMIN_PASSWORD || 'change_this_password';

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Zalo Barobot Admin"');
    res.status(401).send('Yêu cầu xác thực tài khoản quản trị.');
    return;
  }

  const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
  const colonIndex = credentials.indexOf(':');
  const username = colonIndex !== -1 ? credentials.substring(0, colonIndex) : credentials;
  const password = colonIndex !== -1 ? credentials.substring(colonIndex + 1) : '';

  // Cho phép cả change_this_password và barobot123 nếu chưa cấu hình ADMIN_PASSWORD trong .env
  const isPasswordValid = process.env.ADMIN_PASSWORD
    ? password === expectedPassword
    : password === 'change_this_password' || password === 'barobot123';

  if (username === adminUsername && isPasswordValid) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Zalo Barobot Admin"');
  res.status(401).send('Tài khoản hoặc mật khẩu không chính xác.');
}
