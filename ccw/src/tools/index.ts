/**
 * Tool Registry - MCP-like tool system for CCW
 * Provides tool discovery, validation, and execution
 */

import http from 'http';
import type { ToolSchema, ToolResult } from '../types/tool.js';

// Import TypeScript migrated tools (schema + handler)
import * as editFileMod from './edit-file.js';
import * as writeFileMod from './write-file.js';
import * as getModulesByDepthMod from './get-modules-by-depth.js';
import * as classifyFoldersMod from './classify-folders.js';
import * as detectChangedModulesMod from './detect-changed-modules.js';
import * as discoverDesignFilesMod from './discover-design-files.js';
import * as generateModuleDocsMod from './generate-module-docs.js';
import * as generateDddDocsMod from './generate-ddd-docs.js';
import * as convertTokensToCssMod from './convert-tokens-to-css.js';
import * as sessionManagerMod from './session-manager.js';
import * as cliExecutorMod from './cli-executor.js';
// codex_lens / smart_search removed - use codexlens MCP server instead
import * as readFileMod from './read-file.js';
import * as readManyFilesMod from './read-many-files.js';
import * as readOutlineMod from './read-outline.js';
import * as coreMemoryMod from './core-memory.js';
import * as contextCacheMod from './context-cache.js';
import * as skillContextLoaderMod from './skill-context-loader.js';
import * as askQuestionMod from './ask-question.js';
import * as teamMsgMod from './team-msg.js';
import * as jsonBuilderMod from './json-builder.js';


// Import legacy JS tools
import { uiGeneratePreviewTool } from './ui-generate-preview.js';
import { uiInstantiatePrototypesTool } from './ui-instantiate-prototypes.js';
import { updateModuleClaudeTool } from './update-module-claude.js';
import { memoryQueueTool } from './memory-update-queue.js';

