/**
 * Hook Templates - Backend Template Definitions
 *
 * All hook templates are defined here and executed via `ccw hook template exec <id> --stdin`.
 * This avoids Windows Git Bash quote handling issues when inline scripts are used.
 *
 * Usage:
 *   ccw hook template list                    - List available templates
 *   ccw hook template install <id> [--scope project|global] - Install template to settings.json
 *   ccw hook template exec <id> --stdin       - Execute template logic (for hooks)
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

export type HookTriggerType =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'PreCompact';

export type TemplateCategory = 'notification' | 'indexing' | 'automation' | 'utility' | 'protection';

export interface HookTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  trigger: HookTriggerType;
  matcher?: string;
  timeout?: number;
  /** Execute function - receives parsed stdin data */
  execute: (data: HookInputData) => HookOutput | Promise<HookOutput>;
}

export interface HookInputData {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  user_prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_reason?: string;
  stopReason?: string;
  end_turn_reason?: string;
  endTurnReason?: string;
  user_requested?: boolean;
  userRequested?: boolean;
  active_mode?: string;
  activeMode?: string;
  active_workflow?: boolean;
  activeWorkflow?: boolean;
  transcript_path?: string;
  [key: string]: unknown;
}

export interface HookOutput {
  /** Exit code: 0 = success, 2 = block */
  exitCode?: 0 | 2;
  /** stdout content (for system message injection) */
  stdout?: string;
  /** stderr content (for error messages) */
  stderr?: string;
  /** JSON output for hook decision */
  jsonOutput?: Record<string, unknown>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Send notification to dashboard via HTTP (using native fetch)
 */
function notifyDashboard(type: string, payload: Record<string, unknown>): void {
  const data = {
    type,
    ...payload,
    project: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    timestamp: Date.now(),
  };

  // Use native fetch (Node.js 18+) to avoid shell command injection
  fetch('http://localhost:3456/api/hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {
    // Silently ignore errors - dashboard may not be running
  });
}

/**
 * Check if file matches sensitive patterns
 */
function isSensitiveFile(filePath: string): boolean {
  return /\.env|secret|credential|\.key$|\.pem$|id_rsa|\.credentials/i.test(filePath);
}

/**
 * Check if command matches dangerous patterns
 */
function isDangerousCommand(cmd: string): boolean {
  const patterns = [
    /rm\s+-rf/i,
    /rmdir/i,
    /del\s+\//i,
    /format\s+/i,
    /shutdown/i,
    /reboot/i,
    /kill\s+-9/i,
    /pkill/i,
    /mkfs/i,
    /dd\s+if=/i,
    /chmod\s+777/i,
    /chown\s+-R/i,
    />\s*\/dev\//i,
    /wget.*\|.*sh/i,
    /curl.*\|.*bash/i,
    /DROP\s+TABLE/i,
    /TRUNCATE\s+TABLE/i,
    /kubectl\s+delete/i,
    /docker\s+(rm|rmi|system\s+prune)/i,
  ];
  return patterns.some(p => p.test(cmd));
}

/**
 * Safe deletion targets - directories commonly cleaned in dev workflows
 */
const SAFE_DELETE_TARGETS = [
  'node_modules',
  '.next',
  'dist',
  '__pycache__',
  '.cache',
  'coverage',
  '.turbo',
  'build',
];

/**
 * Check if a destructive command targets only safe directories.
 * Returns true if the command IS dangerous (not a safe exception).
 * Returns false if the command targets a safe directory (allow it through).
 */
