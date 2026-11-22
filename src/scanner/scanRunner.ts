import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { runInTransaction } from '../db/database.js';
import type { FindingRepository } from '../db/findingRepository.js';
import type { ScanRepository } from '../db/scanRepository.js';
import type { NewFinding } from '../domain/finding.js';
import { ScanStatusSchema, type RefTips, type Scan } from '../domain/scan.js';
import { GitCommandError, type CommitDiff, type CommitToScan, type GitClient } from '../git/gitTypes.js';
import type { Logger } from '../logger.js';
import type { DetectedLeak } from './detector.js';

export const LEASE_LOST_REASON = 'lost';
export const HISTORY_CHANGED_ERROR = 'history changed since the scan started; start a new scan';

export type RunningScanStatus = 'cloning' | 'scanning';

export interface ScanRunnerDeps {
  config: Config;
  logger: Logger;
  db: DatabaseSync;
  scanRepository: ScanRepository;
  findingRepository: FindingRepository;
  gitClient: GitClient;
  detectLeaks: (line: string) => DetectedLeak[];
}

export interface RunControl {
  signal: AbortSignal;
  shouldStop(): boolean;
}

export type ScanOutcome =
  | { kind: 'completed' }
  | { kind: 'stopped'; status: RunningScanStatus }
  | { kind: 'lost' }
  | { kind: 'failed'; status: RunningScanStatus; error: string; isRetryable: boolean };

export interface ScanRunner {
  runScan(scan: Scan, control: RunControl): Promise<ScanOutcome>;
}

type CommitListResult = { kind: 'ready'; commits: CommitToScan[] } | ScanOutcome;

const CLONING = ScanStatusSchema.enum.cloning;
const SCANNING = ScanStatusSchema.enum.scanning;
const LOST_OUTCOME: ScanOutcome = { kind: 'lost' };
const HISTORY_CHANGED_OUTCOME: ScanOutcome = {
  kind: 'failed',
  status: CLONING,
  error: HISTORY_CHANGED_ERROR,
  isRetryable: false,
};

class LeaseLostError extends Error {
  constructor(scanId: string) {
    super(`Scan ${scanId}: lease lost`);
    this.name = 'LeaseLostError';
  }
}

// One directory per claim: a stalled worker that lost its lease cleans up its own clone, never the new owner's.
export function getCloneDir(config: Config, scanId: string, leaseToken: number): string {
  return join(config.clonesDir, `${scanId}-${leaseToken}`);
}

export function createScanRunner(deps: ScanRunnerDeps): ScanRunner {
  return {
    async runScan(scan, control) {
      let status: RunningScanStatus = CLONING;
      try {
        const commitList = await prepareCommitList(deps, scan, control.signal);
        if (commitList.kind !== 'ready') {
          return commitList;
        }
        const change = { scanId: scan.id, from: CLONING, to: SCANNING, leaseToken: scan.leaseToken, now: new Date() };
        if (deps.scanRepository.transitionScan(change) !== 'applied') {
          return LOST_OUTCOME;
        }
        status = SCANNING;
        return await scanPages(deps, scan, commitList.commits, control);
      } catch (error) {
        return toErrorOutcome(error, status, control.signal);
      }
    },
  };
}

async function prepareCommitList(deps: ScanRunnerDeps, scan: Scan, signal: AbortSignal): Promise<CommitListResult> {
  const cloneDir = getCloneDir(deps.config, scan.id, scan.leaseToken);
  await rm(cloneDir, { recursive: true, force: true });
  await deps.gitClient.cloneMirror(scan.repoUrl, cloneDir, signal);
  if (scan.refTips === null) {
    return freezeRefTips(deps, scan, cloneDir);
  }
  return loadFrozenCommits(deps, scan, scan.refTips, cloneDir);
}

async function freezeRefTips(deps: ScanRunnerDeps, scan: Scan, cloneDir: string): Promise<CommitListResult> {
  const refTips = await deps.gitClient.readRefTips(cloneDir);
  const commits = await deps.gitClient.listCommitsNewestFirst(cloneDir, refTips);
  const wasSaved = deps.scanRepository.saveRefTips(scan.id, scan.leaseToken, refTips, commits.length, new Date());
  if (!wasSaved) {
    return LOST_OUTCOME;
  }
  return { kind: 'ready', commits };
}

