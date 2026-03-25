/**
 * Hooks Routes Module
 * Handles all hooks-related API endpoints
 *
 * ## API Endpoints
 *
 * ### Active Endpoints
 * - POST /api/hook - Main hook endpoint for Claude Code notifications
 *   - Handles: session-start, context, CLI events, A2UI surfaces
 * - POST /api/hook/ccw-exec - Execute CCW CLI commands and parse output
 * - GET /api/hook/project-state - Get project guidelines and recent dev history summary
 * - GET /api/hooks - Get hooks configuration from global and project settings
 * - POST /api/hooks - Save a hook to settings
 * - DELETE /api/hooks - Delete a hook from settings
 *
 * ### Deprecated Endpoints (will be removed in v2.0.0)
 * - POST /api/hook/session-context - Use `ccw hook session-context --stdin` instead
 * - POST /api/hook/ccw-status - Use /api/hook/ccw-exec with command=parse-status
 *
 * ## Service Layer
 * All endpoints use unified services:
 * - HookContextService: Context generation for session-start and per-prompt hooks
 * - SessionStateService: Session state tracking and persistence
 * - SessionEndService: Background task management for session-end events
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';

import type { RouteContext } from './types.js';
import { a2uiWebSocketHandler } from '../a2ui/A2UIWebSocketHandler.js';

interface HooksRouteContext extends RouteContext {
  extractSessionIdFromPath: (filePath: string) => string | null;
}

// ========================================
// Helper Functions
// ========================================

const GLOBAL_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/**
 * Get project settings path
 * @param {string} projectPath
 * @returns {string}
 */
function getProjectSettingsPath(projectPath: string): string {
  // path.join automatically handles cross-platform path separators
  return join(projectPath, '.claude', 'settings.json');
}

/**
 * Read settings file safely
 * @param {string} filePath
 * @returns {Object}
 */
function readSettingsFile(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) {
      return {};
    }
    const content = readFileSync(filePath, 'utf8');
    if (!content.trim()) {
      return {};
    }
    return JSON.parse(content);
  } catch (error: unknown) {
    console.error(`Error reading settings file ${filePath}:`, error);
    return {};
  }
}

/**
 * Get hooks configuration from global and project settings
 * @param {string} projectPath
 * @returns {Object}
 */
function getHooksConfig(projectPath: string): { global: { path: string; hooks: unknown }; project: { path: string | null; hooks: unknown } } {
  const globalSettings = readSettingsFile(GLOBAL_SETTINGS_PATH);
  const projectSettingsPath = projectPath ? getProjectSettingsPath(projectPath) : null;
  const projectSettings = projectSettingsPath ? readSettingsFile(projectSettingsPath) : {};

  return {
    global: {
      path: GLOBAL_SETTINGS_PATH,
      hooks: (globalSettings as { hooks?: unknown }).hooks || {}
    },
    project: {
      path: projectSettingsPath,
      hooks: (projectSettings as { hooks?: unknown }).hooks || {}
    }
  };
}

/**
 * Normalize hook data to Claude Code's official nested format
 * Official format: { matcher?: string, hooks: [{ type: 'command', command: string, timeout?: number }] }
 *
 * IMPORTANT: All timeout values from frontend are in MILLISECONDS and must be converted to SECONDS.
 * Official Claude Code spec requires timeout in seconds.
 *
 * @param {Object} hookData - Hook configuration (may be flat or nested format)
 * @returns {Object} Normalized hook data in official format
 */
