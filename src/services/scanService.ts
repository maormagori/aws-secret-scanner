import type { FindingRepository } from '../db/findingRepository.js';
import type { CreateScanResult, ScanRepository } from '../db/scanRepository.js';
import type { Finding } from '../domain/finding.js';
import { parseRepoUrl } from '../domain/repoUrl.js';
import { ScanStatusSchema, type Scan, type ScanStatus } from '../domain/scan.js';

export type CreateScanOutcome = { kind: 'invalid'; reason: string } | CreateScanResult;
export type ListFindingsOutcome =
  { kind: 'not_found' } | { kind: 'page'; findings: Finding[]; nextCursor: number | null };
export type StopScanOutcome =
  | { kind: 'stopping'; scan: Scan }
  | { kind: 'stopped'; scan: Scan }
  | { kind: 'not_found' }
  | { kind: 'invalid_state'; status: ScanStatus };
export type ResumeScanOutcome =
  | { kind: 'queued'; scan: Scan }
  | { kind: 'not_found' }
  | { kind: 'invalid_state'; status: ScanStatus }
  | { kind: 'conflict' };

export interface ScanService {
  createScan(rawRepoUrl: string): CreateScanOutcome;
  getScan(scanId: string): Scan | undefined;
  listScans(): Scan[];
  listFindings(scanId: string, cursor: number | null, limit: number): ListFindingsOutcome;
  stopScan(scanId: string): StopScanOutcome;
  resumeScan(scanId: string): ResumeScanOutcome;
}

interface ScanServiceDeps {
  scanRepository: ScanRepository;
  findingRepository: FindingRepository;
  now?: () => Date;
}

const { queued: QUEUED, stopped: STOPPED, failed: FAILED } = ScanStatusSchema.enum;

export function createScanService({
  scanRepository,
  findingRepository,
  now = () => new Date(),
}: ScanServiceDeps): ScanService {
  // Scans are never deleted, so a scan we just read is still there when we read it again.
  function readScan(scanId: string): Scan {
    const scan = scanRepository.getScan(scanId);
    if (scan === undefined) {
      throw new Error(`Scan ${scanId} disappeared while it was being updated`);
    }
    return scan;
  }

  function toInvalidState(scanId: string): { kind: 'invalid_state'; status: ScanStatus } {
    return { kind: 'invalid_state', status: readScan(scanId).status };
  }

  function stopQueuedScan(scanId: string): StopScanOutcome {
    const result = scanRepository.transitionScan({ scanId, from: QUEUED, to: STOPPED, leaseToken: null, now: now() });
    if (result !== 'applied') {
      return toInvalidState(scanId);
    }
    return { kind: 'stopped', scan: readScan(scanId) };
  }

  function requestStopOfRunningScan(scanId: string): StopScanOutcome {
    const wasRequested = scanRepository.requestStop(scanId, now());
    if (!wasRequested) {
      return toInvalidState(scanId);
    }
    return { kind: 'stopping', scan: readScan(scanId) };
  }

  function requeueScan(scan: Scan): ResumeScanOutcome {
    const result = scanRepository.transitionScan({
      scanId: scan.id,
      from: scan.status,
      to: QUEUED,
      leaseToken: null,
      now: now(),
      error: null,
      resetDeliveries: true,
    });
    switch (result) {
      case 'applied':
        return { kind: 'queued', scan: readScan(scan.id) };
      case 'conflict':
        return toInvalidState(scan.id);
      case 'duplicate_active':
        return { kind: 'conflict' };
    }
  }

  return {
    createScan(rawRepoUrl) {
      const parsed = parseRepoUrl(rawRepoUrl);
      if (parsed.kind === 'invalid') {
        return parsed;
      }
      return scanRepository.createScan(parsed.repoUrl, now());
    },

    getScan(scanId) {
      return scanRepository.getScan(scanId);
    },

    listScans() {
      return scanRepository.listScans();
    },

    listFindings(scanId, cursor, limit) {
      if (scanRepository.getScan(scanId) === undefined) {
        return { kind: 'not_found' };
      }
      const findings = findingRepository.listFindings(scanId, cursor, limit);
      const lastFinding = findings.at(-1);
      const isFullPage = findings.length === limit;
      const nextCursor = isFullPage && lastFinding !== undefined ? lastFinding.id : null;
      return { kind: 'page', findings, nextCursor };
    },

    stopScan(scanId) {
      const scan = scanRepository.getScan(scanId);
      if (scan === undefined) {
        return { kind: 'not_found' };
      }
      switch (scan.status) {
        case 'queued':
          return stopQueuedScan(scanId);
        case 'cloning':
        case 'scanning':
          return requestStopOfRunningScan(scanId);
        default:
          return { kind: 'invalid_state', status: scan.status };
      }
    },

    resumeScan(scanId) {
      const scan = scanRepository.getScan(scanId);
      if (scan === undefined) {
        return { kind: 'not_found' };
      }
      const isResumable = scan.status === STOPPED || scan.status === FAILED;
      if (!isResumable) {
        return { kind: 'invalid_state', status: scan.status };
      }
      return requeueScan(scan);
    },
  };
}
