import { beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, openDatabase } from '../../src/db/database.js';
import { createScanRepository, toAbandonedScanError, type ScanRepository } from '../../src/db/scanRepository.js';
import { createTestConfig } from '../helpers/testConfig.js';

const config = createTestConfig();
const repoUrl = 'https://github.com/octo/repo';
const start = new Date('2026-01-01T00:00:00.000Z');

function later(ms: number): Date {
  return new Date(start.getTime() + ms);
}

describe('scanRepository', () => {
  let scans: ScanRepository;

  beforeEach(() => {
    scans = createScanRepository(openDatabase(IN_MEMORY_DATABASE));
  });

  function claimFirstScan(): { scanId: string; leaseToken: number } {
    const created = scans.createScan(repoUrl, start);
    const claimed = scans.claimNextScan('worker-1', start, config.leaseMs, config.maxDeliveries);
    expect(claimed?.id).toBe(created.scan.id);
    return { scanId: created.scan.id, leaseToken: claimed?.leaseToken ?? -1 };
  }

  describe('createScan', () => {
    it('returns the active scan when the same repo is created twice', () => {
      const first = scans.createScan(repoUrl, start);
      const second = scans.createScan(repoUrl, later(1));

      expect(first.kind).toBe('created');
      expect(first.scan.status).toBe('queued');
      expect(second).toEqual({ kind: 'existing', scan: first.scan });
      expect(scans.listScans()).toHaveLength(1);
    });

    it('creates a new scan once the previous one finished', () => {
      const first = scans.createScan(repoUrl, start);
      scans.transitionScan({ scanId: first.scan.id, from: 'queued', to: 'stopped', leaseToken: null, now: start });

      const second = scans.createScan(repoUrl, later(1));

      expect(second.kind).toBe('created');
      expect(scans.listScans().map((scan) => scan.id)).toEqual([second.scan.id, first.scan.id]);
    });
  });

  describe('claimNextScan', () => {
    it('lets only one claim take a scan', () => {
      const { leaseToken } = claimFirstScan();

      expect(leaseToken).toBe(1);
      expect(scans.claimNextScan('worker-2', start, config.leaseMs, config.maxDeliveries)).toBeUndefined();
    });

    it('sets the lease, status and deliveryCount on claim', () => {
      const { scanId } = claimFirstScan();

      const scan = scans.getScan(scanId);
      expect(scan).toMatchObject({ status: 'cloning', leaseOwner: 'worker-1', deliveryCount: 1, leaseToken: 1 });
      expect(scan?.leaseExpiresAt).toBe(later(config.leaseMs).toISOString());
    });

    it('does not claim a scan whose runAfter is in the future', () => {
      const { scanId, leaseToken } = claimFirstScan();
      const runAfter = later(config.retryBaseMs).toISOString();
      scans.transitionScan({ scanId, from: 'cloning', to: 'queued', leaseToken, now: start, runAfter });

      expect(scans.claimNextScan('worker-2', later(1), config.leaseMs, config.maxDeliveries)).toBeUndefined();
      expect(scans.claimNextScan('worker-2', later(config.retryBaseMs), config.leaseMs, config.maxDeliveries)?.id).toBe(scanId);
    });

    it('reclaims an expired lease with a higher leaseToken', () => {
      const { scanId, leaseToken } = claimFirstScan();

      expect(scans.claimNextScan('worker-2', later(config.leaseMs - 1), config.leaseMs, config.maxDeliveries)).toBeUndefined();
      const reclaimed = scans.claimNextScan('worker-2', later(config.leaseMs + 1), config.leaseMs, config.maxDeliveries);

      expect(reclaimed?.id).toBe(scanId);
      expect(reclaimed?.leaseToken).toBe(leaseToken + 1);
      expect(reclaimed?.deliveryCount).toBe(2);
      expect(reclaimed?.leaseOwner).toBe('worker-2');
    });

    it('fails a scan whose lease expired maxDeliveries times instead of claiming it again', () => {
      const { scanId } = claimFirstScan();
      const maxDeliveries = 2;
      scans.claimNextScan('worker-2', later(config.leaseMs + 1), config.leaseMs, maxDeliveries);

      const thirdClaimAt = later(2 * config.leaseMs + 2);
      expect(scans.claimNextScan('worker-3', thirdClaimAt, config.leaseMs, maxDeliveries)).toBeUndefined();

      expect(scans.getScan(scanId)).toMatchObject({
        status: 'failed',
        deliveryCount: maxDeliveries,
        error: toAbandonedScanError(maxDeliveries),
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: thirdClaimAt.toISOString(),
      });
    });

    it('reclaims a crashed scan that made progress, since progress resets deliveryCount', () => {
      const { scanId } = claimFirstScan();
      const maxDeliveries = 2;
      const second = scans.claimNextScan('worker-2', later(config.leaseMs + 1), config.leaseMs, maxDeliveries);
      scans.advanceCheckpoint(scanId, second?.leaseToken ?? -1, 5, 'abc', later(config.leaseMs + 2));
      expect(scans.getScan(scanId)?.deliveryCount).toBe(1);

      const third = scans.claimNextScan('worker-3', later(2 * config.leaseMs + 2), config.leaseMs, maxDeliveries);

      expect(third).toMatchObject({ id: scanId, status: 'cloning', deliveryCount: 2, scannedCommits: 5 });
    });
  });

  describe('fencing with an old leaseToken', () => {
    function reclaimByAnotherWorker(): { scanId: string; oldToken: number; newToken: number } {
      const { scanId, leaseToken } = claimFirstScan();
      const reclaimed = scans.claimNextScan('worker-2', later(config.leaseMs + 1), config.leaseMs, config.maxDeliveries);
      return { scanId, oldToken: leaseToken, newToken: reclaimed?.leaseToken ?? -1 };
    }

    it('loses the lease on renew', () => {
      const { scanId, oldToken, newToken } = reclaimByAnotherWorker();
      const now = later(config.leaseMs + 2);

      expect(scans.renewLease(scanId, oldToken, now, config.leaseMs)).toEqual({ kind: 'lost' });
      expect(scans.renewLease(scanId, newToken, now, config.leaseMs)).toEqual({
        kind: 'renewed',
        stopRequested: false,
      });
    });

    it('gets a conflict on transition', () => {
      const { scanId, oldToken } = reclaimByAnotherWorker();
      const change = { scanId, from: 'cloning', to: 'scanning', leaseToken: oldToken, now: later(1) } as const;

      expect(scans.transitionScan(change)).toBe('conflict');
      expect(scans.getScan(scanId)?.status).toBe('cloning');
    });

    it('does not advance the checkpoint or save ref tips', () => {
      const { scanId, oldToken, newToken } = reclaimByAnotherWorker();
      const now = later(1);

      expect(scans.advanceCheckpoint(scanId, oldToken, 5, 'abc', now)).toBe(false);
      expect(scans.saveRefTips(scanId, oldToken, { 'refs/heads/main': 'abc' }, 10, now)).toBe(false);
      expect(scans.getScan(scanId)).toMatchObject({ scannedCommits: 0, refTips: null, totalCommits: null });

      expect(scans.saveRefTips(scanId, newToken, { 'refs/heads/main': 'abc' }, 10, now)).toBe(true);
      expect(scans.advanceCheckpoint(scanId, newToken, 5, 'abc', now)).toBe(true);
      expect(scans.getScan(scanId)).toMatchObject({
        scannedCommits: 5,
        lastScannedSha: 'abc',
        refTips: { 'refs/heads/main': 'abc' },
        totalCommits: 10,
      });
    });
  });

  describe('transitionScan', () => {
    it('throws on a disallowed transition', () => {
      const { scan } = scans.createScan(repoUrl, start);

      expect(() =>
        scans.transitionScan({ scanId: scan.id, from: 'queued', to: 'completed', leaseToken: null, now: start }),
      ).toThrow(/not allowed/);
    });

    it('clears the lease and sets finishedAt when the scan completes', () => {
      const { scanId, leaseToken } = claimFirstScan();
      scans.transitionScan({ scanId, from: 'cloning', to: 'scanning', leaseToken, now: later(1) });

      expect(scans.transitionScan({ scanId, from: 'scanning', to: 'completed', leaseToken, now: later(2) })).toBe(
        'applied',
      );
      expect(scans.getScan(scanId)).toMatchObject({
        status: 'completed',
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: later(2).toISOString(),
      });
    });

    it('resumes a failed scan: clears finishedAt and stopRequested, resets deliveryCount', () => {
      const { scanId, leaseToken } = claimFirstScan();
      scans.requestStop(scanId, start);
      scans.transitionScan({ scanId, from: 'cloning', to: 'failed', leaseToken, now: later(1), error: 'boom' });

      const resumed = scans.transitionScan({
        scanId,
        from: 'failed',
        to: 'queued',
        leaseToken: null,
        now: later(2),
        error: null,
        resetDeliveries: true,
      });

      expect(resumed).toBe('applied');
      expect(scans.getScan(scanId)).toMatchObject({
        status: 'queued',
        deliveryCount: 0,
        error: null,
        finishedAt: null,
        stopRequested: false,
      });
    });

    it('returns duplicate_active when resuming a scan whose repo has another active scan', () => {
      const first = scans.createScan(repoUrl, start);
      scans.transitionScan({ scanId: first.scan.id, from: 'queued', to: 'stopped', leaseToken: null, now: start });
      scans.createScan(repoUrl, later(1));

      const resumed = scans.transitionScan({
        scanId: first.scan.id,
        from: 'stopped',
        to: 'queued',
        leaseToken: null,
        now: later(2),
      });

      expect(resumed).toBe('duplicate_active');
      expect(scans.getScan(first.scan.id)?.status).toBe('stopped');
    });

    it('refunds the delivery when a scan is released on shutdown', () => {
      const { scanId, leaseToken } = claimFirstScan();

      scans.transitionScan({ scanId, from: 'cloning', to: 'queued', leaseToken, now: later(1), refundDelivery: true });

      expect(scans.getScan(scanId)).toMatchObject({ status: 'queued', deliveryCount: 0, leaseOwner: null });
    });
  });

  describe('requestStop', () => {
    it('flags a running scan and the next renew reports it', () => {
      const { scanId, leaseToken } = claimFirstScan();

      expect(scans.requestStop(scanId, start)).toBe(true);
      expect(scans.renewLease(scanId, leaseToken, later(1), config.leaseMs)).toEqual({
        kind: 'renewed',
        stopRequested: true,
      });
    });

    it('does nothing on a scan that is not running', () => {
      const { scan } = scans.createScan(repoUrl, start);

      expect(scans.requestStop(scan.id, start)).toBe(false);
    });
  });
});
