/**
 * Commands Routes Module
 * Handles all Commands-related API endpoints
 *
 * API Endpoints:
 * - GET /api/commands - List all commands with groups
 * - POST /api/commands/:name/toggle - Enable/disable single command
 * - POST /api/commands/group/:groupName/toggle - Batch toggle commands by group
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync, copyFileSync } from 'fs';
import { promises as fsPromises } from 'fs';
import { join, relative, dirname, basename } from 'path';
import { homedir } from 'os';
import { validatePath as validateAllowedPath } from '../../utils/path-validator.js';
import { executeCliTool } from '../../tools/cli-executor.js';
import { SmartContentFormatter } from '../../tools/cli-output-converter.js';
import type { RouteContext } from './types.js';

// ========== Types ==========

type CommandLocation = 'project' | 'user';

interface CommandMetadata {
  name: string;
  description: string;
  group: string;
  argumentHint?: string;
  allowedTools?: string[];
}

interface CommandInfo {
  name: string;
  description: string;
  group: string;
  enabled: boolean;
  location: CommandLocation;
  path: string;
  relativePath: string;  // Path relative to commands root (e.g., 'workflow/plan.md')
  argumentHint?: string;
  allowedTools?: string[];
}

interface CommandsConfig {
  projectCommands: CommandInfo[];
  userCommands: CommandInfo[];
  groups: string[];
}

interface CommandOperationResult {
  success: boolean;
  message: string;
  commandName?: string;
  location?: CommandLocation;
  status?: number;
}

interface GroupDefinition {
  name: string;
  icon?: string;
  color?: string;
}

interface CommandGroupsConfig {
  groups: Record<string, GroupDefinition>;  // Custom group definitions
  assignments: Record<string, string>;      // commandName -> groupId mapping
}

/**
 * Command creation mode type
 */
type CommandCreationMode = 'upload' | 'generate';

/**
 * Parameters for creating a command
 */
interface CreateCommandParams {
  mode: CommandCreationMode;
  location: CommandLocation;
  sourcePath?: string;       // Required for 'upload' mode - path to uploaded file
  skillName?: string;        // Required for 'generate' mode - skill to generate from
  description?: string;      // Optional description for generated commands
  projectPath: string;
  cliType?: string;          // CLI tool type for generation
}

/**
 * Result of command creation operation
 */
interface CommandCreationResult extends CommandOperationResult {
  commandInfo?: CommandMetadata | null;
}

/**
 * Validation result for command file
 */
type CommandFileValidation =
  | { valid: true; errors: string[]; commandInfo: CommandMetadata }
  | { valid: false; errors: string[]; commandInfo: null };

// ========== Helper Functions ==========

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Get commands directory path
 */
function getCommandsDir(location: CommandLocation, projectPath: string): string {
  if (location === 'project') {
    return join(projectPath, '.claude', 'commands');
  }
  return join(homedir(), '.claude', 'commands');
}


/**
 * Parse YAML frontmatter from command file
 */
function parseCommandFrontmatter(content: string): CommandMetadata {
  const result: CommandMetadata = {
    name: '',
    description: '',
    group: 'other'  // Default group
  };

  // Check for YAML frontmatter
  if (content.startsWith('---')) {
    const endIndex = content.indexOf('---', 3);
    if (endIndex > 0) {
      const frontmatter = content.substring(3, endIndex).trim();

      // Parse frontmatter lines
      const lines = frontmatter.split(/[\r\n]+/);
      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, '');

          if (key === 'name') {
            result.name = value;
          } else if (key === 'description') {
            result.description = value;
          } else if (key === 'group') {
            result.group = value || 'other';
          } else if (key === 'argument-hint') {
            result.argumentHint = value;
          } else if (key === 'allowed-tools') {
            result.allowedTools = value
              .replace(/^\[|\]$/g, '')
              .split(',')
              .map(t => t.trim())
              .filter(Boolean);
          }
        }
      }
    }
  }

  return result;
}

/**
 * Validate a command file for creation
 * Checks file existence, reads content, parses frontmatter, validates required fields
 */
