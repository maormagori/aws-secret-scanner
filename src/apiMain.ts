import { createServer } from './api/server.js';
import { createAppContext, handleShutdownSignals } from './bootstrap.js';
import { createScanService } from './services/scanService.js';

const context = await createAppContext('api');
const scanService = createScanService({
  scanRepository: context.scanRepository,
  findingRepository: context.findingRepository,
});
const server = createServer({ scanService, logger: context.logger });
await server.listen({ port: context.config.port, host: '0.0.0.0' });
context.logger.info('Started');

handleShutdownSignals(context, () => server.close());
