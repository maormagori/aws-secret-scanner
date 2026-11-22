import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const PORT = 3200;
const DATABASE_FILE = process.env.DATABASE_FILE ?? '/data/scanner.db';
const API_URL = process.env.API_URL ?? 'http://api:3000';
const DOCKER_SOCKET = '/var/run/docker.sock';
const LOG_TAIL = 200;
const INDEX_FILE = new URL('./index.html', import.meta.url);

const server = http.createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    sendJson(response, 500, { error: String(error) });
  }
});
server.listen(PORT, () => process.stdout.write(`dashboard on :${PORT}\n`));

async function route(request, response) {
  const { method, url } = request;
  if (method === 'GET' && url === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(await readFile(INDEX_FILE));
    return;
  }
  if (method === 'GET' && url === '/state') {
    sendJson(response, 200, readState());
    return;
  }
  if (method === 'GET' && url === '/logs') {
    sendJson(response, 200, await readLogs());
    return;
  }
  const isScanWrite = method === 'POST' && /^\/scans(\/[^/]+\/(stop|resume))?$/.test(url);
  if (isScanWrite) {
    await proxyToApi(request, response);
    return;
  }
  sendJson(response, 404, { error: 'not found' });
}

function readState() {
  let db;
  try {
    // Opened per request: the api may not have created the file yet when the dashboard starts.
    db = new DatabaseSync(DATABASE_FILE, { readOnly: true });
  } catch (error) {
    return { scans: [], findingCounts: {}, recentFindings: [], error: String(error) };
  }
  try {
    const scans = db.prepare('SELECT * FROM scans ORDER BY createdAt DESC').all();
    const countRows = db.prepare('SELECT scanId, COUNT(*) AS count FROM findings GROUP BY scanId').all();
    const findingCounts = {};
    for (const row of countRows) {
      findingCounts[row.scanId] = row.count;
    }
    const recentFindings = db.prepare('SELECT * FROM findings ORDER BY id DESC LIMIT 20').all();
    return { scans, findingCounts, recentFindings, now: new Date().toISOString() };
  } finally {
    db.close();
  }
}

async function readLogs() {
  const self = await dockerGet(`/containers/${os.hostname()}/json`);
  const project = JSON.parse(self.toString()).Config.Labels['com.docker.compose.project'];
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
  const containers = JSON.parse((await dockerGet(`/containers/json?filters=${filters}`)).toString());
  const lines = [];
  for (const container of containers) {
    const name = container.Names[0].replace(/^\//, '');
    const isDashboard = container.Labels['com.docker.compose.service'] === 'dashboard';
    if (isDashboard) continue;
    const raw = await dockerGet(`/containers/${container.Id}/logs?stdout=1&stderr=1&tail=${LOG_TAIL}&timestamps=1`);
    for (const line of stripFrameHeaders(raw).split('\n')) {
      if (line.trim() !== '') lines.push({ container: name, line });
    }
  }
  return { project, lines };
}

// Non-TTY container logs are multiplexed: each chunk has an 8-byte header (stream type, 3 zero bytes, uint32 length).
function stripFrameHeaders(raw) {
  const parts = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const length = raw.readUInt32BE(offset + 4);
    parts.push(raw.subarray(offset + 8, offset + 8 + length).toString());
    offset += 8 + length;
  }
  return parts.join('');
}

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath: DOCKER_SOCKET, path }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
  });
}

async function proxyToApi(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const hasBody = chunks.length > 0;
  const apiResponse = await fetch(API_URL + request.url, {
    method: 'POST',
    headers: hasBody ? { 'content-type': 'application/json' } : {},
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
  response.writeHead(apiResponse.status, { 'content-type': 'application/json' });
  response.end(await apiResponse.text());
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
