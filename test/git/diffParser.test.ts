import { describe, expect, it } from 'vitest';
import { createDiffParser } from '../../src/git/diffParser.js';
import type { CommitDiff } from '../../src/git/gitTypes.js';

const NEWER_SHA = 'b'.repeat(40);
const OLDER_SHA = 'a'.repeat(40);

function buildHeader(sha: string, committedAt: string, subject: string): string {
  const fields = [
    sha,
    committedAt,
    'Carol Committer',
    'carol@example.com',
    'Alice Author',
    'alice@example.com',
    subject,
  ];
  return `\x01${fields.join('\x1f')}`;
}

const SAMPLE_LOG = [
  buildHeader(NEWER_SHA, '2026-01-02T12:00:00+02:00', 'Change config, drop old files'),
  '',
  'diff --git a/config.env b/config.env',
  'index 1111111..2222222 100644',
  '--- a/config.env',
  '+++ b/config.env',
  '@@ -10,4 +10,5 @@ section',
  ' line ten',
  '-removed line',
  '+added at eleven',
  ' line twelve',
  '+++plus signs at thirteen',
  '\\ No newline at end of file',
  '@@ -40,1 +41,2 @@',
  ' line forty-one',
  '+added at forty-two',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone one',
  '-gone two',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'index 0000000..4444444',
  'Binary files /dev/null and b/logo.png differ',
  buildHeader(OLDER_SHA, '2026-01-01T10:00:00Z', 'Add readme'),
  '',
  'diff --git a/docs/read me.md b/docs/read me.md',
  'new file mode 100644',
  'index 0000000..5555555',
  '--- /dev/null',
  '+++ b/docs/read me.md\t',
  '@@ -0,0 +1,2 @@',
  '+first',
  '+second',
];

function parseAll(lines: string[]): CommitDiff[] {
  const parser = createDiffParser();
  const commits: CommitDiff[] = [];
  for (const line of lines) {
    const finishedCommit = parser.pushLine(line);
    if (finishedCommit !== undefined) {
      commits.push(finishedCommit);
    }
  }
  const lastCommit = parser.finish();
  if (lastCommit !== undefined) {
    commits.push(lastCommit);
  }
  return commits;
}

describe('diffParser', () => {
  it('returns each commit with its metadata and added lines', () => {
    const [newer, older, ...rest] = parseAll(SAMPLE_LOG);

    expect(rest).toEqual([]);
    expect(newer).toEqual({
      sha: NEWER_SHA,
      message: 'Change config, drop old files',
      committedAt: '2026-01-02T10:00:00.000Z',
      committerName: 'Carol Committer',
      committerEmail: 'carol@example.com',
      authorName: 'Alice Author',
      authorEmail: 'alice@example.com',
      addedLines: [
        { filePath: 'config.env', lineNumber: 11, text: 'added at eleven' },
        { filePath: 'config.env', lineNumber: 13, text: '++plus signs at thirteen' },
        { filePath: 'config.env', lineNumber: 42, text: 'added at forty-two' },
      ],
    });
    expect(older?.sha).toBe(OLDER_SHA);
    expect(older?.committedAt).toBe('2026-01-01T10:00:00.000Z');
    expect(older?.addedLines).toEqual([
      { filePath: 'docs/read me.md', lineNumber: 1, text: 'first' },
      { filePath: 'docs/read me.md', lineNumber: 2, text: 'second' },
    ]);
  });

  it('reads file paths that git quotes', () => {
    const commits = parseAll([
      buildHeader(NEWER_SHA, '2026-01-02T12:00:00Z', 'Add quoted file'),
      '',
      'diff --git "a/quote\\"name.env" "b/quote\\"name.env"',
      'new file mode 100644',
      'index 0000000..6666666',
      '--- /dev/null',
      '+++ "b/quote\\"name.env"',
      '@@ -0,0 +1 @@',
      '+secret line',
    ]);

    expect(commits[0]?.addedLines).toEqual([{ filePath: 'quote"name.env', lineNumber: 1, text: 'secret line' }]);
  });

  it('returns a commit with no diff (e.g. a merge) with no added lines', () => {
    const commits = parseAll([buildHeader(NEWER_SHA, '2026-01-02T12:00:00Z', 'Merge branch'), '']);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.addedLines).toEqual([]);
  });

  it('returns nothing when no commit header was seen', () => {
    expect(parseAll(['+stray line'])).toEqual([]);
  });

  it('throws on a malformed commit header', () => {
    const parser = createDiffParser();

    expect(() => parser.pushLine('\x01only-a-sha')).toThrow();
  });
});