function normalizeHookFormat(hookData: Record<string, unknown>): Record<string, unknown> {
  /**
   * Convert timeout from milliseconds to seconds
   * Frontend always sends milliseconds, Claude Code expects seconds
   */
  const convertTimeout = (timeout: number): number => {
    // Always convert from milliseconds to seconds
    // This is safe because:
    // - Frontend (HookWizard) uses milliseconds (e.g., 5000ms)
    // - Claude Code official spec requires seconds
    // - Minimum valid timeout is 1 second, so any value < 1000ms becomes 1s
    return Math.max(1, Math.ceil(timeout / 1000));
  };

  // If already in nested format with hooks array, validate and convert
  if (hookData.hooks && Array.isArray(hookData.hooks)) {
    // Ensure each hook in the array has required fields
    const normalizedHooks = (hookData.hooks as Array<Record<string, unknown>>).map(h => {
      const normalized: Record<string, unknown> = {
        type: h.type || 'command',
        command: h.command || '',
      };
      // Convert timeout from milliseconds to seconds
      if (typeof h.timeout === 'number') {
        normalized.timeout = convertTimeout(h.timeout);
      }
      return normalized;
    });

    return {
      ...(hookData.matcher !== undefined ? { matcher: hookData.matcher } : { matcher: '' }),
      hooks: normalizedHooks,
    };
  }

  // Convert flat format to nested format
  // Old format: { command: '...', timeout: 5000, name: '...', failMode: '...' }
  // New format: { matcher: '', hooks: [{ type: 'command', command: '...', timeout: 5 }] }
  if (hookData.command && typeof hookData.command === 'string') {
    const nestedHook: Record<string, unknown> = {
      type: 'command',
      command: hookData.command,
    };

    // Convert timeout from milliseconds to seconds
    if (typeof hookData.timeout === 'number') {
      nestedHook.timeout = convertTimeout(hookData.timeout);
    }

    return {
      matcher: typeof hookData.matcher === 'string' ? hookData.matcher : '',
      hooks: [nestedHook],
    };
  }

  // Return as-is if we can't normalize (let Claude Code validate)
  return hookData;
}

/**
 * Save a hook to settings file
 * @param {string} projectPath
 * @param {string} scope - 'global' or 'project'
 * @param {string} event - Hook event type
 * @param {Object} hookData - Hook configuration
 * @returns {Object}
 */
function saveHookToSettings(
  projectPath: string,
  scope: 'global' | 'project',
  event: string,
  hookData: Record<string, unknown> & { replaceIndex?: unknown }
): Record<string, unknown> {
  try {
    const filePath = scope === 'global' ? GLOBAL_SETTINGS_PATH : getProjectSettingsPath(projectPath);
    const settings = readSettingsFile(filePath) as Record<string, unknown> & { hooks?: Record<string, unknown> };

    // Ensure hooks object exists
    settings.hooks = settings.hooks || {};

    // Ensure the event array exists
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Ensure it's an array
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [settings.hooks[event]];
    }

    // Normalize hook data to official format
    const normalizedData = normalizeHookFormat(hookData);

    // Check if we're replacing an existing hook
    if (typeof hookData.replaceIndex === 'number') {
      const index = hookData.replaceIndex;
      const hooksForEvent = settings.hooks[event] as unknown[];
      if (index >= 0 && index < hooksForEvent.length) {
        hooksForEvent[index] = normalizedData;
      }
    } else {
      // Add new hook
      (settings.hooks[event] as unknown[]).push(normalizedData);
    }

    // Ensure directory exists and write file
    const dirPath = dirname(filePath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');

    return {
      success: true,
      event,
      hookData
    };
  } catch (error: unknown) {
    console.error('Error saving hook:', error);
    return { error: (error as Error).message };
  }
}

/**
 * Delete a hook from settings file
 * @param {string} projectPath
 * @param {string} scope - 'global' or 'project'
 * @param {string} event - Hook event type
 * @param {number} hookIndex - Index of hook to delete
 * @returns {Object}
 */
function deleteHookFromSettings(
  projectPath: string,
  scope: 'global' | 'project',
  event: string,
  hookIndex: number
): Record<string, unknown> {
  try {
    const filePath = scope === 'global' ? GLOBAL_SETTINGS_PATH : getProjectSettingsPath(projectPath);
    const settings = readSettingsFile(filePath) as Record<string, unknown> & { hooks?: Record<string, unknown> };

    if (!settings.hooks || !settings.hooks[event]) {
      return { error: 'Hook not found' };
    }

    // Ensure it's an array
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [settings.hooks[event]];
    }

    const hooksForEvent = settings.hooks[event] as unknown[];

    if (hookIndex < 0 || hookIndex >= hooksForEvent.length) {
      return { error: 'Invalid hook index' };
    }

    // Remove the hook
    hooksForEvent.splice(hookIndex, 1);

    // Remove empty event arrays
    if (hooksForEvent.length === 0) {
      delete settings.hooks[event];
    }

    writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');

    return {
      success: true,
      event,
      hookIndex
    };
  } catch (error: unknown) {
    console.error('Error deleting hook:', error);
    return { error: (error as Error).message };
  }
}

