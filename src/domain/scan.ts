import { z } from 'zod';

export const ScanStatusSchema = z.enum(['queued', 'cloning', 'scanning', 'completed', 'failed', 'stopped']);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const ACTIVE_SCAN_STATUSES: readonly ScanStatus[] = ScanStatusSchema.extract([
  'queued',
  'cloning',
  'scanning',
]).options;
export const RUNNING_SCAN_STATUSES: readonly ScanStatus[] = ScanStatusSchema.extract(['cloning', 'scanning']).options;
export const FINISHED_SCAN_STATUSES: readonly ScanStatus[] = ScanStatusSchema.extract([
  'completed',
  'failed',
  'stopped',
]).options;

export const RefTipsSchema = z.record(z.string(), z.string());
export type RefTips = z.infer<typeof RefTipsSchema>;

export const ScanSchema = z.object({
  id: z.uuid(),
  repoUrl: z.string(),
  status: ScanStatusSchema,
  refTips: RefTipsSchema.nullable(),
  totalCommits: z.number().int().nullable(),
  scannedCommits: z.number().int(),
  lastScannedSha: z.string().nullable(),
  deliveryCount: z.number().int(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  leaseToken: z.number().int(),
  stopRequested: z.boolean(),
  runAfter: z.iso.datetime().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type Scan = z.infer<typeof ScanSchema>;
