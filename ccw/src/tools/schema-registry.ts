/**
 * Schema Registry - Loads and caches JSON schemas from the schemas directory.
 * Provides schema metadata extraction for json-builder tool.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface SchemaEntry {
  id: string;
  title: string;
  file: string;
  format: 'json' | 'jsonl' | 'ndjson';
  /** Top-level array field names (for append operations) */
  arrayFields: string[];
}

export interface SchemaInfo {
  id: string;
  title: string;
  description: string;
  requiredFields: string[];
  optionalFields: string[];
  arrayFields: string[];
  enumFields: Record<string, string[]>;
  format: string;
}

interface JsonSchema {
  title?: string;
  description?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  [key: string]: unknown;
}

interface JsonSchemaProperty {
  type?: string | string[];
  enum?: (string | number)[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  description?: string;
  default?: unknown;
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  additionalProperties?: boolean | JsonSchemaProperty;
  [key: string]: unknown;
}

// Schema definitions — maps short IDs to schema files
const SCHEMA_DEFS: Record<string, Omit<SchemaEntry, 'id' | 'title'>> = {
  'explore':      { file: 'explore-json-schema.json',              arrayFields: ['relevant_files', 'clarification_needs'], format: 'json' },
  'diagnosis':    { file: 'diagnosis-json-schema.json',            arrayFields: ['affected_files', 'reproduction_steps', 'fix_hints', 'clarification_needs'], format: 'json' },
  'finding':      { file: 'discovery-finding-schema.json',         arrayFields: ['findings', 'cross_references'], format: 'json' },
  'plan':         { file: 'plan-overview-base-schema.json',        arrayFields: ['tasks', 'design_decisions', 'focus_paths'], format: 'json' },
  'plan-fix':     { file: 'plan-overview-fix-schema.json',         arrayFields: ['tasks', 'focus_paths'], format: 'json' },
  'plan-legacy':  { file: 'plan-json-schema.json',                 arrayFields: ['tasks', 'design_decisions', 'focus_paths'], format: 'json' },
  'fix-legacy':   { file: 'fix-plan-json-schema.json',             arrayFields: ['tasks', 'focus_paths'], format: 'json' },
  'tech':         { file: 'project-tech-schema.json',              arrayFields: [], format: 'json' },
  'guidelines':   { file: 'project-guidelines-schema.json',        arrayFields: [], format: 'json' },
  'issue':        { file: 'issues-jsonl-schema.json',              arrayFields: [], format: 'jsonl' },
  'queue':        { file: 'queue-schema.json',                     arrayFields: ['entries'], format: 'json' },
  'review-dim':   { file: 'review-dimension-results-schema.json',  arrayFields: ['results'], format: 'json' },
  'review-deep':  { file: 'review-deep-dive-results-schema.json',  arrayFields: ['results'], format: 'json' },
  'debug-log':    { file: 'debug-log-json-schema.json',            arrayFields: [], format: 'ndjson' },
  'discussion':   { file: 'multi-cli-discussion-schema.json',      arrayFields: ['turns'], format: 'json' },
  'task':         { file: 'task-schema.json',                      arrayFields: ['files', 'implementation', 'risks', 'pre_analysis', 'artifacts'], format: 'json' },
  'solution':     { file: 'solution-schema.json',                  arrayFields: ['tasks'], format: 'json' },
  'verify':       { file: 'verify-json-schema.json',               arrayFields: [], format: 'json' },
  'discovery-state': { file: 'discovery-state-schema.json',        arrayFields: [], format: 'json' },
  'conflict':     { file: 'conflict-resolution-schema.json',       arrayFields: [], format: 'json' },
  'registry':     { file: 'registry-schema.json',                  arrayFields: [], format: 'json' },
  'team-tasks':   { file: 'team-tasks-schema.json',                arrayFields: [], format: 'json' },
  'plan-verify':  { file: 'plan-verify-agent-schema.json',         arrayFields: [], format: 'json' },
};

// Cache loaded schemas
const schemaCache = new Map<string, JsonSchema>();

/**
 * Resolve the schemas directory path
 */
function getSchemasDir(): string {
  // Try environment variable first
  if (process.env.CCW_HOME) {
    return resolve(process.env.CCW_HOME, 'workflows', 'cli-templates', 'schemas');
  }
  // Try home directory
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const ccwDir = resolve(home, '.ccw', 'workflows', 'cli-templates', 'schemas');
  if (existsSync(ccwDir)) return ccwDir;
  // Fallback to relative from this file
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, '..', '..', '..', '.ccw', 'workflows', 'cli-templates', 'schemas');
}

/**
 * Load a raw JSON schema by ID
 */
export function loadSchema(schemaId: string): JsonSchema {
  const cached = schemaCache.get(schemaId);
  if (cached) return cached;

  const def = SCHEMA_DEFS[schemaId];
  if (!def) {
    throw new Error(`Unknown schema: "${schemaId}". Available: ${Object.keys(SCHEMA_DEFS).join(', ')}`);
  }

  const schemasDir = getSchemasDir();
  const filePath = resolve(schemasDir, def.file);
  if (!existsSync(filePath)) {
    throw new Error(`Schema file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const schema = JSON.parse(raw) as JsonSchema;
  schemaCache.set(schemaId, schema);
  return schema;
}

/**
 * Get schema entry metadata (without loading full schema)
 */
export function getSchemaEntry(schemaId: string): SchemaEntry {
  const def = SCHEMA_DEFS[schemaId];
  if (!def) {
    throw new Error(`Unknown schema: "${schemaId}". Available: ${Object.keys(SCHEMA_DEFS).join(', ')}`);
  }
  const schema = loadSchema(schemaId);
  return { id: schemaId, title: schema.title || schemaId, ...def };
}

/**
 * Get schema info summary (for agent consumption — replaces reading full schema)
 */
export function getSchemaInfo(schemaId: string): SchemaInfo {
  const schema = loadSchema(schemaId);
  const def = SCHEMA_DEFS[schemaId];
  const props = schema.properties || {};
  const required = schema.required || [];
  const allFields = Object.keys(props).filter(k => !k.startsWith('_comment'));
  const optional = allFields.filter(f => !required.includes(f));

  const enumFields: Record<string, string[]> = {};
  for (const [name, prop] of Object.entries(props)) {
    if (name.startsWith('_comment')) continue;
    if (prop.enum) {
      enumFields[name] = prop.enum.map(String);
    }
    // Check nested enum in properties
    if (prop.properties) {
      for (const [sub, subProp] of Object.entries(prop.properties)) {
        if (subProp.enum) {
          enumFields[`${name}.${sub}`] = subProp.enum.map(String);
        }
      }
    }
    // Check items enum for array fields
    if (prop.items && typeof prop.items === 'object' && prop.items.properties) {
      for (const [sub, subProp] of Object.entries(prop.items.properties)) {
        if (subProp.enum) {
          enumFields[`${name}[].${sub}`] = subProp.enum.map(String);
        }
      }
    }
  }

  return {
    id: schemaId,
    title: schema.title || schemaId,
    description: schema.description || '',
    requiredFields: required,
    optionalFields: optional,
    arrayFields: def.arrayFields,
    enumFields,
    format: def.format,
  };
}

/**
 * List all available schema IDs
 */
export function listSchemas(): string[] {
  return Object.keys(SCHEMA_DEFS);
}

// Exports for validation
export type { JsonSchema, JsonSchemaProperty };
