import { fastify, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from '../logger.js';
import type { ScanService } from '../services/scanService.js';
import { registerScanRoutes } from './scanRoutes.js';

interface ServerDeps {
  scanService: ScanService;
  logger: Logger;
}

export function createServer({ scanService, logger }: ServerDeps): FastifyInstance {
  // Typed as Fastify's logger interface so the instance matches the plain FastifyInstance type the routes take.
  const fastifyLogger: FastifyBaseLogger = logger;
  const app = fastify({ loggerInstance: fastifyLogger });
  registerScanRoutes(app, scanService);
  return app;
}
