/**
 * Integration tests for REST-style session routes.
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const routeUrl = new URL('../../src/core/routes/session-routes.ts', import.meta.url);
routeUrl.searchParams.set('t', String(Date.now()));

let mod: any;

type JsonResponse = { status: number; json: any; text: string };

async function requestJson(baseUrl: string, method: string, path: string, body?: unknown): Promise<JsonResponse> {
  const url = new URL(path, baseUrl);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk.toString();
        });
        res.on('end', () => {
          let json: any = null;
          try {
            json = responseBody ? JSON.parse(responseBody) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json, text: responseBody });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function handlePostRequest(req: http.IncomingMessage, res: http.ServerResponse, handler: (body: unknown) => Promise<any>): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      const result = await handler(parsed);
      if (result?.error) {
        res.writeHead(result.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
      } else {
        const successStatus = typeof result?.status === 'number' ? result.status : 200;
        res.writeHead(successStatus, { 'Content-Type': 'application/json' });
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

    const ctx = {
      pathname,
      url,
      req,
      res,
      initialPath,
      handlePostRequest,
      broadcastToClients() {},
    };

    try {
      const handled = await mod.handleSessionRoutes(ctx);
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

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ccw-sessions-rest-'));
  const activeDir = join(root, '.workflow', 'active', 'WFS-test-active');
  const archivedDir = join(root, '.workflow', 'archives', 'WFS-test-archived');

  mkdirSync(join(activeDir, '.task'), { recursive: true });
  mkdirSync(archivedDir, { recursive: true });

  writeFileSync(
    join(activeDir, 'workflow-session.json'),
    JSON.stringify({
      session_id: 'WFS-test-active',
      type: 'workflow',
      status: 'active',
      project: 'Active Project',
      description: 'Active session',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }, null, 2),
    'utf8'
  );

  writeFileSync(
    join(activeDir, '.task', 'IMPL-001.json'),
    JSON.stringify({ task_id: 'IMPL-001', status: 'pending', title: 'Task One' }, null, 2),
    'utf8'
  );

  writeFileSync(
    join(archivedDir, 'workflow-session.json'),
    JSON.stringify({
      session_id: 'WFS-test-archived',
      type: 'workflow',
      status: 'archived',
      project: 'Archived Project',
      description: 'Archived session',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      archived_at: '2025-01-02T00:00:00.000Z'
    }, null, 2),
    'utf8'
  );

  return root;
}

describe('sessions REST routes integration', async () => {
  before(async () => {
    mock.method(console, 'error', () => {});
    mod = await import(routeUrl.href);
  });

  after(() => {
    mock.restoreAll();
  });

  it('GET /api/sessions returns active and archived sessions', async () => {
    const root = createProjectFixture();
    const { server, baseUrl } = await createServer(root);
    try {
      const res = await requestJson(baseUrl, 'GET', '/api/sessions');
      assert.equal(res.status, 200);
      assert.equal(Array.isArray(res.json.activeSessions), true);
      assert.equal(Array.isArray(res.json.archivedSessions), true);
      assert.equal(res.json.activeSessions.length, 1);
      assert.equal(res.json.archivedSessions.length, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('GET /api/sessions/:id returns single session metadata', async () => {
    const root = createProjectFixture();
    const { server, baseUrl } = await createServer(root);
    try {
      const res = await requestJson(baseUrl, 'GET', '/api/sessions/WFS-test-active');
      assert.equal(res.status, 200);
      assert.equal(res.json.session_id, 'WFS-test-active');
      assert.equal(res.json.description, 'Active session');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('POST /api/sessions creates a new active session', async () => {
    const root = createProjectFixture();
    const { server, baseUrl } = await createServer(root);
    try {
      const res = await requestJson(baseUrl, 'POST', '/api/sessions', {
        session_id: 'WFS-created-session',
        title: 'Created Session',
        description: 'Created via REST',
        status: 'initialized'
      });
      assert.equal(res.status, 201);
      assert.equal(res.json.session_id, 'WFS-created-session');

      const createdFile = join(root, '.workflow', 'active', 'WFS-created-session', 'workflow-session.json');
      assert.equal(existsSync(createdFile), true);
      const meta = JSON.parse(readFileSync(createdFile, 'utf8'));
      assert.equal(meta.session_id, 'WFS-created-session');
      assert.equal(meta.description, 'Created via REST');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PATCH /api/sessions/:id updates session metadata', async () => {
    const root = createProjectFixture();
    const { server, baseUrl } = await createServer(root);
    try {
      const res = await requestJson(baseUrl, 'PATCH', '/api/sessions/WFS-test-active', {
        description: 'Updated session description',
        status: 'paused'
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.description, 'Updated session description');
      assert.equal(res.json.status, 'paused');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('POST /api/sessions/:id/archive moves session to archives', async () => {
    const root = createProjectFixture();
    const { server, baseUrl } = await createServer(root);
    try {
      const res = await requestJson(baseUrl, 'POST', '/api/sessions/WFS-test-active/archive');
      assert.equal(res.status, 200);
      assert.equal(res.json.status, 'archived');

      const activePath = join(root, '.workflow', 'active', 'WFS-test-active');
      const archivedPath = join(root, '.workflow', 'archives', 'WFS-test-active');
      assert.equal(existsSync(activePath), false);
      assert.equal(existsSync(archivedPath), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('GET /api/sessions/:id/tasks returns session tasks', async () => {
    const root = createProjectFixture();
    const { server, baseUrl } = await createServer(root);
    try {
      const res = await requestJson(baseUrl, 'GET', '/api/sessions/WFS-test-active/tasks');
      assert.equal(res.status, 200);
      assert.equal(Array.isArray(res.json), true);
      assert.equal(res.json.length, 1);
      assert.equal(res.json[0].task_id, 'IMPL-001');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PATCH /api/sessions/:id/tasks/:taskId updates a task', async () => {
    const root = createProjectFixture();
    const { server, baseUrl } = await createServer(root);
    try {
      const res = await requestJson(baseUrl, 'PATCH', '/api/sessions/WFS-test-active/tasks/IMPL-001', {
        status: 'completed'
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.status, 'completed');

      const taskFile = join(root, '.workflow', 'active', 'WFS-test-active', '.task', 'IMPL-001.json');
      const task = JSON.parse(readFileSync(taskFile, 'utf8'));
      assert.equal(task.status, 'completed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DELETE /api/sessions/:id removes an active session', async () => {
    const root = createProjectFixture();
    const { server, baseUrl } = await createServer(root);
    try {
      const res = await requestJson(baseUrl, 'DELETE', '/api/sessions/WFS-test-active');
      assert.equal(res.status, 204);

      const activePath = join(root, '.workflow', 'active', 'WFS-test-active');
      assert.equal(existsSync(activePath), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
