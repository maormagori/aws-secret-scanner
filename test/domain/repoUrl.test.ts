import { describe, expect, it } from 'vitest';
import { parseRepoUrl } from '../../src/domain/repoUrl.js';

describe('parseRepoUrl', () => {
  it.each([
    'octo-org/my_repo.js',
    'Octo-Org/My_Repo.js',
    'https://github.com/octo-org/my_repo.js',
    'https://github.com/octo-org/my_repo.js/',
    'https://github.com/octo-org/my_repo.js.git',
    'https://github.com/Octo-Org/my_repo.js.git/',
    'octo-org/my_repo.js.git',
  ])('normalizes %s', (input) => {
    expect(parseRepoUrl(input)).toEqual({ kind: 'valid', repoUrl: 'https://github.com/octo-org/my_repo.js' });
  });

  it.each([
    '',
    'octo',
    'octo/repo/extra',
    'https://gitlab.com/octo/repo',
    'http://github.com/octo/repo',
    'https://github.com/octo/repo/tree/main',
    'octo/..',
    '../repo',
    'octo/re po',
    ' octo/repo',
    'octo/repo\n',
    'octo//repo',
    'octo/repo?x=1',
  ])('rejects %j', (input) => {
    expect(parseRepoUrl(input).kind).toBe('invalid');
  });
});
