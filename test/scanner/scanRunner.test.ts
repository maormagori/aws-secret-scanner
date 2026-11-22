import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, openDatabase } from '../../src/db/database.js';
import { createFindingRepository, type FindingRepository } from '../../src/db/findingRepository.js';
import { createScanRepository, type ScanRepository } from '../../src/db/scanRepository.js';
import { LeakTypeSchema } from '../../src/domain/finding.js';
import type { Scan } from '../../src/domain/scan.js';
import { createLogger } from '../../src/logger.js';
import type { AddedLine } from '../../src/git/gitTypes.js';
import type { DetectedLeak } from '../../src/scanner/detector.js';
import {
  HISTORY_CHANGED_ERROR,
  createScanRunner,
  type RunControl,
  type ScanRunner,
} from '../../src/scanner/scanRunner.js';
import {
  createFakeCommit,
  createFakeGitClient,
  type FakeGitClient,
  type FakeGitScript,
} from '../helpers/fakeGitClient.js';
import { createTestConfig } from '../helpers/testConfig.js';

const LEAK_MARKER = 'AKIA';
const repoUrl = 'https://github.com/octo/repo';
const refTips = { 'refs/heads/main': 'c1' };
const commitsNewestFirst = [
  createFakeCommit('c1', 500, [{ filePath: 'a.env', lineNumber: 1, text: 'AKIA-one' }]),
  createFakeCommit('c2', 400),
  createFakeCommit('c3', 300, [{ filePath: 'b.env', lineNumber: 7, text: 'AKIA-three' }]),
  createFakeCommit('c4', 200),
  createFakeCommit('c5', 100, [{ filePath: 'c.env', lineNumber: 2, text: 'AKIA-five' }]),
];

function detectTestLeaks(line: string): DetectedLeak[] {
  if (!line.includes(LEAK_MARKER)) {
    return [];
  }
  return [{ leakType: LeakTypeSchema.enum.aws_access_key_id, leakValue: line }];
}

function runningControl(): RunControl {
  return { signal: new AbortController().signal, shouldStop: () => false };
}

