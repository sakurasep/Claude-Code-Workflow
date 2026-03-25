/**
 * Orchestrator Routes Module
 * CCW Orchestrator System - HTTP API endpoints for Flow CRUD, Execution Control, and Template Management
 *
 * Flow Endpoints:
 * - GET    /api/orchestrator/flows              - List all flows with pagination
 * - POST   /api/orchestrator/flows              - Create new flow
 * - GET    /api/orchestrator/flows/:id          - Get flow details
 * - PUT    /api/orchestrator/flows/:id          - Update flow
 * - DELETE /api/orchestrator/flows/:id          - Delete flow
 * - POST   /api/orchestrator/flows/:id/duplicate - Duplicate flow
 *
 * Execution Control Endpoints:
 * - POST   /api/orchestrator/flows/:id/execute             - Start flow execution
 * - POST   /api/orchestrator/flows/:id/execute-in-session  - Start flow execution in PTY session
 * - POST   /api/orchestrator/executions/:execId/pause      - Pause execution
 * - POST   /api/orchestrator/executions/:execId/resume     - Resume execution
 * - POST   /api/orchestrator/executions/:execId/stop       - Stop execution
 * - GET    /api/orchestrator/executions/:execId            - Get execution state
 * - GET    /api/orchestrator/executions/:execId/logs       - Get execution logs
 *
 * Template Management Endpoints:
 * - GET    /api/orchestrator/templates          - List local + builtin templates
 * - GET    /api/orchestrator/templates/remote   - Fetch remote templates from GitHub
 * - POST   /api/orchestrator/templates/install  - Install template from URL or GitHub
 * - DELETE /api/orchestrator/templates/:id      - Delete local template
 * - POST   /api/orchestrator/templates/export   - Export flow as template
 *
 * Configuration Endpoints:
 * - GET    /api/config/version                  - Check application version against GitHub
 */

import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import type { RouteContext } from './types.js';
import { FlowExecutor } from '../services/flow-executor.js';
import { validatePath as validateAllowedPath } from '../../utils/path-validator.js';

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In-memory execution engines for pause/resume/stop (best-effort; resets on server restart)
const activeExecutors = new Map<string, FlowExecutor>();

// ============================================================================
// TypeScript Interfaces
// ============================================================================

/**
 * Unified node type - all nodes are prompt templates
 * Replaces previous 6-type system with single unified model
 */
export type FlowNodeType = 'prompt-template';

/**
 * Available CLI tools for execution
 */
export type CliTool = 'gemini' | 'qwen' | 'codex' | 'claude';

/**
 * Execution modes for prompt templates
 * - analysis: Read-only operations, code review, exploration
 * - write: Create/modify/delete files
 * - mainprocess: Execute in main process (blocking)
 * - async: Execute asynchronously (non-blocking)
 */
export type ExecutionMode = 'analysis' | 'write' | 'mainprocess' | 'async';

/**
 * Unified PromptTemplate node data model
 *
 * All workflow nodes are represented as prompt templates with natural language
 * instructions. This model replaces the previous specialized node types:
 * - slash-command -> instruction: "Execute /command args"
 * - cli-command -> instruction + tool + mode
 * - file-operation -> instruction: "Save {{ref}} to path"
 * - conditional -> instruction: "If {{condition}} then..."
 * - parallel -> instruction: "Execute in parallel..."
 * - prompt -> instruction (direct)
 */
export interface PromptTemplateNodeData {
  /**
   * Display label for the node in the editor
   */
  label: string;

  /**
   * Natural language instruction describing what to execute
   * Can include context references using {{variableName}} syntax
   */
  instruction: string;

  /**
   * Optional name for the output, allowing subsequent steps to reference it
   * via contextRefs or {{outputName}} syntax in instructions
   */
  outputName?: string;

  /**
   * Optional CLI tool to use for execution
   * If not specified, the system selects based on task requirements
   */
  tool?: CliTool;

  /**
   * Optional execution mode
   * Defaults to 'mainprocess' if not specified
   */
  mode?: ExecutionMode;

  /**
   * Delivery target for CLI-mode execution.
   * - newExecution: spawn a fresh CLI execution (default)
   * - sendToSession: route to a PTY session (tmux-like send)
   */
  delivery?: 'newExecution' | 'sendToSession';

  /**
   * When delivery=sendToSession, route execution to this PTY session key.
   */
  targetSessionKey?: string;

  /**
   * Optional logical resume key for chaining executions.
   */
  resumeKey?: string;

  /**
   * Optional resume mapping strategy.
   */
  resumeStrategy?: 'nativeResume' | 'promptConcat';

  /**
   * References to outputs from previous steps
   * Use the outputName values from earlier nodes
   */
  contextRefs?: string[];

  /**
   * Selected slash command name for structured execution
   */
  slashCommand?: string;

  /**
   * Arguments for the slash command
   */
  slashArgs?: string;

  /**
   * Instruction type for native CLI session routing
   */
  instructionType?: 'prompt' | 'skill';

  /**
   * Skill name for skill-type instructions
   */
  skillName?: string;

  /**
   * Error handling behavior
   */
  onError?: 'continue' | 'pause' | 'fail';

  // ========== Execution State Fields ==========

  /**
   * Current execution status of this node
   * Uses same values as NodeExecutionStatus defined below
   */
  executionStatus?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

  /**
   * Error message if execution failed
   */
  executionError?: string;

  /**
   * Result data from execution
   */
  executionResult?: unknown;
}

/**
 * NodeData type - unified to single PromptTemplateNodeData
 */
export type NodeData = PromptTemplateNodeData;

/**
 * Flow node definition
 */
export interface FlowNode {
  id: string;
  type: FlowNodeType;
  position: { x: number; y: number };
  data: NodeData;
}

/**
 * Flow edge definition (connection between nodes)
 */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

/**
 * Flow metadata
 */
export interface FlowMetadata {
  author?: string;
  tags?: string[];
  source?: 'local' | 'template' | 'imported';
}

/**
 * Flow definition - complete workflow graph
 */
export interface Flow {
  id: string;
  name: string;
  description?: string;
  version: string;
  created_at: string;
  updated_at: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  variables: Record<string, unknown>;
  metadata: FlowMetadata;
}

/**
 * Flow create request body
 */
interface FlowCreateRequest {
  name: string;
  description?: string;
  version?: string;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  variables?: Record<string, unknown>;
  metadata?: FlowMetadata;
}

/**
 * Flow update request body
 */
interface FlowUpdateRequest {
  name?: string;
  description?: string;
  version?: string;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  variables?: Record<string, unknown>;
  metadata?: FlowMetadata;
}

