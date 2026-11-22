import type { FastifyInstance } from 'fastify';
import { StatusCodes } from 'http-status-codes';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVALID_REPO_URL, INVALID_REQUEST, SCAN_CANNOT_BE_STOPPED, SCAN_NOT_FOUND } from '../../src/api/apiErrors.js';
import { ROUTE_PATHS, withScanId } from '../../src/api/routePaths.js';
import { createServer } from '../../src/api/server.js';
import { IN_MEMORY_DATABASE, openDatabase } from '../../src/db/database.js';
import { createFindingRepository, type FindingRepository } from '../../src/db/findingRepository.js';
import { createScanRepository, type ScanRepository } from '../../src/db/scanRepository.js';
import type { NewFinding } from '../../src/domain/finding.js';
import { createScanService } from '../../src/services/scanService.js';
import { createTestConfig } from '../helpers/testConfig.js';

const config = createTestConfig();
const repoUrl = 'https://github.com/octo/repo';

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

describe('scan routes', () => {
  let app: FastifyInstance;
  let scanRepository: ScanRepository;
  let findingRepository: FindingRepository;

  beforeEach(() => {
    const db = openDatabase(IN_MEMORY_DATABASE);
    scanRepository = createScanRepository(db);
    findingRepository = createFindingRepository(db);
    const scanService = createScanService({ scanRepository, findingRepository });
    app = createServer({ scanService, logger: pino({ level: config.logLevel }) });
  });

  afterEach(async () => {
    await app.close();
  });

  async function postScan(repoUrlInput: unknown): Promise<{ statusCode: number; scanId: string }> {
    const response = await app.inject({ method: 'POST', url: ROUTE_PATHS.scans, payload: { repoUrl: repoUrlInput } });
    return { statusCode: response.statusCode, scanId: response.json().scan?.scanId };
  }

  it('reports health', async () => {
    const response = await app.inject({ method: 'GET', url: ROUTE_PATHS.health });

    expect(response.statusCode).toBe(StatusCodes.OK);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('creates a scan, then returns the same active scan for the same repo', async () => {
    const created = await postScan(repoUrl);
    const existing = await postScan('octo/repo');

    expect(created.statusCode).toBe(StatusCodes.ACCEPTED);
    expect(existing.statusCode).toBe(StatusCodes.OK);
    expect(existing.scanId).toBe(created.scanId);
  });

  it('returns the public scan shape without lease internals', async () => {
    const { scanId } = await postScan(repoUrl);

    const response = await app.inject({ method: 'GET', url: withScanId(ROUTE_PATHS.scan, scanId) });

    expect(response.statusCode).toBe(StatusCodes.OK);
    expect(Object.keys(response.json().scan).sort()).toEqual(
      [
        'deliveryCount',
        'createdAt',
        'error',
        'finishedAt',
        'progress',
        'repoUrl',
        'scanId',
        'status',
        'stopRequested',
        'updatedAt',
      ].sort(),
    );
    expect(response.json().scan.progress).toEqual({ scannedCommits: 0, totalCommits: null });
  });

  it('lists scans', async () => {
    await postScan(repoUrl);

    const response = await app.inject({ method: 'GET', url: ROUTE_PATHS.scans });

    expect(response.statusCode).toBe(StatusCodes.OK);
    expect(response.json().scans).toHaveLength(1);
  });

  it('rejects an invalid repo URL and a missing body field', async () => {
    const invalidUrl = await app.inject({ method: 'POST', url: ROUTE_PATHS.scans, payload: { repoUrl: 'nope' } });
    const missingField = await app.inject({ method: 'POST', url: ROUTE_PATHS.scans, payload: {} });

    expect(invalidUrl.statusCode).toBe(StatusCodes.BAD_REQUEST);
    expect(invalidUrl.json().error).toBe(INVALID_REPO_URL);
    expect(missingField.statusCode).toBe(StatusCodes.BAD_REQUEST);
    expect(missingField.json().error).toBe(INVALID_REQUEST);
  });

  it('returns 404 for an unknown scan', async () => {
    const response = await app.inject({ method: 'GET', url: withScanId(ROUTE_PATHS.scan, 'missing') });

    expect(response.statusCode).toBe(StatusCodes.NOT_FOUND);
    expect(response.json()).toEqual({ error: SCAN_NOT_FOUND });
  });

  it('pages findings with a cursor', async () => {
    const { scanId } = await postScan(repoUrl);
    findingRepository.insertFindings([buildFinding(scanId, 1), buildFinding(scanId, 2), buildFinding(scanId, 3)]);
    const findingsUrl = withScanId(ROUTE_PATHS.findings, scanId);

    const firstPage = await app.inject({ method: 'GET', url: findingsUrl, query: { limit: '2' } });
    const { nextCursor } = firstPage.json();
    const secondPage = await app.inject({
      method: 'GET',
      url: findingsUrl,
      query: { limit: '2', cursor: `${nextCursor}` },
    });

    expect(firstPage.json().findings.map((finding: NewFinding) => finding.lineNumber)).toEqual([1, 2]);
    expect(nextCursor).not.toBeNull();
    expect(secondPage.json().findings.map((finding: NewFinding) => finding.lineNumber)).toEqual([3]);
    expect(secondPage.json().nextCursor).toBeNull();
  });

  it('rejects a bad findings query and an unknown scan', async () => {
    const { scanId } = await postScan(repoUrl);

    const tooLarge = await app.inject({
      method: 'GET',
      url: withScanId(ROUTE_PATHS.findings, scanId),
      query: { limit: '100000' },
    });
    const unknownScan = await app.inject({ method: 'GET', url: withScanId(ROUTE_PATHS.findings, 'missing') });

    expect(tooLarge.statusCode).toBe(StatusCodes.BAD_REQUEST);
    expect(unknownScan.statusCode).toBe(StatusCodes.NOT_FOUND);
  });

  it('stops a queued scan, then resumes it', async () => {
    const { scanId } = await postScan(repoUrl);

    const stopped = await app.inject({ method: 'POST', url: withScanId(ROUTE_PATHS.stop, scanId) });
    const resumed = await app.inject({ method: 'POST', url: withScanId(ROUTE_PATHS.resume, scanId) });

    expect(stopped.statusCode).toBe(StatusCodes.ACCEPTED);
    expect(stopped.json().scan.status).toBe('stopped');
    expect(resumed.statusCode).toBe(StatusCodes.ACCEPTED);
    expect(resumed.json().scan.status).toBe('queued');
  });

  it('refuses to stop a completed scan', async () => {
    const { scanId } = await postScan(repoUrl);
    const claimed = scanRepository.claimNextScan('worker-1', new Date(), config.leaseMs, config.maxDeliveries);
    const leaseToken = claimed?.leaseToken ?? null;
    scanRepository.transitionScan({ scanId, from: 'cloning', to: 'scanning', leaseToken, now: new Date() });
    scanRepository.transitionScan({ scanId, from: 'scanning', to: 'completed', leaseToken, now: new Date() });

    const response = await app.inject({ method: 'POST', url: withScanId(ROUTE_PATHS.stop, scanId) });

    expect(response.statusCode).toBe(StatusCodes.CONFLICT);
    expect(response.json().error).toBe(SCAN_CANNOT_BE_STOPPED);
  });
});
