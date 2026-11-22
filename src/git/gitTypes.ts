import type { RefTips } from '../domain/scan.js';

export interface CommitToScan {
  sha: string;
  committedAtSeconds: number;
}

export interface AddedLine {
  filePath: string;
  lineNumber: number;
  text: string;
}

export interface CommitDiff {
  sha: string;
  message: string;
  committedAt: string;
  committerName: string;
  committerEmail: string;
  authorName: string;
  authorEmail: string;
  addedLines: AddedLine[];
}

export interface GitClient {
  cloneMirror(repoUrl: string, targetDir: string, signal: AbortSignal): Promise<void>;
  readRefTips(repoDir: string): Promise<RefTips>;
  hasAllCommits(repoDir: string, shas: string[]): Promise<boolean>;
  listCommitsNewestFirst(repoDir: string, refTips: RefTips): Promise<CommitToScan[]>;
  streamCommitDiffs(repoDir: string, shas: string[], signal: AbortSignal): AsyncIterable<CommitDiff>;
}

export class GitCommandError extends Error {
  readonly isRetryable: boolean;

  constructor(message: string, isRetryable: boolean) {
    super(message);
    this.name = 'GitCommandError';
    this.isRetryable = isRetryable;
  }
}