function validateCommandFile(filePath: string): CommandFileValidation {
  const errors: string[] = [];

  // Check file exists
  if (!existsSync(filePath)) {
    return { valid: false, errors: ['Command file does not exist'], commandInfo: null };
  }

  // Check file extension
  if (!filePath.endsWith('.md')) {
    return { valid: false, errors: ['Command file must be a .md file'], commandInfo: null };
  }

  // Read file content
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { valid: false, errors: [`Failed to read file: ${(err as Error).message}`], commandInfo: null };
  }

  // Parse frontmatter
  const commandInfo = parseCommandFrontmatter(content);

  // Validate required fields
  if (!commandInfo.name || commandInfo.name.trim() === '') {
    errors.push('Command name is required in frontmatter');
  }

  // Check for valid frontmatter structure
  if (!content.startsWith('---')) {
    errors.push('Command file must have YAML frontmatter (starting with ---)');
  } else {
    const endIndex = content.indexOf('---', 3);
    if (endIndex < 0) {
      errors.push('Command file has invalid frontmatter (missing closing ---)');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, commandInfo: null };
  }

  return { valid: true, errors: [], commandInfo };
}

/**
 * Upload (copy) a command file to the commands directory
 * Handles group subdirectory creation and path security validation
 * @param sourcePath - Source command file path
 * @param targetGroup - Target group subdirectory (e.g., 'workflow/review')
 * @param location - 'project' or 'user'
 * @param projectPath - Project root path
 * @param customName - Optional custom filename (without .md extension)
 * @returns CommandCreationResult with success status and command info
 */