describe('scanRunner', () => {
  let clonesDir: string;
  let db: DatabaseSync;
  let scanRepository: ScanRepository;
  let findingRepository: FindingRepository;

  beforeEach(async () => {
    clonesDir = await mkdtemp(join(tmpdir(), 'scan-runner-'));
    db = openDatabase(IN_MEMORY_DATABASE);
    scanRepository = createScanRepository(db);
    findingRepository = createFindingRepository(db);
  });

  afterEach(async () => {
    await rm(clonesDir, { recursive: true, force: true });
  });

  function createRunner(script: Partial<FakeGitScript> = {}): {
    runScan: ScanRunner['runScan'];
    gitClient: FakeGitClient;
  } {
    const config = createTestConfig({ clonesDir, batchSize: 2 });
    const gitClient = createFakeGitClient({ refTips, commitsNewestFirst, ...script });
    const runner = createScanRunner({
      config,
      logger: createLogger(config, 'worker'),
      db,
      scanRepository,
      findingRepository,
      gitClient,
      detectLeaks: detectTestLeaks,
    });
    return { runScan: runner.runScan, gitClient };
  }

  function claimNewScan(): Scan {
    const config = createTestConfig();
    scanRepository.createScan(repoUrl, new Date());
    const claimed = scanRepository.claimNextScan('worker-1', new Date(), config.leaseMs, config.maxDeliveries);
    if (claimed === undefined) {
      throw new Error('Test setup: no scan was claimed');
    }
    return claimed;
  }

  function claimScanWithCheckpoint(scannedCommits: number, lastScannedSha: string): Scan {
    const claimed = claimNewScan();
    scanRepository.saveRefTips(claimed.id, claimed.leaseToken, refTips, commitsNewestFirst.length, new Date());
    scanRepository.advanceCheckpoint(claimed.id, claimed.leaseToken, scannedCommits, lastScannedSha, new Date());
    const scan = scanRepository.getScan(claimed.id);
    if (scan === undefined) {
      throw new Error('Test setup: scan disappeared');
    }
    return scan;
  }

  function storedLeakValues(scanId: string): string[] {
    return findingRepository.listFindings(scanId, null, 100).map((finding) => finding.leakValue);
  }

  it('scans every page, stores findings and advances the checkpoint to the end', async () => {
    const { runScan, gitClient } = createRunner();
    const scan = claimNewScan();

    const outcome = await runScan(scan, runningControl());

    expect(outcome).toEqual({ kind: 'completed' });
    expect(gitClient.streamedPages).toEqual([['c1', 'c2'], ['c3', 'c4'], ['c5']]);
    expect(storedLeakValues(scan.id)).toEqual(['AKIA-one', 'AKIA-three', 'AKIA-five']);
    expect(scanRepository.getScan(scan.id)).toMatchObject({
      status: 'scanning',
      refTips,
      totalCommits: 5,
      scannedCommits: 5,
      lastScannedSha: 'c5',
    });
    const [firstFinding] = findingRepository.listFindings(scan.id, null, 1);
    expect(firstFinding).toMatchObject({ commitSha: 'c1', filePath: 'a.env', lineNumber: 1, authorName: 'Author' });
  });

  it('resumes after the checkpoint', async () => {
    const { runScan, gitClient } = createRunner();
    const scan = claimScanWithCheckpoint(2, 'c2');

    const outcome = await runScan(scan, runningControl());

    expect(outcome).toEqual({ kind: 'completed' });
    expect(gitClient.streamedPages).toEqual([['c3', 'c4'], ['c5']]);
    expect(storedLeakValues(scan.id)).toEqual(['AKIA-three', 'AKIA-five']);
  });

  it('keeps the first page when git crashes on the second', async () => {
    const { runScan } = createRunner({
      onStreamPage: (pageIndex) => {
        if (pageIndex === 1) {
          throw new Error('network down');
        }
      },
    });
    const scan = claimNewScan();

    const outcome = await runScan(scan, runningControl());

    expect(outcome).toEqual({ kind: 'failed', status: 'scanning', error: 'network down', isRetryable: true });
    expect(storedLeakValues(scan.id)).toEqual(['AKIA-one']);
    expect(scanRepository.getScan(scan.id)).toMatchObject({ scannedCommits: 2, lastScannedSha: 'c2' });
  });

  it('fails without retry when a frozen ref tip is gone', async () => {
    const { runScan, gitClient } = createRunner({ hasAllCommits: false });
    const scan = claimScanWithCheckpoint(2, 'c2');

    const outcome = await runScan(scan, runningControl());

    expect(outcome).toEqual({ kind: 'failed', status: 'cloning', error: HISTORY_CHANGED_ERROR, isRetryable: false });
    expect(gitClient.streamedPages).toEqual([]);
  });

  it('fails without retry when the checkpoint commit moved', async () => {
    const { runScan } = createRunner();
    const scan = claimScanWithCheckpoint(2, 'c3');

    const outcome = await runScan(scan, runningControl());

    expect(outcome).toEqual({ kind: 'failed', status: 'cloning', error: HISTORY_CHANGED_ERROR, isRetryable: false });
  });

  it('reports lost and writes nothing once another worker took the lease', async () => {
    const { runScan } = createRunner({
      onStreamPage: (pageIndex) => {
        if (pageIndex === 1) {
          db.exec('UPDATE scans SET leaseToken = leaseToken + 1');
        }
      },
    });
    const scan = claimNewScan();

    const outcome = await runScan(scan, runningControl());

    expect(outcome).toEqual({ kind: 'lost' });
    expect(storedLeakValues(scan.id)).toEqual(['AKIA-one']);
    expect(scanRepository.getScan(scan.id)).toMatchObject({ scannedCommits: 2 });
  });

  it('stores every finding of a commit with ~150,000 leaks', async () => {
    const leakCount = 150_000;
    const addedLines: AddedLine[] = [];
    for (let lineNumber = 1; lineNumber <= leakCount; lineNumber++) {
      addedLines.push({ filePath: 'huge.env', lineNumber, text: 'AKIA-many' });
    }
    const { runScan } = createRunner({ commitsNewestFirst: [createFakeCommit('c1', 500, addedLines)] });
    const scan = claimNewScan();

    const outcome = await runScan(scan, runningControl());

    expect(outcome).toEqual({ kind: 'completed' });
    expect(db.prepare('SELECT COUNT(*) AS findingCount FROM findings').get()).toEqual({ findingCount: leakCount });
  });

  it('rolls back the checkpoint and every finding of a page when one insert fails', async () => {
    const refusedLeak = 'AKIA-refused';
    db.exec(`
      CREATE TRIGGER refuse_marked_finding BEFORE INSERT ON findings WHEN NEW.leakValue = '${refusedLeak}'
      BEGIN SELECT RAISE(ABORT, 'test: finding refused'); END`);
    const { runScan } = createRunner({
      commitsNewestFirst: [
        createFakeCommit('c1', 500, [{ filePath: 'a.env', lineNumber: 1, text: 'AKIA-one' }]),
        createFakeCommit('c2', 400, [{ filePath: 'b.env', lineNumber: 1, text: refusedLeak }]),
      ],
    });
    const scan = claimNewScan();

    const outcome = await runScan(scan, runningControl());

    expect(outcome).toMatchObject({ kind: 'failed', status: 'scanning', isRetryable: true });
    expect(storedLeakValues(scan.id)).toEqual([]);
    expect(scanRepository.getScan(scan.id)).toMatchObject({ scannedCommits: 0, lastScannedSha: null });
  });

  it('stops between pages when asked', async () => {
    const { runScan, gitClient } = createRunner();
    const scan = claimNewScan();
    const hasScannedOnePage = (): boolean => gitClient.streamedPages.length === 1;
    const control: RunControl = { signal: new AbortController().signal, shouldStop: hasScannedOnePage };

    const outcome = await runScan(scan, control);

    expect(outcome).toEqual({ kind: 'stopped', status: 'scanning' });
    expect(gitClient.streamedPages).toEqual([['c1', 'c2']]);
    expect(scanRepository.getScan(scan.id)).toMatchObject({ scannedCommits: 2 });
  });
});
