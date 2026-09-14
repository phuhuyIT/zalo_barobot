export type HeaderStyle = 'two_row_merged' | 'single_row';

export interface SquadConfig {
  display_name: string;
  sheet_tab_gate_duty: string;
  header_style: HeaderStyle;
  overnight?: boolean;
  cutover_time?: string; // "HH:MM"
  send_next_day?: boolean; // Nếu true: gửi lịch của ngày hôm sau vào buổi tối hôm trước
  next_day_cutover_time?: string; // Giờ chuyển mốc sang ngày mai (mặc định "20:00")
}

export interface ScheduleConfig {
  key: string; // free-form string identifier
  label: string;
  squad?: string;
  type: string; // e.g. 'gate_duty', 'gate_duty_patrol_only', 'leave_roster'
  sheet_tab?: string; // tab name override if not squad gate duty
  recipients: string[]; // recipient keys
  auto_send_time: string | null; // "HH:MM" or null
  enabled: boolean;
  send_next_day?: boolean;
  next_day_cutover_time?: string;
}

export interface ReminderConfig {
  schedule_key: string;
  remind_before_send_minutes?: number; // e.g. 60
  remind_if_not_sent_by?: string; // "HH:MM"
}

export interface AppConfig {
  squads: Record<string, SquadConfig>;
  recipients: Record<string, string>;
  schedules: ScheduleConfig[];
  reminders: ReminderConfig[];
}

export interface DutyTask {
  taskName: string;
  assignee: string;
  parentTask?: string;
  subTask?: string;
}

export interface DailyDuty {
  date: string; // dd/mm/yyyy
  unit?: string;
  isOvernight?: boolean;
  tasks: DutyTask[];
}

export interface LeaveEntry {
  date: string; // dd/mm/yyyy
  onLeave: string[];
  missedTurn: string[];
  rawColumns?: Record<string, string>;
}

export interface LeaveRoster {
  unit?: string;
  entries: LeaveEntry[];
}

export interface SendHistoryEntry {
  id?: number;
  timestamp: string;
  schedule_key: string;
  chat_id: string;
  result: 'success' | 'failure';
  error?: string | null;
  old_message_deleted: boolean;
}

export interface Recipient {
  key: string;
  display_name: string;
  chat_id: string;
  created_at?: string;
  updated_at?: string;
}

export interface MemberLeaveStat {
  name: string;
  leaveCount: number; // Số lần đã được về
  missedCount: number; // Số lần mất lượt
  lastLeaveDate: string | null; // Ngày gần nhất được về (dd/mm/yyyy), null nếu chưa từng về
  turnsSinceLastLeave: number | null; // Số lượt kể từ lần gần nhất được về, null nếu chưa từng về
}

export interface LeaveStatsData {
  unit?: string;
  totalTurns: number;
  latestTurnDate?: string;
  stats: MemberLeaveStat[];
}

export interface RuntimeConfigOverride {
  sheet_tab_gate_duty?: string;
  auto_send_time?: string | null;
  enabled?: boolean;
  send_next_day?: boolean;
  recipients?: string[];
}
