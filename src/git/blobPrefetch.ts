const DIFF_TREE_LINE_PATTERN = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) /;
const SUBMODULE_MODE = '160000';
const ABSENT_SHA_PATTERN = /^0+$/;
const MISSING_SUFFIX = ' missing';

// Reads `git diff-tree -r` lines. git needs both sides of a change to build its diff, so both are collected.
export function listBlobShas(diffTreeLines: string[]): string[] {
  const blobShas = new Set<string>();
  for (const line of diffTreeLines) {
    const match = DIFF_TREE_LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const [, oldMode, newMode, oldSha = '', newSha = ''] = match;
    addBlobSha(blobShas, oldMode, oldSha);
    addBlobSha(blobShas, newMode, newSha);
  }
  return [...blobShas];
}

// Reads `git cat-file --batch-check` lines: `<sha> missing` for objects not in the clone.
export function listMissingShas(batchCheckLines: string[]): string[] {
  const missingShas: string[] = [];
  for (const line of batchCheckLines) {
    if (line.endsWith(MISSING_SUFFIX)) {
      missingShas.push(line.slice(0, -MISSING_SUFFIX.length));
    }
  }
  return missingShas;
}

function addBlobSha(blobShas: Set<string>, mode: string | undefined, sha: string): void {
  const isSubmodule = mode === SUBMODULE_MODE;
  const isAbsent = ABSENT_SHA_PATTERN.test(sha);
  if (isSubmodule || isAbsent) {
    return;
  }
  blobShas.add(sha);
}