function isDestructiveWithSafeException(cmd: string): boolean {
  if (!isDangerousCommand(cmd)) {
    return false;
  }
  // Only apply safe exceptions for rm -rf patterns
  const rmRfMatch = cmd.match(/rm\s+-rf\s+(.+)/i);
  if (rmRfMatch) {
    const args = rmRfMatch[1].trim().split(/\s+/);
    // Every target must match a safe pattern for the exception to apply
    const allSafe = args.length > 0 && args.every(arg => {
      const target = arg.replace(/^["']|["']$/g, '').replace(/[/\\]+$/, '');
      const targetBase = target.split(/[/\\]/).pop() || '';
      return SAFE_DELETE_TARGETS.some(safe =>
        targetBase === safe || target === safe
      );
    });
    if (allSafe) {
      return false; // Safe exception - not dangerous
    }
  }
  return true; // Dangerous, no safe exception applies
}

/**
 * Check if command is a dangerous git operation
 */
function isDangerousGitCommand(cmd: string): boolean {
  const patterns = [
    /git\s+push.*--force/i,
    /git\s+push.*-f/i,
    /git\s+reset\s+--hard/i,
    /git\s+clean\s+-fd/i,
    /git\s+checkout.*--force/i,
    /git\s+branch\s+-D/i,
    /git\s+rebase.*-f/i,
  ];
  return patterns.some(p => p.test(cmd));
}

/**
 * Safely extract string value from unknown input
 */
function getStringInput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

/**
 * Validate file path to prevent command injection
 * Returns null if path is invalid, otherwise returns the sanitized path
 */
function validateFilePath(filePath: string): string | null {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  // Check for dangerous characters that could be used for command injection
  const dangerousPatterns = /[;&|`$(){}[\]<>!\\]/;
  if (dangerousPatterns.test(filePath)) {
    return null;
  }

  // Check for path traversal attempts
  if (filePath.includes('..')) {
    return null;
  }

  // Check for null bytes
  if (filePath.includes('\0')) {
    return null;
  }

  return filePath;
}

/**
 * Safe spawnSync wrapper that avoids shell: true to prevent command injection
 * On Windows, this uses .cmd extension for npm/npx commands
 */
function safeSpawnSync(command: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  // Use spawnSync without shell to avoid command injection
  // Note: On Windows, npx/npm/git may need .cmd extension
  const isWindows = process.platform === 'win32';
  const execCommand = isWindows && !command.endsWith('.cmd') && ['npx', 'npm', 'git', 'ccw'].includes(command)
    ? `${command}.cmd`
    : command;

  return spawnSync(execCommand, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

/**
 * Safe spawnSync with inherited stdio (for tools that need interactive output)
 */
function safeSpawnSyncInherit(command: string, args: string[]): void {
  const isWindows = process.platform === 'win32';
  const execCommand = isWindows && !command.endsWith('.cmd') && ['npx', 'npm', 'git', 'ccw'].includes(command)
    ? `${command}.cmd`
    : command;

  spawnSync(execCommand, args, {
    stdio: 'inherit',
    shell: false,
    cwd: process.cwd(),
  });
}

/**
 * Check if file is in protected system paths
 */
function isSystemPath(path: string): boolean {
  const sysPatterns = [
    /\/etc\//i,
    /\/usr\//i,
    /\/bin\//i,
    /\/sbin\//i,
    /\/boot\//i,
    /\/sys\//i,
    /\/proc\//i,
    /C:\\Windows/i,
    /C:\\Program Files/i,
  ];
  return sysPatterns.some(p => p.test(path));
}

// ============================================================================
// Hook Templates
// ============================================================================

export const HOOK_TEMPLATES: HookTemplate[] = [
  // ============ Notification Templates ============
  {
    id: 'session-start-notify',
    name: 'Session Start Notify',
    description: 'Notify dashboard when a new workflow session is created',
    category: 'notification',
    trigger: 'SessionStart',
    execute: () => {
      notifyDashboard('SESSION_CREATED', {});
      return { exitCode: 0 };
    }
  },
  {
    id: 'session-state-watch',
    name: 'Session State Watch',
    description: 'Watch for session metadata file changes (workflow-session.json)',
    category: 'notification',
    trigger: 'PostToolUse',
    matcher: 'Write|Edit',
    execute: (data) => {
      const file = getStringInput(data.tool_input?.file_path);
      if (file && /workflow-session\.json$|session-metadata\.json$/.test(file)) {
        try {
          if (existsSync(file)) {
            const content = readFileSync(file, 'utf8');
            const sessionData = JSON.parse(content);
            notifyDashboard('SESSION_STATE_CHANGED', {
              file,
              sessionId: sessionData.session_id || '',
              status: sessionData.status || 'unknown',
            });
          }
        } catch {
          // Ignore parse errors
        }
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'stop-notify',
    name: 'Stop Notify',
    description: 'Notify dashboard when Claude finishes responding',
    category: 'notification',
    trigger: 'Stop',
    execute: () => {
      notifyDashboard('TASK_COMPLETED', {});
      return { exitCode: 0 };
    }
  },
  {
    id: 'memory-sync-dashboard',
    name: 'Memory Sync Dashboard',
    description: 'Sync memory V2 status to dashboard on changes',
    category: 'notification',
    trigger: 'PostToolUse',
    matcher: 'mcp__ccw-tools__core_memory',
    execute: () => {
      notifyDashboard('MEMORY_V2_STATUS_UPDATED', {});
      return { exitCode: 0 };
    }
  },

  // ============ Automation Templates ============
  {
    id: 'auto-format-on-write',
    name: 'Auto Format on Write',
    description: 'Auto-format files after Claude writes or edits them',
    category: 'automation',
    trigger: 'PostToolUse',
    matcher: 'Write|Edit',
    execute: (data) => {
      const rawFile = getStringInput(data.tool_input?.file_path);
      const file = validateFilePath(rawFile);
      if (file) {
        safeSpawnSyncInherit('npx', ['prettier', '--write', file]);
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'auto-lint-on-write',
    name: 'Auto Lint on Write',
    description: 'Auto-lint files after Claude writes or edits them',
    category: 'automation',
    trigger: 'PostToolUse',
    matcher: 'Write|Edit',
    execute: (data) => {
      const rawFile = getStringInput(data.tool_input?.file_path);
      const file = validateFilePath(rawFile);
      if (file) {
        safeSpawnSyncInherit('npx', ['eslint', '--fix', file]);
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'git-auto-stage',
    name: 'Git Auto Stage',
    description: 'Auto stage all modified files when Claude finishes responding',
    category: 'automation',
    trigger: 'Stop',
    execute: () => {
      safeSpawnSyncInherit('git', ['add', '-u']);
      return { exitCode: 0 };
    }
  },

  // ============ Protection Templates ============
  {
    id: 'block-sensitive-files',
    name: 'Block Sensitive Files',
    description: 'Block modifications to sensitive files (.env, secrets, credentials)',
    category: 'protection',
    trigger: 'PreToolUse',
    matcher: 'Write|Edit',
    execute: (data) => {
      const file = getStringInput(data.tool_input?.file_path);
      if (file && isSensitiveFile(file)) {
        return {
          exitCode: 2,
          stderr: `Blocked: modifying sensitive file ${file}`,
        };
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'danger-bash-confirm',
    name: 'Danger Bash Confirm',
    description: 'Require confirmation for dangerous bash commands',
    category: 'protection',
    trigger: 'PreToolUse',
    matcher: 'Bash',
    execute: (data) => {
      const cmd = (data.tool_input?.command as string) || '';
      if (isDangerousCommand(cmd)) {
        return {
          exitCode: 0,
          jsonOutput: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: `Potentially dangerous command detected: requires user confirmation`
            }
          }
        };
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'danger-file-protection',
    name: 'Danger File Protection',
    description: 'Block modifications to protected files',
    category: 'protection',
    trigger: 'PreToolUse',
    matcher: 'Write|Edit',
    execute: (data) => {
      const file = getStringInput(data.tool_input?.file_path);
      const protectedPatterns = /\.env|\.git\/|package-lock\.json|yarn\.lock|\.credentials|secrets|id_rsa|\.pem$|\.key$/i;
      if (file && protectedPatterns.test(file)) {
        return {
          exitCode: 2,
          jsonOutput: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `Protected file cannot be modified: ${file}`
            }
          }
        };
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'danger-git-destructive',
    name: 'Danger Git Destructive',
    description: 'Require confirmation for destructive git operations',
    category: 'protection',
    trigger: 'PreToolUse',
    matcher: 'Bash',
    execute: (data) => {
      const cmd = (data.tool_input?.command as string) || '';
      if (isDangerousGitCommand(cmd)) {
        return {
          exitCode: 0,
          jsonOutput: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: `Destructive git operation detected: ${cmd}`
            }
          }
        };
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'danger-network-confirm',
    name: 'Danger Network Confirm',
    description: 'Require confirmation for network operations',
    category: 'protection',
    trigger: 'PreToolUse',
    matcher: 'Bash|WebFetch',
    execute: (data) => {
      const tool = data.tool_name || '';

      if (tool === 'WebFetch') {
        const url = (data.tool_input?.url as string) || '';
        return {
          exitCode: 0,
          jsonOutput: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: `Network request to: ${url}`
            }
          }
        };
      }

      const cmd = (data.tool_input?.command as string) || '';
      const netCmds = /^(curl|wget|nc |netcat|ssh |scp |rsync|ftp )/i;
      if (netCmds.test(cmd)) {
        return {
          exitCode: 0,
          jsonOutput: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: `Network command requires confirmation: ${cmd}`
            }
          }
        };
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'danger-system-paths',
    name: 'Danger System Paths',
    description: 'Block modifications to system paths',
    category: 'protection',
    trigger: 'PreToolUse',
    matcher: 'Write|Edit|Bash',
    execute: (data) => {
      const tool = data.tool_name || '';

      if (tool === 'Bash') {
        const cmd = (data.tool_input?.command as string) || '';
        if (isSystemPath(cmd)) {
          return {
            exitCode: 0,
            jsonOutput: {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'ask',
                permissionDecisionReason: `System path operation requires confirmation`
              }
            }
          };
        }
      } else {
        const file = getStringInput(data.tool_input?.file_path);
        if (file && isSystemPath(file)) {
          return {
            exitCode: 2,
            jsonOutput: {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `Cannot modify system file: ${file}`
              }
            }
          };
        }
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'danger-permission-change',
    name: 'Danger Permission Change',
    description: 'Require confirmation for permission changes',
    category: 'protection',
    trigger: 'PreToolUse',
    matcher: 'Bash',
    execute: (data) => {
      const cmd = (data.tool_input?.command as string) || '';
      const permCmds = /^(chmod|chown|chgrp|setfacl|icacls|takeown|cacls)/i;
      if (permCmds.test(cmd)) {
        return {
          exitCode: 0,
          jsonOutput: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: `Permission change requires confirmation: ${cmd}`
            }
          }
        };
      }
      return { exitCode: 0 };
    }
  },

  {
    id: 'careful-destructive-guard',
    name: 'Careful Destructive Guard',
    description: 'Block destructive commands but allow safe targets (node_modules, dist, .next, etc.)',
    category: 'protection',
    trigger: 'PreToolUse',
    matcher: 'Bash',
    execute: (data) => {
      const cmd = (data.tool_input?.command as string) || '';
      if (isDestructiveWithSafeException(cmd)) {
        return {
          exitCode: 0,
          jsonOutput: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: `Destructive command detected: requires user confirmation`
            }
          }
        };
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'freeze-edit-boundary',
    name: 'Freeze Edit Boundary',
    description: 'Block Write/Edit to files outside locked directories defined in .claude/freeze.json',
    category: 'protection',
    trigger: 'PreToolUse',
    matcher: 'Write|Edit',
    execute: (data) => {
      const file = getStringInput(data.tool_input?.file_path);
      if (!file) {
        return { exitCode: 0 };
      }
      const projectDir = data.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const freezePath = join(projectDir, '.claude', 'freeze.json');
      if (!existsSync(freezePath)) {
        return { exitCode: 0 };
      }
      try {
        const freezeData = JSON.parse(readFileSync(freezePath, 'utf8'));
        const lockedDirs: string[] = freezeData.locked_dirs;
        if (!Array.isArray(lockedDirs) || lockedDirs.length === 0) {
          return { exitCode: 0 };
        }
        const resolvedFile = resolve(projectDir, file);
        const isInLockedDir = lockedDirs.some(dir => {
          const resolvedDir = resolve(projectDir, dir);
          return resolvedFile.startsWith(resolvedDir + '/') || resolvedFile.startsWith(resolvedDir + '\\');
        });
        if (!isInLockedDir) {
          return {
            exitCode: 2,
            jsonOutput: {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `File ${file} is outside locked directories: ${lockedDirs.join(', ')}`
              }
            }
          };
        }
      } catch {
        // Ignore parse errors - if freeze.json is invalid, allow edits
      }
      return { exitCode: 0 };
    }
  },

  // ============ Indexing Templates ============
  {
    id: 'post-edit-index',
    name: 'Post Edit Index',
    description: 'Notify indexing service when files are modified',
    category: 'indexing',
    trigger: 'PostToolUse',
    matcher: 'Write|Edit',
    execute: (data) => {
      const file = getStringInput(data.tool_input?.file_path);
      if (file) {
        notifyDashboard('FILE_MODIFIED', { file });
      }
      return { exitCode: 0 };
    }
  },
  {
    id: 'session-end-summary',
    name: 'Session End Summary',
    description: 'Send session summary to dashboard on session end',
    category: 'indexing',
    trigger: 'Stop',
    execute: (data) => {
      notifyDashboard('SESSION_SUMMARY', {
        transcript: data.transcript_path || '',
      });
      return { exitCode: 0 };
    }
  },

  // ============ Utility Templates ============
  {
    id: 'memory-auto-compress',
    name: 'Auto Memory Compress',
    description: 'Automatically compress memory when entries exceed threshold',
    category: 'utility',
    trigger: 'Stop',
    execute: () => {
      safeSpawnSyncInherit('ccw', ['memory', 'consolidate', '--threshold', '50']);
      return { exitCode: 0 };
    }
  },
  {
    id: 'memory-preview-extract',
    name: 'Memory Preview & Extract',
    description: 'Preview extraction queue and extract eligible sessions',
    category: 'utility',
    trigger: 'SessionStart',
    execute: () => {
      safeSpawnSyncInherit('ccw', ['memory', 'preview', '--include-native']);
      return { exitCode: 0 };
    }
  },
  {
    id: 'memory-status-check',
    name: 'Memory Status Check',
    description: 'Check memory extraction and consolidation status',
    category: 'utility',
    trigger: 'SessionStart',
    execute: () => {
      safeSpawnSyncInherit('ccw', ['memory', 'status']);
      return { exitCode: 0 };
    }
  },
  {
    id: 'memory-v2-extract',
    name: 'Memory V2 Extract',
    description: 'Trigger Phase 1 extraction when session ends',
    category: 'utility',
    trigger: 'Stop',
    execute: () => {
      safeSpawnSyncInherit('ccw', ['core-memory', 'extract', '--max-sessions', '10']);
      return { exitCode: 0 };
    }
  },
  {
    id: 'memory-v2-auto-consolidate',
    name: 'Memory V2 Auto Consolidate',
    description: 'Trigger Phase 2 consolidation after extraction jobs complete',
    category: 'utility',
    trigger: 'Stop',
    execute: () => {
      const result = safeSpawnSync('ccw', ['core-memory', 'extract', '--json']);
      try {
        const d = JSON.parse(result.stdout);
        if (d && d.total_stage1 >= 5) {
          safeSpawnSyncInherit('ccw', ['core-memory', 'consolidate']);
        }
      } catch {
        // Ignore parse errors
      }
      return { exitCode: 0 };
    }
  },
];

// ============================================================================
// Template Registry
// ============================================================================

const templateMap = new Map<string, HookTemplate>();
HOOK_TEMPLATES.forEach(t => templateMap.set(t.id, t));

/**
 * Get template by ID
 */
export function getTemplate(id: string): HookTemplate | undefined {
  return templateMap.get(id);
}

/**
 * List all templates grouped by category
 */
export function listTemplatesByCategory(): Record<TemplateCategory, HookTemplate[]> {
  const result: Record<TemplateCategory, HookTemplate[]> = {
    notification: [],
    indexing: [],
    automation: [],
    utility: [],
    protection: [],
  };
  HOOK_TEMPLATES.forEach(t => {
    result[t.category].push(t);
  });
  return result;
}

/**
 * Get all templates
 */
export function getAllTemplates(): HookTemplate[] {
  return [...HOOK_TEMPLATES];
}

/**
 * Execute a template by ID
 */
export async function executeTemplate(id: string, data: HookInputData): Promise<HookOutput> {
  const template = templateMap.get(id);
  if (!template) {
    return {
      exitCode: 0,
      stderr: `Template not found: ${id}`,
    };
  }
  return template.execute(data);
}

/**
 * Generate settings.json hook configuration for a template
 */
export function generateHookConfig(template: HookTemplate): Record<string, unknown> {
  const config: Record<string, unknown> = {
    _templateId: template.id,
    hooks: [{
      type: 'command',
      command: `ccw hook template exec ${template.id} --stdin`,
      ...(template.timeout ? { timeout: template.timeout } : {}),
    }],
  };

  if (template.matcher) {
    config.matcher = template.matcher;
  }

  return config;
}

/**
 * Install a template to settings.json
 */
export function installTemplateToSettings(
  templateId: string,
  scope: 'project' | 'global' = 'project'
): { success: boolean; message: string } {
  const template = templateMap.get(templateId);
  if (!template) {
    return { success: false, message: `Template not found: ${templateId}` };
  }

  const settingsPath = scope === 'global'
    ? join(homedir(), '.claude', 'settings.json')
    : join(process.cwd(), '.claude', 'settings.json');

  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      return { success: false, message: `Failed to parse ${settingsPath}` };
    }
  }

  // Initialize hooks structure
  if (!settings.hooks) {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks[template.trigger]) {
    hooks[template.trigger] = [];
  }

  // Check if already installed
  const triggerHooks = hooks[template.trigger] as Array<Record<string, unknown>>;
  const alreadyInstalled = triggerHooks.some((h) =>
    h._templateId === templateId
  );

  if (alreadyInstalled) {
    return { success: true, message: `Template ${templateId} already installed` };
  }

  // Add the hook
  triggerHooks.push(generateHookConfig(template));

  // Write back
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return { success: true, message: `Template ${templateId} installed to ${settingsPath}` };
  } catch (e) {
    return { success: false, message: `Failed to write settings: ${(e as Error).message}` };
  }
}
