import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitClient } from '../../src/git/gitClient.js';
import { GitCommandError, type CommitDiff, type GitClient } from '../../src/git/gitTypes.js';
import { createTestConfig } from '../helpers/testConfig.js';

const FAKE_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const FIRST_COMMIT_DATE = '2026-01-01T10:00:00Z';
const FEATURE_COMMIT_DATE = '2026-01-02T10:00:00Z';
const SECOND_COMMIT_DATE = '2026-01-03T10:00:00Z';
const QUOTED_PATHS_COMMIT_DATE = '2026-01-04T10:00:00Z';
const QUOTE_FILE_NAME = 'quote"name.env';
const TAB_FILE_NAME = 'tab\tname.env';

let tempDir: string;
let repoDir: string;
let firstSha: string;
let featureSha: string;
let secondSha: string;
let gitClient: GitClient;

function runGit(args: string[], commitDate = FIRST_COMMIT_DATE): string {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Alice Author',
    GIT_AUTHOR_EMAIL: 'alice@example.com',
    GIT_COMMITTER_NAME: 'Carol Committer',
    GIT_COMMITTER_EMAIL: 'carol@example.com',
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_DATE: commitDate,
  };
  return execFileSync('git', args, { cwd: repoDir, env, encoding: 'utf8' }).trim();
}

function commitFile(fileName: string, content: string, message: string, commitDate: string): string {
  writeFileSync(join(repoDir, fileName), content);
  runGit(['add', fileName]);
  runGit(['commit', '-q', '-m', message], commitDate);
  return runGit(['rev-parse', 'HEAD']);
}

async function collectDiffs(shas: string[], signal: AbortSignal): Promise<CommitDiff[]> {
  const diffs: CommitDiff[] = [];
  for await (const diff of gitClient.streamCommitDiffs(repoDir, shas, signal)) {
    diffs.push(diff);
  }
  return diffs;
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'git-client-test-'));
  repoDir = join(tempDir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
  firstSha = commitFile('readme.md', 'hello\n', 'Add readme', FIRST_COMMIT_DATE);
  runGit(['checkout', '-q', '-b', 'feature']);
  featureSha = commitFile('notes.md', 'feature work\n', 'Add notes', FEATURE_COMMIT_DATE);
  runGit(['checkout', '-q', 'main']);
  secondSha = commitFile('readme.md', `hello\naws_key=${FAKE_ACCESS_KEY_ID}\n`, 'Add key', SECOND_COMMIT_DATE);
  gitClient = createGitClient(createTestConfig());
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('gitClient', () => {
  it('reads every ref tip', async () => {
    expect(await gitClient.readRefTips(repoDir)).toEqual({
      'refs/heads/main': secondSha,
      'refs/heads/feature': featureSha,
    });
  });

  it('lists commits from all ref tips, newest first, each once', async () => {
    const refTips = await gitClient.readRefTips(repoDir);

    expect(await gitClient.listCommitsNewestFirst(repoDir, refTips)).toEqual([
      { sha: secondSha, committedAtSeconds: Date.parse(SECOND_COMMIT_DATE) / 1000 },
      { sha: featureSha, committedAtSeconds: Date.parse(FEATURE_COMMIT_DATE) / 1000 },
      { sha: firstSha, committedAtSeconds: Date.parse(FIRST_COMMIT_DATE) / 1000 },
    ]);
  });

  it('streams commit diffs in the requested order with added lines', async () => {
    const diffs = await collectDiffs([secondSha, firstSha], new AbortController().signal);

    expect(diffs.map((diff) => diff.sha)).toEqual([secondSha, firstSha]);
    expect(diffs[0]).toEqual({
      sha: secondSha,
      message: 'Add key',
      committedAt: '2026-01-03T10:00:00.000Z',
      committerName: 'Carol Committer',
      committerEmail: 'carol@example.com',
      authorName: 'Alice Author',
      authorEmail: 'alice@example.com',
      addedLines: [{ filePath: 'readme.md', lineNumber: 2, text: `aws_key=${FAKE_ACCESS_KEY_ID}` }],
    });
    expect(diffs[1]?.addedLines).toEqual([{ filePath: 'readme.md', lineNumber: 1, text: 'hello' }]);
  });

  it('streams nothing for an empty sha list instead of falling back to HEAD', async () => {
    expect(await collectDiffs([], new AbortController().signal)).toEqual([]);
  });

  it('throws a retryable GitCommandError when the diff stream is aborted', async () => {
    const aborted = AbortSignal.abort();

    await expect(collectDiffs([secondSha], aborted)).rejects.toSatisfy(
      (error) => error instanceof GitCommandError && error.isRetryable,
    );
  });

  it('reports whether all commits exist', async () => {
    expect(await gitClient.hasAllCommits(repoDir, [firstSha, secondSha])).toBe(true);
    expect(await gitClient.hasAllCommits(repoDir, [firstSha, 'f'.repeat(40)])).toBe(false);
  });

  it('decodes file paths that git quotes', async () => {
    const fileNames = ['normal.env', QUOTE_FILE_NAME, TAB_FILE_NAME];
    for (const fileName of fileNames) {
      writeFileSync(join(repoDir, fileName), `aws_key=${FAKE_ACCESS_KEY_ID}\n`);
    }
    runGit(['add', ...fileNames]);
    runGit(['commit', '-q', '-m', 'Add quoted names'], QUOTED_PATHS_COMMIT_DATE);
    const quotedPathsSha = runGit(['rev-parse', 'HEAD']);
    // Move main back so the other tests still see the original refs; the commit stays readable by SHA.
    runGit(['reset', '-q', '--hard', secondSha]);

    const [diff] = await collectDiffs([quotedPathsSha], new AbortController().signal);

    const filePaths = diff?.addedLines.map((addedLine) => addedLine.filePath);
    expect(filePaths?.sort()).toEqual([...fileNames].sort());
  });

  it('mirror-clones a repo with all its refs', async () => {
    const mirrorDir = join(tempDir, 'mirror.git');

    await gitClient.cloneMirror(`file://${repoDir}`, mirrorDir, new AbortController().signal);

    expect(await gitClient.readRefTips(mirrorDir)).toEqual(await gitClient.readRefTips(repoDir));
  });

  it('throws a GitCommandError naming the subcommand and repo when clone fails', async () => {
    const missingRepoUrl = `file://${join(tempDir, 'missing')}`;

    await expect(
      gitClient.cloneMirror(missingRepoUrl, join(tempDir, 'failed.git'), new AbortController().signal),
    ).rejects.toThrow(new RegExp(`git clone failed for ${missingRepoUrl}`));
  });

  describe('against a server that never answers', () => {
    let silentServer: Server;
    let silentServerUrl: string;

    beforeAll(async () => {
      // Accepts the connection and never responds, so git's remote helper blocks while holding the pipes.
      silentServer = createServer(() => undefined);
      await new Promise<void>((resolve) => silentServer.listen(0, '127.0.0.1', resolve));
      const { port } = silentServer.address() as AddressInfo; // listen() on a TCP port always gives AddressInfo.
      silentServerUrl = `http://127.0.0.1:${port}/x.git`;
    });

    afterAll(() => {
      silentServer.closeAllConnections();
      silentServer.close();
    });

    it('rejects with a retryable GitCommandError soon after the clone is aborted', async () => {
      const clone = gitClient.cloneMirror(silentServerUrl, join(tempDir, 'silent.git'), AbortSignal.timeout(100));

      await expect(clone).rejects.toSatisfy((error) => error instanceof GitCommandError && error.isRetryable);
    }, 3000);
  });
});
