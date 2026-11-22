import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  ACTIVE_SCAN_STATUSES,
  FINISHED_SCAN_STATUSES,
  RUNNING_SCAN_STATUSES,
  ScanStatusSchema,
  type RefTips,
  type Scan,
  type ScanStatus,
} from '../domain/scan.js';
import { canTransition } from '../domain/scanStateMachine.js';
import { runInTransaction } from './database.js';
import { toScan } from './scanRow.js';
import { toSqlList } from './schema.js';

export type CreateScanResult = { kind: 'created'; scan: Scan } | { kind: 'existing'; scan: Scan };
export type RenewLeaseResult = { kind: 'renewed'; stopRequested: boolean } | { kind: 'lost' };
export type TransitionResult = 'applied' | 'conflict' | 'duplicate_active';

export interface ScanTransition {
  scanId: string;
  from: ScanStatus;
  to: ScanStatus;
  leaseToken: number | null;
  now: Date;
  error?: string | null;
  runAfter?: string | null;
  resetDeliveries?: boolean;
  refundDelivery?: boolean;
}

export interface ScanRepository {
  createScan(repoUrl: string, now: Date): CreateScanResult;
  getScan(scanId: string): Scan | undefined;
  listScans(): Scan[];
  claimNextScan(workerId: string, now: Date, leaseMs: number, maxDeliveries: number): Scan | undefined;
  renewLease(scanId: string, leaseToken: number, now: Date, leaseMs: number): RenewLeaseResult;
  transitionScan(change: ScanTransition): TransitionResult;
  saveRefTips(scanId: string, leaseToken: number, refTips: RefTips, totalCommits: number, now: Date): boolean;
  advanceCheckpoint(
    scanId: string,
    leaseToken: number,
    scannedCommits: number,
    lastScannedSha: string,
    now: Date,
  ): boolean;
  requestStop(scanId: string, now: Date): boolean;
}

const QUEUED = ScanStatusSchema.enum.queued;
const CLONING = ScanStatusSchema.enum.cloning;
const FAILED = ScanStatusSchema.enum.failed;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const RUNNING_SQL_LIST = toSqlList(RUNNING_SCAN_STATUSES);
const IS_FENCED_SQL = `id = :scanId AND leaseToken = :leaseToken AND status IN (${RUNNING_SQL_LIST})`;

