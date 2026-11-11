export type ExternalSquad = 'main' | 'culi';

export interface ExternalDutyConfig {
  partnerLeaderUserId: string;
  extraEditorIds: string[];
  partnerChatId: string;
  aliasMain: string;
  aliasCuli: string;
  reminderTimes: string[];
  maxReminders: number;
}

export interface ExternalDutyReport {
  date: string;
  squad: ExternalSquad;
  shiftKey: string;
  shiftLabel: string;
  names: string[];
  cleared: boolean;
  rawMessage: string;
  messageId: string;
  senderId: string;
  submittedAt: string;
}

export interface ShiftColumn {
  name: string;
  parentName?: string;
  subName?: string;
  raw: string;
  empty: boolean;
  caNumber: number | null;
  /** Cột trên sheet, bắt đầu từ 0. */
  colIndex: number;
}

export interface DoiLine {
  squad: ExternalSquad;
  shiftQuery: string;
  names: string[];
  cleared: boolean;
}
