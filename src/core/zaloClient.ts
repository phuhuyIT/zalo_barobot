/**
 * zaloClient.ts
 *
 * Client gọi trực tiếp REST API của Zalo Bot Platform (https://bot-api.zapps.me).
 * Tuân thủ quy tắc #12: Chỉ nhận văn bản đã format, không chứa logic format dữ liệu.
 * Tuân thủ mục 5.3: deleteMessage là best-effort, không throw exception làm gián đoạn luồng gửi.
 */

import axios, { AxiosInstance, isAxiosError } from 'axios';

export interface SendMessageResult {
  messageId: string;
  raw: Record<string, unknown>;
}

export interface SendPhotoResult {
  messageId: string;
  raw: Record<string, unknown>;
}

export class ZaloClient {
  private token: string;
  private baseUrl: string;
  private client: AxiosInstance;

  constructor(token?: string, baseUrl?: string) {
    this.token = (token || process.env.ZALO_BOT_TOKEN || '').trim();
    this.baseUrl = (baseUrl || process.env.ZALO_BASE_URL || 'https://bot-api.zapps.me').replace(/\/$/, '');

    this.client = axios.create({
      baseURL: `${this.baseUrl}/bot${this.token}`,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Gửi tin nhắn văn bản đến chat_id (nhóm hoặc cá nhân).
   */
  async sendMessage(chatId: string, text: string): Promise<SendMessageResult> {
    if (!this.token) {
      throw new Error('ZALO_BOT_TOKEN chưa được cấu hình.');
    }

    try {
      const response = await this.client.post('/sendMessage', {
        chat_id: chatId,
        text: text,
      });

      const data = response.data;
      if (!data || data.ok === false) {
        throw new Error(data?.description || `Gửi tin nhắn thất bại: mã lỗi ${data?.error_code}`);
      }

      // message_id có thể nằm ở result.message_id hoặc data.message_id
      const messageId =
        data.result?.message_id !== undefined
          ? String(data.result.message_id)
          : data.message_id !== undefined
          ? String(data.message_id)
          : `msg_${Date.now()}`;

      return {
        messageId,
        raw: data,
      };
    } catch (error: unknown) {
      const errMsg = isAxiosError(error)
        ? error.response?.data?.description || error.message
        : error instanceof Error
        ? error.message
        : String(error);
      throw new Error(`Lỗi gửi tin nhắn Zalo tới chat_id ${chatId}: ${errMsg}`, { cause: error });
    }
  }

  /**
   * Gửi ảnh qua URL https (không phải đường dẫn đĩa — docs sendPhoto).
   * Dùng cho QR login (Step 5) và báo cáo proof (Step 10).
   */
  async sendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<SendPhotoResult> {
    if (!this.token) {
      throw new Error('ZALO_BOT_TOKEN chưa được cấu hình.');
    }
    if (!/^https:\/\//i.test(photoUrl)) {
      throw new Error('sendPhoto yêu cầu URL https, không nhận đường dẫn file.');
    }

    try {
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        photo: photoUrl,
      };
      if (caption) payload.caption = caption;

      const response = await this.client.post('/sendPhoto', payload);
      const data = response.data;
      if (!data || data.ok === false) {
        throw new Error(data?.description || `Gửi ảnh thất bại: mã lỗi ${data?.error_code}`);
      }

      const messageId =
        data.result?.message_id !== undefined
          ? String(data.result.message_id)
          : data.message_id !== undefined
            ? String(data.message_id)
            : `msg_${Date.now()}`;

      return { messageId, raw: data };
    } catch (error: unknown) {
      const errMsg = isAxiosError(error)
        ? error.response?.data?.description || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`Lỗi gửi ảnh Zalo tới chat_id ${chatId}: ${errMsg}`, { cause: error });
    }
  }

  /**
   * Xóa tin nhắn cũ (F4 - Best Effort).
   * Quy tắc mục 5.3: Nếu API lỗi hoặc không hỗ trợ, ghi log cảnh báo và tiếp tục,
   * TUYỆT ĐỐI không throw exception làm gián đoạn việc gửi tin mới.
   */
  async deleteMessage(chatId: string, messageId: string): Promise<boolean> {
    if (!this.token || !messageId) return false;

    try {
      const response = await this.client.post('/deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      });

      const data = response.data;
      if (data && data.ok) {
        return true;
      }

      console.warn(`[ZaloClient] deleteMessage không thành công (chat_id: ${chatId}, msg: ${messageId}):`, data);
      return false;
    } catch (error: unknown) {
      // Ghi warning và tiếp tục, không ngắt luồng
      const errMsg = isAxiosError(error)
        ? error.response?.data?.description || error.message
        : error instanceof Error
        ? error.message
        : String(error);
      console.warn(
        `[ZaloClient] Lỗi khi gọi deleteMessage (chat_id: ${chatId}, msg: ${messageId}): ${errMsg}`
      );
      return false;
    }
  }

  /**
   * Thiết lập webhook URL cho Zalo Bot.
   */
  async setWebhook(url: string, secretToken?: string): Promise<Record<string, unknown>> {
    if (!this.token) {
      throw new Error('ZALO_BOT_TOKEN chưa được cấu hình.');
    }

    const payload: Record<string, unknown> = { url };
    if (secretToken) {
      payload.secret_token = secretToken;
    }

    const response = await this.client.post('/setWebhook', payload);
    return response.data as Record<string, unknown>;
  }

  /**
   * Lấy thông tin về Bot hiện tại.
   */
  async getMe(): Promise<Record<string, unknown>> {
    if (!this.token) {
      throw new Error('ZALO_BOT_TOKEN chưa được cấu hình.');
    }

    const response = await this.client.get('/getMe');
    return response.data as Record<string, unknown>;
  }
}
