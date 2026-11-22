import type { Config } from '../config.js';
import type { RefTips } from '../domain/scan.js';
import { listBlobShas, listMissingShas } from './blobPrefetch.js';
import { parseRevListLine, sortCommitsNewestFirst } from './commitLister.js';
import { COMMIT_HEADER_FORMAT, createDiffParser } from './diffParser.js';
import { spawnGitProcess } from './gitProcess.js';
import { GitCommandError, type CommitDiff, type CommitToScan, type GitClient } from './gitTypes.js';

const NON_RETRYABLE_STDERR_PATTERNS = [
  /Repository not found/,
  /Authentication failed/,
  /could not read Username/,
  /repository '.*' not found/,
];
const MAX_STDERR_LENGTH = 2000;
const REDACTED = '***';

interface GitCommand {
  subcommand: string;
  args: string[];
  // The repo URL or directory, named in error messages.
  target: string;
  cwd?: string;
  configOptions?: string[];
  stdinLines?: string[];
  extraEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export function createGitClient(config: Config): GitClient {
  const secrets = listSecrets(config.githubToken);
  const authOptions = buildAuthOptions(config.githubToken);

  function runLines(command: GitCommand): AsyncGenerator<string> {
    return streamGitLines(command, authOptions, secrets);
  }

  async function cloneMirror(repoUrl: string, targetDir: string, signal: AbortSignal): Promise<void> {
    const cloneSignal = AbortSignal.any([signal, AbortSignal.timeout(config.cloneTimeoutMs)]);
    const args = ['--mirror', '--filter=blob:none', repoUrl, targetDir];
    await collectLines(runLines({ subcommand: 'clone', args, target: repoUrl, signal: cloneSignal }));
  }

  async function readRefTips(repoDir: string): Promise<RefTips> {
    const command = { subcommand: 'for-each-ref', args: ['--format=%(refname) %(objectname)'], target: repoDir };
    const refTips: RefTips = {};
    for await (const line of runLines({ ...command, cwd: repoDir })) {
      const [refName = '', sha = ''] = line.split(' ');
      refTips[refName] = sha;
    }
    return refTips;
  }

  async function hasAllCommits(repoDir: string, shas: string[]): Promise<boolean> {
    const missingShas = await listMissingObjects(repoDir, shas);
    return missingShas.length === 0;
  }

  async function listCommitsNewestFirst(repoDir: string, refTips: RefTips): Promise<CommitToScan[]> {
    const tipShas = Object.values(refTips);
    const command = { subcommand: 'rev-list', args: ['--timestamp', '--stdin'], target: repoDir, cwd: repoDir };
    const commits: CommitToScan[] = [];
    for await (const line of runLines({ ...command, stdinLines: tipShas })) {
      commits.push(parseRevListLine(line));
    }
    return sortCommitsNewestFirst(commits);
  }

  async function* streamCommitDiffs(repoDir: string, shas: string[], signal: AbortSignal): AsyncGenerator<CommitDiff> {
    // With empty stdin, `git log` falls back to HEAD and would scan a commit nobody asked for.
    if (shas.length === 0) {
      return;
    }
    await prefetchBlobs(repoDir, shas, signal);
    const parser = createDiffParser();
    for await (const line of runLines(buildLogCommand(repoDir, shas, signal))) {
      const finishedCommit = parser.pushLine(line);
      if (finishedCommit !== undefined) {
        yield finishedCommit;
      }
    }
    const lastCommit = parser.finish();
    if (lastCommit !== undefined) {
      yield lastCommit;
    }
  }

  // Without this, `git log -p` in a blobless clone fetches the missing blobs about once per commit.
  // Any blob this misses is still fetched lazily by `git log`.
  async function prefetchBlobs(repoDir: string, shas: string[], signal: AbortSignal): Promise<void> {
    const diffTreeArgs = ['-r', '--root', '--no-renames', '--no-commit-id', '--stdin'];
    const diffTree = { subcommand: 'diff-tree', args: diffTreeArgs, target: repoDir, cwd: repoDir, signal };
    const blobShas = listBlobShas(await collectLines(runLines({ ...diffTree, stdinLines: shas })));
    // No blobs: cat-file with empty stdin prints nothing, so this costs one local process and no request.
    const missingShas = await listMissingObjects(repoDir, blobShas);
    if (missingShas.length === 0) {
      return;
    }
    await collectLines(runLines(buildBlobFetchCommand(repoDir, missingShas, signal)));
  }

  async function listMissingObjects(repoDir: string, shas: string[]): Promise<string[]> {
    // Without this, a missing SHA in a blobless clone makes git try to fetch it from the remote.
    const extraEnv = { GIT_NO_LAZY_FETCH: '1' };
    const command = { subcommand: 'cat-file', args: ['--batch-check'], target: repoDir, cwd: repoDir };
    return listMissingShas(await collectLines(runLines({ ...command, stdinLines: shas, extraEnv })));
  }

  function buildLogCommand(repoDir: string, shas: string[], signal: AbortSignal): GitCommand {
    return {
      subcommand: 'log',
      configOptions: ['-c', `core.bigFileThreshold=${config.bigFileThreshold}`, '-c', 'core.quotePath=false'],
      // The explicit prefixes keep `+++ b/<path>` even if the user's git config sets diff.noprefix.
      args: [
        '-p',
        '--no-walk=unsorted',
        '--stdin',
        '--no-renames',
        '--no-color',
        '--no-ext-diff',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        `--format=${COMMIT_HEADER_FORMAT}`,
      ],
      target: repoDir,
      cwd: repoDir,
      stdinLines: shas,
      signal,
    };
  }

  // The same request git's own lazy fetch sends, but for a whole page of blobs at once.
  function buildBlobFetchCommand(repoDir: string, blobShas: string[], signal: AbortSignal): GitCommand {
    return {
      subcommand: 'fetch',
      configOptions: ['-c', 'fetch.negotiationAlgorithm=noop'],
      args: ['origin', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin'],
      target: repoDir,
      cwd: repoDir,
      stdinLines: blobShas,
      signal,
    };
  }

  return { cloneMirror, readRefTips, hasAllCommits, listCommitsNewestFirst, streamCommitDiffs };
}

async function* streamGitLines(command: GitCommand, authOptions: string[], secrets: string[]): AsyncGenerator<string> {
  const args = [...authOptions, ...(command.configOptions ?? []), command.subcommand, ...command.args];
  const gitProcess = spawnGitProcess(args, {
    cwd: command.cwd,
    env: { ...process.env, ...command.extraEnv, GIT_TERMINAL_PROMPT: '0' },
    stdinLines: command.stdinLines ?? [],
    signal: command.signal,
  });
  try {
    for await (const line of gitProcess.stdoutLines) {
      yield line;
    }
    // An abort ends here too: the killed process exits with a null code.
    const { exitCode, stderr } = await gitProcess.waitForExit();
    if (exitCode !== 0) {
      throw toGitCommandError(command, exitCode, redact(stderr, secrets));
    }
  } finally {
    gitProcess.kill();
  }
}

function toGitCommandError(command: GitCommand, exitCode: number | null, stderr: string): GitCommandError {
  const isRetryable = !NON_RETRYABLE_STDERR_PATTERNS.some((pattern) => pattern.test(stderr));
  const trimmedStderr = stderr.trim().slice(-MAX_STDERR_LENGTH);
  const message = `git ${command.subcommand} failed for ${command.target} (exit ${exitCode}): ${trimmedStderr}`;
  return new GitCommandError(message, isRetryable);
}

async function collectLines(lines: AsyncIterable<string>): Promise<string[]> {
  const collected: string[] = [];
  for await (const line of lines) {
    collected.push(line);
  }
  return collected;
}

function buildAuthOptions(githubToken: string | undefined): string[] {
  if (githubToken === undefined) {
    return [];
  }
  return ['-c', `http.extraHeader=Authorization: Basic ${encodeBasicCredentials(githubToken)}`];
}

function listSecrets(githubToken: string | undefined): string[] {
  if (githubToken === undefined) {
    return [];
  }
  return [githubToken, encodeBasicCredentials(githubToken)];
}

function encodeBasicCredentials(githubToken: string): string {
  return Buffer.from(`x-access-token:${githubToken}`).toString('base64');
}

function redact(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }
  return redacted;
}
