/**
 * CLI Routes Module
 * Handles all CLI-related API endpoints
 */
import {
  getCliToolsStatus,
  getCliToolsFullStatus,
  installCliTool,
  uninstallCliTool,
  enableCliTool,
  disableCliTool,
  getExecutionHistory,
  getExecutionHistoryAsync,
  getExecutionDetail,
  getConversationDetail,
  getConversationDetailWithNativeInfo,
  deleteExecution,
  deleteExecutionAsync,
  batchDeleteExecutionsAsync,
  executeCliTool,
  generateExecutionId,
  getNativeSessionContent,
  getFormattedNativeConversation,
  getEnrichedConversation,
  getHistoryWithNativeInfo
} from '../../tools/cli-executor.js';
import { getHistoryStore } from '../../tools/cli-history-store.js';
import { StoragePaths } from '../../config/storage-paths.js';
import { listAllNativeSessions } from '../../tools/native-session-discovery.js';
import { SmartContentFormatter } from '../../tools/cli-output-converter.js';
import { generateSmartContext, formatSmartContext } from '../../tools/smart-context.js';
import {
  loadCliConfig,
  getToolConfig,
  updateToolConfig,
  getFullConfigResponse
} from '../../tools/cli-config-manager.js';
import {
  loadClaudeCliTools,
  ensureClaudeCliTools,
  ensureClaudeCliToolsAsync,
  saveClaudeCliTools,
  loadClaudeCliSettings,
  saveClaudeCliSettings,
  updateClaudeToolEnabled,
  updateClaudeCacheSettings,
  getClaudeCliToolsInfo,
  addClaudeApiEndpoint,
  removeClaudeApiEndpoint,
  addClaudeCustomEndpoint,  // @deprecated - kept for backward compatibility
  removeClaudeCustomEndpoint,  // @deprecated - kept for backward compatibility
  updateCodeIndexMcp,
  getCodeIndexMcp
} from '../../tools/claude-cli-tools.js';
import type { RouteContext } from './types.js';
import { existsSync } from 'fs';
import { resolve, normalize } from 'path';
import { homedir } from 'os';

// ========== Path Security Utilities ==========
// Allowed directories for session file access (path traversal protection)
const ALLOWED_SESSION_DIRS: string[] = [
  resolve(homedir(), '.claude', 'projects'),
  resolve(homedir(), '.local', 'share', 'opencode', 'storage'),
  resolve(homedir(), '.gemini', 'sessions'),
  resolve(homedir(), '.qwen', 'sessions'),
  resolve(homedir(), '.codex')
];

/**
 * Validates that an absolute path is within one of the allowed directories.
 * Prevents path traversal attacks by checking the resolved path.
 *
 * @param absolutePath - The absolute path to validate
 * @param allowedDirs - Array of allowed directory paths
 * @returns true if path is within an allowed directory, false otherwise
 */
function isPathWithinAllowedDirs(absolutePath: string, allowedDirs: string[]): boolean {
  // Normalize the path to resolve any remaining . or .. sequences
  const normalizedPath = normalize(absolutePath);

  // Check if the path starts with any of the allowed directories
  for (const allowedDir of allowedDirs) {
    const normalizedAllowedDir = normalize(allowedDir);
    // Ensure path is within allowed dir (starts with allowedDir + separator)
    if (normalizedPath.startsWith(normalizedAllowedDir + '/') ||
        normalizedPath.startsWith(normalizedAllowedDir + '\\') ||
        normalizedPath === normalizedAllowedDir) {
      return true;
    }
  }
  return false;
}

/**
 * Validates a file path parameter to prevent path traversal attacks.
 * Returns validated absolute path or throws an error.
 *
 * @param inputPath - The user-provided path (may be relative or absolute)
 * @param allowedDirs - Array of allowed directory paths
 * @returns Object with resolved path or error
 */
function validatePath(inputPath: string, allowedDirs: string[]): { valid: true; path: string } | { valid: false; error: string } {
  if (!inputPath || typeof inputPath !== 'string') {
    return { valid: false, error: 'Path parameter is required' };
  }

  // Resolve to absolute path (handles relative paths and .. sequences)
  const resolvedPath = resolve(inputPath);

  // Validate the resolved path is within allowed directories
  if (!isPathWithinAllowedDirs(resolvedPath, allowedDirs)) {
    console.warn(`[Security] Path traversal attempt blocked: ${inputPath} resolved to ${resolvedPath}`);
    return { valid: false, error: 'Invalid path: access denied' };
  }

  return { valid: true, path: resolvedPath };
}

// ========== Active Executions State ==========
// Stores running CLI executions for state recovery when view is opened/refreshed
interface ActiveExecution {
  id: string;
  tool: string;
  mode: string;
  prompt: string;
  startTime: number;
  output: string[];  // Array-based buffer to limit memory usage
  status: 'running' | 'completed' | 'error';
  completedTimestamp?: number;  // When execution completed (for 5-minute retention)
}

// API response type with output as string (for backward compatibility)
type ActiveExecutionDto = Omit<ActiveExecution, 'output'> & { output: string };

const activeExecutions = new Map<string, ActiveExecution>();
const EXECUTION_RETENTION_MS = 5 * 60 * 1000;  // 5 minutes
const MAX_OUTPUT_BUFFER_LINES = 1000;  // Max lines to keep in memory per execution
const MAX_ACTIVE_EXECUTIONS = 200;  // Max concurrent executions in memory

