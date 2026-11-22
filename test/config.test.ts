import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('treats an empty GITHUB_TOKEN as no token', () => {
    expect(loadConfig({ GITHUB_TOKEN: '' }).githubToken).toBeUndefined();
  });

  it('keeps a non-empty GITHUB_TOKEN', () => {
    expect(loadConfig({ GITHUB_TOKEN: 'ghp_example' }).githubToken).toBe('ghp_example');
  });
});
