/**
 * patrol.types.ts
 *
 * Kiểu dữ liệu cho tính năng thu thập lịch đi tuần và nhắc nhở Tiểu đội 1.
 */

export interface PatrolMember {
  id: number;
  fullName: string;
  aliases: string[];
  createdAt: string;
}

export interface PatrolDailyStatus {
  id?: number;
  date: string; // DD/MM/YYYY (Asia/Ho_Chi_Minh)
  groupId: string;
  senderId: string;
  leaderUserId: string;
  submitted: boolean;
  selectedMembers: string[]; // Danh sách tên các thành viên được chọn
  rawMessage?: string;
  messageId?: string;
  receivedAt?: string;
  reminderCount: number;
  lastReminderAt?: string | null;
  status: 'pending' | 'submitted' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface ParsePatrolCommandResult {
  isValid: boolean;
  commandFound: boolean;
  members: string[];
  unresolvedNames?: string[];
  error?: string;
}

export interface PatrolCommandPayload {
  text: string;
  chatId: string;
  senderId: string;
  messageId?: string;
}

export interface PatrolCommandResult {
  handled: boolean;
  success: boolean;
  ignoredReason?: string;
  error?: string;
  members?: string[];
  summarySent?: boolean;
}
