import { loadConfig, type Config } from '../../src/config.js';

export function createTestConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({}), logLevel: 'silent', ...overrides };
}
