import { rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { Config } from '../config.js';
import type { ScanRepository, ScanTransition } from '../db/scanRepository.js';
import { ScanStatusSchema, type Scan } from '../domain/scan.js';
import type { Logger } from '../logger.js';
import {
  LEASE_LOST_REASON,
  getCloneDir,
  type RunControl,
  type ScanOutcome,
  type ScanRunner,
} from '../scanner/scanRunner.js';

export const SHUTDOWN_REASON = 'shutdown';

export interface WorkerPoolDeps {
  config: Config;
  logger: Logger;
  scanRepository: ScanRepository;
  scanRunner: ScanRunner;
  now?: () => Date;
}

export interface WorkerPool {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const HEARTBEATS_PER_LEASE = 3;

export function createWorkerPool(deps: WorkerPoolDeps): WorkerPool {
  const { config, logger, scanRepository, scanRunner } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const shutdown = new AbortController();
  const slotLoops: Promise<void>[] = [];

  async function runSlot(slotIndex: number): Promise<void> {
    const workerId = `${hostname()}-${process.pid}-${slotIndex}`;
    while (!shutdown.signal.aborted) {
      const scan = scanRepository.claimNextScan(workerId, now(), config.leaseMs, config.maxDeliveries);
      if (scan === undefined) {
        await sleepUnlessAborted(config.pollMs, shutdown.signal);
        continue;
      }
      logger.info({ scanId: scan.id, deliveryCount: scan.deliveryCount, workerId }, 'Scan claimed');
      await runClaimedScan(scan);
    }
  }

  async function runClaimedScan(scan: Scan): Promise<void> {
    try {
      const { outcome, signal } = await runWithHeartbeat(scan);
      const wasShutDown = signal.aborted && signal.reason === SHUTDOWN_REASON;
      applyOutcome(scan, outcome, wasShutDown);
    } finally {
      await rm(getCloneDir(config, scan.id, scan.leaseToken), { recursive: true, force: true });
    }
  }

  async function runWithHeartbeat(scan: Scan): Promise<{ outcome: ScanOutcome; signal: AbortSignal }> {
    const leaseLost = new AbortController();
    let isStopRequested = scan.stopRequested;
    const heartbeat = setInterval(() => {
      const renewal = scanRepository.renewLease(scan.id, scan.leaseToken, now(), config.leaseMs);
      if (renewal.kind === 'lost') {
        leaseLost.abort(LEASE_LOST_REASON);
        return;
      }
      isStopRequested = renewal.stopRequested;
    }, config.leaseMs / HEARTBEATS_PER_LEASE);

    const control: RunControl = {
      signal: AbortSignal.any([shutdown.signal, leaseLost.signal]),
      shouldStop: () => isStopRequested,
    };
    try {
      const outcome = await scanRunner.runScan(scan, control);
      return { outcome, signal: control.signal };
    } finally {
      clearInterval(heartbeat);
    }
  }

  function applyOutcome(scan: Scan, outcome: ScanOutcome, wasShutDown: boolean): void {
    // Re-read the count: a page of progress during this run reset it to 1.
    const deliveryCount = readDeliveryCount(scan.id);
    const logFields = { scanId: scan.id, deliveryCount, outcome: outcome.kind, wasShutDown };
    const change = toTransition(scan, outcome, { wasShutDown, deliveryCount, config, now: now() });
    if (change === null) {
      logger.warn(logFields, 'Scan lease lost; another worker owns it now');
      return;
    }
    const result = scanRepository.transitionScan(change);
    logger.info({ ...logFields, to: change.to, result, error: change.error }, 'Scan run ended');
  }

  // Scans are never deleted, so the scan this slot claimed is still there.
  function readDeliveryCount(scanId: string): number {
    const scan = scanRepository.getScan(scanId);
    if (scan === undefined) {
      throw new Error(`Scan ${scanId} disappeared while a worker held it`);
    }
    return scan.deliveryCount;
  }

  return {
    async start() {
      // Clone dirs only live while a slot holds a scan, so anything here is left over from a crash.
      await rm(config.clonesDir, { recursive: true, force: true });
      for (let slotIndex = 0; slotIndex < config.workerConcurrency; slotIndex++) {
        slotLoops.push(runSlot(slotIndex));
      }
    },

    async stop() {
      shutdown.abort(SHUTDOWN_REASON);
      await Promise.all(slotLoops);
    },
  };
}

interface OutcomeContext {
  wasShutDown: boolean;
  deliveryCount: number;
  config: Config;
  now: Date;
}

function toTransition(scan: Scan, outcome: ScanOutcome, context: OutcomeContext): ScanTransition | null {
  // The lease token is the one we claimed with, so a scan another worker took over is never overwritten.
  const base = { scanId: scan.id, leaseToken: scan.leaseToken, now: context.now };
  switch (outcome.kind) {
    case 'completed':
      return { ...base, from: ScanStatusSchema.enum.scanning, to: ScanStatusSchema.enum.completed };
    case 'stopped':
      return { ...base, from: outcome.status, to: ScanStatusSchema.enum.stopped };
    case 'lost':
      return null;
    case 'failed':
      return toFailureTransition(outcome, context, base);
  }
}

function toFailureTransition(
  outcome: Extract<ScanOutcome, { kind: 'failed' }>,
  context: OutcomeContext,
  base: Pick<ScanTransition, 'scanId' | 'leaseToken' | 'now'>,
): ScanTransition {
  const from = outcome.status;
  // A shutdown cuts the run off mid-way; the error it caused is ours, not the scan's.
  if (context.wasShutDown) {
    return { ...base, from, to: ScanStatusSchema.enum.queued, refundDelivery: true };
  }
  const canRetry = outcome.isRetryable && context.deliveryCount < context.config.maxDeliveries;
  if (!canRetry) {
    return { ...base, from, to: ScanStatusSchema.enum.failed, error: outcome.error };
  }
  const backoffMs = context.config.retryBaseMs * 2 ** (context.deliveryCount - 1);
  const runAfter = new Date(base.now.getTime() + backoffMs).toISOString();
  return { ...base, from, to: ScanStatusSchema.enum.queued, error: outcome.error, runAfter };
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