// ============================================================================
// Execution State Interfaces (per DESIGN_SPEC.md Section 3.3)
// ============================================================================

/**
 * Execution status values
 */
export type ExecutionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

/**
 * Node execution status values
 */
export type NodeExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Execution log entry
 */
export interface ExecutionLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  nodeId?: string;
  message: string;
}

/**
 * Individual node execution state
 */
export interface NodeExecutionState {
  status: NodeExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

/**
 * Full execution state for a flow run
 */
export interface ExecutionState {
  id: string;
  flowId: string;
  status: ExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  currentNodeId?: string;
  /** Session key if execution is running in a PTY session */
  sessionKey?: string;
  variables: Record<string, unknown>;
  nodeStates: Record<string, NodeExecutionState>;
  logs: ExecutionLog[];
}

// ============================================================================
// Template Interfaces
// ============================================================================

/**
 * Template metadata - additional info for templates beyond Flow metadata
 */
export interface TemplateMetadata {
  author: string;
  category: string;
  tags: string[];
  version: string;
  description: string;
  source: 'local' | 'builtin' | 'remote';
  remoteUrl?: string;
  installedAt?: string;
}

/**
 * Template definition - extends Flow with template-specific metadata
 */
export interface Template extends Omit<Flow, 'metadata'> {
  template_metadata: TemplateMetadata;
}

/**
 * Remote template index entry (from GitHub)
 */
export interface RemoteTemplateEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  tags: string[];
  downloadUrl: string;
}

/**
 * Remote template index response
 */
export interface RemoteTemplateIndex {
  version: string;
  updated_at: string;
  templates: RemoteTemplateEntry[];
}

/**
 * Template install request body
 */
interface TemplateInstallRequest {
  url?: string;
  templateId?: string;
}

/**
 * Template export request body
 */
interface TemplateExportRequest {
  flowId: string;
  name?: string;
  author?: string;
  category?: string;
  tags?: string[];
  description?: string;
}

// ============================================================================
// Storage Helpers
// ============================================================================

/**
 * Generate a unique flow ID
 * Format: flow-{timestamp}-{random8hex}
 */
function generateFlowId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const random = randomBytes(4).toString('hex');
  return `flow-${timestamp}-${random}`;
}

/**
 * Get the flows storage directory path
 */
function getFlowsDir(workflowDir: string): string {
  return join(workflowDir, '.workflow', '.orchestrator', 'flows');
}

/**
 * Read a single flow from storage
 */
async function readFlowStorage(workflowDir: string, flowId: string): Promise<Flow | null> {
  const { readFile } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const flowsDir = getFlowsDir(workflowDir);
  const filePath = join(flowsDir, `${flowId}.json`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as Flow;
  } catch {
    return null;
  }
}

/**
 * Write a flow to storage
 */
async function writeFlowStorage(workflowDir: string, flow: Flow): Promise<void> {
  const { writeFile, mkdir } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const flowsDir = getFlowsDir(workflowDir);

  if (!existsSync(flowsDir)) {
    await mkdir(flowsDir, { recursive: true });
  }

  const filePath = join(flowsDir, `${flow.id}.json`);
  await writeFile(filePath, JSON.stringify(flow, null, 2), 'utf-8');
}

/**
 * Delete a flow from storage
 */
async function deleteFlowStorage(workflowDir: string, flowId: string): Promise<void> {
  const { unlink } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const flowsDir = getFlowsDir(workflowDir);
  const filePath = join(flowsDir, `${flowId}.json`);

  if (existsSync(filePath)) {
    await unlink(filePath);
  }
}

/**
 * List all flows from storage
 * Returns flows sorted by updated_at (most recent first)
 */
async function listFlows(workflowDir: string): Promise<Flow[]> {
  const { readdir } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const flowsDir = getFlowsDir(workflowDir);

  if (!existsSync(flowsDir)) {
    return [];
  }

  const files = await readdir(flowsDir);
  const flowFiles = files.filter(f => f.startsWith('flow-') && f.endsWith('.json'));

  const flows: Flow[] = [];
  for (const file of flowFiles) {
    const flowId = file.replace('.json', '');
    const flow = await readFlowStorage(workflowDir, flowId);
    if (flow) {
      flows.push(flow);
    }
  }

  // Sort by updated_at (most recent first)
  flows.sort((a, b) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );

  return flows;
}

/**
 * Validate flow ID format to prevent path traversal
 */
function isValidFlowId(id: string): boolean {
  if (!id) return false;
  // Block path traversal attempts and null bytes
  if (id.includes('/') || id.includes('\\') || id === '..' || id === '.') return false;
  if (id.includes('\0')) return false;
  // Must start with 'flow-'
  if (!id.startsWith('flow-')) return false;
  return true;
}

// ============================================================================
// Execution Storage Helpers
// ============================================================================

/**
 * Generate a unique execution ID
 * Format: exec-{timestamp}-{random8hex}
 */
function generateExecutionId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const random = randomBytes(4).toString('hex');
  return `exec-${timestamp}-${random}`;
}

/**
 * Get the executions storage directory path
 */
function getExecutionsDir(workflowDir: string): string {
  return join(workflowDir, '.workflow', '.orchestrator', 'executions');
}

/**
 * Validate execution ID format to prevent path traversal
 */
function isValidExecutionId(id: string): boolean {
  if (!id) return false;
  // Block path traversal attempts and null bytes
  if (id.includes('/') || id.includes('\\') || id === '..' || id === '.') return false;
  if (id.includes('\0')) return false;
  // Must start with 'exec-'
  if (!id.startsWith('exec-')) return false;
  return true;
}

/**
 * Read execution state from storage
 */
async function readExecutionStorage(workflowDir: string, execId: string): Promise<ExecutionState | null> {
  const { readFile } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const executionsDir = getExecutionsDir(workflowDir);
  const filePath = join(executionsDir, execId, 'status.json');

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as ExecutionState;
  } catch {
    return null;
  }
}

/**
 * Write execution state to storage
 */
async function writeExecutionStorage(workflowDir: string, execution: ExecutionState): Promise<void> {
  const { writeFile, mkdir } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const executionsDir = getExecutionsDir(workflowDir);
  const execDir = join(executionsDir, execution.id);

  if (!existsSync(execDir)) {
    await mkdir(execDir, { recursive: true });
  }

  const filePath = join(execDir, 'status.json');
  await writeFile(filePath, JSON.stringify(execution, null, 2), 'utf-8');
}

/**
 * Append a log entry to the execution state
 */