export function createScanRepository(db: DatabaseSync): ScanRepository {
  const insertScan = db.prepare(`
    INSERT OR IGNORE INTO scans (id, repoUrl, status, createdAt, updatedAt)
    VALUES (:id, :repoUrl, :status, :now, :now)`);
  const selectScan = db.prepare('SELECT * FROM scans WHERE id = ?');
  const selectActiveScanForRepo = db.prepare(`
    SELECT * FROM scans WHERE repoUrl = ? AND status IN (${toSqlList(ACTIVE_SCAN_STATUSES)})`);
  const selectAllScans = db.prepare('SELECT * FROM scans ORDER BY createdAt DESC, id DESC');
  const failAbandonedScans = db.prepare(`
    UPDATE scans
    SET status = :failed, error = :error, leaseOwner = NULL, leaseExpiresAt = NULL, finishedAt = :now, updatedAt = :now
    WHERE status IN (${RUNNING_SQL_LIST}) AND leaseExpiresAt < :now AND deliveryCount >= :maxDeliveries`);
  const selectClaimableScan = db.prepare(`
    SELECT * FROM scans
    WHERE (status = :queued AND stopRequested = 0 AND (runAfter IS NULL OR runAfter <= :now))
       OR (status IN (${RUNNING_SQL_LIST}) AND leaseExpiresAt < :now)
    ORDER BY createdAt, id
    LIMIT 1`);
  const claimScan = db.prepare(`
    UPDATE scans
    SET status = :cloning, leaseOwner = :workerId, leaseExpiresAt = :leaseExpiresAt, leaseToken = leaseToken + 1,
        deliveryCount = deliveryCount + 1, runAfter = NULL, updatedAt = :now
    WHERE id = :scanId
    RETURNING *`);
  const renewScanLease = db.prepare(`
    UPDATE scans SET leaseExpiresAt = :leaseExpiresAt, updatedAt = :now WHERE ${IS_FENCED_SQL}
    RETURNING stopRequested`);
  const updateRefTips = db.prepare(`
    UPDATE scans SET refTips = :refTips, totalCommits = :totalCommits, updatedAt = :now WHERE ${IS_FENCED_SQL}`);
  const updateCheckpoint = db.prepare(`
    UPDATE scans SET scannedCommits = :scannedCommits, lastScannedSha = :lastScannedSha, deliveryCount = 1,
      updatedAt = :now
    WHERE ${IS_FENCED_SQL}`);
  const setStopRequested = db.prepare(`
    UPDATE scans SET stopRequested = 1, updatedAt = :now WHERE id = :scanId AND status IN (${RUNNING_SQL_LIST})`);

  return {
    createScan(repoUrl, now) {
      return runInTransaction(db, () => {
        const insertResult = insertScan.run({ id: randomUUID(), repoUrl, status: QUEUED, now: now.toISOString() });
        const wasInserted = insertResult.changes > 0;
        const activeScan = toScan(selectActiveScanForRepo.get(repoUrl));
        return wasInserted ? { kind: 'created', scan: activeScan } : { kind: 'existing', scan: activeScan };
      });
    },

    getScan(scanId) {
      const row = selectScan.get(scanId);
      return row === undefined ? undefined : toScan(row);
    },

    listScans() {
      return selectAllScans.all().map(toScan);
    },

    claimNextScan(workerId, now, leaseMs, maxDeliveries) {
      return runInTransaction(db, () => {
        // A crashed worker can't report its failure, so the delivery limit is enforced here: the dead-letter step.
        failAbandonedScans.run({
          failed: FAILED,
          error: toAbandonedScanError(maxDeliveries),
          now: now.toISOString(),
          maxDeliveries,
        });
        const claimableRow = selectClaimableScan.get({ queued: QUEUED, now: now.toISOString() });
        if (claimableRow === undefined) {
          return undefined;
        }
        const claimedRow = claimScan.get({
          scanId: toScan(claimableRow).id,
          cloning: CLONING,
          workerId,
          leaseExpiresAt: addMs(now, leaseMs),
          now: now.toISOString(),
        });
        return toScan(claimedRow);
      });
    },

    renewLease(scanId, leaseToken, now, leaseMs) {
      const renewedRow = renewScanLease.get({
        scanId,
        leaseToken,
        leaseExpiresAt: addMs(now, leaseMs),
        now: now.toISOString(),
      });
      if (renewedRow === undefined) {
        return { kind: 'lost' };
      }
      return { kind: 'renewed', stopRequested: renewedRow.stopRequested === 1 };
    },

    transitionScan(change) {
      if (!canTransition(change.from, change.to)) {
        throw new Error(`Scan ${change.scanId}: transition ${change.from} → ${change.to} is not allowed`);
      }
      const update = buildTransitionUpdate(change);
      try {
        const updateResult = db.prepare(update.sql).run(update.params);
        return updateResult.changes > 0 ? 'applied' : 'conflict';
      } catch (error) {
        // The unique index on active scans per repo rejects the update when the repo already has an active scan.
        if (isUniqueConstraintError(error)) {
          return 'duplicate_active';
        }
        throw error;
      }
    },

    saveRefTips(scanId, leaseToken, refTips, totalCommits, now) {
      const params = { scanId, leaseToken, refTips: JSON.stringify(refTips), totalCommits, now: now.toISOString() };
      return updateRefTips.run(params).changes > 0;
    },

    advanceCheckpoint(scanId, leaseToken, scannedCommits, lastScannedSha, now) {
      const params = { scanId, leaseToken, scannedCommits, lastScannedSha, now: now.toISOString() };
      return updateCheckpoint.run(params).changes > 0;
    },

    requestStop(scanId, now) {
      return setStopRequested.run({ scanId, now: now.toISOString() }).changes > 0;
    },
  };
}

function buildTransitionUpdate(change: ScanTransition): { sql: string; params: Record<string, SQLInputValue> } {
  const assignments = ['status = :to', 'updatedAt = :now'];
  const conditions = ['id = :scanId', 'status = :from'];
  const params: Record<string, SQLInputValue> = {
    scanId: change.scanId,
    from: change.from,
    to: change.to,
    now: change.now.toISOString(),
  };
  if (change.error !== undefined) {
    assignments.push('error = :error');
    params.error = change.error;
  }
  if (change.runAfter !== undefined) {
    assignments.push('runAfter = :runAfter');
    params.runAfter = change.runAfter;
  }
  if (change.resetDeliveries === true) {
    assignments.push('deliveryCount = 0');
  }
  if (change.refundDelivery === true) {
    assignments.push('deliveryCount = MAX(deliveryCount - 1, 0)');
  }
  const isLeavingRunning = RUNNING_SCAN_STATUSES.includes(change.from) && !RUNNING_SCAN_STATUSES.includes(change.to);
  if (isLeavingRunning) {
    assignments.push('leaseOwner = NULL', 'leaseExpiresAt = NULL');
  }
  if (FINISHED_SCAN_STATUSES.includes(change.to)) {
    assignments.push('finishedAt = :now');
  }
  if (change.to === QUEUED) {
    assignments.push('finishedAt = NULL', 'stopRequested = 0');
  }
  if (change.leaseToken !== null) {
    conditions.push('leaseToken = :leaseToken');
    params.leaseToken = change.leaseToken;
  }
  return { sql: `UPDATE scans SET ${assignments.join(', ')} WHERE ${conditions.join(' AND ')}`, params };
}

export function toAbandonedScanError(deliveryCount: number): string {
  return `Scan was abandoned by workers ${deliveryCount} times without progress`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && 'errcode' in error && error.errcode === SQLITE_CONSTRAINT_UNIQUE;
}

function addMs(time: Date, ms: number): string {
  return new Date(time.getTime() + ms).toISOString();
}
