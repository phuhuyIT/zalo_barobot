import fs from 'fs';
import path from 'path';
import * as jsYaml from 'js-yaml';
import dotenv from 'dotenv';
import { AppConfig, SquadConfig, ScheduleConfig } from '../types';
import { getRecipient, seedDefaultRecipients } from '../store';

dotenv.config();

const yaml = (jsYaml as any).default || jsYaml;

let cachedConfig: AppConfig | null = null;

export function setConfig(config: AppConfig): void {
  cachedConfig = config;
}

export function loadConfig(configPath?: string): AppConfig {
  const resolvedPath =
    configPath ||
    process.env.CONFIG_PATH ||
    path.resolve(process.cwd(), 'config/schedules.yaml');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found at: ${resolvedPath}`);
  }

  const fileContents = fs.readFileSync(resolvedPath, 'utf8');
  const rawConfig = yaml.load(fileContents) as any;

  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error(`Invalid YAML configuration in ${resolvedPath}`);
  }

  // Resolve recipient environment variables
  const resolvedRecipients: Record<string, string> = {};
  if (rawConfig.recipients && typeof rawConfig.recipients === 'object') {
    for (const [key, val] of Object.entries(rawConfig.recipients)) {
      if (typeof val === 'string' && val.startsWith('$')) {
        const envVarName = val.slice(1);
        resolvedRecipients[key] = (process.env[envVarName] || '').trim();
      } else {
        resolvedRecipients[key] = String(val || '');
      }
    }
  }

  const config: AppConfig = {
    squads: rawConfig.squads || {},
    recipients: resolvedRecipients,
    schedules: rawConfig.schedules || [],
    reminders: rawConfig.reminders || [],
  };

  // Seed default recipients vào store nếu chưa có (F12)
  try {
    const defaultLabels: Record<string, string> = {
      admin: 'Admin',
      squad_main: 'Tiểu đội 2',
      squad_culi: 'Tiểu đội culi',
      platoon_leader: 'Trung đội trưởng',
    };
    const seedList = Object.entries(resolvedRecipients).map(([key, chatId]) => ({
      key,
      display_name: defaultLabels[key] || key,
      chat_id: chatId,
    }));
    seedDefaultRecipients(seedList);
  } catch {
    // Không làm gián đoạn việc load config nếu database chưa được kết nối
  }

  cachedConfig = config;
  return config;
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

export function reloadConfig(configPath?: string): AppConfig {
  return loadConfig(configPath);
}

export function getRecipientChatId(recipientKey: string, config?: AppConfig): string {
  try {
    const fromStore = getRecipient(recipientKey);
    if (fromStore && fromStore.chat_id) {
      return fromStore.chat_id;
    }
  } catch {
    // Dự phòng đọc từ config khi chạy test độc lập không có kết nối DB
  }
  const currentConfig = config || getConfig();
  return currentConfig.recipients[recipientKey] || recipientKey;
}

export function getScheduleConfig(scheduleKey: string, config?: AppConfig): ScheduleConfig | undefined {
  const currentConfig = config || getConfig();
  return currentConfig.schedules.find((s) => s.key === scheduleKey);
}

export function getSquadConfig(squadKey?: string, config?: AppConfig): SquadConfig | undefined {
  if (!squadKey) return undefined;
  const currentConfig = config || getConfig();
  return currentConfig.squads[squadKey];
}
