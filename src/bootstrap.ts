import { mkdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, type Config } from './config.js';
import { openDatabase } from './db/database.js';
import { createFindingRepository, type FindingRepository } from './db/findingRepository.js';
import { createScanRepository, type ScanRepository } from './db/scanRepository.js';
import { createLogger, type Logger } from './logger.js';

export type AppRole = 'api' | 'worker';

export interface AppContext {
  config: Config;
  logger: Logger;
  db: DatabaseSync;
  scanRepository: ScanRepository;
  findingRepository: FindingRepository;
}

export async function createAppContext(role: AppRole): Promise<AppContext> {
  const config = loadConfig(process.env);
  const logger = createLogger(config, role);
  await mkdir(config.dataDir, { recursive: true });
  const db = openDatabase(config.databaseFile);
  return {
    config,
    logger,
    db,
    scanRepository: createScanRepository(db),
    findingRepository: createFindingRepository(db),
  };
}

export function handleShutdownSignals(context: AppContext, stop: () => Promise<void>): void {
  async function shutDown(signalName: string): Promise<void> {
    context.logger.info({ signalName }, 'Shutting down');
    await stop();
    // Closed last: stop() still writes to the DB (a worker releases its scans).
    context.db.close();
    process.exit(0);
  }
  process.once('SIGTERM', (signalName) => void shutDown(signalName));
  process.once('SIGINT', (signalName) => void shutDown(signalName));
}
