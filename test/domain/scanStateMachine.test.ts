import { describe, expect, it } from 'vitest';
import { canTransition } from '../../src/domain/scanStateMachine.js';

describe('canTransition', () => {
  it.each([
    ['queued', 'cloning'],
    ['queued', 'stopped'],
    ['cloning', 'scanning'],
    ['cloning', 'cloning'],
    ['scanning', 'cloning'],
    ['scanning', 'completed'],
    ['scanning', 'queued'],
    ['cloning', 'failed'],
    ['scanning', 'stopped'],
    ['stopped', 'queued'],
    ['failed', 'queued'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['completed', 'queued'],
    ['completed', 'failed'],
    ['queued', 'scanning'],
    ['queued', 'completed'],
    ['stopped', 'cloning'],
    ['failed', 'scanning'],
    ['cloning', 'completed'],
  ] as const)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});
