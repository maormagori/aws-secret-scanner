import { pino, type Logger } from 'pino';
import type { AppRole } from './bootstrap.js';
import type { Config } from './config.js';

export type { Logger };

export function createLogger(config: Config, role: AppRole): Logger {
  return pino({ level: config.logLevel, msgPrefix: `[${role}] `, base: { role } });
}
