/**
 * auth.ts
 *
 * Middleware xác thực Basic Auth bảo vệ Web UI và các API nội bộ.
 */

import { Request, Response, NextFunction } from 'express';
import { timingSafeCompare } from '../taskproof/http/internalAuth';

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

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostnameFromHostHeader(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 1 ? value.slice(1, end) : '';
  }
  return value.split(':')[0];
}

/** undefined = header absent. null = present but not a usable origin. */
function headerOriginHost(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'null') return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * State-changing admin routes must come from the same host the browser called.
 * GET stays open so the page can load. Missing Origin is allowed for non-browser clients.
 */
export function rejectCrossOriginWrite(req: Request, res: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  if ((req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
    res.status(403).json({ success: false, error: 'cross-origin request rejected' });
    return;
  }
  const expected = hostnameFromHostHeader(req.get('host') || '');
  const origin = headerOriginHost(req.get('origin'));
  if (origin === null || (typeof origin === 'string' && origin !== expected)) {
    res.status(403).json({ success: false, error: 'cross-origin request rejected' });
    return;
  }
  if (origin === undefined) {
    const referer = headerOriginHost(req.get('referer'));
    if (referer === null || (typeof referer === 'string' && referer !== expected)) {
      res.status(403).json({ success: false, error: 'cross-origin request rejected' });
      return;
    }
  }
  next();
}
