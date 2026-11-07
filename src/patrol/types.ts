/**
 * types.ts
 *
 * Kiểu dữ liệu cho tính năng thu thập lịch đi tuần và nhắc nhở Tiểu đội 1.
 */

export interface PatrolMember {
  id: number;
  fullName: string;
  aliases: string[];
  createdAt: string;
}

export interface PatrolSiteConfig {
  siteKey: string;
  displayName: string;
  leaderUserId: string;
  /** Trụ sở 1: người báo cáo thứ hai. Trụ sở 2 không dùng trường này. */
  leaderUserId2?: string;
  chatId?: string;
  mergeWithSheet: boolean;
  reminderTimes: string[];
  maxReminders: number;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PatrolShift {
  shiftNumber: number;
  shiftLabel?: string;
  members: string[];
}

export interface PatrolDailyStatus {
  id?: number;
  date: string; // DD/MM/YYYY (Asia/Ho_Chi_Minh)
  siteKey: string;
  groupId: string;
  senderId: string;
  leaderUserId: string;
  submitted: boolean;
  hasPatrol: boolean; // false nếu báo nghỉ/không có ca tuần (tuantra 0 / tuantra nghi / tuantra none)
  selectedMembers: string[]; // Danh sách tên các thành viên được chọn (hoặc tất cả thành viên gộp)
  shifts: PatrolShift[]; // Danh sách các ca tuần tra trong ngày
  rawMessage?: string;
  messageId?: string;
  receivedAt?: string;
  reminderCount: number;
  lastReminderAt?: string | null;
  status: 'pending' | 'submitted' | 'no_patrol' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

/** Một người báo cáo của Trụ sở 1 (khi lịch trụ sở đó do 2 người gửi). */
export interface PatrolReporterStatus {
  id?: number;
  date: string;
  siteKey: string;
  reporterUserId: string;
  groupId: string;
  senderId: string;
  submitted: boolean;
  hasPatrol: boolean;
  isMultiShift: boolean;
  selectedMembers: string[];
  shifts: PatrolShift[];
  rawMessage?: string;
  messageId?: string;
  receivedAt?: string;
  reminderCount: number;
  lastReminderAt?: string | null;
  status: 'pending' | 'submitted' | 'no_patrol' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface PatrolSummaryDailyStatus {
  date: string; // DD/MM/YYYY
  summarySent: boolean;
  sentAt?: string | null;
  messageId?: string | null;
  lastContent?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParsePatrolCommandResult {
  isValid: boolean;
  commandFound: boolean;
  isNoPatrol?: boolean;
  isMultiShift?: boolean;
  members: string[];
  shifts?: PatrolShift[];
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
  siteKey?: string;
  ignoredReason?: string;
  error?: string;
  members?: string[];
  shifts?: PatrolShift[];
  summarySent?: boolean;
  waitingForOtherSite?: boolean;
  /** Trụ sở 1 đã nhận một người, còn chờ người báo cáo kia. */
  waitingForOtherReporter?: boolean;
  isNoPatrol?: boolean;
}
