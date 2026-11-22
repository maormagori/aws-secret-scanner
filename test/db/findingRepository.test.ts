import { beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, openDatabase } from '../../src/db/database.js';
import { createFindingRepository, type FindingRepository } from '../../src/db/findingRepository.js';
import { createScanRepository } from '../../src/db/scanRepository.js';
import type { NewFinding } from '../../src/domain/finding.js';

function buildFinding(scanId: string, lineNumber: number): NewFinding {
  return {
    scanId,
    commitSha: 'a'.repeat(40),
    commitMessage: 'Add config',
    committedAt: '2026-01-01T10:00:00+02:00',
    committerName: 'Ada',
    committerEmail: 'ada@example.com',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    filePath: 'config/aws.env',
    lineNumber,
    leakType: 'aws_access_key_id',
    leakValue: 'AKIAABCDEFGHIJKLMNOP',
  };
}

describe('findingRepository', () => {
  let findings: FindingRepository;
  let scanId: string;

  beforeEach(() => {
    const db = openDatabase(IN_MEMORY_DATABASE);
    findings = createFindingRepository(db);
    scanId = createScanRepository(db).createScan('https://github.com/octo/repo', new Date()).scan.id;
  });

  it('stores one row when the same finding is inserted twice', () => {
    findings.insertFindings([buildFinding(scanId, 1)]);
    findings.insertFindings([buildFinding(scanId, 1)]);

    const stored = findings.listFindings(scanId, null, 10);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject(buildFinding(scanId, 1));
  });

  it('pages in insert order with no repeats', () => {
    const lineNumbers = [5, 3, 9, 1, 7];
    findings.insertFindings(lineNumbers.map((lineNumber) => buildFinding(scanId, lineNumber)));

    const pagedLineNumbers: number[] = [];
    let afterId: number | null = null;
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const page = findings.listFindings(scanId, afterId, 2);
      pagedLineNumbers.push(...page.map((finding) => finding.lineNumber));
      afterId = page.at(-1)?.id ?? afterId;
    }

    expect(pagedLineNumbers).toEqual(lineNumbers);
    expect(findings.listFindings(scanId, afterId, 2)).toEqual([]);
  });
});
