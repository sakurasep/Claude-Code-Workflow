/**
 * Integration tests for hooks REST compatibility endpoints used by frontend.
 */
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooksRoutesUrl = new URL('../../src/core/routes/hooks-routes.ts', import.meta.url);
hooksRoutesUrl.searchParams.set('t', String(Date.now()));

let mod: any;

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
};

async function callHooks(
  initialPath: string,
  method: string,
  pathname: string,
  body?: any,
): Promise<{ handled: boolean; status: number; json: any }> {
  const url = new URL(pathname, 'http://localhost');
  let status = 0;
  let text = '';

  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: any) {
      text = chunk === undefined ? '' : String(chunk);
    },
  };

  const handlePostRequest = async (_req: any, _res: any, handler: (parsed: any) => Promise<any>) => {
    const result = await handler(body ?? {});
    if (result && typeof result === 'object' && typeof result.error === 'string' && result.error.length > 0) {
      res.writeHead(typeof result.status === 'number' ? result.status : 500);
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    const successStatus = typeof result?.status === 'number' ? result.status : 200;
    res.writeHead(successStatus);
    res.end(JSON.stringify(result));
  };

  const handled = await mod.handleHooksRoutes({
    pathname: url.pathname,
    url,
    req: { method },
    res,
    initialPath,
    handlePostRequest,
    broadcastToClients() {},
    extractSessionIdFromPath() {
      return null;
    },
  });

  return { handled, status, json: text ? JSON.parse(text) : null };
}

describe('hooks REST compatibility integration', async () => {
  let homeDir = '';
  let projectRoot = '';

  before(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'ccw-hooks-rest-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'ccw-hooks-rest-project-'));

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.HOMEDRIVE = undefined;
    process.env.HOMEPATH = undefined;

    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
    mock.method(console, 'error', () => {});

    mod = await import(hooksRoutesUrl.href);
  });

  beforeEach(() => {
    rmSync(join(homeDir, '.claude'), { recursive: true, force: true });
    rmSync(join(projectRoot, '.claude'), { recursive: true, force: true });
  });

  after(() => {
    mock.restoreAll();
    process.env.HOME = originalEnv.HOME;
    process.env.USERPROFILE = originalEnv.USERPROFILE;
    process.env.HOMEDRIVE = originalEnv.HOMEDRIVE;
    process.env.HOMEPATH = originalEnv.HOMEPATH;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('POST /api/hooks/create creates a project hook compatible with frontend', async () => {
    const res = await callHooks(projectRoot, 'POST', '/api/hooks/create', {
      name: 'project-PreToolUse-0',
      description: 'Test hook',
      trigger: 'PreToolUse',
      matcher: 'Write',
      command: 'echo hello'
    });

    assert.equal(res.handled, true);
    assert.equal(res.status, 201);
    assert.equal(res.json.trigger, 'PreToolUse');
    assert.equal(res.json.command, 'echo hello');
    assert.equal(res.json.matcher, 'Write');
    assert.equal(res.json.scope, 'project');
    assert.equal(res.json.index, 0);
  });

  it('PATCH /api/hooks/:hookName updates an existing hook', async () => {
    const created = await callHooks(projectRoot, 'POST', '/api/hooks/create', {
      name: 'project-PreToolUse-0',
      description: 'Test hook',
      trigger: 'PreToolUse',
      matcher: 'Write',
      command: 'echo hello'
    });
    assert.equal(created.status, 201);

    const updated = await callHooks(projectRoot, 'PATCH', '/api/hooks/project-PreToolUse-0', {
      matcher: 'Edit',
      command: 'echo updated'
    });

    assert.equal(updated.handled, true);
    assert.equal(updated.status, 200);
    assert.equal(updated.json.trigger, 'PreToolUse');
    assert.equal(updated.json.matcher, 'Edit');
    assert.equal(updated.json.command, 'echo updated');
    assert.equal(updated.json.scope, 'project');
    assert.equal(updated.json.index, 0);
  });
});