function parseHookName(hookName: string): { scope: 'global' | 'project'; event: string; index: number } | null {
  const parts = hookName.split('-');
  if (parts.length < 3) return null;
  const scope = parts[0];
  const indexStr = parts[parts.length - 1];
  const event = parts.slice(1, -1).join('-');
  const index = Number(indexStr);

  if ((scope !== 'global' && scope !== 'project') || !event || Number.isNaN(index)) {
    return null;
  }

  return { scope, event, index } as { scope: 'global' | 'project'; event: string; index: number };
}

function getHookEntry(projectPath: string, scope: 'global' | 'project', event: string, hookIndex: number): Record<string, unknown> | null {
  const hooksData = getHooksConfig(projectPath);
  const scopeData = hooksData[scope];
  const hooks = scopeData?.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || !Array.isArray(hooks[event]) || hookIndex < 0 || hookIndex >= hooks[event].length) {
    return null;
  }
  return hooks[event][hookIndex] as Record<string, unknown>;
}

function mapHookResponse(
  hookName: string,
  scope: 'global' | 'project',
  event: string,
  hookIndex: number,
  hookEntry: Record<string, unknown>,
): Record<string, unknown> {
  let command = '';
  if (Array.isArray(hookEntry.hooks) && hookEntry.hooks.length > 0) {
    command = (hookEntry.hooks as Array<Record<string, unknown>>)
      .map((h) => String(h.command || h.prompt || ''))
      .filter(Boolean)
      .join(' && ');
  }
  if (!command && typeof hookEntry.command === 'string') {
    command = hookEntry.command;
  }

  return {
    name: hookName,
    description: typeof hookEntry.description === 'string' ? hookEntry.description : undefined,
    enabled: true,
    command,
    trigger: event,
    matcher: typeof hookEntry.matcher === 'string' ? hookEntry.matcher : undefined,
    scope,
    index: hookIndex,
    templateId: typeof hookEntry._templateId === 'string' ? hookEntry._templateId : undefined,
  };
}

// ========================================
// Session State Tracking
// ========================================
// NOTE: Session state is managed by the CLI command (src/commands/hook.ts)
// using file-based persistence (~/.claude/.ccw-sessions/).
// This ensures consistent state tracking across all invocation methods.
// The /api/hook endpoint delegates to SessionClusteringService without
// managing its own state, as the authoritative state lives in the CLI layer.

// ========================================
// Route Handler
// ========================================

/**
 * Handle hooks routes
 * @returns true if route was handled, false otherwise
 */