interface LegacyTool {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

// Tool registry
const tools = new Map<string, LegacyTool>();

// Dashboard notification settings
const DASHBOARD_PORT = process.env.CCW_PORT || 3456;

/**
 * Notify dashboard of tool execution events (fire and forget)
 */
function notifyDashboard(data: Record<string, unknown>): void {
  const payload = JSON.stringify({
    type: 'tool_execution',
    ...data,
    timestamp: new Date().toISOString()
  });

  const req = http.request({
    hostname: 'localhost',
    port: Number(DASHBOARD_PORT),
    path: '/api/hook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  });

  // Fire and forget - log errors only in debug mode
  req.on('error', (err) => {
    if (process.env.DEBUG) console.error('[Dashboard] Tool notification failed:', err.message);
  });
  req.write(payload);
  req.end();
}

/**
 * Convert new-style tool (schema + handler) to legacy format
 */
function toLegacyTool(mod: {
  schema: ToolSchema;
  handler: (params: Record<string, unknown>) => Promise<ToolResult<unknown>>;
}): LegacyTool {
  return {
    name: mod.schema.name,
    description: mod.schema.description,
    parameters: {
      type: 'object',
      properties: mod.schema.inputSchema?.properties || {},
      required: mod.schema.inputSchema?.required || []
    },
    execute: async (params: Record<string, unknown>) => {
      const result = await mod.handler(params);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.result;
    }
  };
}

/**
 * Register a tool in the registry
 */
function registerTool(tool: LegacyTool): void {
  if (!tool.name || !tool.execute) {
    throw new Error('Tool must have name and execute function');
  }
  tools.set(tool.name, tool);
}

/**
 * Get all registered tools
 */
export function listTools(): Array<Omit<LegacyTool, 'execute'>> {
  return Array.from(tools.values()).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

/**
 * Get a specific tool by name
 */
export function getTool(name: string): LegacyTool | null {
  return tools.get(name) || null;
}

/**
 * Validate parameters against tool schema
 */
function validateParams(tool: LegacyTool, params: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const schema = tool.parameters;

  if (!schema || !schema.properties) {
    return { valid: true, errors: [] };
  }

  // Check required parameters
  const required = schema.required || [];
  for (const req of required) {
    if (params[req] === undefined || params[req] === null) {
      errors.push(`Missing required parameter: ${req}`);
    }
  }

  // Type validation
  for (const [key, value] of Object.entries(params)) {
    const propSchema = schema.properties[key] as { type?: string };
    if (!propSchema) {
      continue; // Allow extra params
    }

    if (propSchema.type === 'string' && typeof value !== 'string') {
      errors.push(`Parameter '${key}' must be a string`);
    }
    if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`Parameter '${key}' must be a boolean`);
    }
    if (propSchema.type === 'number' && typeof value !== 'number') {
      errors.push(`Parameter '${key}' must be a number`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Execute a tool with given parameters
 */
export async function executeTool(name: string, params: Record<string, unknown> = {}): Promise<{
  success: boolean;
  result?: unknown;
  error?: string;
}> {
  const tool = tools.get(name);

  if (!tool) {
    return {
      success: false,
      error: `Tool not found: ${name}`
    };
  }

  // Validate parameters
  const validation = validateParams(tool, params);
  if (!validation.valid) {
    return {
      success: false,
      error: `Parameter validation failed: ${validation.errors.join(', ')}`
    };
  }

  // Notify dashboard - execution started
  notifyDashboard({
    toolName: name,
    status: 'started',
    params: sanitizeParams(params)
  });

  // Execute tool
  try {
    const result = await tool.execute(params);

    // Notify dashboard - execution completed
    notifyDashboard({
      toolName: name,
      status: 'completed',
      result: sanitizeResult(result)
    });

    return {
      success: true,
      result
    };
  } catch (error) {
    // Notify dashboard - execution failed
    notifyDashboard({
      toolName: name,
      status: 'failed',
      error: (error as Error).message || 'Tool execution failed'
    });

    return {
      success: false,
      error: (error as Error).message || 'Tool execution failed'
    };
  }
}

/**
 * Sanitize params for notification (truncate large values)
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > 200) {
      sanitized[key] = value.substring(0, 200) + '...';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = '[Object]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Sanitize result for notification (truncate large values)
 */
function sanitizeResult(result: unknown): unknown {
  if (result === null || result === undefined) return result;
  const str = JSON.stringify(result);
  if (str.length > 500) {
    return { _truncated: true, preview: str.substring(0, 500) + '...' };
  }
  return result;
}

/**
 * Get tool schema in MCP-compatible format
 */
export function getToolSchema(name: string): ToolSchema | null {
  const tool = tools.get(name);
  if (!tool) return null;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.parameters?.properties || {},
      required: tool.parameters?.required || []
    }
  };
}

/**
 * Get all tool schemas in MCP-compatible format
 */
export function getAllToolSchemas(): ToolSchema[] {
  return Array.from(tools.keys()).map(name => getToolSchema(name)).filter((s): s is ToolSchema => s !== null);
}

// Register TypeScript migrated tools
registerTool(toLegacyTool(editFileMod));
registerTool(toLegacyTool(writeFileMod));
registerTool(toLegacyTool(getModulesByDepthMod));
registerTool(toLegacyTool(classifyFoldersMod));
registerTool(toLegacyTool(detectChangedModulesMod));
registerTool(toLegacyTool(discoverDesignFilesMod));
registerTool(toLegacyTool(generateModuleDocsMod));
registerTool(toLegacyTool(generateDddDocsMod));
registerTool(toLegacyTool(convertTokensToCssMod));
registerTool(toLegacyTool(sessionManagerMod));
registerTool(toLegacyTool(cliExecutorMod));
// codex_lens / smart_search removed - use codexlens MCP server instead
registerTool(toLegacyTool(readFileMod));
registerTool(toLegacyTool(readManyFilesMod));
registerTool(toLegacyTool(readOutlineMod));
registerTool(toLegacyTool(coreMemoryMod));
registerTool(toLegacyTool(contextCacheMod));
registerTool(toLegacyTool(skillContextLoaderMod));
registerTool(toLegacyTool(askQuestionMod));
registerTool(toLegacyTool(teamMsgMod));
registerTool(toLegacyTool(jsonBuilderMod));

// Register legacy JS tools
registerTool(uiGeneratePreviewTool);
registerTool(uiInstantiatePrototypesTool);
registerTool(updateModuleClaudeTool);
registerTool(memoryQueueTool);

// Export for external tool registration
export { registerTool };

// Export ToolSchema type
export type { ToolSchema };

// Export CommandRegistry for direct import
export { CommandRegistry, createCommandRegistry, getAllCommandsSync, getCommandSync } from './command-registry.js';
export type { CommandMetadata, CommandSummary } from './command-registry.js';
