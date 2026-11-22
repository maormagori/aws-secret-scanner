import { ACTIVE_SCAN_STATUSES } from '../domain/scan.js';

export function toSqlList(values: readonly string[]): string {
  const quotedValues = values.map((value) => `'${value}'`);
  return quotedValues.join(', ');
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  repoUrl TEXT NOT NULL,
  status TEXT NOT NULL,
  refTips TEXT,
  totalCommits INTEGER,
  scannedCommits INTEGER NOT NULL DEFAULT 0,
  lastScannedSha TEXT,
  deliveryCount INTEGER NOT NULL DEFAULT 0,
  leaseOwner TEXT,
  leaseExpiresAt TEXT,
  leaseToken INTEGER NOT NULL DEFAULT 0,
  stopRequested INTEGER NOT NULL DEFAULT 0,
  runAfter TEXT,
  error TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  finishedAt TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS scans_one_active_per_repo
  ON scans (repoUrl) WHERE status IN (${toSqlList(ACTIVE_SCAN_STATUSES)});

CREATE INDEX IF NOT EXISTS scans_status_run_after ON scans (status, runAfter);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanId TEXT NOT NULL REFERENCES scans (id),
  commitSha TEXT NOT NULL,
  commitMessage TEXT NOT NULL,
  committedAt TEXT NOT NULL,
  committerName TEXT NOT NULL,
  committerEmail TEXT NOT NULL,
  authorName TEXT NOT NULL,
  authorEmail TEXT NOT NULL,
  filePath TEXT NOT NULL,
  lineNumber INTEGER NOT NULL,
  leakType TEXT NOT NULL,
  leakValue TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS findings_unique_leak
  ON findings (scanId, commitSha, filePath, lineNumber, leakValue);
`;
