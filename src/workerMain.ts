import { createAppContext, handleShutdownSignals } from './bootstrap.js';
import { createGitClient } from './git/gitClient.js';
import { detectLeaks } from './scanner/detector.js';
import { createScanRunner } from './scanner/scanRunner.js';
import { createWorkerPool } from './worker/workerPool.js';

const context = await createAppContext('worker');
const scanRunner = createScanRunner({
  ...context,
  gitClient: createGitClient(context.config),
  detectLeaks,
});
const pool = createWorkerPool({ ...context, scanRunner });
await pool.start();
context.logger.info('Started');

handleShutdownSignals(context, () => pool.stop());
