import { z } from 'zod';

export const LeakTypeSchema = z.enum(['aws_access_key_id', 'aws_secret_access_key']);
export type LeakType = z.infer<typeof LeakTypeSchema>;

export const FindingSchema = z.object({
  id: z.number().int(),
  scanId: z.uuid(),
  commitSha: z.string(),
  commitMessage: z.string(),
  committedAt: z.iso.datetime({ offset: true }),
  committerName: z.string(),
  committerEmail: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  filePath: z.string(),
  lineNumber: z.number().int(),
  leakType: LeakTypeSchema,
  leakValue: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const NewFindingSchema = FindingSchema.omit({ id: true });
export type NewFinding = z.infer<typeof NewFindingSchema>;
