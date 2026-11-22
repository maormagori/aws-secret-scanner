import { z } from 'zod';
import { RefTipsSchema, ScanSchema, type RefTips, type Scan } from '../domain/scan.js';

// SQLite has no JSON or boolean column types: refTips is stored as JSON text and stopRequested as 0/1.
const ScanRowSchema = ScanSchema.extend({
  refTips: z.string().nullable(),
  stopRequested: z.number().int(),
});

export function toScan(row: unknown): Scan {
  const scanRow = ScanRowSchema.parse(row);
  return { ...scanRow, refTips: parseRefTips(scanRow.refTips), stopRequested: scanRow.stopRequested === 1 };
}

function parseRefTips(refTipsJson: string | null): RefTips | null {
  if (refTipsJson === null) {
    return null;
  }
  return RefTipsSchema.parse(JSON.parse(refTipsJson));
}