/**
 * Cleanup stale completed executions older than retention period
 * Runs periodically to prevent memory buildup
 */
export function cleanupStaleExecutions(): void {
  const now = Date.now();
  const staleIds: string[] = [];

  for (const [id, exec] of activeExecutions.entries()) {
    if (exec.completedTimestamp && (now - exec.completedTimestamp) > EXECUTION_RETENTION_MS) {
      staleIds.push(id);
    }
  }

  staleIds.forEach(id => {
    activeExecutions.delete(id);
    console.log(`[ActiveExec] Cleaned up stale execution: ${id}`);
  });

  if (staleIds.length > 0) {
    console.log(`[ActiveExec] Cleaned up ${staleIds.length} stale execution(s), remaining: ${activeExecutions.size}`);
  }
}

/**
 * Get all active CLI executions
 * Used by frontend to restore state when view is opened during execution
 * Note: Converts output array back to string for API compatibility
 */
export function getActiveExecutions(): ActiveExecutionDto[] {
  return Array.from(activeExecutions.values()).map(exec => ({
    ...exec,
    output: exec.output.join('')  // Convert array buffer to string for API
  }));
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const numericValue = Number(trimmed);
    if (Number.isFinite(numericValue)) {
      return numericValue > 0 && numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

function isSavedExecutionNewerThanActive(activeStartTimeMs: number | undefined, savedTimestamp: unknown): boolean {
  if (activeStartTimeMs === undefined) {
    return false;
  }

  const savedTimestampMs = normalizeTimestampMs(savedTimestamp);
  if (savedTimestampMs === undefined) {
    return false;
  }

  return savedTimestampMs >= activeStartTimeMs;
}

function getSavedConversationWithNativeInfo(projectPath: string, executionId: string) {
  const historyDbPath = StoragePaths.project(projectPath).historyDb;
  if (!existsSync(historyDbPath)) {
    return null;
  }

  try {
    return getHistoryStore(projectPath).getConversationWithNativeInfo(executionId);
  } catch {
    return null;
  }
}

function cleanupSupersededActiveExecutions(projectPath: string): void {
  const supersededIds: string[] = [];

  for (const [executionId, activeExec] of activeExecutions.entries()) {
    const savedConversation = getSavedConversationWithNativeInfo(projectPath, executionId);
    if (!savedConversation) {
      continue;
    }

    if (isSavedExecutionNewerThanActive(
      normalizeTimestampMs(activeExec.startTime),
      savedConversation.updated_at || savedConversation.created_at
    )) {
      supersededIds.push(executionId);
    }
  }

  supersededIds.forEach(executionId => {
    activeExecutions.delete(executionId);
  });

  if (supersededIds.length > 0) {
    console.log(`[ActiveExec] Removed ${supersededIds.length} superseded execution(s): ${supersededIds.join(', ')}`);
  }
}

/**
 * Update active execution state from hook events
 * Called by hooks-routes when CLI events are received from terminal execution
 */
export function updateActiveExecution(event: {
  type: 'started' | 'output' | 'completed';
  executionId: string;
  tool?: string;
  mode?: string;
  prompt?: string;
  output?: string;
  success?: boolean;
}): void {
  const { type, executionId, tool, mode, prompt, output, success } = event;

  // Debug log for troubleshooting
  console.log(`[ActiveExec] ${type}: ${executionId} (current count: ${activeExecutions.size})`);

  if (!executionId) {
    console.warn('[ActiveExec] Missing executionId, skipping');
    return;
  }

  if (type === 'started') {
    // Check map size limit before creating new execution
    if (activeExecutions.size >= MAX_ACTIVE_EXECUTIONS) {
      console.warn(`[ActiveExec] Max executions limit reached (${MAX_ACTIVE_EXECUTIONS}), cleanup may be needed`);
    }

    // Create new active execution with array-based output buffer
    activeExecutions.set(executionId, {
      id: executionId,
      tool: tool || 'unknown',
      mode: mode || 'analysis',
      prompt: (prompt || '').substring(0, 500),
      startTime: Date.now(),
      output: [],  // Initialize as empty array instead of empty string
      status: 'running'
    });
  } else if (type === 'output') {
    // Append output to existing execution using array with size limit
    const activeExec = activeExecutions.get(executionId);
    if (activeExec && output) {
      activeExec.output.push(output);
      // Keep buffer size under limit by shifting old entries
      if (activeExec.output.length > MAX_OUTPUT_BUFFER_LINES) {
        activeExec.output.shift();  // Remove oldest entry
      }
    }
  } else if (type === 'completed') {
    // Mark as completed with timestamp for retention-based cleanup
    const activeExec = activeExecutions.get(executionId);
    if (activeExec) {
      activeExec.status = success ? 'completed' : 'error';
      activeExec.completedTimestamp = Date.now();
      console.log(`[ActiveExec] Marked as ${activeExec.status}, retained for ${EXECUTION_RETENTION_MS / 1000}s`);
    }
  }
}

/**
 * Handle CLI routes
 * @returns true if route was handled, false otherwise
 */
function mapCliInstallation(tool: string, status: {
  available?: boolean;
  enabled?: boolean;
  path?: string | null;
  packageName?: string;
}): Record<string, unknown> {
  return {
    name: tool,
    version: status.packageName || 'unknown',
    installed: Boolean(status.available),
    path: status.path || undefined,
    status: status.available ? (status.enabled === false ? 'inactive' : 'active') : 'inactive',
    lastChecked: new Date().toISOString(),
  };
}

export async function handleCliRoutes(ctx: RouteContext): Promise<boolean> {
  const { pathname, url, req, res, initialPath, handlePostRequest, broadcastToClients } = ctx;

  // Compatibility API: CLI installations list
  if (pathname === '/api/cli/installations' && req.method === 'GET') {
    const fullStatus = await getCliToolsFullStatus();
    const tools = Object.entries(fullStatus).map(([tool, status]) => mapCliInstallation(tool, status));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools }));
    return true;
  }

  const cliInstallationMatch = pathname.match(/^\/api\/cli\/installations\/([^/]+)\/(install|uninstall|upgrade|check)$/);
  if (cliInstallationMatch && req.method === 'POST') {
    const tool = decodeURIComponent(cliInstallationMatch[1]);
    const action = cliInstallationMatch[2];

    if (action === 'check') {
      const fullStatus = await getCliToolsFullStatus();
      const status = fullStatus[tool];
      if (!status) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown tool' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mapCliInstallation(tool, status)));
      return true;
    }

    if (action === 'install') {
      const result = await installCliTool(tool);
      if (!result.success) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error || 'Install failed' }));
        return true;
      }
      broadcastToClients({
        type: 'CLI_TOOL_INSTALLED',
        payload: { tool, timestamp: new Date().toISOString() }
      });
      const fullStatus = await getCliToolsFullStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mapCliInstallation(tool, fullStatus[tool] || { available: true, enabled: true, path: null, packageName: 'unknown' })));
      return true;
    }

    if (action === 'uninstall') {
      const result = await uninstallCliTool(tool);
      if (!result.success) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error || 'Uninstall failed' }));
        return true;
      }
      broadcastToClients({
        type: 'CLI_TOOL_UNINSTALLED',
        payload: { tool, timestamp: new Date().toISOString() }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return true;
    }

    if (action === 'upgrade') {
      const installResult = await installCliTool(tool);
      if (!installResult.success) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: installResult.error || 'Upgrade failed' }));
        return true;
      }
      broadcastToClients({
        type: 'CLI_TOOL_UPGRADED',
        payload: { tool, timestamp: new Date().toISOString() }
      });
      const fullStatus = await getCliToolsFullStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mapCliInstallation(tool, fullStatus[tool] || { available: true, enabled: true, path: null, packageName: 'unknown' })));
      return true;
    }
  }

  // API: Get Active CLI Executions (for state recovery)
  if (pathname === '/api/cli/active' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;
    cleanupStaleExecutions();
    cleanupSupersededActiveExecutions(projectPath);

    const executions = getActiveExecutions().map(exec => ({
      ...exec,
      isComplete: exec.status !== 'running'
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ executions }));
    return true;
  }

  // API: CLI Tools Status
  if (pathname === '/api/cli/status') {
    const status = await getCliToolsStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return true;
  }

  // API: CLI Tools Full Status (with enabled state)
  if (pathname === '/api/cli/full-status') {
    const status = await getCliToolsFullStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return true;
  }

  // API: Install CLI Tool
  if (pathname === '/api/cli/install' && req.method === 'POST') {
    handlePostRequest(req, res, async (body: unknown) => {
      const { tool } = body as { tool: string };
      if (!tool) {
        return { error: 'Tool name is required', status: 400 };
      }

      const result = await installCliTool(tool);
      if (result.success) {
        // Broadcast tool installed event
        broadcastToClients({
          type: 'CLI_TOOL_INSTALLED',
          payload: { tool, timestamp: new Date().toISOString() }
        });
        return { success: true, message: `${tool} installed successfully` };
      } else {
        return { success: false, error: result.error, status: 500 };
      }
    });
    return true;
  }

  // API: Uninstall CLI Tool
  if (pathname === '/api/cli/uninstall' && req.method === 'POST') {
    handlePostRequest(req, res, async (body: unknown) => {
      const { tool } = body as { tool: string };
      if (!tool) {
        return { error: 'Tool name is required', status: 400 };
      }

      const result = await uninstallCliTool(tool);
      if (result.success) {
        // Broadcast tool uninstalled event
        broadcastToClients({
          type: 'CLI_TOOL_UNINSTALLED',
          payload: { tool, timestamp: new Date().toISOString() }
        });
        return { success: true, message: `${tool} uninstalled successfully` };
      } else {
        return { success: false, error: result.error, status: 500 };
      }
    });
    return true;
  }

  // API: Enable CLI Tool
  if (pathname === '/api/cli/enable' && req.method === 'POST') {
    handlePostRequest(req, res, async (body: unknown) => {
      const { tool } = body as { tool: string };
      if (!tool) {
        return { error: 'Tool name is required', status: 400 };
      }

      const result = enableCliTool(tool);
      // Broadcast tool enabled event
      broadcastToClients({
        type: 'CLI_TOOL_ENABLED',
        payload: { tool, timestamp: new Date().toISOString() }
      });
      return { success: true, message: `${tool} enabled` };
    });
    return true;
  }

  // API: Disable CLI Tool
  if (pathname === '/api/cli/disable' && req.method === 'POST') {
    handlePostRequest(req, res, async (body: unknown) => {
      const { tool } = body as { tool: string };
      if (!tool) {
        return { error: 'Tool name is required', status: 400 };
      }

      const result = disableCliTool(tool);
      // Broadcast tool disabled event
      broadcastToClients({
        type: 'CLI_TOOL_DISABLED',
        payload: { tool, timestamp: new Date().toISOString() }
      });
      return { success: true, message: `${tool} disabled` };
    });
    return true;
  }

  // API: Get Full CLI Config (with predefined models)
  if (pathname === '/api/cli/config' && req.method === 'GET') {
    try {
      const response = getFullConfigResponse(initialPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // API: Get/Update Tool Config
  const configMatch = pathname.match(/^\/api\/cli\/config\/(gemini|qwen|codex|claude|opencode)$/);
  if (configMatch) {
    const tool = configMatch[1];

    // GET: Get single tool config
    if (req.method === 'GET') {
      try {
        const toolConfig = getToolConfig(initialPath, tool);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(toolConfig));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return true;
    }

    // PUT: Update tool config
    if (req.method === 'PUT') {
      handlePostRequest(req, res, async (body: unknown) => {
        try {
          const updates = body as { enabled?: boolean; primaryModel?: string; secondaryModel?: string; availableModels?: string[]; tags?: string[]; envFile?: string | null; settingsFile?: string | null; effort?: string | null };
          const updated = updateToolConfig(initialPath, tool, updates);

          // Broadcast config updated event
          broadcastToClients({
            type: 'CLI_CONFIG_UPDATED',
            payload: { tool, config: updated, timestamp: new Date().toISOString() }
          });

          return { success: true, config: updated };
        } catch (err) {
          return { error: (err as Error).message, status: 500 };
        }
      });
      return true;
    }
  }

  // Helper: Get API endpoints from tools (type: 'api-endpoint')
  const getApiEndpointsFromTools = (config: any) => {
    return Object.entries(config.tools)
      .filter(([_, t]: [string, any]) => t.type === 'api-endpoint')
      .map(([name, t]: [string, any]) => ({ id: t.id || name, name, enabled: t.enabled }));
  };

  // API: Get all API endpoints (for --tool custom --model <id>)
  if (pathname === '/api/cli/endpoints' && req.method === 'GET') {
    (async () => {
      try {
        // Use ensureClaudeCliToolsAsync to auto-create config with availability sync
        const config = await ensureClaudeCliToolsAsync(initialPath);
        const endpoints = getApiEndpointsFromTools(config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ endpoints }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    })();
    return true;
  }

  // API: Add/Update API endpoint
  if (pathname === '/api/cli/endpoints' && req.method === 'POST') {
    handlePostRequest(req, res, async (body: unknown) => {
      try {
        const { id, name, enabled } = body as { id: string; name: string; enabled: boolean };
        if (!id || !name) {
          return { error: 'id and name are required', status: 400 };
        }
        const config = addClaudeApiEndpoint(initialPath, { id, name, enabled: enabled !== false });

        broadcastToClients({
          type: 'CLI_ENDPOINT_UPDATED',
          payload: { endpoint: { id, name, enabled }, timestamp: new Date().toISOString() }
        });

        return { success: true, endpoints: getApiEndpointsFromTools(config) };
      } catch (err) {
        return { error: (err as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Update API endpoint enabled status
  if (pathname.match(/^\/api\/cli\/endpoints\/[^/]+$/) && req.method === 'PUT') {
    const endpointId = pathname.split('/').pop() || '';
    handlePostRequest(req, res, async (body: unknown) => {
      try {
        const { enabled, name: newName } = body as { enabled?: boolean; name?: string };
        const config = loadClaudeCliTools(initialPath);

        // Find the tool by id (api-endpoint type)
        const toolEntry = Object.entries(config.tools).find(
          ([_, t]: [string, any]) => t.type === 'api-endpoint' && t.id === endpointId
        );

        if (!toolEntry) {
          return { error: 'Endpoint not found', status: 404 };
        }

        const [toolName, tool] = toolEntry as [string, any];

        if (typeof enabled === 'boolean') tool.enabled = enabled;
        // If name changes, we need to rename the key
        if (newName && newName !== toolName) {
          delete config.tools[toolName];
          config.tools[newName] = tool;
        }

        saveClaudeCliTools(initialPath, config);

        const endpoint = { id: tool.id || toolName, name: newName || toolName, enabled: tool.enabled };

        broadcastToClients({
          type: 'CLI_ENDPOINT_UPDATED',
          payload: { endpoint, timestamp: new Date().toISOString() }
        });

        return { success: true, endpoint };
      } catch (err) {
        return { error: (err as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Delete API endpoint
  if (pathname.match(/^\/api\/cli\/endpoints\/[^/]+$/) && req.method === 'DELETE') {
    const endpointId = pathname.split('/').pop() || '';
    try {
      const config = removeClaudeApiEndpoint(initialPath, endpointId);

      broadcastToClients({
        type: 'CLI_ENDPOINT_DELETED',
        payload: { endpointId, timestamp: new Date().toISOString() }
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, endpoints: getApiEndpointsFromTools(config) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // API: CLI Execution History
  if (pathname === '/api/cli/history') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const tool = url.searchParams.get('tool') || null;
    const status = url.searchParams.get('status') || null;
    const category = url.searchParams.get('category') as 'user' | 'internal' | 'insight' | null;
    const search = url.searchParams.get('search') || null;
    const recursive = url.searchParams.get('recursive') !== 'false';

    getExecutionHistoryAsync(projectPath, { limit, tool, status, category, search, recursive })
      .then(history => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return true;
  }

  // API: CLI Execution Detail (GET) or Delete (DELETE)
  if (pathname === '/api/cli/execution') {
    const projectPath = url.searchParams.get('path') || initialPath;
    cleanupStaleExecutions();
    cleanupSupersededActiveExecutions(projectPath);
    const executionId = url.searchParams.get('id');

    if (!executionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Execution ID is required' }));
      return true;
    }

    // Handle DELETE request
    if (req.method === 'DELETE') {
      deleteExecutionAsync(projectPath, executionId)
        .then(result => {
          if (result.success) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Execution deleted' }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.error || 'Delete failed' }));
          }
        })
        .catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return true;
    }

    const conversation = getSavedConversationWithNativeInfo(projectPath, executionId) || getConversationDetailWithNativeInfo(projectPath, executionId);

    // Handle GET request - return conversation with native session info
    // First check in-memory active executions (for running/recently completed)
    const activeExec = activeExecutions.get(executionId);
    const shouldPreferSavedConversation = !!activeExec && !!conversation && isSavedExecutionNewerThanActive(
      normalizeTimestampMs(activeExec.startTime),
      conversation.updated_at || conversation.created_at
    );

    if (activeExec && !shouldPreferSavedConversation) {
      // Return active execution data as conversation record format
      // Note: Convert output array buffer back to string for API compatibility
      const activeConversation = {
        id: activeExec.id,
        tool: activeExec.tool,
        mode: activeExec.mode,
        created_at: new Date(activeExec.startTime).toISOString(),
        turn_count: 1,
        turns: [{
          turn: 1,
          timestamp: new Date(activeExec.startTime).toISOString(),
          prompt: activeExec.prompt,
          output: { stdout: activeExec.output.join(''), stderr: '' },  // Convert array to string
          duration_ms: activeExec.completedTimestamp
            ? activeExec.completedTimestamp - activeExec.startTime
            : Date.now() - activeExec.startTime
        }],
        // Active execution flag for frontend to handle appropriately
        _active: true,
        _status: activeExec.status
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(activeConversation));
      return true;
    }

    if (!conversation) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Conversation not found' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(conversation));
    return true;
  }

  // API: Batch Delete CLI Executions
  if (pathname === '/api/cli/batch-delete' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { path: projectPath, ids } = body as { path?: string; ids: string[] };

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return { error: 'ids array is required', status: 400 };
      }

      const basePath = projectPath || initialPath;
      return await batchDeleteExecutionsAsync(basePath, ids);
    });
    return true;
  }

  // API: Get Native Session Content
  // Supports: ?id=<executionId> (existing), ?path=<filepath>&tool=<tool> (new direct path query)
  if (pathname === '/api/cli/native-session') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const executionId = url.searchParams.get('id');
    const filePath = url.searchParams.get('filePath');  // New: direct file path
    const toolParam = url.searchParams.get('tool') || 'auto';  // New: tool type for path query
    const format = url.searchParams.get('format') || 'json';

    // Priority: filePath > id (backward compatible)
    if (!executionId && !filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Either execution ID (id) or file path (filePath) is required' }));
      return true;
    }

    // Security: Validate filePath is within allowed session directories
    if (filePath) {
      const pathValidation = validatePath(filePath, ALLOWED_SESSION_DIRS);
      if (!pathValidation.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid path: access denied' }));
        return true;
      }
    }

    try {
      let result;

      // Direct file path query (new)
      if (filePath) {
        const { parseSessionFile } = await import('../../tools/session-content-parser.js');

        // Determine tool type
        let tool = toolParam;
        if (tool === 'auto') {
          // Auto-detect tool from file path
          if (filePath.includes('.claude') as boolean || filePath.includes('claude-session')) {
            tool = 'claude';
          } else if (filePath.includes('.opencode') as boolean || filePath.includes('opencode')) {
            tool = 'opencode';
          } else if (filePath.includes('.codex') as boolean || filePath.includes('rollout-')) {
            tool = 'codex';
          } else if (filePath.includes('.qwen') as boolean) {
            tool = 'qwen';
          } else if (filePath.includes('.gemini') as boolean) {
            tool = 'gemini';
          } else {
            // Default to claude for unknown paths
            tool = 'claude';
          }
        }

        const session = await parseSessionFile(filePath, tool);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Native session not found at path: ' + filePath }));
          return true;
        }

        if (format === 'text') {
          const { formatConversation } = await import('../../tools/session-content-parser.js');
          result = formatConversation(session, {
            includeThoughts: url.searchParams.get('thoughts') === 'true',
            includeToolCalls: url.searchParams.get('tools') === 'true',
            includeTokens: url.searchParams.get('tokens') === 'true'
          });
        } else if (format === 'pairs') {
          const { extractConversationPairs } = await import('../../tools/session-content-parser.js');
          result = extractConversationPairs(session);
        } else {
          result = session;
        }
      } else {
        // Existing: query by execution ID
        if (format === 'text') {
          result = await getFormattedNativeConversation(projectPath, executionId!, {
            includeThoughts: url.searchParams.get('thoughts') === 'true',
            includeToolCalls: url.searchParams.get('tools') === 'true',
            includeTokens: url.searchParams.get('tokens') === 'true'
          });
        } else if (format === 'pairs') {
          const enriched = await getEnrichedConversation(projectPath, executionId!);
          result = enriched?.merged || null;
        } else {
          result = await getNativeSessionContent(projectPath, executionId!);
        }
      }

      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Native session not found' }));
        return true;
      }

      res.writeHead(200, { 'Content-Type': format === 'text' ? 'text/plain' : 'application/json' });
      res.end(format === 'text' ? result : JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // API: List Native Sessions (new endpoint)
  // Supports: ?tool=<gemini|qwen|codex|claude|opencode> & ?project=<projectPath>
  if (pathname === '/api/cli/native-sessions' && req.method === 'GET') {
    const toolFilter = url.searchParams.get('tool');
    const projectPath = url.searchParams.get('project') || initialPath;

    try {
      const {
        getDiscoverer,
        getNativeSessions
      } = await import('../../tools/native-session-discovery.js');

      const sessions: Array<{
        id: string;
        tool: string;
        path: string;
        title?: string;
        startTime: string;
        updatedAt: string;
        projectHash?: string;
      }> = [];

      // Define supported tools
      const supportedTools = ['gemini', 'qwen', 'codex', 'claude', 'opencode'] as const;
      const toolsToQuery = toolFilter && supportedTools.includes(toolFilter as typeof supportedTools[number])
        ? [toolFilter as typeof supportedTools[number]]
        : [...supportedTools];

      for (const tool of toolsToQuery) {
        const discoverer = getDiscoverer(tool);
        if (!discoverer) continue;

        const nativeSessions = getNativeSessions(tool, {
          workingDir: projectPath,
          limit: 100
        });

        for (const session of nativeSessions) {
          // Try to extract title from session
          let title: string | undefined;
          try {
            const firstUserMessage = (discoverer as any).extractFirstUserMessage?.(session.filePath);
            if (firstUserMessage) {
              // Truncate to first 100 chars as title
              title = firstUserMessage.substring(0, 100).trim();
              if (firstUserMessage.length > 100) {
                title += '...';
              }
            }
          } catch {
            // Ignore errors extracting title
          }

          sessions.push({
            id: session.sessionId,
            tool: session.tool,
            path: session.filePath,
            title,
            startTime: session.createdAt.toISOString(),
            updatedAt: session.updatedAt.toISOString(),
            projectHash: session.projectHash
          });
        }
      }

      // Sort by updatedAt descending
      sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions, count: sessions.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // API: Get Enriched Conversation
  if (pathname === '/api/cli/enriched') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const executionId = url.searchParams.get('id');

    if (!executionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Execution ID is required' }));
      return true;
    }

    getEnrichedConversation(projectPath, executionId)
      .then(result => {
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Conversation not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      });
    return true;
  }

  // API: Get History with Native Session Info
  if (pathname === '/api/cli/history-native') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const tool = url.searchParams.get('tool') || null;
    const status = url.searchParams.get('status') || null;
    const category = url.searchParams.get('category') as 'user' | 'internal' | 'insight' | null;
    const search = url.searchParams.get('search') || null;
    const recursive = url.searchParams.get('recursive') !== 'false';

    getHistoryWithNativeInfo(projectPath, { limit, tool, status, category, search, recursive })
      .then(history => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      });
    return true;
  }

  // API: List Native CLI Sessions (with pagination support)
  if (pathname === '/api/cli/native-sessions' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || null;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const cursor = url.searchParams.get('cursor'); // ISO timestamp for cursor-based pagination

    try {
      // Parse cursor timestamp if provided
      const afterTimestamp = cursor ? new Date(cursor) : undefined;

      // Fetch sessions with limit + 1 to detect if there are more
      const allSessions = listAllNativeSessions({
        workingDir: projectPath || undefined,
        limit: limit + 1, // Fetch one extra to check hasMore
        afterTimestamp
      });

      // Determine if there are more results
      const hasMore = allSessions.length > limit;
      const sessions = hasMore ? allSessions.slice(0, limit) : allSessions;

      // Get next cursor (timestamp of last item for cursor-based pagination)
      const nextCursor = sessions.length > 0
        ? sessions[sessions.length - 1].updatedAt.toISOString()
        : null;

      // Group sessions by tool
      const byTool: Record<string, typeof sessions> = {};
      for (const session of sessions) {
        if (!byTool[session.tool]) {
          byTool[session.tool] = [];
        }
        byTool[session.tool].push(session);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sessions,
        byTool,
        hasMore,
        nextCursor,
        count: sessions.length
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // API: Execute CLI Tool
  if (pathname === '/api/cli/execute' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { tool, prompt, mode, format, model, dir, includeDirs, timeout, smartContext, parentExecutionId, category, toFile } = body as any;

      if (!tool || !prompt) {
        return { error: 'tool and prompt are required', status: 400 };
      }

      // Security: Validate toFile path is within project directory
      if (toFile) {
        const projectDir = resolve(dir || initialPath);
        const pathValidation = validatePath(toFile, [projectDir]);
        if (!pathValidation.valid) {
          return { error: 'Invalid path: access denied', status: 400 };
        }
      }

      // Generate smart context if enabled
      let finalPrompt = prompt;
      if (smartContext?.enabled) {
        try {
          const contextResult = await generateSmartContext(prompt, {
            enabled: true,
            maxFiles: smartContext.maxFiles || 10,
            searchMode: 'text'
          }, dir || initialPath);

          const contextAppendage = formatSmartContext(contextResult);
          if (contextAppendage) {
            finalPrompt = prompt + contextAppendage;
          }
        } catch (err) {
          console.warn('[Smart Context] Failed to generate:', err);
        }
      }

      const executionId = generateExecutionId(tool);

      // Store active execution for state recovery
      // Check map size limit before creating new execution
      if (activeExecutions.size >= MAX_ACTIVE_EXECUTIONS) {
        console.warn(`[ActiveExec] Max executions limit reached (${MAX_ACTIVE_EXECUTIONS}), cleanup may be needed`);
      }
      activeExecutions.set(executionId, {
        id: executionId,
        tool,
        mode: mode || 'analysis',
        prompt: prompt.substring(0, 500), // Truncate for display
        startTime: Date.now(),
        output: [],  // Initialize as empty array for memory-efficient buffering
        status: 'running'
      });

      // Broadcast execution started
      broadcastToClients({
        type: 'CLI_EXECUTION_STARTED',
        payload: {
          executionId,
          tool,
          mode: mode || 'analysis',
          parentExecutionId,
          timestamp: new Date().toISOString()
        }
      });

      try {
        const result = await executeCliTool({
          tool,
          prompt: finalPrompt,
          mode: mode || 'analysis',
          format: format || 'plain',
          model,
          cd: dir || initialPath,
          includeDirs,
          timeout: timeout || 0, // 0 = no internal timeout, controlled by external caller
          category: category || 'user',
          parentExecutionId,
          stream: true
        }, (unit) => {
          // CliOutputUnit handler: use SmartContentFormatter for intelligent formatting (never returns null)
          const content = SmartContentFormatter.format(unit.content, unit.type);

          // Append to active execution buffer using array with size limit
          const activeExec = activeExecutions.get(executionId);
          if (activeExec) {
            activeExec.output.push(content || '');
            // Keep buffer size under limit by shifting old entries
            if (activeExec.output.length > MAX_OUTPUT_BUFFER_LINES) {
              activeExec.output.shift();  // Remove oldest entry
            }
          }

          broadcastToClients({
            type: 'CLI_OUTPUT',
            payload: {
              executionId,
              chunkType: unit.type,
              data: content
            }
          });
        });

        // Mark as completed with timestamp for retention-based cleanup (not immediate delete)
        const activeExec = activeExecutions.get(executionId);
        if (activeExec) {
          activeExec.status = result.success ? 'completed' : 'error';
          activeExec.completedTimestamp = Date.now();
          console.log(`[ActiveExec] Direct execution ${executionId} marked as ${activeExec.status}, retained for ${EXECUTION_RETENTION_MS / 1000}s`);
        }

        // Save output to file if --to-file is specified
        if (toFile && result.stdout) {
          try {
            const { writeFileSync, mkdirSync } = await import('fs');
            const { dirname, resolve } = await import('path');
            const filePath = resolve(dir || initialPath, toFile);
            const dirPath = dirname(filePath);
            mkdirSync(dirPath, { recursive: true });
            writeFileSync(filePath, result.stdout, 'utf8');
            console.log(`[API] Output saved to: ${filePath}`);
          } catch (err) {
            console.warn(`[API] Failed to save output to file: ${(err as Error).message}`);
          }
        }

        // Broadcast completion
        broadcastToClients({
          type: 'CLI_EXECUTION_COMPLETED',
          payload: {
            executionId,
            success: result.success,
            status: result.execution.status,
            duration_ms: result.execution.duration_ms
          }
        });

        return {
          success: result.success,
          execution: result.execution,
          parsedOutput: result.parsedOutput,  // Filtered output (excludes metadata/progress)
          finalOutput: result.finalOutput     // Agent message only (for --final flag)
        };

      } catch (error: unknown) {
        // Mark as completed with timestamp for retention-based cleanup (not immediate delete)
        const activeExec = activeExecutions.get(executionId);
        if (activeExec) {
          activeExec.status = 'error';
          activeExec.completedTimestamp = Date.now();
          console.log(`[ActiveExec] Direct execution ${executionId} marked as error, retained for ${EXECUTION_RETENTION_MS / 1000}s`);
        }

        broadcastToClients({
          type: 'CLI_EXECUTION_ERROR',
          payload: {
            executionId,
            error: (error as Error).message
          }
        });

        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: CLI Review - Submit review for an execution
  if (pathname.startsWith('/api/cli/review/') && req.method === 'POST') {
    const executionId = pathname.replace('/api/cli/review/', '');
    handlePostRequest(req, res, async (body) => {
      const { status, rating, comments, reviewer } = body as {
        status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
        rating?: number;
        comments?: string;
        reviewer?: string;
      };

      if (!status) {
        return { error: 'status is required', status: 400 };
      }

      try {
        const historyStore = await import('../../tools/cli-history-store.js').then(m => m.getHistoryStore(initialPath));

        const execution = historyStore.getConversation(executionId);
        if (!execution) {
          return { error: 'Execution not found', status: 404 };
        }

        const review = await historyStore.saveReview({
          execution_id: executionId,
          status,
          rating,
          comments,
          reviewer
        });

        broadcastToClients({
          type: 'CLI_REVIEW_UPDATED',
          payload: {
            executionId,
            review,
            timestamp: new Date().toISOString()
          }
        });

        return { success: true, review };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: CLI Review - Get review for an execution
  if (pathname.startsWith('/api/cli/review/') && req.method === 'GET') {
    const executionId = pathname.replace('/api/cli/review/', '');
    try {
      const historyStore = await import('../../tools/cli-history-store.js').then(m => m.getHistoryStore(initialPath));
      const review = historyStore.getReview(executionId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ review }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: CLI Reviews - List all reviews
  if (pathname === '/api/cli/reviews' && req.method === 'GET') {
    try {
      const historyStore = await import('../../tools/cli-history-store.js').then(m => m.getHistoryStore(initialPath));
      const statusFilter = url.searchParams.get('status') as 'pending' | 'approved' | 'rejected' | 'changes_requested' | null;
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);

      const reviews = historyStore.getReviews({
        status: statusFilter || undefined,
        limit
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reviews, count: reviews.length }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Get CLI Tools Config from .claude/cli-tools.json (with fallback to global)
  if (pathname === '/api/cli/tools-config' && req.method === 'GET') {
    (async () => {
      try {
        // Use ensureClaudeCliToolsAsync to auto-create config with availability sync
        const toolsConfig = await ensureClaudeCliToolsAsync(initialPath);
        const settingsConfig = loadClaudeCliSettings(initialPath);
        const info = getClaudeCliToolsInfo(initialPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          tools: toolsConfig,
          settings: settingsConfig,
          _configInfo: info
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    })();
    return true;
  }

  // API: Update CLI Tools Config
  if (pathname === '/api/cli/tools-config' && req.method === 'PUT') {
    handlePostRequest(req, res, async (body: unknown) => {
      try {
        const updates = body as { tools?: any; settings?: any };

        // Update tools config if provided
        if (updates.tools) {
          const currentTools = loadClaudeCliTools(initialPath);
          const updatedTools = {
            ...currentTools,
            tools: { ...currentTools.tools, ...(updates.tools.tools || {}) }
          };
          saveClaudeCliTools(initialPath, updatedTools);
        }

        // Update settings config if provided
        if (updates.settings) {
          const currentSettings = loadClaudeCliSettings(initialPath);
          const s = updates.settings;

          // Deep merge: only update fields that are explicitly provided
          const updatedSettings = {
            ...currentSettings,
            // Scalar fields: only update if explicitly provided
            ...(s.defaultTool !== undefined && { defaultTool: s.defaultTool }),
            ...(s.promptFormat !== undefined && { promptFormat: s.promptFormat }),
            ...(s.nativeResume !== undefined && { nativeResume: s.nativeResume }),
            ...(s.recursiveQuery !== undefined && { recursiveQuery: s.recursiveQuery }),
            ...(s.codeIndexMcp !== undefined && { codeIndexMcp: s.codeIndexMcp }),
            // Nested objects: deep merge
            smartContext: {
              ...currentSettings.smartContext,
              ...(s.smartContext || {})
            },
            cache: {
              ...currentSettings.cache,
              ...(s.cache || {})
            }
          };
          saveClaudeCliSettings(initialPath, updatedSettings);
        }

        const toolsConfig = loadClaudeCliTools(initialPath);
        const settingsConfig = loadClaudeCliSettings(initialPath);

        broadcastToClients({
          type: 'CLI_TOOLS_CONFIG_UPDATED',
          payload: { tools: toolsConfig, settings: settingsConfig, timestamp: new Date().toISOString() }
        });

        return { success: true, tools: toolsConfig, settings: settingsConfig };
      } catch (err) {
        return { error: (err as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Update specific tool enabled status
  const toolsConfigMatch = pathname.match(/^\/api\/cli\/tools-config\/([a-zA-Z0-9_-]+)$/);
  if (toolsConfigMatch && req.method === 'PUT') {
    const toolName = toolsConfigMatch[1];
    handlePostRequest(req, res, async (body: unknown) => {
      try {
        const { enabled } = body as { enabled: boolean };
        const config = updateClaudeToolEnabled(initialPath, toolName, enabled);

        broadcastToClients({
          type: 'CLI_TOOL_TOGGLED',
          payload: { tool: toolName, enabled, timestamp: new Date().toISOString() }
        });

        return { success: true, config };
      } catch (err) {
        return { error: (err as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Update cache settings
  if (pathname === '/api/cli/tools-config/cache' && req.method === 'PUT') {
    handlePostRequest(req, res, async (body: unknown) => {
      try {
        const cacheSettings = body as { injectionMode?: string; defaultPrefix?: string; defaultSuffix?: string };
        const settings = updateClaudeCacheSettings(initialPath, cacheSettings as any);

        broadcastToClients({
          type: 'CLI_CACHE_SETTINGS_UPDATED',
          payload: { cache: settings.cache, timestamp: new Date().toISOString() }
        });

        return { success: true, settings };
      } catch (err) {
        return { error: (err as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Get Code Index MCP provider
  if (pathname === '/api/cli/code-index-mcp' && req.method === 'GET') {
    try {
      const provider = getCodeIndexMcp(initialPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ provider }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // API: Update Code Index MCP provider
  if (pathname === '/api/cli/code-index-mcp' && req.method === 'PUT') {
    handlePostRequest(req, res, async (body: unknown) => {
      try {
        const { provider } = body as { provider: 'codexlens' | 'ace' | 'none' };
        if (!provider || !['codexlens', 'ace', 'none'].includes(provider)) {
          return { error: 'Invalid provider. Must be "codexlens", "ace", or "none"', status: 400 };
        }

        const result = updateCodeIndexMcp(initialPath, provider);

        if (result.success) {
          broadcastToClients({
            type: 'CODE_INDEX_MCP_UPDATED',
            payload: { provider, timestamp: new Date().toISOString() }
          });
          return { success: true, provider };
        } else {
          return { error: result.error, status: 500 };
        }
      } catch (err) {
        return { error: (err as Error).message, status: 500 };
      }
    });
    return true;
  }

  return false;
}
