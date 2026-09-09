export type HeaderStyle = 'two_row_merged' | 'single_row';

export interface SquadConfig {
  display_name: string;
  sheet_tab_gate_duty: string;
  header_style: HeaderStyle;
  overnight?: boolean;
  cutover_time?: string; // "HH:MM"
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

export interface RuntimeConfigOverride {
  sheet_tab_gate_duty?: string;
  auto_send_time?: string | null;
  enabled?: boolean;
}
