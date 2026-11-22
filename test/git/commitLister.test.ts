import { describe, expect, it } from 'vitest';
import { parseRevListLine, sortCommitsNewestFirst } from '../../src/git/commitLister.js';

describe('sortCommitsNewestFirst', () => {
  it('sorts out-of-order commits by committer time, newest first', () => {
    const commits = [
      { sha: 'aaa', committedAtSeconds: 100 },
      { sha: 'bbb', committedAtSeconds: 300 },
      { sha: 'ccc', committedAtSeconds: 200 },
    ];

    expect(sortCommitsNewestFirst(commits).map((commit) => commit.sha)).toEqual(['bbb', 'ccc', 'aaa']);
  });

  it('breaks ties by sha ascending', () => {
    const commits = [
      { sha: 'fff', committedAtSeconds: 100 },
      { sha: 'aaa', committedAtSeconds: 100 },
      { sha: 'ccc', committedAtSeconds: 200 },
      { sha: 'bbb', committedAtSeconds: 100 },
    ];

    expect(sortCommitsNewestFirst(commits).map((commit) => commit.sha)).toEqual(['ccc', 'aaa', 'bbb', 'fff']);
  });

  it('does not change the input array', () => {
    const commits = [
      { sha: 'aaa', committedAtSeconds: 100 },
      { sha: 'bbb', committedAtSeconds: 200 },
    ];

    sortCommitsNewestFirst(commits);

    expect(commits.map((commit) => commit.sha)).toEqual(['aaa', 'bbb']);
  });
});

describe('parseRevListLine', () => {
  it('reads the timestamp and the sha', () => {
    expect(parseRevListLine('1700000000 0123abcd')).toEqual({ sha: '0123abcd', committedAtSeconds: 1700000000 });
  });

  it('throws on a line that is not `<seconds> <sha>`', () => {
    expect(() => parseRevListLine('not a rev-list line')).toThrow('not a rev-list line');
  });
});