async function loadFrozenCommits(
  deps: ScanRunnerDeps,
  scan: Scan,
  refTips: RefTips,
  cloneDir: string,
): Promise<CommitListResult> {
  const hasFrozenTips = await deps.gitClient.hasAllCommits(cloneDir, Object.values(refTips));
  if (!hasFrozenTips) {
    return HISTORY_CHANGED_OUTCOME;
  }
  const commits = await deps.gitClient.listCommitsNewestFirst(cloneDir, refTips);
  const checkpointCommit = commits[scan.scannedCommits - 1];
  const hasCheckpointMoved = scan.scannedCommits > 0 && checkpointCommit?.sha !== scan.lastScannedSha;
  if (hasCheckpointMoved) {
    return HISTORY_CHANGED_OUTCOME;
  }
  return { kind: 'ready', commits };
}

async function scanPages(
  deps: ScanRunnerDeps,
  scan: Scan,
  commits: CommitToScan[],
  control: RunControl,
): Promise<ScanOutcome> {
  let scannedCommits = scan.scannedCommits;
  while (true) {
    const page = commits.slice(scannedCommits, scannedCommits + deps.config.batchSize);
    const lastCommit = page.at(-1);
    if (lastCommit === undefined) {
      return { kind: 'completed' };
    }
    if (control.shouldStop()) {
      return { kind: 'stopped', status: SCANNING };
    }
    control.signal.throwIfAborted();
    const findings = await collectPageFindings(deps, scan, page, control.signal);
    scannedCommits += page.length;
    savePage(deps, scan, scannedCommits, lastCommit.sha, findings);
    deps.logger.debug({ scanId: scan.id, scannedCommits, findings: findings.length }, 'Page scanned');
  }
}

async function collectPageFindings(
  deps: ScanRunnerDeps,
  scan: Scan,
  page: CommitToScan[],
  signal: AbortSignal,
): Promise<NewFinding[]> {
  const cloneDir = getCloneDir(deps.config, scan.id, scan.leaseToken);
  const shas = page.map((commit) => commit.sha);
  const findings: NewFinding[] = [];
  for await (const commitDiff of deps.gitClient.streamCommitDiffs(cloneDir, shas, signal)) {
    // A plain loop, not push(...): spreading a huge commit's findings as arguments overflows the call stack.
    for (const finding of findCommitLeaks(scan.id, commitDiff, deps.detectLeaks)) {
      findings.push(finding);
    }
  }
  return findings;
}

function findCommitLeaks(
  scanId: string,
  commitDiff: CommitDiff,
  detectLeaks: (line: string) => DetectedLeak[],
): NewFinding[] {
  const findings: NewFinding[] = [];
  for (const addedLine of commitDiff.addedLines) {
    for (const leak of detectLeaks(addedLine.text)) {
      findings.push({
        scanId,
        commitSha: commitDiff.sha,
        commitMessage: commitDiff.message,
        committedAt: commitDiff.committedAt,
        committerName: commitDiff.committerName,
        committerEmail: commitDiff.committerEmail,
        authorName: commitDiff.authorName,
        authorEmail: commitDiff.authorEmail,
        filePath: addedLine.filePath,
        lineNumber: addedLine.lineNumber,
        leakType: leak.leakType,
        leakValue: leak.leakValue,
      });
    }
  }
  return findings;
}

function savePage(
  deps: ScanRunnerDeps,
  scan: Scan,
  scannedCommits: number,
  lastScannedSha: string,
  findings: NewFinding[],
): void {
  // The checkpoint goes first: if our lease is gone, throwing rolls back before any finding is written.
  runInTransaction(deps.db, () => {
    const now = new Date();
    const wasAdvanced = deps.scanRepository.advanceCheckpoint(
      scan.id,
      scan.leaseToken,
      scannedCommits,
      lastScannedSha,
      now,
    );
    if (!wasAdvanced) {
      throw new LeaseLostError(scan.id);
    }
    deps.findingRepository.insertFindings(findings);
  });
}

function toErrorOutcome(error: unknown, status: RunningScanStatus, signal: AbortSignal): ScanOutcome {
  const isLeaseLost = error instanceof LeaseLostError || signal.reason === LEASE_LOST_REASON;
  if (isLeaseLost) {
    return LOST_OUTCOME;
  }
  if (error instanceof GitCommandError) {
    return { kind: 'failed', status, error: error.message, isRetryable: error.isRetryable };
  }
  // Unknown errors are retried; the delivery limit stops a scan that fails the same way every time.
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'failed', status, error: message, isRetryable: true };
}
