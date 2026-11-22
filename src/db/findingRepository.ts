import type { DatabaseSync } from 'node:sqlite';
import { FindingSchema, type Finding, type NewFinding } from '../domain/finding.js';

export interface FindingRepository {
  insertFindings(findings: NewFinding[]): void;
  listFindings(scanId: string, afterId: number | null, limit: number): Finding[];
}

const FIRST_PAGE_AFTER_ID = 0;

export function createFindingRepository(db: DatabaseSync): FindingRepository {
  // OR IGNORE plus the unique index on the leak's location makes replaying a batch after a crash a no-op.
  const insertFinding = db.prepare(`
    INSERT OR IGNORE INTO findings (
      scanId, commitSha, commitMessage, committedAt, committerName, committerEmail,
      authorName, authorEmail, filePath, lineNumber, leakType, leakValue
    ) VALUES (
      :scanId, :commitSha, :commitMessage, :committedAt, :committerName, :committerEmail,
      :authorName, :authorEmail, :filePath, :lineNumber, :leakType, :leakValue
    )`);
  const selectFindingsPage = db.prepare('SELECT * FROM findings WHERE scanId = ? AND id > ? ORDER BY id LIMIT ?');

  return {
    insertFindings(findings) {
      for (const finding of findings) {
        insertFinding.run(finding);
      }
    },

    listFindings(scanId, afterId, limit) {
      const rows = selectFindingsPage.all(scanId, afterId ?? FIRST_PAGE_AFTER_ID, limit);
      return rows.map((row) => FindingSchema.parse(row));
    },
  };
}
