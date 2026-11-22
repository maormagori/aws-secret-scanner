import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitClient } from '../../src/git/gitClient.js';
import type { CommitDiff, GitClient } from '../../src/git/gitTypes.js';
import { createTestConfig } from '../helpers/testConfig.js';

const FAKE_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const FETCH_TRACE_PATTERN = /trace: built-in: git fetch /;

let tempDir: string;
let mirrorDir: string;
let traceFile: string;
let gitClient: GitClient;

function runGit(args: string[], cwd: string): string {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Alice Author',
    GIT_AUTHOR_EMAIL: 'alice@example.com',
    GIT_COMMITTER_NAME: 'Carol Committer',
    GIT_COMMITTER_EMAIL: 'carol@example.com',
  };
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

function commitFile(workDir: string, fileName: string, content: string): void {
  writeFileSync(join(workDir, fileName), content);
  runGit(['add', fileName], workDir);
  runGit(['commit', '-q', '-m', `Change ${fileName}`], workDir);
}

async function collectDiffsWithTrace(shas: string[]): Promise<CommitDiff[]> {
  // GIT_TRACE set to a path makes every git process (and the lazy-fetch subprocesses) append to that file.
  process.env.GIT_TRACE = traceFile;
  try {
    const diffs: CommitDiff[] = [];
    for await (const diff of gitClient.streamCommitDiffs(mirrorDir, shas, new AbortController().signal)) {
      diffs.push(diff);
    }
    return diffs;
  } finally {
    delete process.env.GIT_TRACE;
  }
}

function countFetches(): number {
  const traceLines = readFileSync(traceFile, 'utf8').split('\n');
  return traceLines.filter((line) => FETCH_TRACE_PATTERN.test(line)).length;
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'blobless-clone-test-'));
  const workDir = join(tempDir, 'work');
  const remoteDir = join(tempDir, 'remote.git');
  mirrorDir = join(tempDir, 'mirror.git');
  traceFile = join(tempDir, 'trace.log');
  execFileSync('git', ['init', '-q', '-b', 'main', workDir]);
  commitFile(workDir, 'readme.md', 'hello\n');
  commitFile(workDir, 'notes.md', 'some notes\n');
  commitFile(workDir, 'readme.md', `hello\naws_key=${FAKE_ACCESS_KEY_ID}\n`);
  commitFile(workDir, 'notes.md', 'some notes\nmore notes\n');
  execFileSync('git', ['init', '-q', '--bare', remoteDir]);
  runGit(['config', 'uploadpack.allowFilter', 'true'], remoteDir);
  runGit(['config', 'uploadpack.allowAnySHA1InWant', 'true'], remoteDir);
  runGit(['push', '-q', remoteDir, 'main'], workDir);
  runGit(['clone', '-q', '--mirror', '--filter=blob:none', `file://${remoteDir}`, mirrorDir], tempDir);
  gitClient = createGitClient(createTestConfig());
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('streamCommitDiffs in a blobless clone', () => {
  it('fetches all blobs of the page in one request and finds the added lines', async () => {
    const shas = runGit(['rev-list', 'main'], mirrorDir).split('\n');

    const diffs = await collectDiffsWithTrace(shas);

    expect(countFetches()).toBe(1);
    expect(diffs.map((diff) => diff.sha)).toEqual(shas);
    expect(diffs[1]?.addedLines).toEqual([
      { filePath: 'readme.md', lineNumber: 2, text: `aws_key=${FAKE_ACCESS_KEY_ID}` },
    ]);
    expect(diffs[0]?.addedLines).toEqual([{ filePath: 'notes.md', lineNumber: 2, text: 'more notes' }]);
  });

  it('makes no request when every blob is already local', async () => {
    rmSync(traceFile, { force: true });
    writeFileSync(traceFile, '');
    const shas = runGit(['rev-list', 'main'], mirrorDir).split('\n');

    await collectDiffsWithTrace(shas);

    expect(countFetches()).toBe(0);
  });
});