async function appendExecutionLog(
  workflowDir: string,
  execId: string,
  log: Omit<ExecutionLog, 'timestamp'>
): Promise<ExecutionState | null> {
  const execution = await readExecutionStorage(workflowDir, execId);
  if (!execution) {
    return null;
  }

  const logEntry: ExecutionLog = {
    ...log,
    timestamp: new Date().toISOString()
  };

  execution.logs.push(logEntry);
  await writeExecutionStorage(workflowDir, execution);
  return execution;
}

// ============================================================================
// Template Storage Helpers
// ============================================================================

/**
 * GitHub repository configuration for remote templates
 */
const GITHUB_CONFIG = {
  owner: 'anthropics',
  repo: 'claude-code-workflow',
  branch: 'main',
  templatesPath: 'templates/orchestrator'
};

/**
 * Remote templates cache with TTL (5 minutes)
 */
let remoteTemplatesCache: {
  data: RemoteTemplateIndex | null;
  timestamp: number;
} = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Generate a unique template ID
 * Format: tpl-{timestamp}-{random8hex}
 */
function generateTemplateId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const random = randomBytes(4).toString('hex');
  return `tpl-${timestamp}-${random}`;
}

/**
 * Get the templates storage directory path (local user templates)
 */
function getTemplatesDir(workflowDir: string): string {
  return join(workflowDir, '.workflow', '.orchestrator', 'templates');
}

/**
 * Get the builtin templates directory path (shipped with CCW)
 * Returns null if the directory doesn't exist (e.g., in npm package without src/)
 */
