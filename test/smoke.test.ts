import { describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

describe('smoke', () => {
  it('runs the entry point', () => {
    expect(main()).toBeUndefined();
  });
});
