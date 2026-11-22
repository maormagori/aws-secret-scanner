import { describe, expect, it } from 'vitest';
import { unquoteGitPath } from '../../src/git/quotedPath.js';

describe('unquoteGitPath', () => {
  it('returns an unquoted path unchanged', () => {
    expect(unquoteGitPath('b/docs/read me.md')).toBe('b/docs/read me.md');
  });

  it('decodes escaped quotes, backslashes, tabs, newlines and carriage returns', () => {
    expect(unquoteGitPath('"b/a\\"b\\\\c\\td\\ne\\rf"')).toBe('b/a"b\\c\td\ne\rf');
  });

  it('decodes octal escapes as UTF-8 bytes', () => {
    expect(unquoteGitPath('"b/caf\\303\\251.env"')).toBe('b/café.env');
  });

  it('decodes a control character written as an octal escape', () => {
    expect(unquoteGitPath('"b/bell\\007.env"')).toBe('b/bell\x07.env');
  });

  it('keeps raw UTF-8 characters inside a quoted path', () => {
    expect(unquoteGitPath('"b/🔑\\"key.env"')).toBe('b/🔑"key.env');
  });

  it('throws on an escape git never writes', () => {
    expect(() => unquoteGitPath('"b/bad\\q.env"')).toThrow(/Unknown escape/);
  });
});
