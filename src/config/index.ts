import fs from 'fs';
import path from 'path';
import * as jsYaml from 'js-yaml';
import dotenv from 'dotenv';
import { AppConfig, SquadConfig, ScheduleConfig } from '../types';

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
        resolvedRecipients[key] = process.env[envVarName] || '';
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
