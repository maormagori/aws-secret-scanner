import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
import { IN_MEMORY_DATABASE, openDatabase } from '../../src/db/database.js';
import { createFindingRepository } from '../../src/db/findingRepository.js';
import { createScanRepository, type ScanRepository } from '../../src/db/scanRepository.js';
import { GitCommandError } from '../../src/git/gitTypes.js';
import { createLogger } from '../../src/logger.js';
import { createScanRunner, getCloneDir } from '../../src/scanner/scanRunner.js';
import { createWorkerPool, type WorkerPool } from '../../src/worker/workerPool.js';
import { createFakeCommit, createFakeGitClient, waitForAbort, type FakeGitScript } from '../helpers/fakeGitClient.js';
import { createTestConfig } from '../helpers/testConfig.js';

const repoUrl = 'https://github.com/octo/repo';
const start = new Date('2026-01-01T00:00:00.000Z');

describe('workerPool', () => {
  let config: Config;
  let scanRepository: ScanRepository;
  let pool: WorkerPool | undefined;
  let clock: Date;

  beforeEach(async () => {
    const clonesDir = await mkdtemp(join(tmpdir(), 'worker-pool-'));
    config = createTestConfig({ clonesDir, workerConcurrency: 1, pollMs: 10, leaseMs: 300, maxDeliveries: 2 });
    clock = start;
  });

  afterEach(async () => {
    await pool?.stop();
    await rm(config.clonesDir, { recursive: true, force: true });
  });

  function startPool(script: Partial<FakeGitScript>): Promise<void> {
    const db = openDatabase(IN_MEMORY_DATABASE);
    scanRepository = createScanRepository(db);
    const gitClient = createFakeGitClient({
      refTips: { 'refs/heads/main': 'c1' },
      commitsNewestFirst: [createFakeCommit('c1', 100)],
      ...script,
    });
    const logger = createLogger(config, 'worker');
    const scanRunner = createScanRunner({
      config,
      logger,
      db,
      scanRepository,
      findingRepository: createFindingRepository(db),
      gitClient,
      detectLeaks: () => [],
    });
    pool = createWorkerPool({ config, logger, scanRepository, scanRunner, now: () => clock });
    return pool.start();
  }

  function msAfterStart(ms: number): Date {
    return new Date(start.getTime() + ms);
  }

  function claimAsStalledWorker(scanId: string): number {
    const claimed = scanRepository.claimNextScan('stalled-worker', clock, config.leaseMs, config.maxDeliveries);
    expect(claimed?.id).toBe(scanId);
    return claimed?.leaseToken ?? -1;
  }

  it('completes a scan and deletes its clone dir', async () => {
    await startPool({
      onClone: async (targetDir) => {
        await mkdir(targetDir, { recursive: true });
      },
    });
    const { scan } = scanRepository.createScan(repoUrl, start);

    await vi.waitFor(() => expect(scanRepository.getScan(scan.id)?.status).toBe('completed'));
    const claimedLeaseToken = 1;
    expect(existsSync(getCloneDir(config, scan.id, claimedLeaseToken))).toBe(false);
  });

  it('clones each claim into its own dir and leaves the stalled owner its dir', async () => {
    const cloneDirs: string[] = [];
    await startPool({
      onClone: async (targetDir) => {
        cloneDirs.push(targetDir);
        await mkdir(targetDir, { recursive: true });
      },
    });
    const { scan } = scanRepository.createScan(repoUrl, start);
    const stalledLeaseToken = claimAsStalledWorker(scan.id);
    const stalledCloneDir = getCloneDir(config, scan.id, stalledLeaseToken);
    await mkdir(stalledCloneDir, { recursive: true });

    clock = msAfterStart(config.leaseMs + 1);
    await vi.waitFor(() => expect(scanRepository.getScan(scan.id)?.status).toBe('completed'));

    const newCloneDir = getCloneDir(config, scan.id, stalledLeaseToken + 1);
    expect(cloneDirs).toEqual([newCloneDir]);
    expect(existsSync(newCloneDir)).toBe(false);
    expect(existsSync(stalledCloneDir)).toBe(true);
  });

  it('retries a scan that made progress after 2 crashes instead of failing it', async () => {
    config = { ...config, batchSize: 1, maxDeliveries: 3 };
    await startPool({
      commitsNewestFirst: [createFakeCommit('c1', 200), createFakeCommit('c2', 100)],
      onStreamPage: (pageIndex) => {
        if (pageIndex === 1) {
          throw new GitCommandError('fetch timed out', true);
        }
      },
    });
    const { scan } = scanRepository.createScan(repoUrl, start);
    claimAsStalledWorker(scan.id);
    clock = msAfterStart(config.leaseMs + 1);
    claimAsStalledWorker(scan.id);

    clock = msAfterStart(2 * config.leaseMs + 2);
    await vi.waitFor(() =>
      expect(scanRepository.getScan(scan.id)).toMatchObject({
        status: 'queued',
        deliveryCount: 1,
        scannedCommits: 1,
        error: 'fetch timed out',
        runAfter: new Date(clock.getTime() + config.retryBaseMs).toISOString(),
      }),
    );
  });

  it('re-queues a retryable failure with backoff, then fails after maxDeliveries', async () => {
    await startPool({
      onClone: () => {
        throw new GitCommandError('clone timed out', true);
      },
    });
    const { scan } = scanRepository.createScan(repoUrl, start);

    await vi.waitFor(() =>
      expect(scanRepository.getScan(scan.id)).toMatchObject({
        status: 'queued',
        deliveryCount: 1,
        error: 'clone timed out',
        runAfter: msAfterStart(config.retryBaseMs).toISOString(),
      }),
    );

    clock = msAfterStart(config.retryBaseMs);
    await vi.waitFor(() =>
      expect(scanRepository.getScan(scan.id)).toMatchObject({ status: 'failed', deliveryCount: 2, error: 'clone timed out' }),
    );
  });

  it('releases a running scan to queued on stop() without counting a delivery', async () => {
    await startPool({
      onClone: async (targetDir, signal) => {
        await mkdir(targetDir, { recursive: true });
        await waitForAbort(signal);
      },
    });
    const { scan } = scanRepository.createScan(repoUrl, start);
    const claimedLeaseToken = 1;
    const cloneDir = getCloneDir(config, scan.id, claimedLeaseToken);
    await vi.waitFor(() => expect(existsSync(cloneDir)).toBe(true));

    await pool?.stop();

    expect(scanRepository.getScan(scan.id)).toMatchObject({ status: 'queued', deliveryCount: 0, leaseOwner: null });
    expect(existsSync(cloneDir)).toBe(false);
  });
});