function getBuiltinTemplatesDir(): string | null {
  // Try multiple possible locations for builtin templates
  const possiblePaths = [
    // From dist/core/routes/ -> ccw/templates/orchestrator/
    join(__dirname, '..', '..', '..', 'templates', 'orchestrator'),
    // From dist/core/routes/ -> ccw/src/templates/orchestrator/ (dev mode)
    join(__dirname, '..', '..', '..', 'src', 'templates', 'orchestrator'),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

/**
 * Validate template ID format to prevent path traversal
 */
function isValidTemplateId(id: string): boolean {
  if (!id) return false;
  // Block path traversal attempts and null bytes
  if (id.includes('/') || id.includes('\\') || id === '..' || id === '.') return false;
  if (id.includes('\0')) return false;
  // Must start with 'tpl-' for user templates or be alphanumeric for builtin
  if (!id.startsWith('tpl-') && !/^[a-zA-Z0-9-]+$/.test(id)) return false;
  return true;
}

/**
 * Read a single template from storage
 */
async function readTemplateStorage(workflowDir: string, templateId: string): Promise<Template | null> {
  const { readFile } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const templatesDir = getTemplatesDir(workflowDir);
  const filePath = join(templatesDir, `${templateId}.json`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as Template;
  } catch {
    return null;
  }
}

/**
 * Write a template to storage
 */
async function writeTemplateStorage(workflowDir: string, template: Template): Promise<void> {
  const { writeFile, mkdir } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const templatesDir = getTemplatesDir(workflowDir);

  if (!existsSync(templatesDir)) {
    await mkdir(templatesDir, { recursive: true });
  }

  const filePath = join(templatesDir, `${template.id}.json`);
  await writeFile(filePath, JSON.stringify(template, null, 2), 'utf-8');
}

/**
 * Delete a template from storage
 */
async function deleteTemplateStorage(workflowDir: string, templateId: string): Promise<void> {
  const { unlink } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const templatesDir = getTemplatesDir(workflowDir);
  const filePath = join(templatesDir, `${templateId}.json`);

  if (existsSync(filePath)) {
    await unlink(filePath);
  }
}

/**
 * List local templates from storage
 * Returns templates sorted by installedAt (most recent first)
 */
async function listLocalTemplates(workflowDir: string): Promise<Template[]> {
  const { readdir, readFile } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const templatesDir = getTemplatesDir(workflowDir);

  if (!existsSync(templatesDir)) {
    return [];
  }

  const files = await readdir(templatesDir);
  const templateFiles = files.filter(f => f.endsWith('.json'));

  const templates: Template[] = [];
  for (const file of templateFiles) {
    const templateId = file.replace('.json', '');
    const template = await readTemplateStorage(workflowDir, templateId);
    if (template) {
      templates.push(template);
    }
  }

  // Sort by installedAt (most recent first)
  templates.sort((a, b) => {
    const aTime = a.template_metadata?.installedAt ? new Date(a.template_metadata.installedAt).getTime() : 0;
    const bTime = b.template_metadata?.installedAt ? new Date(b.template_metadata.installedAt).getTime() : 0;
    return bTime - aTime;
  });

  return templates;
}

/**
 * List builtin templates from CCW installation
 */
async function listBuiltinTemplates(): Promise<Template[]> {
  const { readdir, readFile } = await import('fs/promises');
  const builtinDir = getBuiltinTemplatesDir();

  // getBuiltinTemplatesDir() returns null if no builtin templates directory exists
  if (!builtinDir) {
    return [];
  }

  const files = await readdir(builtinDir);
  const templateFiles = files.filter(f => f.endsWith('.json') && f !== 'index.json');

  const templates: Template[] = [];
  for (const file of templateFiles) {
    try {
      const filePath = join(builtinDir, file);
      const content = await readFile(filePath, 'utf-8');
      const template = JSON.parse(content) as Template;
      // Mark as builtin source
      if (template.template_metadata) {
        template.template_metadata.source = 'builtin';
      }
      templates.push(template);
    } catch {
      // Skip invalid template files
    }
  }

  return templates;
}

/**
 * Fetch remote template index from GitHub
 * Uses caching to avoid rate limits
 */
async function fetchRemoteTemplateIndex(): Promise<RemoteTemplateIndex> {
  // Check cache
  const now = Date.now();
  if (remoteTemplatesCache.data && (now - remoteTemplatesCache.timestamp) < CACHE_TTL_MS) {
    return remoteTemplatesCache.data;
  }

  const indexUrl = `https://raw.githubusercontent.com/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/${GITHUB_CONFIG.branch}/${GITHUB_CONFIG.templatesPath}/index.json`;

  try {
    const response = await fetch(indexUrl);
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const index = await response.json() as RemoteTemplateIndex;

    // Update cache
    remoteTemplatesCache = { data: index, timestamp: now };

    return index;
  } catch (error) {
    // Return cached data if available, even if expired
    if (remoteTemplatesCache.data) {
      return remoteTemplatesCache.data;
    }
    throw error;
  }
}

/**
 * Fetch a single template from a URL
 */
async function fetchRemoteTemplate(url: string): Promise<Template> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch template: ${response.status} ${response.statusText}`);
  }

  const template = await response.json() as Template;
  return template;
}

/**
 * Convert a Flow to a Template with metadata
 */
function flowToTemplate(
  flow: Flow,
  metadata: {
    author?: string;
    category?: string;
    tags?: string[];
    description?: string;
  }
): Template {
  const now = new Date().toISOString();
  const templateId = generateTemplateId();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { metadata: flowMetadata, ...flowWithoutMetadata } = flow;

  return {
    ...flowWithoutMetadata,
    id: templateId,
    template_metadata: {
      author: metadata.author || flowMetadata?.author || 'Unknown',
      category: metadata.category || 'General',
      tags: metadata.tags || flowMetadata?.tags || [],
      version: flow.version || '1.0.0',
      description: metadata.description || flow.description || '',
      source: 'local',
      installedAt: now
    }
  };
}

// ============================================================================
// Route Handler
// ============================================================================

/**
 * Handle orchestrator routes
 * @returns true if route was handled, false otherwise
 */
export async function handleOrchestratorRoutes(ctx: RouteContext): Promise<boolean> {
  const { pathname, req, res, initialPath, handlePostRequest, broadcastToClients } = ctx;

  // Get workflow directory from initialPath, optionally overridden by ?path= (scoped to allowed dirs)
  const allowedRoot = initialPath || process.cwd();
  let workflowDir = allowedRoot;

  const projectPathParam = ctx.url.searchParams.get('path');
  if (projectPathParam && projectPathParam.trim()) {
    try {
      workflowDir = await validateAllowedPath(projectPathParam, {
        mustExist: true,
        allowedDirectories: [allowedRoot],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.toLowerCase().includes('access denied') ? 403 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: status === 403 ? 'Access denied' : 'Invalid path' }));
      return true;
    }
  }

  // ==== LIST FLOWS ====
  // GET /api/orchestrator/flows
  if (pathname === '/api/orchestrator/flows' && req.method === 'GET') {
    try {
      const flows = await listFlows(workflowDir);

      // Parse query params for pagination
      const url = ctx.url;
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);

      // Apply pagination
      const paginatedFlows = flows.slice(offset, offset + limit);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: paginatedFlows,
        total: flows.length,
        limit,
        offset,
        hasMore: offset + limit < flows.length,
        timestamp: new Date().toISOString()
      }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ==== CREATE FLOW ====
  // POST /api/orchestrator/flows
  if (pathname === '/api/orchestrator/flows' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { name, description, version, nodes, edges, variables, metadata } = body as FlowCreateRequest;

      // Validation
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return { success: false, error: 'name is required and must be non-empty', status: 400 };
      }

      try {
        const flowId = generateFlowId();
        const now = new Date().toISOString();

        const flow: Flow = {
          id: flowId,
          name: name.trim(),
          description: description?.trim() || '',
          version: version || '1.0.0',
          created_at: now,
          updated_at: now,
          nodes: nodes || [],
          edges: edges || [],
          variables: variables || {},
          metadata: metadata || { source: 'local' }
        };

        await writeFlowStorage(workflowDir, flow);

        // Broadcast flow creation
        try {
          broadcastToClients({
            type: 'ORCHESTRATOR_FLOW_CREATED',
            flow_id: flowId,
            flow: flow
          });
        } catch {
          // Ignore broadcast errors
        }

        return { success: true, data: flow };
      } catch (error) {
        return { success: false, error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // ==== DUPLICATE FLOW ====
  // POST /api/orchestrator/flows/:id/duplicate
  if (pathname.match(/^\/api\/orchestrator\/flows\/[^/]+\/duplicate$/) && req.method === 'POST') {
    const flowId = pathname.split('/').slice(-2)[0];
    if (!flowId || !isValidFlowId(flowId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid flow ID format' }));
      return true;
    }

    handlePostRequest(req, res, async (body) => {
      const { name } = body as { name?: string };

      try {
        const originalFlow = await readFlowStorage(workflowDir, flowId);
        if (!originalFlow) {
          return { success: false, error: 'Flow not found', status: 404 };
        }

        const newFlowId = generateFlowId();
        const now = new Date().toISOString();

        const duplicatedFlow: Flow = {
          ...originalFlow,
          id: newFlowId,
          name: name?.trim() || `${originalFlow.name} (Copy)`,
          created_at: now,
          updated_at: now,
          metadata: {
            ...originalFlow.metadata,
            source: 'local'
          }
        };

        await writeFlowStorage(workflowDir, duplicatedFlow);

        // Broadcast flow duplication
        try {
          broadcastToClients({
            type: 'ORCHESTRATOR_FLOW_DUPLICATED',
            original_flow_id: flowId,
            flow_id: newFlowId,
            flow: duplicatedFlow
          });
        } catch {
          // Ignore broadcast errors
        }

        return { success: true, data: duplicatedFlow, message: 'Flow duplicated successfully' };
      } catch (error) {
        return { success: false, error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // ==== GET SINGLE FLOW ====
  // GET /api/orchestrator/flows/:id
  if (pathname.match(/^\/api\/orchestrator\/flows\/[^/]+$/) && req.method === 'GET') {
    const flowId = pathname.split('/').pop();
    if (!flowId || !isValidFlowId(flowId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid flow ID format' }));
      return true;
    }

    try {
      const flow = await readFlowStorage(workflowDir, flowId);
      if (!flow) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Flow not found' }));
        return true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: flow }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ==== UPDATE FLOW ====
  // PUT /api/orchestrator/flows/:id
  if (pathname.match(/^\/api\/orchestrator\/flows\/[^/]+$/) && req.method === 'PUT') {
    const flowId = pathname.split('/').pop();
    if (!flowId || !isValidFlowId(flowId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid flow ID format' }));
      return true;
    }

    handlePostRequest(req, res, async (body) => {
      const { name, description, version, nodes, edges, variables, metadata } = body as FlowUpdateRequest;

      try {
        const flow = await readFlowStorage(workflowDir, flowId);
        if (!flow) {
          return { success: false, error: 'Flow not found', status: 404 };
        }

        // Apply updates
        if (name !== undefined) {
          if (typeof name !== 'string' || name.trim().length === 0) {
            return { success: false, error: 'name must be a non-empty string', status: 400 };
          }
          flow.name = name.trim();
        }

        if (description !== undefined) {
          flow.description = typeof description === 'string' ? description.trim() : '';
        }

        if (version !== undefined) {
          flow.version = version;
        }

        if (nodes !== undefined) {
          if (!Array.isArray(nodes)) {
            return { success: false, error: 'nodes must be an array', status: 400 };
          }
          flow.nodes = nodes;
        }

        if (edges !== undefined) {
          if (!Array.isArray(edges)) {
            return { success: false, error: 'edges must be an array', status: 400 };
          }
          flow.edges = edges;
        }

        if (variables !== undefined) {
          flow.variables = variables || {};
        }

        if (metadata !== undefined) {
          flow.metadata = { ...flow.metadata, ...metadata };
        }

        flow.updated_at = new Date().toISOString();

        await writeFlowStorage(workflowDir, flow);

        // Broadcast flow update
        try {
          broadcastToClients({
            type: 'ORCHESTRATOR_FLOW_UPDATED',
            flow_id: flowId,
            flow: flow
          });
        } catch {
          // Ignore broadcast errors
        }

        return { success: true, data: flow };
      } catch (error) {
        return { success: false, error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // ==== DELETE FLOW ====
  // DELETE /api/orchestrator/flows/:id
  if (pathname.match(/^\/api\/orchestrator\/flows\/[^/]+$/) && req.method === 'DELETE') {
    const flowId = pathname.split('/').pop();
    if (!flowId || !isValidFlowId(flowId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid flow ID format' }));
      return true;
    }

    try {
      const flow = await readFlowStorage(workflowDir, flowId);
      if (!flow) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Flow not found' }));
        return true;
      }

      // TODO: Check if flow is currently being executed (future enhancement)
      // For now, allow deletion regardless of execution state

      await deleteFlowStorage(workflowDir, flowId);

      // Broadcast flow deletion
      try {
        broadcastToClients({
          type: 'ORCHESTRATOR_FLOW_DELETED',
          flow_id: flowId
        });
      } catch {
        // Ignore broadcast errors
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Flow deleted' }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ============================================================================
  // Execution Control Endpoints
  // ============================================================================

  // Helper to broadcast execution state updates
  const broadcastExecutionStateUpdate = (execution: ExecutionState): void => {
    try {
      broadcastToClients({
        type: 'ORCHESTRATOR_STATE_UPDATE',
        execId: execution.id,
        status: execution.status,
        currentNodeId: execution.currentNodeId,
        timestamp: new Date().toISOString()
      });
    } catch {
      // Ignore broadcast errors
    }
  };

  // Helper to broadcast specific execution status messages (for frontend executionMonitorStore)
  const broadcastExecutionStatusMessage = (
    execution: ExecutionState,
    sessionKey?: string
  ): void => {
    const timestamp = new Date().toISOString();

    // Map execution status to specific message types
    const messageTypeMap: Record<string, string> = {
      paused: 'EXECUTION_PAUSED',
      running: 'EXECUTION_RESUMED',
      completed: 'EXECUTION_COMPLETED',
      failed: 'EXECUTION_FAILED',
    };

    const messageType = messageTypeMap[execution.status];
    if (messageType) {
      try {
        broadcastToClients({
          type: messageType,
          payload: {
            executionId: execution.id,
            flowId: execution.flowId,
            status: execution.status,
            timestamp,
            projectPath: workflowDir,
          },
        });
      } catch {
        // Ignore broadcast errors
      }
    }

    // Broadcast CLI_SESSION_UNLOCKED when execution completes or fails
    if ((execution.status === 'completed' || execution.status === 'failed') && sessionKey) {
      try {
        broadcastToClients({
          type: 'CLI_SESSION_UNLOCKED',
          payload: {
            sessionKey,
            timestamp,
            projectPath: workflowDir,
          },
        });
      } catch {
        // Ignore broadcast errors
      }
    }
  };

  // ==== EXECUTE FLOW ====
  // POST /api/orchestrator/flows/:id/execute
  if (pathname.match(/^\/api\/orchestrator\/flows\/[^/]+\/execute$/) && req.method === 'POST') {
    const flowId = pathname.split('/').slice(-2)[0];
    if (!flowId || !isValidFlowId(flowId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid flow ID format' }));
      return true;
    }

    handlePostRequest(req, res, async (body) => {
      const { variables: inputVariables } = body as { variables?: Record<string, unknown> };

      try {
        // Verify flow exists
        const flow = await readFlowStorage(workflowDir, flowId);
        if (!flow) {
          return { success: false, error: 'Flow not found', status: 404 };
        }

        // Create execution state
        const execId = generateExecutionId();
        const now = new Date().toISOString();

        // Initialize node states for all nodes in the flow
        const nodeStates: Record<string, NodeExecutionState> = {};
        for (const node of flow.nodes) {
          nodeStates[node.id] = {
            status: 'pending'
          };
        }

        const execution: ExecutionState = {
          id: execId,
          flowId: flowId,
          status: 'pending',
          startedAt: now,
          variables: { ...flow.variables, ...inputVariables },
          nodeStates,
          logs: [{
            timestamp: now,
            level: 'info',
            message: `Execution started for flow: ${flow.name}`
          }]
        };

        // Save execution state
        await writeExecutionStorage(workflowDir, execution);

        // Broadcast execution created
        broadcastExecutionStateUpdate(execution);

        // Trigger actual flow executor (best-effort, async)
        // Execution state is persisted by FlowExecutor and updates are broadcast via WebSocket.
        try {
          const executor = new FlowExecutor(flow, execId, workflowDir);
          activeExecutors.set(execId, executor);

          void executor.execute(inputVariables).then((finalState) => {
            // Keep executor instance if paused, so it can be resumed.
            if (finalState.status !== 'paused') {
              activeExecutors.delete(execId);
            }
          }).catch(() => {
            // Best-effort cleanup on unexpected failures.
            activeExecutors.delete(execId);
          });
        } catch {
          // If executor bootstrap fails, keep the pending execution for inspection.
        }

        return {
          success: true,
          data: {
            execId: execution.id,
            flowId: execution.flowId,
            status: execution.status,
            startedAt: execution.startedAt
          },
          message: 'Execution created'
        };
      } catch (error) {
        return { success: false, error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // ==== EXECUTE FLOW IN SESSION ====
  // POST /api/orchestrator/flows/:id/execute-in-session
  if (pathname.match(/^\/api\/orchestrator\/flows\/[^/]+\/execute-in-session$/) && req.method === 'POST') {
    const flowId = pathname.split('/').slice(-2)[0];
    if (!flowId || !isValidFlowId(flowId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid flow ID format' }));
      return true;
    }

    handlePostRequest(req, res, async (body) => {
      const {
        sessionConfig,
        sessionKey: existingSessionKey,
        variables: inputVariables,
        stepTimeout,
        errorStrategy = 'pause'
      } = body as {
        sessionConfig?: {
          tool?: string;
          model?: string;
          preferredShell?: string;
        };
        sessionKey?: string;
        variables?: Record<string, unknown>;
        stepTimeout?: number;
        errorStrategy?: 'pause' | 'skip' | 'stop';
      };

      // Input validation
      const validTools = ['claude', 'gemini', 'qwen', 'codex', 'opencode'];
      const validShells = ['bash', 'pwsh', 'cmd'];
      const validErrorStrategies = ['pause', 'skip', 'stop'];

      if (sessionConfig) {
        if (sessionConfig.tool && !validTools.includes(sessionConfig.tool)) {
          return { success: false, error: `Invalid tool. Must be one of: ${validTools.join(', ')}`, status: 400 };
        }
        if (sessionConfig.preferredShell && !validShells.includes(sessionConfig.preferredShell)) {
          return { success: false, error: `Invalid preferredShell. Must be one of: ${validShells.join(', ')}`, status: 400 };
        }
        if (sessionConfig.model && typeof sessionConfig.model !== 'string') {
          return { success: false, error: 'model must be a string', status: 400 };
        }
      }

      if (inputVariables && typeof inputVariables !== 'object') {
        return { success: false, error: 'variables must be an object', status: 400 };
      }

      if (stepTimeout !== undefined) {
        if (typeof stepTimeout !== 'number' || stepTimeout < 1000 || stepTimeout > 3600000) {
          return { success: false, error: 'stepTimeout must be a number between 1000 and 3600000 (ms)', status: 400 };
        }
      }

      if (!validErrorStrategies.includes(errorStrategy)) {
        return { success: false, error: `Invalid errorStrategy. Must be one of: ${validErrorStrategies.join(', ')}`, status: 400 };
      }

      try {
        // Verify flow exists
        const flow = await readFlowStorage(workflowDir, flowId);
        if (!flow) {
          return { success: false, error: 'Flow not found', status: 404 };
        }

        // Generate execution ID
        const execId = generateExecutionId();
        const now = new Date().toISOString();

        // Determine session key
        let sessionKey = existingSessionKey;
        if (!sessionKey) {
          // Create new session if not provided
          // This would typically call the session manager
          sessionKey = `cli-session-${Date.now()}-${randomBytes(4).toString('hex')}`;
        }

        // Create execution state
        const nodeStates: Record<string, NodeExecutionState> = {};
        for (const node of flow.nodes) {
          nodeStates[node.id] = {
            status: 'pending'
          };
        }

        const execution: ExecutionState = {
          id: execId,
          flowId: flowId,
          status: 'pending',
          startedAt: now,
          sessionKey: sessionKey,
          variables: { ...flow.variables, ...inputVariables },
          nodeStates,
          logs: [{
            timestamp: now,
            level: 'info',
            message: `Execution started in session: ${sessionKey}`
          }]
        };

        // Save execution state
        await writeExecutionStorage(workflowDir, execution);

        // Broadcast execution created
        broadcastExecutionStateUpdate(execution);

        // Broadcast EXECUTION_STARTED to WebSocket clients
        broadcastToClients({
          type: 'EXECUTION_STARTED',
          payload: {
            executionId: execId,
            flowId: flowId,
            sessionKey: sessionKey,
            stepName: flow.name,
            totalSteps: flow.nodes.length,
            timestamp: now,
            projectPath: workflowDir,
          }
        });

        // Lock the session (via WebSocket broadcast for frontend to handle)
        broadcastToClients({
          type: 'CLI_SESSION_LOCKED',
          payload: {
            sessionKey: sessionKey,
            reason: `Executing workflow: ${flow.name}`,
            executionId: execId,
            timestamp: now,
            projectPath: workflowDir,
          }
        });

        // TODO: Implement actual step-by-step execution in PTY session
        // For now, mark as running and let the frontend handle the orchestration
        execution.status = 'running';
        await writeExecutionStorage(workflowDir, execution);
        broadcastExecutionStateUpdate(execution);

        return {
          success: true,
          data: {
            executionId: execution.id,
            flowId: execution.flowId,
            sessionKey: sessionKey,
            status: execution.status,
            totalSteps: flow.nodes.length,
            startedAt: execution.startedAt
          },
          message: 'Execution started in session'
        };
      } catch (error) {
        return { success: false, error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // ==== PAUSE EXECUTION ====
  // POST /api/orchestrator/executions/:execId/pause
  if (pathname.match(/^\/api\/orchestrator\/executions\/[^/]+\/pause$/) && req.method === 'POST') {
    const execId = pathname.split('/').slice(-2)[0];
    if (!execId || !isValidExecutionId(execId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid execution ID format' }));
      return true;
    }

    try {
      const executor = activeExecutors.get(execId);
      if (executor) {
        executor.pause();
        const execution = await readExecutionStorage(workflowDir, execId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: execution ?? executor.getState(),
          message: 'Pause requested'
        }));
        return true;
      }

      const execution = await readExecutionStorage(workflowDir, execId);
      if (!execution) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Execution not found' }));
        return true;
      }

      // Can only pause running executions
      if (execution.status !== 'running') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: `Cannot pause execution with status: ${execution.status}`
        }));
        return true;
      }

      // Update status to paused
      execution.status = 'paused';
      execution.logs.push({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'Execution paused by user'
      });

      await writeExecutionStorage(workflowDir, execution);
      broadcastExecutionStateUpdate(execution);
      broadcastExecutionStatusMessage(execution);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: execution,
        message: 'Execution paused'
      }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ==== RESUME EXECUTION ====
  // POST /api/orchestrator/executions/:execId/resume
  if (pathname.match(/^\/api\/orchestrator\/executions\/[^/]+\/resume$/) && req.method === 'POST') {
    const execId = pathname.split('/').slice(-2)[0];
    if (!execId || !isValidExecutionId(execId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid execution ID format' }));
      return true;
    }

    try {
      const executor = activeExecutors.get(execId);
      if (executor) {
        const current = executor.getState();
        if (current.status !== 'paused') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Cannot resume execution with status: ${current.status}`
          }));
          return true;
        }

        void executor.resume().then((finalState) => {
          if (finalState.status !== 'paused') {
            activeExecutors.delete(execId);
          }
        }).catch(() => {
          // Best-effort: keep executor for inspection/resume retries.
        });

        const execution = await readExecutionStorage(workflowDir, execId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: execution ?? executor.getState(),
          message: 'Resume requested'
        }));
        return true;
      }

      const execution = await readExecutionStorage(workflowDir, execId);
      if (!execution) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Execution not found' }));
        return true;
      }

      // Can only resume paused executions
      if (execution.status !== 'paused') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: `Cannot resume execution with status: ${execution.status}`
        }));
        return true;
      }

      // Update status to running
      execution.status = 'running';
      execution.logs.push({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'Execution resumed by user'
      });

      await writeExecutionStorage(workflowDir, execution);
      broadcastExecutionStateUpdate(execution);
      broadcastExecutionStatusMessage(execution);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: execution,
        message: 'Execution resumed'
      }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ==== STOP EXECUTION ====
  // POST /api/orchestrator/executions/:execId/stop
  if (pathname.match(/^\/api\/orchestrator\/executions\/[^/]+\/stop$/) && req.method === 'POST') {
    const execId = pathname.split('/').slice(-2)[0];
    if (!execId || !isValidExecutionId(execId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid execution ID format' }));
      return true;
    }

    try {
      const executor = activeExecutors.get(execId);
      if (executor) {
        executor.stop();

        // If currently paused, mark as failed immediately (no running loop to observe stop flag).
        const current = executor.getState();
        if (current.status === 'paused') {
          const now = new Date().toISOString();
          current.status = 'failed';
          current.completedAt = now;
          current.logs.push({
            timestamp: now,
            level: 'warn',
            message: 'Execution manually stopped by user'
          });
          await writeExecutionStorage(workflowDir, current);
          broadcastExecutionStateUpdate(current);
          activeExecutors.delete(execId);
        }

        const execution = await readExecutionStorage(workflowDir, execId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: execution ?? current,
          message: 'Stop requested'
        }));
        return true;
      }

      const execution = await readExecutionStorage(workflowDir, execId);
      if (!execution) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Execution not found' }));
        return true;
      }

      // Can only stop running, paused, or pending executions
      if (!['running', 'paused', 'pending'].includes(execution.status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: `Cannot stop execution with status: ${execution.status}`
        }));
        return true;
      }

      // Update status to failed with manual stop reason
      const now = new Date().toISOString();
      execution.status = 'failed';
      execution.completedAt = now;
      execution.logs.push({
        timestamp: now,
        level: 'warn',
        message: 'Execution manually stopped by user'
      });

      await writeExecutionStorage(workflowDir, execution);
      broadcastExecutionStateUpdate(execution);
      broadcastExecutionStatusMessage(execution, execution.sessionKey);

      // Broadcast EXECUTION_STOPPED for frontend executionMonitorStore
      broadcastToClients({
        type: 'EXECUTION_STOPPED',
        payload: {
          executionId: execution.id,
          flowId: execution.flowId,
          reason: 'User requested stop',
          timestamp: now,
          projectPath: workflowDir,
        },
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: execution,
        message: 'Execution stopped'
      }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ==== GET EXECUTION STATE ====
  // GET /api/orchestrator/executions/:execId
  if (pathname.match(/^\/api\/orchestrator\/executions\/[^/]+$/) && req.method === 'GET') {
    const execId = pathname.split('/').pop();
    if (!execId || !isValidExecutionId(execId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid execution ID format' }));
      return true;
    }

    try {
      const execution = await readExecutionStorage(workflowDir, execId);
      if (!execution) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Execution not found' }));
        return true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: execution }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ==== GET EXECUTION LOGS ====
  // GET /api/orchestrator/executions/:execId/logs
  if (pathname.match(/^\/api\/orchestrator\/executions\/[^/]+\/logs$/) && req.method === 'GET') {
    const execId = pathname.split('/').slice(-2)[0];
    if (!execId || !isValidExecutionId(execId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid execution ID format' }));
      return true;
    }

    try {
      const execution = await readExecutionStorage(workflowDir, execId);
      if (!execution) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Execution not found' }));
        return true;
      }

      // Parse pagination params from URL
      const url = ctx.url;
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const level = url.searchParams.get('level'); // Optional filter by log level
      const nodeId = url.searchParams.get('nodeId'); // Optional filter by node

      // Apply filters
      let filteredLogs = execution.logs;

      if (level) {
        filteredLogs = filteredLogs.filter(log => log.level === level);
      }

      if (nodeId) {
        filteredLogs = filteredLogs.filter(log => log.nodeId === nodeId);
      }

      // Apply pagination
      const paginatedLogs = filteredLogs.slice(offset, offset + limit);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          execId: execution.id,
          logs: paginatedLogs,
          total: filteredLogs.length,
          limit,
          offset,
          hasMore: offset + limit < filteredLogs.length
        }
      }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ==== GET COORDINATOR PIPELINE COMPATIBILITY DETAILS ====
  // GET /api/coordinator/pipeline/:execId
  if (pathname.match(/^\/api\/coordinator\/pipeline\/[^/]+$/) && req.method === 'GET') {
    const execId = pathname.split('/').pop();
    if (!execId || !isValidExecutionId(execId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid execution ID format' }));
      return true;
    }

    try {
      const execution = await readExecutionStorage(workflowDir, execId);
      if (!execution) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Execution not found' }));
        return true;
      }

      const flow = await readFlowStorage(workflowDir, execution.flowId);
      const flowNodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
      const nodes = flowNodes.map((node) => {
        const state = execution.nodeStates[node.id] || { status: 'pending' };
        const data = (node as any).data || {};
        return {
          id: node.id,
          name: data.label || node.id,
          description: data.instruction || data.description || undefined,
          command: data.instruction || data.slashCommand || data.command || '',
          status: state.status,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          result: state.result,
          error: state.error,
          output: typeof state.result === 'string' ? state.result : undefined,
          parentId: undefined,
          children: [],
        };
      });

      const logs = (execution.logs || []).map((log, idx) => ({
        id: `${execId}-log-${idx}`,
        timestamp: log.timestamp,
        level: (log.level === 'debug' || log.level === 'warn' || log.level === 'error' || log.level === 'info') ? log.level : 'info',
        message: log.message,
        nodeId: log.nodeId,
        source: log.nodeId ? 'node' : 'system',
      }));

      const coordinatorDetails = {
        id: execution.id,
        name: flow?.name || execution.flowId,
        description: flow?.description,
        nodes,
        totalSteps: nodes.length,
        estimatedDuration: undefined,
        logs,
        status: execution.status === 'pending' ? 'initializing' : execution.status,
        createdAt: execution.startedAt || new Date().toISOString(),
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: coordinatorDetails }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ============================================================================
  // Template Management Endpoints
  // ============================================================================

  // ==== LIST TEMPLATES ====
  // GET /api/orchestrator/templates
  // Returns combined list of local and builtin templates
  if (pathname === '/api/orchestrator/templates' && req.method === 'GET') {
    try {
      // Get local templates
      const localTemplates = await listLocalTemplates(workflowDir);

      // Get builtin templates
      const builtinTemplates = await listBuiltinTemplates();

      // Combine and deduplicate (local takes precedence)
      const localIds = new Set(localTemplates.map(t => t.id));
      const combinedTemplates = [
        ...localTemplates,
        ...builtinTemplates.filter(t => !localIds.has(t.id))
      ];

      // Parse query params for filtering
      const url = ctx.url;
      const category = url.searchParams.get('category');
      const source = url.searchParams.get('source');

      let filteredTemplates = combinedTemplates;

      if (category) {
        filteredTemplates = filteredTemplates.filter(
          t => t.template_metadata?.category?.toLowerCase() === category.toLowerCase()
        );
      }

      if (source) {
        filteredTemplates = filteredTemplates.filter(
          t => t.template_metadata?.source === source
        );
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: filteredTemplates,
        total: filteredTemplates.length,
        sources: {
          local: localTemplates.length,
          builtin: builtinTemplates.length
        },
        timestamp: new Date().toISOString()
      }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ==== LIST REMOTE TEMPLATES ====
  // GET /api/orchestrator/templates/remote
  // Fetches template index from GitHub
  if (pathname === '/api/orchestrator/templates/remote' && req.method === 'GET') {
    try {
      const remoteIndex = await fetchRemoteTemplateIndex();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: remoteIndex.templates,
        total: remoteIndex.templates.length,
        index_version: remoteIndex.version,
        updated_at: remoteIndex.updated_at,
        timestamp: new Date().toISOString()
      }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: (error as Error).message,
        message: 'Failed to fetch remote templates. Check network connectivity and GitHub rate limits.'
      }));
      return true;
    }
  }

  // ==== INSTALL TEMPLATE ====
  // POST /api/orchestrator/templates/install
  // Downloads template from URL or GitHub and saves locally
  if (pathname === '/api/orchestrator/templates/install' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { url, templateId } = body as TemplateInstallRequest;

      // Must provide either url or templateId
      if (!url && !templateId) {
        return { success: false, error: 'Either url or templateId is required', status: 400 };
      }

      try {
        let downloadUrl = url;
        let templateName = '';

        // If templateId provided, look up URL from remote index
        if (templateId && !url) {
          const remoteIndex = await fetchRemoteTemplateIndex();
          const remoteTemplate = remoteIndex.templates.find(t => t.id === templateId);

          if (!remoteTemplate) {
            return { success: false, error: `Template ${templateId} not found in remote index`, status: 404 };
          }

          downloadUrl = remoteTemplate.downloadUrl;
          templateName = remoteTemplate.name;
        }

        if (!downloadUrl) {
          return { success: false, error: 'Could not determine download URL', status: 400 };
        }

        // Fetch the template
        const remoteTemplate = await fetchRemoteTemplate(downloadUrl);

        // Generate new local ID and update metadata
        const now = new Date().toISOString();
        const localTemplate: Template = {
          ...remoteTemplate,
          id: generateTemplateId(),
          template_metadata: {
            ...remoteTemplate.template_metadata,
            source: 'remote',
            remoteUrl: downloadUrl,
            installedAt: now
          }
        };

        // Save to local storage
        await writeTemplateStorage(workflowDir, localTemplate);

        // Broadcast template installation
        try {
          broadcastToClients({
            type: 'ORCHESTRATOR_TEMPLATE_INSTALLED',
            template_id: localTemplate.id,
            template: localTemplate
          });
        } catch {
          // Ignore broadcast errors
        }

        return {
          success: true,
          data: localTemplate,
          message: `Template "${templateName || localTemplate.name}" installed successfully`
        };
      } catch (error) {
        return { success: false, error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // ==== EXPORT FLOW AS TEMPLATE ====
  // POST /api/orchestrator/templates/export
  // Converts an existing flow to a template
  if (pathname === '/api/orchestrator/templates/export' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { flowId, name, author, category, tags, description } = body as TemplateExportRequest;

      // Validation
      if (!flowId || typeof flowId !== 'string') {
        return { success: false, error: 'flowId is required', status: 400 };
      }

      if (!isValidFlowId(flowId)) {
        return { success: false, error: 'Invalid flow ID format', status: 400 };
      }

      try {
        // Read the source flow
        const flow = await readFlowStorage(workflowDir, flowId);
        if (!flow) {
          return { success: false, error: 'Flow not found', status: 404 };
        }

        // Convert to template
        const template = flowToTemplate(flow, {
          author,
          category,
          tags,
          description
        });

        // Override name if provided
        if (name && typeof name === 'string' && name.trim()) {
          template.name = name.trim();
        }

        // Save template
        await writeTemplateStorage(workflowDir, template);

        // Broadcast template export
        try {
          broadcastToClients({
            type: 'ORCHESTRATOR_TEMPLATE_EXPORTED',
            flow_id: flowId,
            template_id: template.id,
            template: template
          });
        } catch {
          // Ignore broadcast errors
        }

        return {
          success: true,
          data: template,
          message: `Flow exported as template "${template.name}"`
        };
      } catch (error) {
        return { success: false, error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // ==== DELETE TEMPLATE ====
  // DELETE /api/orchestrator/templates/:id
  // Only deletes local templates (cannot delete builtin)
  if (pathname.match(/^\/api\/orchestrator\/templates\/[^/]+$/) && req.method === 'DELETE') {
    const templateId = pathname.split('/').pop();
    if (!templateId || !isValidTemplateId(templateId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid template ID format' }));
      return true;
    }

    try {
      // Check if template exists in local storage
      const template = await readTemplateStorage(workflowDir, templateId);
      if (!template) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Template not found in local storage' }));
        return true;
      }

      // Cannot delete builtin templates
      if (template.template_metadata?.source === 'builtin') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'Cannot delete builtin templates. Only local and installed templates can be deleted.'
        }));
        return true;
      }

      // Delete the template
      await deleteTemplateStorage(workflowDir, templateId);

      // Broadcast template deletion
      try {
        broadcastToClients({
          type: 'ORCHESTRATOR_TEMPLATE_DELETED',
          template_id: templateId
        });
      } catch {
        // Ignore broadcast errors
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Template deleted' }));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (error as Error).message }));
      return true;
    }
  }

  // ==== VERSION CHECK ====
  // GET /api/config/version
  // Check application version against GitHub latest release
  if (pathname === '/api/config/version' && req.method === 'GET') {
    try {
      const { VersionChecker } = await import('../services/version-checker.js');
      const checker = new VersionChecker();
      const result = await checker.checkVersion();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: result }));
      return true;
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
      return true;
    }
  }

  return false;
}
