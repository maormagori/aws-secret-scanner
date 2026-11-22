import type { CommitToScan } from './gitTypes.js';

const REV_LIST_LINE_PATTERN = /^(\d+) ([0-9a-f]+)$/;

export function sortCommitsNewestFirst(commits: CommitToScan[]): CommitToScan[] {
  return [...commits].sort(compareNewestFirst);
}

export function parseRevListLine(line: string): CommitToScan {
  const match = REV_LIST_LINE_PATTERN.exec(line);
  if (match === null) {
    throw new Error(`Unexpected git rev-list line: ${line}`);
  }
  const [, seconds = '', sha = ''] = match;
  return { sha, committedAtSeconds: Number(seconds) };
}

function compareNewestFirst(left: CommitToScan, right: CommitToScan): number {
  if (left.committedAtSeconds !== right.committedAtSeconds) {
    return right.committedAtSeconds - left.committedAtSeconds;
  }
  if (left.sha === right.sha) {
    return 0;
  }
  return left.sha < right.sha ? -1 : 1;
}
