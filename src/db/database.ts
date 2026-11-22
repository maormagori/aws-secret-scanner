import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

export const IN_MEMORY_DATABASE = ':memory:';
const BUSY_TIMEOUT_MS = 5000;

export function openDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  // WAL lets the api and worker processes read while one of them writes; it does not apply to in-memory databases.
  if (filePath !== IN_MEMORY_DATABASE) {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

export function runInTransaction<T>(db: DatabaseSync, work: () => T): T {
  // IMMEDIATE takes the write lock up front, so two processes can't both read the same row and then write it.
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