export async function handleHooksRoutes(ctx: HooksRouteContext): Promise<boolean> {
  const { pathname, url, req, res, initialPath, handlePostRequest, broadcastToClients, extractSessionIdFromPath } = ctx;

  // API: Hook endpoint for Claude Code notifications
  if (pathname === '/api/hook' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      if (typeof body !== 'object' || body === null) {
        return { error: 'Invalid request body', status: 400 };
      }

      const payload = body as Record<string, unknown>;
      const type = payload.type;
      const filePath = payload.filePath;
      const sessionId = payload.sessionId;
      const extraData: Record<string, unknown> = { ...payload };
      delete extraData.type;
      delete extraData.filePath;
      delete extraData.sessionId;

      // Determine session ID from file path if not provided
      let resolvedSessionId = typeof sessionId === 'string' ? sessionId : undefined;
      if (!resolvedSessionId && typeof filePath === 'string') {
        resolvedSessionId = extractSessionIdFromPath(filePath) ?? undefined;
      }

      // Handle context hooks (session-start, context)
      if (type === 'session-start' || type === 'context') {
        try {
          const projectPath = url.searchParams.get('path') || initialPath;

          // Use HookContextService for unified context generation
          const { HookContextService } = await import('../services/hook-context-service.js');
          const contextService = new HookContextService({ projectPath });

          const format = url.searchParams.get('format') || 'markdown';
          const prompt = typeof extraData.prompt === 'string' ? extraData.prompt : undefined;

          // Build context using the service
          const result = await contextService.buildPromptContext({
            sessionId: resolvedSessionId || '',
            prompt,
            projectId: projectPath
          });

          // Return context directly
          return {
            success: true,
            type: result.type,
            format,
            content: result.content,
            sessionId: resolvedSessionId
          };
        } catch (error) {
          console.error('[Hooks] Failed to generate context:', error);
          // Return empty content on failure (fail silently)
          return {
            success: true,
            type: 'context',
            format: 'markdown',
            content: '',
            sessionId: resolvedSessionId,
            error: (error as Error).message
          };
        }
      }

      // Update active executions state for CLI streaming events (terminal execution)
      if (type === 'CLI_EXECUTION_STARTED' || type === 'CLI_OUTPUT' || type === 'CLI_EXECUTION_COMPLETED') {
        console.log(`[Hooks] CLI event: ${type}, executionId: ${extraData.executionId}`);
        try {
          const { updateActiveExecution } = await import('./cli-routes.js');

          if (type === 'CLI_EXECUTION_STARTED') {
            updateActiveExecution({
              type: 'started',
              executionId: String(extraData.executionId || ''),
              tool: String(extraData.tool || 'unknown'),
              mode: String(extraData.mode || 'analysis'),
              prompt: String(extraData.prompt_preview || '')
            });
          } else if (type === 'CLI_OUTPUT') {
            updateActiveExecution({
              type: 'output',
              executionId: String(extraData.executionId || ''),
              output: String(extraData.data || '')
            });
          } else if (type === 'CLI_EXECUTION_COMPLETED') {
            updateActiveExecution({
              type: 'completed',
              executionId: String(extraData.executionId || ''),
              success: Boolean(extraData.success)
            });
          }
        } catch (err) {
          console.error('[Hooks] Failed to update active execution:', err);
        }
      }

      // Broadcast to all connected WebSocket clients
      const notification = {
        type: typeof type === 'string' && type.trim().length > 0 ? type : 'session_updated',
        payload: {
          sessionId: resolvedSessionId,
          filePath: typeof filePath === 'string' ? filePath : undefined,
          timestamp: new Date().toISOString(),
          ...extraData  // Pass through toolName, status, result, params, error, etc.
        }
      };

      // When an A2UI surface is forwarded from the MCP process, initialize
      // selection tracking on the Dashboard so that submit actions resolve
      // to the correct value type (single-select string vs multi-select array).
      if (type === 'a2ui-surface' && extraData?.initialState) {
        const initState = extraData.initialState as Record<string, unknown>;
        const questionId = initState.questionId as string | undefined;
        const questionType = initState.questionType as string | undefined;

        // Handle multi-question surfaces (multi-page): initialize tracking for each page
        if (questionType === 'multi-question' && Array.isArray(initState.pages)) {
          const pages = initState.pages as Array<{ questionId: string; type: string }>;
          for (const page of pages) {
            if (page.type === 'multi-select') {
              a2uiWebSocketHandler.initMultiSelect(page.questionId);
            } else if (page.type === 'select') {
              a2uiWebSocketHandler.initSingleSelect(page.questionId);
            }
          }
        } else if (questionId && questionType === 'select') {
          // Single-question surface: initialize based on question type
          a2uiWebSocketHandler.initSingleSelect(questionId);
        } else if (questionId && questionType === 'multi-select') {
          a2uiWebSocketHandler.initMultiSelect(questionId);
        }
      }

      broadcastToClients(notification);

      return { success: true, notification };
    });
    return true;
  }

  // API: Unified Session Context endpoint (Progressive Disclosure)
  // @DEPRECATED - This endpoint is deprecated and will be removed in a future version.
  // Migration: Use CLI command `ccw hook session-context --stdin` instead.
  // This endpoint now uses HookContextService for consistency with CLI.
  // - First prompt: returns cluster-based session overview
  // - Subsequent prompts: returns intent-matched sessions based on prompt
  if (pathname === '/api/hook/session-context' && req.method === 'POST') {
    // Add deprecation warning header
    res.setHeader('X-Deprecated', 'true');
    res.setHeader('X-Deprecation-Message', 'Use CLI command "ccw hook session-context --stdin" instead. This endpoint will be removed in v2.0.0');
    res.setHeader('X-Migration-Guide', 'https://github.com/ccw-project/ccw/blob/main/docs/migration-hooks.md#session-context');

    handlePostRequest(req, res, async (body) => {
      // Log deprecation warning
      console.warn('[DEPRECATED] /api/hook/session-context is deprecated. Use "ccw hook session-context --stdin" instead.');

      const { sessionId, prompt } = body as { sessionId?: string; prompt?: string };

      if (!sessionId) {
        return {
          success: true,
          content: '',
          error: 'sessionId is required',
          _deprecated: true,
          _migration: 'Use "ccw hook session-context --stdin"'
        };
      }

      try {
        const projectPath = url.searchParams.get('path') || initialPath;

        // Use HookContextService for unified context generation
        const { HookContextService } = await import('../services/hook-context-service.js');
        const contextService = new HookContextService({ projectPath });

        // Build context using the service
        const result = await contextService.buildPromptContext({
          sessionId,
          prompt,
          projectId: projectPath
        });

        return {
          success: true,
          type: result.type,
          isFirstPrompt: result.isFirstPrompt,
          loadCount: result.state.loadCount,
          content: result.content,
          sessionId,
          _deprecated: true,
          _migration: 'Use "ccw hook session-context --stdin"'
        };
      } catch (error) {
        console.error('[Hooks] Failed to generate session context:', error);
        return {
          success: true,
          content: '',
          sessionId,
          error: (error as Error).message,
          _deprecated: true,
          _migration: 'Use "ccw hook session-context --stdin"'
        };
      }
    });
    return true;
  }

  // API: Execute CCW CLI command and parse status
  if (pathname === '/api/hook/ccw-exec' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      if (typeof body !== 'object' || body === null) {
        return { error: 'Invalid request body', status: 400 };
      }

      const { filePath, command = 'parse-status' } = body as { filePath?: unknown; command?: unknown };

      if (typeof filePath !== 'string') {
        return { error: 'filePath is required', status: 400 };
      }

      // Check if this is a CCW status.json file
      if (!filePath.includes('status.json') ||
          !filePath.match(/\.(ccw|ccw-coordinator|ccw-debug)\//)) {
        return { success: false, message: 'Not a CCW status file' };
      }

      try {
        // Execute CCW CLI command to parse status
        const result = await executeCliCommand('ccw', ['hook', 'parse-status', filePath]);

        if (result.success) {
          const parsed = JSON.parse(result.output);
          return {
            success: true,
            ...parsed
          };
        } else {
          return {
            success: false,
            error: result.error
          };
        }
      } catch (error) {
        console.error('[Hooks] Failed to execute CCW command:', error);
        return {
          success: false,
          error: (error as Error).message
        };
      }
    });
    return true;
  }

  // API: Parse CCW status.json and return formatted status
  // @DEPRECATED - Use /api/hook/ccw-exec with command=parse-status instead.
  // This endpoint is kept for backward compatibility but will be removed.
  if (pathname === '/api/hook/ccw-status' && req.method === 'POST') {
    // Add deprecation warning header
    res.setHeader('X-Deprecated', 'true');
    res.setHeader('X-Deprecation-Message', 'Use /api/hook/ccw-exec with command=parse-status instead. This endpoint will be removed in v2.0.0');

    console.warn('[DEPRECATED] /api/hook/ccw-status is deprecated. Use /api/hook/ccw-exec instead.');

    handlePostRequest(req, res, async (body) => {
      if (typeof body !== 'object' || body === null) {
        return { error: 'Invalid request body', status: 400 };
      }

      const { filePath } = body as { filePath?: unknown };

      if (typeof filePath !== 'string') {
        return { error: 'filePath is required', status: 400 };
      }

      // Delegate to ccw-exec for unified handling
      try {
        const result = await executeCliCommand('ccw', ['hook', 'parse-status', filePath]);

        if (result.success) {
          return {
            success: true,
            message: result.output,
            _deprecated: true,
            _migration: 'Use /api/hook/ccw-exec with command=parse-status'
          };
        } else {
          return {
            success: false,
            error: result.error,
            _deprecated: true
          };
        }
      } catch (error) {
        console.error('[Hooks] Failed to parse CCW status:', error);
        return {
          success: false,
          error: (error as Error).message,
          _deprecated: true
        };
      }
    });
    return true;
  }

  // API: Get project state summary for hook injection
  if (pathname === '/api/hook/project-state' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '5', 10), 20);

    const result: Record<string, unknown> = { tech: { recent: [] }, guidelines: { constraints: [], recent_learnings: [] } };

    // Read project-tech.json
    const techPath = join(projectPath, '.workflow', 'project-tech.json');
    if (existsSync(techPath)) {
      try {
        const tech = JSON.parse(readFileSync(techPath, 'utf8'));
        const allEntries: Array<{ title: string; category: string; date: string }> = [];
        if (tech.development_index) {
          for (const [cat, entries] of Object.entries(tech.development_index)) {
            if (Array.isArray(entries)) {
              for (const e of entries as Array<{ title?: string; date?: string }>) {
                allEntries.push({ title: e.title || '', category: cat, date: e.date || '' });
              }
            }
          }
        }
        allEntries.sort((a, b) => b.date.localeCompare(a.date));
        (result.tech as Record<string, unknown>).recent = allEntries.slice(0, limit);
      } catch { /* ignore parse errors */ }
    }

    // Read specs from spec system (ccw spec load --dimension specs)
    try {
      const { getDimensionIndex } = await import('../../tools/spec-index-builder.js');
      const specsIndex = await getDimensionIndex(projectPath, 'specs');
      const g = result.guidelines as Record<string, unknown>;
      const constraints: string[] = [];
      for (const entry of specsIndex.entries) {
        if (entry.readMode === 'required') {
          constraints.push(entry.title);
        }
      }
      g.constraints = constraints.slice(0, limit);
      g.recent_learnings = [];
    } catch { /* ignore errors */ }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // API: Get hooks configuration
  if (pathname === '/api/hooks' && req.method === 'GET') {
    const projectPathParam = url.searchParams.get('path');
    const hooksData = getHooksConfig(projectPathParam || initialPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(hooksData));
    return true;
  }

  // API: Create hook (frontend compatibility)
  if (pathname === '/api/hooks/create' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      if (typeof body !== 'object' || body === null) {
        return { error: 'Invalid request body', status: 400 };
      }

      const { name, description, trigger, matcher, command } = body as {
        name?: unknown;
        description?: unknown;
        trigger?: unknown;
        matcher?: unknown;
        command?: unknown;
      };

      if (typeof trigger !== 'string' || typeof command !== 'string') {
        return { error: 'trigger and command are required', status: 400 };
      }

      const parsed = typeof name === 'string' ? parseHookName(name) : null;
      const scope = parsed?.scope || 'project';
      const projectPath = initialPath;

      const saveResult = saveHookToSettings(projectPath, scope, trigger, {
        command,
        ...(typeof matcher === 'string' ? { matcher } : {}),
        ...(typeof description === 'string' ? { description } : {}),
      });

      if (saveResult.error) {
        return { error: saveResult.error, status: 500 };
      }

      const hooksData = getHooksConfig(projectPath);
      const scopeHooks = hooksData[scope].hooks as Record<string, unknown[]>;
      const index = Array.isArray(scopeHooks?.[trigger]) ? scopeHooks[trigger].length - 1 : 0;
      const hookEntry = getHookEntry(projectPath, scope, trigger, index);
      const hookName = `${scope}-${trigger}-${index}`;

      return {
        ...mapHookResponse(hookName, scope, trigger, index, hookEntry || { command, matcher, description }),
        status: 201,
      };
    });
    return true;
  }

  // API: Save hook
  if (pathname === '/api/hooks' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      if (typeof body !== 'object' || body === null) {
        return { error: 'Invalid request body', status: 400 };
      }

      const { projectPath, scope, event, hookData } = body as {
        projectPath?: unknown;
        scope?: unknown;
        event?: unknown;
        hookData?: unknown;
      };

      if ((scope !== 'global' && scope !== 'project') || typeof event !== 'string' || typeof hookData !== 'object' || hookData === null) {
        return { error: 'scope, event, and hookData are required', status: 400 };
      }

      const resolvedProjectPath = typeof projectPath === 'string' && projectPath.trim().length > 0 ? projectPath : initialPath;
      return saveHookToSettings(resolvedProjectPath, scope, event, hookData as Record<string, unknown>);
    });
    return true;
  }

  if (pathname === '/api/hooks/update' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      if (typeof body !== 'object' || body === null) {
        return { error: 'Invalid request body', status: 400 };
      }
      const { name, description, trigger, matcher, command } = body as Record<string, unknown>;
      if (typeof name !== 'string') {
        return { error: 'name is required', status: 400 };
      }

      const parsed = parseHookName(name);
      if (!parsed) {
        return { error: 'Invalid hook name', status: 400 };
      }

      const { scope, event, index } = parsed;
      const projectPath = initialPath;
      const targetEvent = typeof trigger === 'string' && trigger.trim().length > 0 ? trigger : event;
      const existing = getHookEntry(projectPath, scope, event, index);
      if (!existing) {
        return { error: 'Hook not found', status: 404 };
      }

      // If trigger changed, delete old and create new at target event.
      if (targetEvent !== event) {
        const delResult = deleteHookFromSettings(projectPath, scope, event, index);
        if (delResult.error) {
          return { error: delResult.error, status: 500 };
        }
        const createResult = saveHookToSettings(projectPath, scope, targetEvent, {
          command: typeof command === 'string' ? command : (Array.isArray(existing.hooks) && existing.hooks.length > 0 ? String((existing.hooks as Array<Record<string, unknown>>)[0].command || '') : String(existing.command || '')),
          matcher: typeof matcher === 'string' ? matcher : existing.matcher,
          description: typeof description === 'string' ? description : existing.description,
        });
        if (createResult.error) {
          return { error: createResult.error, status: 500 };
        }
        const hooksData = getHooksConfig(projectPath);
        const scopeHooks = hooksData[scope].hooks as Record<string, unknown[]>;
        const newIndex = Array.isArray(scopeHooks?.[targetEvent]) ? scopeHooks[targetEvent].length - 1 : 0;
        const created = getHookEntry(projectPath, scope, targetEvent, newIndex);
        return mapHookResponse(`${scope}-${targetEvent}-${newIndex}`, scope, targetEvent, newIndex, created || {});
      }

      const updates = {
        description,
        matcher,
        command,
      };
      const currentCommand = Array.isArray(existing.hooks) && existing.hooks.length > 0
        ? String((existing.hooks as Array<Record<string, unknown>>)[0].command || '')
        : String(existing.command || '');
      const saveResult = saveHookToSettings(projectPath, scope, event, {
        command: typeof updates.command === 'string' ? updates.command : currentCommand,
        matcher: typeof updates.matcher === 'string' ? updates.matcher : existing.matcher,
        description: typeof updates.description === 'string' ? updates.description : existing.description,
        replaceIndex: index,
      });
      if (saveResult.error) {
        return { error: saveResult.error, status: 500 };
      }
      const updated = getHookEntry(projectPath, scope, event, index);
      return mapHookResponse(name, scope, event, index, updated || {});
    });
    return true;
  }

  const hookToggleMatch = pathname.match(/^\/api\/hooks\/([^/]+)\/toggle$/);
  if (hookToggleMatch && req.method === 'POST') {
    const hookName = decodeURIComponent(hookToggleMatch[1]);
    handlePostRequest(req, res, async (body) => {
      const parsed = parseHookName(hookName);
      if (!parsed) {
        return { error: 'Invalid hook name', status: 400 };
      }
      const { scope, event, index } = parsed;
      const projectPath = initialPath;
      const existing = getHookEntry(projectPath, scope, event, index);
      if (!existing) {
        return { error: 'Hook not found', status: 404 };
      }

      const enabled = typeof body?.enabled === 'boolean' ? body.enabled : true;
      if (enabled) {
        return mapHookResponse(hookName, scope, event, index, existing);
      }

      const delResult = deleteHookFromSettings(projectPath, scope, event, index);
      if (delResult.error) {
        return { error: delResult.error, status: 500 };
      }
      return {
        name: hookName,
        enabled: false,
        trigger: event,
        scope,
        index,
      };
    });
    return true;
  }

  const hookPatchMatch = pathname.match(/^\/api\/hooks\/([^/]+)$/);
  if (hookPatchMatch && req.method === 'PATCH') {
    const hookName = decodeURIComponent(hookPatchMatch[1]);
    handlePostRequest(req, res, async (body) => {
      const parsed = parseHookName(hookName);
      if (!parsed) {
        return { error: 'Invalid hook name', status: 400 };
      }

      const { scope, event, index } = parsed;
      const projectPath = initialPath;
      const existing = getHookEntry(projectPath, scope, event, index);
      if (!existing) {
        return { error: 'Hook not found', status: 404 };
      }

      const updates = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      const currentCommand = Array.isArray(existing.hooks) && existing.hooks.length > 0
        ? String((existing.hooks as Array<Record<string, unknown>>)[0].command || '')
        : String(existing.command || '');

      const saveResult = saveHookToSettings(projectPath, scope, event, {
        command: typeof updates.command === 'string' ? updates.command : currentCommand,
        matcher: typeof updates.matcher === 'string' ? updates.matcher : existing.matcher,
        description: typeof updates.description === 'string' ? updates.description : existing.description,
        replaceIndex: index,
      });

      if (saveResult.error) {
        return { error: saveResult.error, status: 500 };
      }

      const updated = getHookEntry(projectPath, scope, event, index);
      if (!updated) {
        return { error: 'Hook not found after update', status: 500 };
      }
      return mapHookResponse(hookName, scope, event, index, updated);
    });
    return true;
  }

  // API: Delete hook
  if (pathname === '/api/hooks' && req.method === 'DELETE') {
    handlePostRequest(req, res, async (body) => {
      if (typeof body !== 'object' || body === null) {
        return { error: 'Invalid request body', status: 400 };
      }

      const { projectPath, scope, event, hookIndex } = body as {
        projectPath?: unknown;
        scope?: unknown;
        event?: unknown;
        hookIndex?: unknown;
      };

      if ((scope !== 'global' && scope !== 'project') || typeof event !== 'string' || typeof hookIndex !== 'number') {
        return { error: 'scope, event, and hookIndex are required', status: 400 };
      }

      const resolvedProjectPath = typeof projectPath === 'string' && projectPath.trim().length > 0 ? projectPath : initialPath;
      return deleteHookFromSettings(resolvedProjectPath, scope, event, hookIndex);
    });
    return true;
  }

  // API: Get hook templates list
  if (pathname === '/api/hooks/templates' && req.method === 'GET') {
    (async () => {
      try {
        const { getAllTemplates, listTemplatesByCategory } = await import('../hooks/hook-templates.js');
        const category = url.searchParams.get('category');

        if (category) {
          const byCategory = listTemplatesByCategory();
          const templates = byCategory[category as keyof typeof byCategory] || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, templates }));
        } else {
          const templates = getAllTemplates();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, templates }));
        }
      } catch (error) {
        console.error('[Hooks] Failed to get templates:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      }
    })();
    return true;
  }

  // API: Install hook template
  if (pathname === '/api/hooks/templates/install' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      if (typeof body !== 'object' || body === null) {
        return { error: 'Invalid request body', status: 400 };
      }

      const { templateId, scope = 'project', projectPath } = body as {
        templateId?: unknown;
        scope?: unknown;
        projectPath?: unknown;
      };

      if (typeof templateId !== 'string') {
        return { error: 'templateId is required', status: 400 };
      }

      try {
        const { installTemplateToSettings } = await import('../hooks/hook-templates.js');
        const resolvedProjectPath = typeof projectPath === 'string' && projectPath.trim().length > 0
          ? projectPath
          : initialPath;

        // Override process.cwd() for project-scoped installation
        const originalCwd = process.cwd;
        if (scope === 'project') {
          process.cwd = () => resolvedProjectPath;
        }

        const result = installTemplateToSettings(
          templateId,
          (scope === 'global' ? 'global' : 'project') as 'global' | 'project'
        );

        // Restore original cwd
        process.cwd = originalCwd;

        return result;
      } catch (error) {
        console.error('[Hooks] Failed to install template:', error);
        return { success: false, error: (error as Error).message };
      }
    });
    return true;
  }

  return false;
}

// ========================================
// Helper: Execute CLI Command
// ========================================

/**
 * Execute a CLI command and capture output
 * @param {string} command - Command name (e.g., 'ccw', 'npx')
 * @param {string[]} args - Command arguments
 * @returns {Promise<{success: boolean; output: string; error?: string}>}
 */
async function executeCliCommand(
  command: string,
  args: string[]
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000  // 30 second timeout
    });

    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });
    }

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({
          success: true,
          output: output.trim()
        });
      } else {
        resolve({
          success: false,
          output: output.trim(),
          error: errorOutput.trim() || `Command failed with exit code ${code}`
        });
      }
    });

    child.on('error', (err: Error) => {
      resolve({
        success: false,
        output: '',
        error: err.message
      });
    });
  });
}
