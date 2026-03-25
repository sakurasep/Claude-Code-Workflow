/**
 * Compatibility test for /api/memory/analyze.
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const routeUrl = new URL('../../src/core/routes/memory-routes.ts', import.meta.url);
routeUrl.searchParams.set('t', String(Date.now()));
let mod: any;
let projectRoot = '';

type JsonResponse = { status: number; json: any; text: string };

async function requestJson(baseUrl: string, method: string, path: string, body?: unknown): Promise<JsonResponse> {
  const url = new URL(path, baseUrl);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk.toString(); });
      res.on('end', () => {
        let json: any = null;
        try { json = responseBody ? JSON.parse(responseBody) : null; } catch {}
        resolve({ status: res.statusCode || 0, json, text: responseBody });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function handlePostRequest(req: http.IncomingMessage, res: http.ServerResponse, handler: (body: unknown) => Promise<any>): void {
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', async () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      const result = await handler(parsed);
      if (result?.error) {
        res.writeHead(result.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || String(err) }));
    }
  });
}

async function createServer(initialPath: string): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    const ctx = { pathname, url, req, res, initialPath, handlePostRequest, broadcastToClients() {} };
    try {
      const handled = await mod.handleMemoryRoutes(ctx);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || String(err) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('memory analyze compatibility integration', async () => {
  before(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'ccw-memory-analyze-'));
    mock.method(console, 'error', () => {});
    mod = await import(routeUrl.href);
  });

  after(() => {
    mock.restoreAll();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('POST /api/memory/analyze returns PromptInsightsResponse-compatible shape', async () => {
    const { server, baseUrl } = await createServer(projectRoot);
    try {
      const res = await requestJson(baseUrl, 'POST', '/api/memory/analyze', { tool: 'gemini', limit: 10 });
      assert.equal(res.status, 200);
      assert.equal(Array.isArray(res.json.insights), true);
      assert.equal(Array.isArray(res.json.patterns), true);
      assert.equal(Array.isArray(res.json.suggestions), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
