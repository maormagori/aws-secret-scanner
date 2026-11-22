import { beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, openDatabase } from '../../src/db/database.js';
import { createFindingRepository } from '../../src/db/findingRepository.js';
import { createScanRepository, type ScanRepository } from '../../src/db/scanRepository.js';
import { createScanService, type ScanService } from '../../src/services/scanService.js';
import { createTestConfig } from '../helpers/testConfig.js';

const config = createTestConfig();
const repoUrl = 'https://github.com/octo/repo';
const now = new Date('2026-01-01T00:00:00.000Z');

describe('scanService', () => {
  let scanRepository: ScanRepository;
  let service: ScanService;

  beforeEach(() => {
    const db = openDatabase(IN_MEMORY_DATABASE);
    scanRepository = createScanRepository(db);
    service = createScanService({ scanRepository, findingRepository: createFindingRepository(db), now: () => now });
  });

  function createQueuedScanId(): string {
    const outcome = service.createScan(repoUrl);
    if (outcome.kind === 'invalid') {
      throw new Error(outcome.reason);
    }
    return outcome.scan.id;
  }

  function claimScan(): { scanId: string; leaseToken: number } {
    const scanId = createQueuedScanId();
    const claimed = scanRepository.claimNextScan('worker-1', now, config.leaseMs, config.maxDeliveries);
    if (claimed === undefined) {
      throw new Error('Expected a claimable scan');
    }
    return { scanId, leaseToken: claimed.leaseToken };
  }

  it('normalizes the repo URL and dedupes an active scan', () => {
    const first = service.createScan('octo/Repo');
    const second = service.createScan(`${repoUrl}.git`);

    expect(first).toMatchObject({ kind: 'created', scan: { repoUrl } });
    expect(second.kind).toBe('existing');
    if (first.kind !== 'invalid' && second.kind !== 'invalid') {
      expect(second.scan.id).toBe(first.scan.id);
    }
  });

  it('rejects an invalid repo URL', () => {
    expect(service.createScan('not a repo').kind).toBe('invalid');
  });

  it('asks a running scan to stop instead of stopping it', () => {
    const { scanId } = claimScan();

    const outcome = service.stopScan(scanId);

    expect(outcome).toMatchObject({ kind: 'stopping', scan: { status: 'cloning', stopRequested: true } });
  });

  it('resumes a failed scan with its deliveryCount reset and error cleared', () => {
    const { scanId, leaseToken } = claimScan();
    scanRepository.transitionScan({ scanId, from: 'cloning', to: 'failed', leaseToken, now, error: 'boom' });

    const outcome = service.resumeScan(scanId);

    expect(outcome).toMatchObject({ kind: 'queued', scan: { status: 'queued', deliveryCount: 0, error: null } });
  });

  it('refuses to resume when the repo already has another active scan', () => {
    const stoppedScanId = createQueuedScanId();
    service.stopScan(stoppedScanId);
    createQueuedScanId();

    expect(service.resumeScan(stoppedScanId)).toEqual({ kind: 'conflict' });
  });

  it('refuses to resume a queued scan', () => {
    expect(service.resumeScan(createQueuedScanId())).toEqual({ kind: 'invalid_state', status: 'queued' });
  });

  it('returns not_found for unknown scans', () => {
    expect(service.stopScan('missing').kind).toBe('not_found');
    expect(service.resumeScan('missing').kind).toBe('not_found');
    expect(service.listFindings('missing', null, 10).kind).toBe('not_found');
  });
});
