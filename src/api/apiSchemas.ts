import { z } from 'zod';
import { ScanSchema, type Scan } from '../domain/scan.js';

export const DEFAULT_FINDINGS_LIMIT = 100;
export const MAX_FINDINGS_LIMIT = 500;

export const CreateScanBodySchema = z.object({ repoUrl: z.string() });

export const ScanParamsSchema = z.object({ scanId: z.string().min(1) });

// Query strings arrive as text, so the numbers are coerced.
export const FindingsQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_FINDINGS_LIMIT).default(DEFAULT_FINDINGS_LIMIT),
});

// The public scan shape: lease internals (owner, token, expiry, runAfter) and refTips stay inside the service.
export const ScanResponseSchema = ScanSchema.pick({
  repoUrl: true,
  status: true,
  deliveryCount: true,
  stopRequested: true,
  error: true,
  createdAt: true,
  updatedAt: true,
  finishedAt: true,
}).extend({
  scanId: ScanSchema.shape.id,
  progress: ScanSchema.pick({ scannedCommits: true, totalCommits: true }),
});
export type ScanResponse = z.infer<typeof ScanResponseSchema>;

export function toScanResponse(scan: Scan): ScanResponse {
  return {
    scanId: scan.id,
    repoUrl: scan.repoUrl,
    status: scan.status,
    progress: { scannedCommits: scan.scannedCommits, totalCommits: scan.totalCommits },
    deliveryCount: scan.deliveryCount,
    stopRequested: scan.stopRequested,
    error: scan.error,
    createdAt: scan.createdAt,
    updatedAt: scan.updatedAt,
    finishedAt: scan.finishedAt,
  };
}