async function uploadCommand(
  sourcePath: string,
  targetGroup: string,
  location: CommandLocation,
  projectPath: string,
  customName?: string
): Promise<CommandCreationResult> {
  try {
    // Validate source file exists and is .md
    if (!existsSync(sourcePath)) {
      return { success: false, message: 'Source command file does not exist', status: 404 };
    }

    if (!sourcePath.endsWith('.md')) {
      return { success: false, message: 'Source file must be a .md file', status: 400 };
    }

    // Validate source file content
    const validation = validateCommandFile(sourcePath);
    if (!validation.valid) {
      return { success: false, message: validation.errors.join(', '), status: 400 };
    }

    // Get target commands directory
    const commandsDir = getCommandsDir(location, projectPath);

    // Build target path with optional group subdirectory
    let targetDir = commandsDir;
    if (targetGroup && targetGroup.trim() !== '') {
      // Sanitize group path - prevent path traversal
      const sanitizedGroup = targetGroup
        .replace(/\.\./g, '')  // Remove path traversal attempts
        .replace(/[<>:"|?*]/g, '') // Remove invalid characters
        .replace(/\/+/g, '/') // Collapse multiple slashes
        .replace(/^\/|\/$/g, ''); // Remove leading/trailing slashes

      if (sanitizedGroup) {
        targetDir = join(commandsDir, sanitizedGroup);
      }
    }

    // Create target directory if needed
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Determine target filename
    const sourceBasename = basename(sourcePath, '.md');
    const targetFilename = (customName && customName.trim() !== '')
      ? `${customName.replace(/\.md$/, '')}.md`
      : `${sourceBasename}.md`;

    // Sanitize filename - prevent path traversal
    const sanitizedFilename = targetFilename
      .replace(/\.\./g, '')
      .replace(/[<>:"|?*]/g, '')
      .replace(/\//g, '');

    const targetPath = join(targetDir, sanitizedFilename);

    // Security check: ensure target path is within commands directory
    const resolvedTarget = targetPath; // Already resolved by join
    const resolvedCommandsDir = commandsDir;

    if (!resolvedTarget.startsWith(resolvedCommandsDir)) {
      return { success: false, message: 'Invalid target path - path traversal detected', status: 400 };
    }

    // Check if target already exists
    if (existsSync(targetPath)) {
      return { success: false, message: `Command '${sanitizedFilename}' already exists in target location`, status: 409 };
    }

    // Copy file to target path
    copyFileSync(sourcePath, targetPath);

    return {
      success: true,
      message: 'Command uploaded successfully',
      commandName: validation.commandInfo.name,
      location,
      commandInfo: {
        name: validation.commandInfo.name,
        description: validation.commandInfo.description,
        group: targetGroup || 'other'
      }
    };
  } catch (error) {
    return {
      success: false,
      message: (error as Error).message,
      status: 500
    };
  }
}

/**
 * Generation parameters for command generation via CLI
 */
interface CommandGenerationParams {
  commandName: string;
  description: string;
  location: CommandLocation;
  projectPath: string;
  group?: string;
  argumentHint?: string;
  broadcastToClients?: (data: unknown) => void;
  cliType?: string;
}

/**
 * Generate command via CLI tool using command-generator skill
 * Follows the pattern from skills-routes.ts generateSkillViaCLI
 * @param params - Generation parameters including name, description, location, etc.
 * @returns CommandCreationResult with success status and generated command info
 */
async function generateCommandViaCLI({
  commandName,
  description,
  location,
  projectPath,
  group,
  argumentHint,
  broadcastToClients,
  cliType = 'claude'
}: CommandGenerationParams): Promise<CommandCreationResult> {
  // Generate unique execution ID for tracking
  const executionId = `cmd-gen-${commandName}-${Date.now()}`;

  try {
    // Validate required inputs
    if (!commandName || commandName.trim() === '') {
      return { success: false, message: 'Command name is required', status: 400 };
    }

    if (!description || description.trim() === '') {
      return { success: false, message: 'Description is required for command generation', status: 400 };
    }

    // Sanitize command name - prevent path traversal
    if (commandName.includes('..') || commandName.includes('/') || commandName.includes('\\')) {
      return { success: false, message: 'Invalid command name - path characters not allowed', status: 400 };
    }

    // Get target commands directory
    const commandsDir = getCommandsDir(location, projectPath);

    // Build target path with optional group subdirectory
    let targetDir = commandsDir;

    if (group && group.trim() !== '') {
      const sanitizedGroup = group
        .replace(/\.\./g, '')
        .replace(/[<>:"|?*]/g, '')
        .replace(/\/+/g, '/')
        .replace(/^\/|\/$/g, '');

      if (sanitizedGroup) {
        targetDir = join(commandsDir, sanitizedGroup);
      }
    }

    const targetPath = join(targetDir, `${commandName}.md`);

    // Check if command already exists
    if (existsSync(targetPath)) {
      return {
        success: false,
        message: `Command '${commandName}' already exists in ${location} location${group ? ` (group: ${group})` : ''}`,
        status: 409
      };
    }

    // Ensure target directory exists
    if (!existsSync(targetDir)) {
      await fsPromises.mkdir(targetDir, { recursive: true });
    }

    // Build target location display for prompt
    const targetLocationDisplay = location === 'project'
      ? '.claude/commands/'
      : '~/.claude/commands/';

    // Build structured command parameters for /command-generator skill
    const commandParams = {
      skillName: commandName,
      description,
      location,
      group: group || '',
      argumentHint: argumentHint || ''
    };

    // Prompt that invokes /command-generator skill with structured parameters
    const prompt = `/command-generator

## Command Parameters (Structured Input)

\`\`\`json
${JSON.stringify(commandParams, null, 2)}
\`\`\`

## User Request

Create a new Claude Code command with the following specifications:

- **Command Name**: ${commandName}
- **Description**: ${description}
- **Target Location**: ${targetLocationDisplay}${group ? `${group}/` : ''}${commandName}.md
- **Location Type**: ${location === 'project' ? 'Project-level (.claude/commands/)' : 'User-level (~/.claude/commands/)'}
${group ? `- **Group**: ${group}` : ''}
${argumentHint ? `- **Argument Hint**: ${argumentHint}` : ''}

## Instructions

1. Use the command-generator skill to create a command file with proper YAML frontmatter
2. Include name, description in frontmatter${group ? '\n3. Include group in frontmatter' : ''}${argumentHint ? '\n4. Include argument-hint in frontmatter' : ''}
3. Generate useful command content and usage examples
4. Output the file to: ${targetPath}`;

    // Broadcast CLI_EXECUTION_STARTED event
    if (broadcastToClients) {
      broadcastToClients({
        type: 'CLI_EXECUTION_STARTED',
        payload: {
          executionId,
          tool: cliType,
          mode: 'write',
          category: 'internal',
          context: 'command-generation',
          commandName
        }
      });
    }

    // Create onOutput callback for real-time streaming
    const onOutput = broadcastToClients
      ? (unit: import('../../tools/cli-output-converter.js').CliOutputUnit) => {
          const content = SmartContentFormatter.format(unit.content, unit.type);
          broadcastToClients({
            type: 'CLI_OUTPUT',
            payload: {
              executionId,
              chunkType: unit.type,
              data: content
            }
          });
        }
      : undefined;

    // Execute CLI tool with write mode
    const startTime = Date.now();
    const result = await executeCliTool({
      tool: cliType,
      prompt,
      mode: 'write',
      cd: projectPath,
      timeout: 600000, // 10 minutes
      category: 'internal',
      id: executionId
    }, onOutput);

    // Broadcast CLI_EXECUTION_COMPLETED event
    if (broadcastToClients) {
      broadcastToClients({
        type: 'CLI_EXECUTION_COMPLETED',
        payload: {
          executionId,
          success: result.success,
          status: result.execution?.status || (result.success ? 'success' : 'error'),
          duration_ms: Date.now() - startTime
        }
      });
    }

    // Check if execution was successful
    if (!result.success) {
      return {
        success: false,
        message: `CLI generation failed: ${result.stderr || 'Unknown error'}`,
        status: 500
      };
    }

    // Validate the generated command file exists
    if (!existsSync(targetPath)) {
      return {
        success: false,
        message: 'Generated command file not found at expected location',
        status: 500
      };
    }

    // Validate the generated command file content
    const validation = validateCommandFile(targetPath);
    if (!validation.valid) {
      return {
        success: false,
        message: `Generated command is invalid: ${validation.errors.join(', ')}`,
        status: 500
      };
    }

    return {
      success: true,
      message: 'Command generated successfully',
      commandName: validation.commandInfo.name,
      location,
      commandInfo: {
        name: validation.commandInfo.name,
        description: validation.commandInfo.description,
        group: validation.commandInfo.group
      }
    };
  } catch (error) {
    return {
      success: false,
      message: (error as Error).message,
      status: 500
    };
  }
}

/**
 * Get command groups config file path
 */
function getGroupsConfigPath(location: CommandLocation, projectPath: string): string {
  const baseDir = location === 'project'
    ? join(projectPath, '.claude')
    : join(homedir(), '.claude');
  return join(baseDir, 'command-groups.json');
}

/**
 * Load command groups configuration
 */
function loadGroupsConfig(location: CommandLocation, projectPath: string): CommandGroupsConfig {
  const configPath = getGroupsConfigPath(location, projectPath);

  const defaultConfig: CommandGroupsConfig = {
    groups: {},
    assignments: {}
  };

  if (!existsSync(configPath)) {
    return defaultConfig;
  }

  try {
    const content = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(content);

    return {
      groups: isRecord(parsed.groups) ? parsed.groups as Record<string, GroupDefinition> : {},
      assignments: isRecord(parsed.assignments) ? parsed.assignments as Record<string, string> : {}
    };
  } catch (err) {
    console.error(`[Commands] Failed to load groups config from ${configPath}:`, err);
    return defaultConfig;
  }
}

/**
 * Save command groups configuration
 */
function saveGroupsConfig(location: CommandLocation, projectPath: string, config: CommandGroupsConfig): void {
  const configPath = getGroupsConfigPath(location, projectPath);
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  try {
    const content = JSON.stringify(config, null, 2);
    require('fs').writeFileSync(configPath, content, 'utf8');
  } catch (err) {
    console.error(`[Commands] Failed to save groups config to ${configPath}:`, err);
  }
}

/**
 * Get group for a command (from config or inferred from path)
 */
function getCommandGroup(commandName: string, relativePath: string, location: CommandLocation, projectPath: string): string {
  // First check custom assignments
  const config = loadGroupsConfig(location, projectPath);
  if (config.assignments[commandName]) {
    return config.assignments[commandName];
  }

  // Fallback to path-based inference - use full directory path as group
  const parts = relativePath.split(/[/\\]/);
  if (parts.length > 1) {
    // Use full directory path (excluding filename) as group
    // e.g., 'workflow/review/code-review.md' -> 'workflow/review'
    return parts.slice(0, -1).join('/');
  }

  return 'other';
}

/**
 * Recursively scan directory for command files
 */
function scanCommandsRecursive(
  baseDir: string,
  currentDir: string,
  location: CommandLocation,
  projectPath: string
): CommandInfo[] {
  const results: CommandInfo[] = [];

  if (!existsSync(currentDir)) {
    return results;
  }

  try {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      let relativePath = relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        results.push(...scanCommandsRecursive(baseDir, fullPath, location, projectPath));
      } else if (entry.isFile()) {
        // Check for .md or .md.disabled files
        const isEnabled = entry.name.endsWith('.md') && !entry.name.endsWith('.md.disabled');
        const isDisabled = entry.name.endsWith('.md.disabled');

        if (isEnabled || isDisabled) {
          try {
            const content = readFileSync(fullPath, 'utf8');
            const metadata = parseCommandFrontmatter(content);

            // For disabled files, remove .disabled from relativePath for consistency
            if (isDisabled) {
              relativePath = relativePath.replace(/\.disabled$/, '');
            }

            const commandName = metadata.name || basename(relativePath, '.md');

            // Get group from external config (not from frontmatter)
            const group = getCommandGroup(commandName, relativePath, location, projectPath);

            results.push({
              name: commandName,
              description: metadata.description,
              group,
              enabled: isEnabled,
              location,
              path: fullPath,
              relativePath,
              argumentHint: metadata.argumentHint,
              allowedTools: metadata.allowedTools
            });
          } catch (err) {
            // Skip files that fail to read
            console.error(`[Commands] Failed to read ${fullPath}:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[Commands] Failed to scan directory ${currentDir}:`, err);
  }

  return results;
}

/**
 * Get all commands configuration
 */
function getCommandsConfig(projectPath: string): CommandsConfig {
  const result: CommandsConfig = {
    projectCommands: [],
    userCommands: [],
    groups: []
  };

  const groupSet = new Set<string>();

  try {
    // Scan project commands (includes both .md and .md.disabled)
    const projectDir = getCommandsDir('project', projectPath);
    result.projectCommands = scanCommandsRecursive(projectDir, projectDir, 'project', projectPath);

    // Scan user commands (includes both .md and .md.disabled)
    const userDir = getCommandsDir('user', projectPath);
    result.userCommands = scanCommandsRecursive(userDir, userDir, 'user', projectPath);

    // Collect all groups
    for (const cmd of [...result.projectCommands, ...result.userCommands]) {
      groupSet.add(cmd.group);
    }

    result.groups = Array.from(groupSet).sort();
  } catch (error) {
    console.error('[Commands] Error reading commands config:', error);
  }

  return result;
}


/**
 * Find command by name in commands list
 */
function findCommand(
  commands: CommandInfo[],
  commandName: string
): CommandInfo | undefined {
  // Try exact name match first
  let cmd = commands.find(c => c.name === commandName);
  if (cmd) return cmd;

  // Try matching by relative path (without extension)
  cmd = commands.find(c => {
    const pathWithoutExt = c.relativePath.replace(/\.md$/, '');
    return pathWithoutExt === commandName;
  });
  if (cmd) return cmd;

  // Try matching by filename (without extension)
  cmd = commands.find(c => {
    const filename = basename(c.relativePath, '.md');
    return filename === commandName;
  });

  return cmd;
}

/**
 * Toggle a command's enabled state
 */
async function toggleCommand(
  commandName: string,
  location: CommandLocation,
  projectPath: string,
  initialPath: string
): Promise<CommandOperationResult> {
  try {
    // Validate command name
    if (commandName.includes('..')) {
      return { success: false, message: 'Invalid command name', status: 400 };
    }

    const config = getCommandsConfig(projectPath);
    const commands = location === 'project' ? config.projectCommands : config.userCommands;
    const command = findCommand(commands, commandName);

    if (!command) {
      return { success: false, message: 'Command not found', status: 404 };
    }

    const commandsDir = getCommandsDir(location, projectPath);
    // relativePath already includes .md extension (e.g., 'workflow/plan.md')
    const commandPath = join(commandsDir, command.relativePath);
    const disabledPath = commandPath + '.disabled';

    if (command.enabled) {
      // Disable: rename .md to .md.disabled
      if (!existsSync(commandPath)) {
        return { success: false, message: 'Command file not found', status: 404 };
      }
      if (existsSync(disabledPath)) {
        return { success: false, message: 'Command already disabled', status: 409 };
      }

      renameSync(commandPath, disabledPath);
      return {
        success: true,
        message: 'Command disabled',
        commandName: command.name,
        location
      };
    } else {
      // Enable: rename .md.disabled back to .md
      if (!existsSync(disabledPath)) {
        return { success: false, message: 'Disabled command not found', status: 404 };
      }
      if (existsSync(commandPath)) {
        return { success: false, message: 'Command already enabled', status: 409 };
      }

      renameSync(disabledPath, commandPath);
      return {
        success: true,
        message: 'Command enabled',
        commandName: command.name,
        location
      };
    }
  } catch (error) {
    return {
      success: false,
      message: (error as Error).message,
      status: 500
    };
  }
}

/**
 * Toggle all commands in a group
 */
async function toggleGroup(
  groupName: string,
  location: CommandLocation,
  enable: boolean,
  projectPath: string,
  initialPath: string
): Promise<{ success: boolean; results: CommandOperationResult[]; message: string }> {
  const config = getCommandsConfig(projectPath);
  const commands = location === 'project' ? config.projectCommands : config.userCommands;
  
  // Filter commands by group and current state
  const targetCommands = commands.filter(cmd => 
    cmd.group === groupName && cmd.enabled !== enable
  );

  if (targetCommands.length === 0) {
    return {
      success: true,
      results: [],
      message: `No commands to ${enable ? 'enable' : 'disable'} in group '${groupName}'`
    };
  }

  const results: CommandOperationResult[] = [];

  for (const cmd of targetCommands) {
    const result = await toggleCommand(cmd.name, location, projectPath, initialPath);
    results.push(result);
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  return {
    success: failCount === 0,
    results,
    message: `${enable ? 'Enabled' : 'Disabled'} ${successCount} commands${failCount > 0 ? `, ${failCount} failed` : ''}`
  };
}

// ========== Route Handler ==========

/**
 * Handle Commands routes
 * @returns true if route was handled, false otherwise
 */
export async function handleCommandsRoutes(ctx: RouteContext): Promise<boolean> {
  const { pathname, url, req, res, initialPath, handlePostRequest } = ctx;

  // GET /api/commands - List all commands
  if (pathname === '/api/commands' && req.method === 'GET') {
    const projectPathParam = url.searchParams.get('path') || initialPath;

    try {
      const validatedProjectPath = await validateAllowedPath(projectPathParam, { 
        mustExist: true, 
        allowedDirectories: [initialPath] 
      });
      
      const config = getCommandsConfig(validatedProjectPath);

      // Include groups config from both project and user
      const projectGroupsConfig = loadGroupsConfig('project', validatedProjectPath);
      const userGroupsConfig = loadGroupsConfig('user', validatedProjectPath);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...config,
        projectGroupsConfig,
        userGroupsConfig
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('Access denied') ? 403 : 400;
      console.error(`[Commands] Project path validation failed: ${message}`);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: status === 403 ? 'Access denied' : 'Invalid path', 
        projectCommands: [], 
        userCommands: [],
        groups: []
      }));
    }
    return true;
  }

  // POST /api/commands/:name/toggle - Toggle single command
  if (pathname.match(/^\/api\/commands\/[^/]+\/toggle$/) && req.method === 'POST') {
    const pathParts = pathname.split('/');
    const commandName = decodeURIComponent(pathParts[3]);

    handlePostRequest(req, res, async (body) => {
      if (!isRecord(body)) {
        return { error: 'Invalid request body', status: 400 };
      }

      const locationValue = body.location;
      const projectPathParam = typeof body.projectPath === 'string' ? body.projectPath : undefined;

      if (locationValue !== 'project' && locationValue !== 'user') {
        return { error: 'Location is required (project or user)' };
      }

      const projectPath = projectPathParam || initialPath;
      return toggleCommand(commandName, locationValue, projectPath, initialPath);
    });
    return true;
  }

  // POST /api/commands/group/:groupName/toggle - Toggle all commands in group
  if (pathname.match(/^\/api\/commands\/group\/[^/]+\/toggle$/) && req.method === 'POST') {
    const pathParts = pathname.split('/');
    const groupName = decodeURIComponent(pathParts[4]);

    handlePostRequest(req, res, async (body) => {
      if (!isRecord(body)) {
        return { error: 'Invalid request body', status: 400 };
      }

      const locationValue = body.location;
      const enable = body.enable === true;
      const projectPathParam = typeof body.projectPath === 'string' ? body.projectPath : undefined;

      if (locationValue !== 'project' && locationValue !== 'user') {
        return { error: 'Location is required (project or user)' };
      }

      const projectPath = projectPathParam || initialPath;
      return toggleGroup(groupName, locationValue, enable, projectPath, initialPath);
    });
    return true;
  }

  // GET /api/commands/groups - Get groups configuration
  if (pathname === '/api/commands/groups' && req.method === 'GET') {
    const projectPathParam = url.searchParams.get('path') || initialPath;
    const location = url.searchParams.get('location') || 'project';

    try {
      const validatedProjectPath = await validateAllowedPath(projectPathParam, {
        mustExist: true,
        allowedDirectories: [initialPath]
      });

      if (location !== 'project' && location !== 'user') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid location' }));
        return true;
      }

      const groupsConfig = loadGroupsConfig(location as CommandLocation, validatedProjectPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(groupsConfig));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('Access denied') ? 403 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return true;
  }

  // PUT /api/commands/groups - Update groups configuration
  if (pathname === '/api/commands/groups' && req.method === 'PUT') {
    const projectPathParam = url.searchParams.get('path') || initialPath;
    const location = url.searchParams.get('location') || 'project';

    handlePostRequest(req, res, async (body) => {
      try {
        const validatedProjectPath = await validateAllowedPath(projectPathParam, {
          mustExist: true,
          allowedDirectories: [initialPath]
        });

        if (location !== 'project' && location !== 'user') {
          return { error: 'Invalid location', status: 400 };
        }

        if (!isRecord(body)) {
          return { error: 'Invalid request body', status: 400 };
        }

        // Validate and save groups config
        const config: CommandGroupsConfig = {
          groups: isRecord(body.groups) ? body.groups as Record<string, GroupDefinition> : {},
          assignments: isRecord(body.assignments) ? body.assignments as Record<string, string> : {}
        };

        saveGroupsConfig(location as CommandLocation, validatedProjectPath, config);

        return {
          success: true,
          message: 'Groups configuration updated',
          data: config,
          status: 200
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes('Access denied') ? 403 : 400;
        console.error(`[Commands] Failed to update groups config: ${message}`);
        return { error: message, status };
      }
    });
    return true;
  }

  // GET /api/commands/groups/config - Read commands groups config
  if (pathname === '/api/commands/groups/config' && req.method === 'GET') {
    const locationParam = url.searchParams.get('location');
    const projectPathParam = url.searchParams.get('path') || initialPath;
    const location: CommandLocation = locationParam === 'user' ? 'user' : 'project';
    const config = loadGroupsConfig(location, projectPathParam);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return true;
  }

  // POST /api/commands/validate-import - Validate source command file
  if (pathname === '/api/commands/validate-import' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      if (!isRecord(body) || typeof body.sourcePath !== 'string' || body.sourcePath.trim() === '') {
        return { valid: false, errors: ['sourcePath is required'], status: 400 };
      }

      try {
        const validatedSourcePath = await validateAllowedPath(body.sourcePath, { mustExist: true, allowedDirectories: [initialPath, homedir()] });
        const result = validateCommandFile(validatedSourcePath);
        if (!result.valid) {
          return { valid: false, errors: result.errors };
        }
        return {
          valid: true,
          errors: [],
          commandInfo: {
            name: result.commandInfo.name,
            description: result.commandInfo.description,
          }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes('Access denied') ? 403 : (message.includes('not exist') ? 404 : 400);
        return { valid: false, errors: [status === 403 ? 'Access denied' : (status === 404 ? 'Command file does not exist' : message)], status };
      }
    });
    return true;
  }

  // POST /api/commands/create - Create command (upload or generate)
  if (pathname === '/api/commands/create' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      if (!isRecord(body)) {
        return { success: false, message: 'Invalid request body', status: 400 };
      }

      const mode = body.mode;
      const locationValue = body.location;
      const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath : undefined;
      const skillName = typeof body.skillName === 'string' ? body.skillName : undefined;
      const description = typeof body.description === 'string' ? body.description : undefined;
      const group = typeof body.group === 'string' ? body.group : undefined;
      const argumentHint = typeof body.argumentHint === 'string' ? body.argumentHint : undefined;
      const projectPathParam = typeof body.projectPath === 'string' ? body.projectPath : undefined;
      const cliType = typeof body.cliType === 'string' ? body.cliType : 'claude';

      // Validate mode
      if (mode !== 'upload' && mode !== 'generate') {
        return { success: false, message: 'Mode is required and must be "upload" or "generate"', status: 400 };
      }

      // Validate location
      if (locationValue !== 'project' && locationValue !== 'user') {
        return { success: false, message: 'Location is required (project or user)', status: 400 };
      }

      const location: CommandLocation = locationValue;
      const projectPath = projectPathParam || initialPath;

      // Validate project path for security
      let validatedProjectPath = projectPath;
      if (location === 'project') {
        try {
          validatedProjectPath = await validateAllowedPath(projectPath, { mustExist: true, allowedDirectories: [initialPath] });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status = message.includes('Access denied') ? 403 : 400;
          console.error(`[Commands] Project path validation failed: ${message}`);
          return { success: false, message: status === 403 ? 'Access denied' : 'Invalid path', status };
        }
      }

      if (mode === 'upload') {
        // Upload mode: copy existing command file
        if (!sourcePath) {
          return { success: false, message: 'Source path is required for upload mode', status: 400 };
        }

        // Validate source path for security
        let validatedSourcePath: string;
        try {
          validatedSourcePath = await validateAllowedPath(sourcePath, { mustExist: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status = message.includes('Access denied') ? 403 : 400;
          console.error(`[Commands] Source path validation failed: ${message}`);
          return { success: false, message: status === 403 ? 'Access denied' : 'Invalid source path', status };
        }

        return await uploadCommand(
          validatedSourcePath,
          group || '',
          location,
          validatedProjectPath
        );
      } else if (mode === 'generate') {
        // Generate mode: use CLI to generate command
        if (!skillName) {
          return { success: false, message: 'Skill name is required for generate mode', status: 400 };
        }
        if (!description) {
          return { success: false, message: 'Description is required for generate mode', status: 400 };
        }

        // Validate skill name for security
        if (skillName.includes('..') || skillName.includes('/') || skillName.includes('\\')) {
          return { success: false, message: 'Invalid skill name - path characters not allowed', status: 400 };
        }

        return await generateCommandViaCLI({
          commandName: skillName,
          description,
          location,
          projectPath: validatedProjectPath,
          group,
          argumentHint,
          broadcastToClients: ctx.broadcastToClients,
          cliType
        });
      }

      // This should never be reached due to mode validation above
      return { success: false, message: 'Invalid mode', status: 400 };
    });
    return true;
  }

  return false;
}
