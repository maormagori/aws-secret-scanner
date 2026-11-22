import { z } from 'zod';

export const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  dataDir: z.string().min(1).default('./data'),
  clonesDir: z.string().min(1).default('./data/clones'),
  databaseFile: z.string().min(1).default('./data/scanner.db'),
  // An empty value (e.g. `GITHUB_TOKEN=` in a compose file) means "no token", not an empty token.
  githubToken: z
    .string()
    .optional()
    .transform((token) => (token === '' ? undefined : token)),
  workerConcurrency: z.coerce.number().int().positive().default(3),
  leaseMs: z.coerce.number().int().positive().default(30000),
  pollMs: z.coerce.number().int().positive().default(1000),
  batchSize: z.coerce.number().int().positive().default(200),
  maxDeliveries: z.coerce.number().int().positive().default(3),
  retryBaseMs: z.coerce.number().int().positive().default(5000),
  cloneTimeoutMs: z.coerce.number().int().positive().default(600000),
  bigFileThreshold: z.string().min(1).default('50m'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = ConfigSchema.safeParse({
    port: env.PORT,
    dataDir: env.DATA_DIR,
    clonesDir: env.CLONES_DIR,
    databaseFile: env.DATABASE_FILE,
    githubToken: env.GITHUB_TOKEN,
    workerConcurrency: env.WORKER_CONCURRENCY,
    leaseMs: env.LEASE_MS,
    pollMs: env.POLL_MS,
    batchSize: env.BATCH_SIZE,
    maxDeliveries: env.MAX_DELIVERIES,
    retryBaseMs: env.RETRY_BASE_MS,
    cloneTimeoutMs: env.CLONE_TIMEOUT_MS,
    bigFileThreshold: env.BIG_FILE_THRESHOLD,
    logLevel: env.LOG_LEVEL,
  });
  if (!result.success) {
    throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
