import { z } from 'zod';
import type { CommitDiff } from './gitTypes.js';
import { unquoteGitPath } from './quotedPath.js';

const COMMIT_MARKER = '\x01';
const FIELD_SEPARATOR = '\x1f';

export const COMMIT_HEADER_FORMAT = '%x01%H%x1f%cI%x1f%cn%x1f%ce%x1f%an%x1f%ae%x1f%s';

const HeaderFieldsSchema = z.tuple([
  z.string(),
  z.iso.datetime({ offset: true }),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const NEW_FILE_HEADER = '+++ ';
const NEW_FILE_PATH_PREFIX = 'b/';

export interface DiffParser {
  pushLine(line: string): CommitDiff | undefined;
  finish(): CommitDiff | undefined;
}

export function createDiffParser(): DiffParser {
  let currentCommit: CommitDiff | undefined;
  // Stays undefined for deleted files (`+++ /dev/null`) and binary files (no `+++` line), so they add nothing.
  let currentFilePath: string | undefined;
  // `+++`/`Binary files` are file headers only before the first `@@`; inside a hunk, `+++x` is an added line `++x`.
  let isInFileHeader = false;
  let nextLineNumber = 0;

  function pushLine(line: string): CommitDiff | undefined {
    if (line.startsWith(COMMIT_MARKER)) {
      const finishedCommit = currentCommit;
      currentCommit = parseCommitHeader(line);
      currentFilePath = undefined;
      isInFileHeader = false;
      return finishedCommit;
    }
    if (currentCommit === undefined) {
      return undefined;
    }
    if (line.startsWith('diff --git ')) {
      currentFilePath = undefined;
      isInFileHeader = true;
      return undefined;
    }
    if (isInFileHeader) {
      readFileHeaderLine(line);
      return undefined;
    }
    readHunkLine(line, currentCommit);
    return undefined;
  }

  function readFileHeaderLine(line: string): void {
    const hunkMatch = HUNK_HEADER_PATTERN.exec(line);
    if (hunkMatch !== null) {
      nextLineNumber = Number(hunkMatch[1]);
      isInFileHeader = false;
      return;
    }
    if (line.startsWith(NEW_FILE_HEADER)) {
      currentFilePath = parseNewFilePath(line.slice(NEW_FILE_HEADER.length));
    }
  }

  function readHunkLine(line: string, commit: CommitDiff): void {
    const hunkMatch = HUNK_HEADER_PATTERN.exec(line);
    if (hunkMatch !== null) {
      nextLineNumber = Number(hunkMatch[1]);
      return;
    }
    if (line.startsWith('+')) {
      if (currentFilePath !== undefined) {
        commit.addedLines.push({ filePath: currentFilePath, lineNumber: nextLineNumber, text: line.slice(1) });
      }
      nextLineNumber += 1;
      return;
    }
    if (line.startsWith(' ')) {
      nextLineNumber += 1;
    }
  }

  function finish(): CommitDiff | undefined {
    const finishedCommit = currentCommit;
    currentCommit = undefined;
    return finishedCommit;
  }

  return { pushLine, finish };
}

// Returns undefined for `/dev/null` (a deleted file).
function parseNewFilePath(rawPath: string): string | undefined {
  // git appends a tab after an unquoted path that contains a space (for `patch` compatibility).
  const unquotedPath = unquoteGitPath(rawPath.replace(/\t$/, ''));
  if (!unquotedPath.startsWith(NEW_FILE_PATH_PREFIX)) {
    return undefined;
  }
  return unquotedPath.slice(NEW_FILE_PATH_PREFIX.length);
}

function parseCommitHeader(line: string): CommitDiff {
  const fields = HeaderFieldsSchema.parse(line.slice(COMMIT_MARKER.length).split(FIELD_SEPARATOR));
  const [sha, committedAt, committerName, committerEmail, authorName, authorEmail, message] = fields;
  return {
    sha,
    message,
    committedAt: new Date(committedAt).toISOString(),
    committerName,
    committerEmail,
    authorName,
    authorEmail,
    addedLines: [],
  };
}
