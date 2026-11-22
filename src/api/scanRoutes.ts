import type { FastifyInstance, FastifyReply } from 'fastify';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import type { ScanService } from '../services/scanService.js';
import {
  INVALID_REPO_URL,
  INVALID_REQUEST,
  REPO_HAS_ACTIVE_SCAN,
  SCAN_CANNOT_BE_RESUMED,
  SCAN_CANNOT_BE_STOPPED,
  SCAN_NOT_FOUND,
} from './apiErrors.js';
import { CreateScanBodySchema, FindingsQuerySchema, ScanParamsSchema, toScanResponse } from './apiSchemas.js';
import { ROUTE_PATHS } from './routePaths.js';

export function registerScanRoutes(app: FastifyInstance, scanService: ScanService): void {
  app.get(ROUTE_PATHS.health, (_request, reply) => reply.code(StatusCodes.OK).send({ status: 'ok' }));

  app.post(ROUTE_PATHS.scans, (request, reply) => {
    const body = CreateScanBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendInvalidRequest(reply, body.error);
    }
    const outcome = scanService.createScan(body.data.repoUrl);
    switch (outcome.kind) {
      case 'invalid':
        return reply.code(StatusCodes.BAD_REQUEST).send({ error: INVALID_REPO_URL, details: outcome.reason });
      case 'created':
        return reply.code(StatusCodes.ACCEPTED).send({ scan: toScanResponse(outcome.scan) });
      case 'existing':
        return reply.code(StatusCodes.OK).send({ scan: toScanResponse(outcome.scan) });
    }
  });

  app.get(ROUTE_PATHS.scans, (_request, reply) => {
    const scans = scanService.listScans().map(toScanResponse);
    return reply.code(StatusCodes.OK).send({ scans });
  });

  app.get(ROUTE_PATHS.scan, (request, reply) => {
    const params = ScanParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendInvalidRequest(reply, params.error);
    }
    const scan = scanService.getScan(params.data.scanId);
    if (scan === undefined) {
      return sendNotFound(reply);
    }
    return reply.code(StatusCodes.OK).send({ scan: toScanResponse(scan) });
  });

  app.get(ROUTE_PATHS.findings, (request, reply) => {
    const params = ScanParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendInvalidRequest(reply, params.error);
    }
    const query = FindingsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendInvalidRequest(reply, query.error);
    }
    const cursor = query.data.cursor ?? null;
    const outcome = scanService.listFindings(params.data.scanId, cursor, query.data.limit);
    switch (outcome.kind) {
      case 'not_found':
        return sendNotFound(reply);
      case 'page':
        return reply.code(StatusCodes.OK).send({ findings: outcome.findings, nextCursor: outcome.nextCursor });
    }
  });

  app.post(ROUTE_PATHS.stop, (request, reply) => {
    const params = ScanParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendInvalidRequest(reply, params.error);
    }
    const outcome = scanService.stopScan(params.data.scanId);
    switch (outcome.kind) {
      case 'not_found':
        return sendNotFound(reply);
      case 'invalid_state':
        return sendConflict(reply, SCAN_CANNOT_BE_STOPPED, `Scan status is ${outcome.status}`);
      case 'stopping':
      case 'stopped':
        return reply.code(StatusCodes.ACCEPTED).send({ scan: toScanResponse(outcome.scan) });
    }
  });

  app.post(ROUTE_PATHS.resume, (request, reply) => {
    const params = ScanParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendInvalidRequest(reply, params.error);
    }
    const outcome = scanService.resumeScan(params.data.scanId);
    switch (outcome.kind) {
      case 'not_found':
        return sendNotFound(reply);
      case 'invalid_state':
        return sendConflict(reply, SCAN_CANNOT_BE_RESUMED, `Scan status is ${outcome.status}`);
      case 'conflict':
        return sendConflict(reply, REPO_HAS_ACTIVE_SCAN, 'Stop or wait for the active scan of this repo first');
      case 'queued':
        return reply.code(StatusCodes.ACCEPTED).send({ scan: toScanResponse(outcome.scan) });
    }
  });
}

function sendInvalidRequest(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(StatusCodes.BAD_REQUEST).send({ error: INVALID_REQUEST, details: z.prettifyError(error) });
}

function sendNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(StatusCodes.NOT_FOUND).send({ error: SCAN_NOT_FOUND });
}

function sendConflict(reply: FastifyReply, message: string, details: string): FastifyReply {
  return reply.code(StatusCodes.CONFLICT).send({ error: message, details });
}
