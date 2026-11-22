import type { ScanStatus } from './scan.js';

// A reclaim after an expired lease restarts at cloning, hence cloning → cloning and scanning → cloning.
export const SCAN_TRANSITIONS: Record<ScanStatus, readonly ScanStatus[]> = {
  queued: ['cloning', 'stopped'],
  cloning: ['scanning', 'cloning', 'queued', 'failed', 'stopped'],
  scanning: ['completed', 'cloning', 'queued', 'failed', 'stopped'],
  completed: [],
  failed: ['queued'],
  stopped: ['queued'],
};

export function canTransition(from: ScanStatus, to: ScanStatus): boolean {
  return SCAN_TRANSITIONS[from].includes(to);
}
