import type { RefTips } from '../../src/domain/scan.js';
import type { AddedLine, CommitDiff, CommitToScan, GitClient } from '../../src/git/gitTypes.js';

export type FakeCommit = CommitDiff & CommitToScan;

export interface FakeGitScript {
  refTips: RefTips;
  commitsNewestFirst: FakeCommit[];
  hasAllCommits?: boolean;
  onClone?: (targetDir: string, signal: AbortSignal) => Promise<void> | void;
  onStreamPage?: (pageIndex: number, signal: AbortSignal) => Promise<void> | void;
}

export interface FakeGitClient extends GitClient {
  streamedPages: string[][];
}

export function createFakeGitClient(script: FakeGitScript): FakeGitClient {
  const streamedPages: string[][] = [];
  const commitsBySha = new Map(script.commitsNewestFirst.map((commit) => [commit.sha, commit]));

  return {
    streamedPages,

    async cloneMirror(_repoUrl, targetDir, signal) {
      await script.onClone?.(targetDir, signal);
    },

    async readRefTips() {
      return script.refTips;
    },

    async hasAllCommits() {
      return script.hasAllCommits ?? true;
    },

    async listCommitsNewestFirst() {
      return script.commitsNewestFirst.map((commit) => ({
        sha: commit.sha,
        committedAtSeconds: commit.committedAtSeconds,
      }));
    },

    async *streamCommitDiffs(_repoDir, shas, signal) {
      const pageIndex = streamedPages.length;
      streamedPages.push(shas);
      await script.onStreamPage?.(pageIndex, signal);
      for (const sha of shas) {
        const commit = commitsBySha.get(sha);
        if (commit === undefined) {
          throw new Error(`Fake git: unknown commit ${sha}`);
        }
        yield commit;
      }
    },
  };
}

export function createFakeCommit(sha: string, committedAtSeconds: number, addedLines: AddedLine[] = []): FakeCommit {
  return {
    sha,
    committedAtSeconds,
    message: `commit ${sha}`,
    committedAt: new Date(committedAtSeconds * 1000).toISOString(),
    committerName: 'Committer',
    committerEmail: 'committer@example.com',
    authorName: 'Author',
    authorEmail: 'author@example.com',
    addedLines,
  };
}

export function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Fake git: aborted')), { once: true });
  });
}
