/**
 * JSON Builder Tool - Schema-aware structured JSON construction/validation.
 *
 * Commands:
 *   init     — Create empty schema-compliant JSON skeleton
 *   set      — Set/append fields with instant validation
 *   validate — Full schema + semantic validation
 *   merge    — Merge multiple same-schema JSONs
 *   info     — Get schema summary (replaces agent reading raw schema)
 *
 * Replaces agent hand-writing JSON + self-validation with tool-assisted
 * incremental build + automatic validation.
 */

import { z } from 'zod';
import type { ToolSchema, ToolResult } from '../types/tool.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { validatePath } from '../utils/path-validator.js';
import {
  loadSchema,
  getSchemaInfo,
  listSchemas,
  type JsonSchema,
  type JsonSchemaProperty,
} from './schema-registry.js';

// ─── Params ──────────────────────────────────────────────────

const OpSchema = z.object({
  path: z.string().min(1),
  value: z.unknown(),
});

const ParamsSchema = z.object({
  cmd: z.enum(['init', 'set', 'validate', 'merge', 'info']),
  schema: z.string().optional(),
  target: z.string().optional(),
  output: z.string().optional(),
  ops: z.array(OpSchema).optional(),
  sources: z.array(z.string()).optional(),
  strategy: z.string().optional(),
});

type Params = z.infer<typeof ParamsSchema>;

// ─── Tool Schema ─────────────────────────────────────────────

export const schema: ToolSchema = {
  name: 'json_builder',
  description: `Schema-aware JSON builder with validation. Commands:
  init: Create skeleton from schema. Params: schema (string), output (string)
  set: Set/append fields. Params: target (string), ops [{path, value}...]
  validate: Full validation. Params: target (string), schema? (string)
  merge: Merge JSONs. Params: sources (string[]), output (string), strategy? (string)
  info: Schema summary. Params: schema (string)`,
  inputSchema: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: 'Command: init|set|validate|merge|info' },
      schema: { type: 'string', description: 'Schema ID (e.g. explore, task, diagnosis)' },
      target: { type: 'string', description: 'Target JSON file path' },
      output: { type: 'string', description: 'Output file path' },
      ops: {
        type: 'array',
        description: 'Set operations: [{path: "field.sub" or "arr[+]", value: ...}]',
      },
      sources: { type: 'array', description: 'Source files for merge' },
      strategy: { type: 'string', description: 'Merge strategy: dedup_by_path (default)' },
    },
    required: ['cmd'],
  },
};

// ─── Handler ─────────────────────────────────────────────────

export async function handler(params: Record<string, unknown>): Promise<ToolResult> {
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: `Invalid params: ${parsed.error.message}` };
  }

  const p = parsed.data;
  try {
    switch (p.cmd) {
      case 'init':    return await cmdInit(p);
      case 'set':     return await cmdSet(p);
      case 'validate':return await cmdValidate(p);
      case 'merge':   return await cmdMerge(p);
      case 'info':    return cmdInfo(p);
      default:
        return { success: false, error: `Unknown command: ${p.cmd}` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── init ────────────────────────────────────────────────────

async function cmdInit(p: Params): Promise<ToolResult> {
  if (!p.schema) return { success: false, error: 'schema is required for init' };
  if (!p.output) return { success: false, error: 'output is required for init' };

  const jsonSchema = loadSchema(p.schema);
  const skeleton = buildSkeleton(jsonSchema);
  const outputPath = await validatePath(p.output);
  ensureDir(outputPath);
  const content = JSON.stringify(skeleton, null, 2);
  writeFileSync(outputPath, content, 'utf-8');

  const info = getSchemaInfo(p.schema);
  return {
    success: true,
    result: {
      path: outputPath,
      schema: p.schema,
      requiredFields: info.requiredFields,
      arrayFields: info.arrayFields,
      message: `Initialized ${p.schema} skeleton (${info.requiredFields.length} required fields)`,
    },
  };
}

/**
 * Build a JSON skeleton from schema — fills required fields with type-appropriate defaults
 */
function buildSkeleton(schema: JsonSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);

  for (const [name, prop] of Object.entries(props)) {
    if (name.startsWith('_comment') || name.startsWith('$')) continue;
    if (name === 'deprecated' || name === 'deprecated_message' || name === 'migration_guide') continue;
    if (name === '_field_usage_by_producer' || name === '_directory_convention') continue;

    // Only include required fields in skeleton
    if (!required.has(name)) continue;

    result[name] = getDefaultValue(prop);
  }

  return result;
}

function getDefaultValue(prop: JsonSchemaProperty): unknown {
  if (prop.default !== undefined) return prop.default;

  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  switch (type) {
    case 'string':  return '';
    case 'number':
    case 'integer': return 0;
    case 'boolean': return false;
    case 'array':   return [];
    case 'object': {
      if (!prop.properties) return {};
      const obj: Record<string, unknown> = {};
      const reqSet = new Set(prop.required || []);
      for (const [k, v] of Object.entries(prop.properties)) {
        if (reqSet.has(k)) {
          obj[k] = getDefaultValue(v);
        }
      }
      return obj;
    }
    default: return null;
  }
}

// ─── set ─────────────────────────────────────────────────────

async function cmdSet(p: Params): Promise<ToolResult> {
  if (!p.target) return { success: false, error: 'target is required for set' };
  if (!p.ops || p.ops.length === 0) return { success: false, error: 'ops is required for set' };

  const targetPath = await validatePath(p.target);
  if (!existsSync(targetPath)) {
    return { success: false, error: `Target file not found: ${targetPath}` };
  }

  const raw = readFileSync(targetPath, 'utf-8');
  const doc = JSON.parse(raw) as Record<string, unknown>;

  // Detect schema from doc._metadata?.source or from file name
  const schemaId = p.schema || detectSchema(doc, targetPath);

  const errors: string[] = [];
  const warnings: string[] = [];
  let applied = 0;

  for (const op of p.ops) {
    const result = applyOp(doc, op.path, op.value, schemaId);
    if (result.error) {
      errors.push(`${op.path}: ${result.error}`);
    } else {
      applied++;
      if (result.warnings) warnings.push(...result.warnings);
    }
  }

  if (errors.length > 0 && applied === 0) {
    return { success: false, error: `All ops failed: ${errors.join('; ')}` };
  }

  // Write back
  writeFileSync(targetPath, JSON.stringify(doc, null, 2), 'utf-8');

  return {
    success: true,
    result: { applied, errors, warnings },
  };
}

interface OpResult {
  error?: string;
  warnings?: string[];
}

function applyOp(doc: Record<string, unknown>, path: string, value: unknown, schemaId?: string): OpResult {
  const warnings: string[] = [];

  // Handle "auto" values
  if (value === 'auto') {
    if (path.endsWith('timestamp')) {
      value = new Date().toISOString();
    }
  }

  // Parse path: "field.sub", "arr[+]", "arr[0]", "arr[?key=val]"
  const segments = parsePath(path);
  if (!segments || segments.length === 0) {
    return { error: 'Invalid path syntax' };
  }

  // Validate value against schema if schema is known
  if (schemaId) {
    const validationResult = validateFieldValue(schemaId, path, value);
    if (validationResult.error) return { error: validationResult.error };
    if (validationResult.warnings) warnings.push(...validationResult.warnings);
  }

  // Navigate to parent and set
  let current: unknown = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg.type === 'key') {
      if (typeof current !== 'object' || current === null) {
        return { error: `Cannot navigate into non-object at "${seg.value}"` };
      }
      const obj = current as Record<string, unknown>;
      if (obj[seg.value] === undefined) {
        // Auto-create intermediate objects/arrays
        const nextSeg = segments[i + 1];
        obj[seg.value] = nextSeg.type === 'append' || nextSeg.type === 'index' ? [] : {};
      }
      current = obj[seg.value];
    } else if (seg.type === 'index') {
      if (!Array.isArray(current)) return { error: `Not an array at index ${seg.value}` };
      current = current[Number(seg.value)];
    }
  }

  // Apply final segment
  const last = segments[segments.length - 1];
  if (last.type === 'key') {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return { error: `Cannot set key "${last.value}" on non-object` };
    }
    (current as Record<string, unknown>)[last.value] = value;
  } else if (last.type === 'append') {
    if (!Array.isArray(current)) {
      return { error: `Cannot append to non-array` };
    }
    current.push(value);
  } else if (last.type === 'index') {
    if (!Array.isArray(current)) {
      return { error: `Cannot index into non-array` };
    }
    current[Number(last.value)] = value;
  } else if (last.type === 'query') {
    if (!Array.isArray(current)) {
      return { error: `Cannot query non-array` };
    }
    const { key, val } = last as QuerySegment;
    const idx = current.findIndex((item: unknown) =>
      typeof item === 'object' && item !== null && (item as Record<string, unknown>)[key] === val
    );
    if (idx === -1) return { error: `No item found where ${key}=${val}` };
    current[idx] = value;
  }

  return { warnings: warnings.length > 0 ? warnings : undefined };
}

interface KeySegment { type: 'key'; value: string; }
interface IndexSegment { type: 'index'; value: string; }
interface AppendSegment { type: 'append'; value: string; }
interface QuerySegment { type: 'query'; value: string; key: string; val: string; }
type PathSegment = KeySegment | IndexSegment | AppendSegment | QuerySegment;

function parsePath(path: string): PathSegment[] | null {
  const segments: PathSegment[] = [];
  // Split by '.' but respect brackets
  const parts = path.split(/\.(?![^\[]*\])/);

  for (const part of parts) {
    const bracketMatch = part.match(/^(\w+)\[(.+)\]$/);
    if (bracketMatch) {
      const [, field, bracket] = bracketMatch;
      segments.push({ type: 'key', value: field });

      if (bracket === '+') {
        segments.push({ type: 'append', value: '+' });
      } else if (/^\d+$/.test(bracket)) {
        segments.push({ type: 'index', value: bracket });
      } else if (bracket.includes('=')) {
        const [key, val] = bracket.split('=', 2);
        segments.push({ type: 'query', value: bracket, key: key.replace('?', ''), val } as QuerySegment);
      }
    } else {
      segments.push({ type: 'key', value: part });
    }
  }

  return segments.length > 0 ? segments : null;
}

// ─── validate ────────────────────────────────────────────────

async function cmdValidate(p: Params): Promise<ToolResult> {
  if (!p.target) return { success: false, error: 'target is required for validate' };

  const targetPath = await validatePath(p.target);
  if (!existsSync(targetPath)) {
    return { success: false, error: `Target file not found: ${targetPath}` };
  }

  const raw = readFileSync(targetPath, 'utf-8');
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { success: false, error: 'Invalid JSON in target file' };
  }

  const schemaId = p.schema || detectSchema(doc, targetPath);
  if (!schemaId) {
    return { success: false, error: 'Cannot detect schema. Provide schema param.' };
  }

  const jsonSchema = loadSchema(schemaId);
  const errors: string[] = [];
  const warnings: string[] = [];

  // Layer 1: JSON Schema structural validation
  validateObject(doc, jsonSchema, '', errors, warnings);

  // Layer 2: Semantic quality validation
  validateSemantics(doc, schemaId, errors, warnings);

  const stats = {
    fields: Object.keys(doc).filter(k => !k.startsWith('_comment')).length,
    schema: schemaId,
    arrayItems: countArrayItems(doc, jsonSchema),
  };

  return {
    success: true,
    result: {
      valid: errors.length === 0,
      errors,
      warnings,
      stats,
    },
  };
}

function validateObject(
  obj: Record<string, unknown>,
  schema: JsonSchema | JsonSchemaProperty,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  const props = schema.properties || {};
  const required = new Set(schema.required || []);

  // Check required fields
  for (const req of required) {
    const val = obj[req];
    if (val === undefined || val === null) {
      errors.push(`${prefix}${req}: required field missing`);
    } else if (typeof val === 'string' && val === '' && req !== 'error_message') {
      errors.push(`${prefix}${req}: required field is empty string`);
    } else if (Array.isArray(val) && val.length === 0) {
      const propSchema = props[req];
      if (propSchema?.minItems && propSchema.minItems > 0) {
        errors.push(`${prefix}${req}: array requires at least ${propSchema.minItems} items`);
      }
    }
  }

  // Validate each field
  for (const [name, value] of Object.entries(obj)) {
    if (name.startsWith('_comment') || name.startsWith('$')) continue;
    const propSchema = props[name];
    if (!propSchema) continue; // allow additional props

    validateValue(value, propSchema, `${prefix}${name}`, errors, warnings);
  }
}

function validateValue(
  value: unknown,
  propSchema: JsonSchemaProperty,
  path: string,
  errors: string[],
  warnings: string[],
): void {
  if (value === null || value === undefined) return;

  const expectedType = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type];

  // Type check
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (propSchema.type && !expectedType.includes(actualType) && !expectedType.includes('null')) {
    // integer is typeof 'number'
    if (!(actualType === 'number' && expectedType.includes('integer'))) {
      errors.push(`${path}: expected ${expectedType.join('|')}, got ${actualType}`);
      return;
    }
  }

  // Enum check
  if (propSchema.enum && !propSchema.enum.includes(value as string | number)) {
    errors.push(`${path}: value "${value}" not in enum [${propSchema.enum.join(', ')}]`);
  }

  // Const check
  if (propSchema.const !== undefined && value !== propSchema.const) {
    errors.push(`${path}: expected const "${propSchema.const}", got "${value}"`);
  }

  // String constraints
  if (typeof value === 'string') {
    if (propSchema.minLength && value.length < propSchema.minLength) {
      errors.push(`${path}: string length ${value.length} < minLength ${propSchema.minLength}`);
    }
    if (propSchema.maxLength && value.length > propSchema.maxLength) {
      errors.push(`${path}: string length ${value.length} > maxLength ${propSchema.maxLength}`);
    }
    if (propSchema.pattern) {
      try {
        if (!new RegExp(propSchema.pattern).test(value)) {
          errors.push(`${path}: does not match pattern "${propSchema.pattern}"`);
        }
      } catch { /* skip invalid regex in schema */ }
    }
  }

  // Number constraints
  if (typeof value === 'number') {
    if (propSchema.minimum !== undefined && value < propSchema.minimum) {
      errors.push(`${path}: ${value} < minimum ${propSchema.minimum}`);
    }
    if (propSchema.maximum !== undefined && value > propSchema.maximum) {
      errors.push(`${path}: ${value} > maximum ${propSchema.maximum}`);
    }
  }

  // Array constraints
  if (Array.isArray(value)) {
    if (propSchema.minItems && value.length < propSchema.minItems) {
      errors.push(`${path}: array has ${value.length} items, needs >= ${propSchema.minItems}`);
    }
    if (propSchema.maxItems && value.length > propSchema.maxItems) {
      warnings.push(`${path}: array has ${value.length} items, max recommended ${propSchema.maxItems}`);
    }
    // Validate each item
    if (propSchema.items && typeof propSchema.items === 'object') {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (propSchema.items.type === 'object' && typeof item === 'object' && item !== null) {
          validateObject(item as Record<string, unknown>, propSchema.items, `${path}[${i}].`, errors, warnings);
        } else {
          validateValue(item, propSchema.items, `${path}[${i}]`, errors, warnings);
        }
      }
    }
  }

  // Object: recurse
  if (typeof value === 'object' && !Array.isArray(value) && value !== null && propSchema.properties) {
    validateObject(value as Record<string, unknown>, propSchema, `${path}.`, errors, warnings);
  }
}

// ─── Semantic Validation (Layer 2) ───────────────────────────

function validateSemantics(doc: Record<string, unknown>, schemaId: string, errors: string[], warnings: string[]): void {
  // explore + diagnosis: file list quality
  if (schemaId === 'explore') {
    validateFileList(doc, 'relevant_files', errors, warnings);
  } else if (schemaId === 'diagnosis') {
    validateFileList(doc, 'affected_files', errors, warnings);
  }

  // task: circular dependency check
  if (schemaId === 'task' || schemaId === 'solution' || schemaId === 'plan' || schemaId === 'plan-legacy') {
    validateNoCyclicDeps(doc, errors);
  }
}

const GENERIC_PHRASES = [
  'related to', 'relevant file', 'relevant to', 'important file',
  'related file', 'useful for', 'needed for',
];

function validateFileList(doc: Record<string, unknown>, field: string, errors: string[], warnings: string[]): void {
  const files = doc[field];
  if (!Array.isArray(files)) return;

  const allManual = files.length > 0 && files.every((f: Record<string, unknown>) => f.discovery_source === 'manual');
  if (allManual && files.length > 3) {
    warnings.push(`${field}: all ${files.length} files discovered via "manual" — consider using bash-scan or cli-analysis`);
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i] as Record<string, unknown>;
    const rationale = (f.rationale as string) || '';
    const relevance = (f.relevance as number) || 0;

    // Check generic rationale
    const lower = rationale.toLowerCase();
    for (const phrase of GENERIC_PHRASES) {
      if (lower === phrase || (lower.length < 25 && lower.includes(phrase))) {
        warnings.push(`${field}[${i}].rationale: too generic ("${rationale}") — be more specific`);
        break;
      }
    }

    // High relevance files need key_code and topic_relation
    if (relevance >= 0.7) {
      if (!f.key_code || (Array.isArray(f.key_code) && (f.key_code as unknown[]).length === 0)) {
        warnings.push(`${field}[${i}]: relevance=${relevance} but missing key_code (recommended for >= 0.7)`);
      }
      if (!f.topic_relation) {
        warnings.push(`${field}[${i}]: relevance=${relevance} but missing topic_relation (recommended for >= 0.7)`);
      }
    }
  }
}

function validateNoCyclicDeps(doc: Record<string, unknown>, errors: string[]): void {
  const tasks = (doc.tasks as Array<Record<string, unknown>>) || [];
  if (tasks.length === 0) return;

  // Build adjacency
  const deps = new Map<string, string[]>();
  for (const t of tasks) {
    const id = t.id as string;
    if (!id) continue;
    deps.set(id, (t.depends_on as string[]) || []);
  }

  // DFS cycle check
  const visited = new Set<string>();
  const stack = new Set<string>();

  function hasCycle(node: string): boolean {
    if (stack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    for (const dep of deps.get(node) || []) {
      if (hasCycle(dep)) return true;
    }
    stack.delete(node);
    return false;
  }

  for (const id of deps.keys()) {
    if (hasCycle(id)) {
      errors.push(`tasks: circular dependency detected involving "${id}"`);
      break;
    }
  }
}

function countArrayItems(doc: Record<string, unknown>, schema: JsonSchema): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, value] of Object.entries(doc)) {
    if (Array.isArray(value)) {
      counts[name] = value.length;
    }
  }
  return counts;
}

// ─── Field-level validation (for set) ────────────────────────

interface FieldValidation {
  error?: string;
  warnings?: string[];
}

function validateFieldValue(schemaId: string, fieldPath: string, value: unknown): FieldValidation {
  const warnings: string[] = [];
  let jsonSchema: JsonSchema;
  try {
    jsonSchema = loadSchema(schemaId);
  } catch {
    return {}; // Skip validation if schema not found
  }

  // Resolve the property schema for this path
  const propSchema = resolvePropertySchema(jsonSchema, fieldPath);
  if (!propSchema) return {}; // Unknown field, allow it

  // For array appends, validate the item against items schema
  if (fieldPath.includes('[+]') || fieldPath.match(/\[\d+\]/)) {
    const itemSchema = propSchema.items;
    if (itemSchema && typeof value === 'object' && value !== null) {
      const errors: string[] = [];
      if (itemSchema.type === 'object') {
        validateObject(value as Record<string, unknown>, itemSchema, '', errors, warnings);
      }
      if (errors.length > 0) return { error: errors.join('; ') };
    }
    return { warnings: warnings.length > 0 ? warnings : undefined };
  }

  // For direct field set, validate the value
  const errors: string[] = [];
  validateValue(value, propSchema, fieldPath, errors, warnings);
  if (errors.length > 0) return { error: errors.join('; ') };
  return { warnings: warnings.length > 0 ? warnings : undefined };
}

function resolvePropertySchema(schema: JsonSchema, fieldPath: string): JsonSchemaProperty | null {
  const cleanPath = fieldPath.replace(/\[\+\]|\[\d+\]|\[\?[^\]]+\]/g, '');
  const parts = cleanPath.split('.');
  let current: JsonSchemaProperty | undefined = schema as unknown as JsonSchemaProperty;

  for (const part of parts) {
    if (!part) continue;
    if (current?.properties?.[part]) {
      current = current.properties[part];
    } else if (current?.items?.properties?.[part]) {
      current = current.items.properties[part];
    } else {
      return null;
    }
  }

  return current || null;
}

// ─── merge ───────────────────────────────────────────────────

async function cmdMerge(p: Params): Promise<ToolResult> {
  if (!p.sources || p.sources.length < 2) {
    return { success: false, error: 'merge requires at least 2 sources' };
  }
  if (!p.output) return { success: false, error: 'output is required for merge' };

  const docs: Record<string, unknown>[] = [];
  for (const src of p.sources) {
    const srcPath = await validatePath(src);
    if (!existsSync(srcPath)) {
      return { success: false, error: `Source not found: ${srcPath}` };
    }
    docs.push(JSON.parse(readFileSync(srcPath, 'utf-8')));
  }

  const schemaId = p.schema || detectSchema(docs[0], p.sources[0]);
  const jsonSchema = schemaId ? loadSchema(schemaId) : null;
  const strategy = p.strategy || 'dedup_by_path';

  const merged = mergeDocuments(docs, jsonSchema, strategy);

  const outputPath = await validatePath(p.output);
  ensureDir(outputPath);
  writeFileSync(outputPath, JSON.stringify(merged, null, 2), 'utf-8');

  return {
    success: true,
    result: {
      path: outputPath,
      sourceCount: docs.length,
      strategy,
      message: `Merged ${docs.length} documents`,
    },
  };
}

function mergeDocuments(
  docs: Record<string, unknown>[],
  schema: JsonSchema | null,
  strategy: string,
): Record<string, unknown> {
  const base = structuredClone(docs[0]);
  const props = schema?.properties || {};

  for (let i = 1; i < docs.length; i++) {
    const other = docs[i];
    for (const [key, value] of Object.entries(other)) {
      if (key.startsWith('_') || key.startsWith('$')) continue;

      const existing = base[key];
      const propSchema = props[key];
      const propType = propSchema?.type;

      if (Array.isArray(existing) && Array.isArray(value)) {
        // Array merge with dedup
        if (strategy === 'dedup_by_path') {
          base[key] = deduplicateArrays(existing, value);
        } else {
          base[key] = [...existing, ...value];
        }
      } else if (typeof existing === 'string' && typeof value === 'string' && propType === 'string') {
        // Text fields: concatenate if both non-empty
        if (existing && value && existing !== value) {
          base[key] = `${existing}\n\n${value}`;
        } else if (!existing && value) {
          base[key] = value;
        }
      } else if (existing === undefined || existing === null || existing === '' || existing === 0) {
        // Fill empty values
        base[key] = value;
      }
    }
  }

  // Update metadata
  if (base._metadata && typeof base._metadata === 'object') {
    (base._metadata as Record<string, unknown>).timestamp = new Date().toISOString();
    (base._metadata as Record<string, unknown>).merged_from = docs.length;
  }

  return base;
}

function deduplicateArrays(a: unknown[], b: unknown[]): unknown[] {
  const result = [...a];
  const existingPaths = new Set(
    a.filter(item => typeof item === 'object' && item !== null)
      .map(item => (item as Record<string, unknown>).path as string)
      .filter(Boolean)
  );

  for (const item of b) {
    if (typeof item === 'object' && item !== null) {
      const path = (item as Record<string, unknown>).path as string;
      if (path && existingPaths.has(path)) {
        // Dedup: keep the one with higher relevance
        const existingIdx = result.findIndex(
          e => typeof e === 'object' && e !== null && (e as Record<string, unknown>).path === path
        );
        if (existingIdx !== -1) {
          const existingRel = ((result[existingIdx] as Record<string, unknown>).relevance as number) || 0;
          const newRel = ((item as Record<string, unknown>).relevance as number) || 0;
          if (newRel > existingRel) {
            result[existingIdx] = item;
          }
        }
      } else {
        result.push(item);
        if (path) existingPaths.add(path);
      }
    } else {
      // Primitive: dedup by value
      if (!result.includes(item)) {
        result.push(item);
      }
    }
  }

  return result;
}

// ─── info ────────────────────────────────────────────────────

function cmdInfo(p: Params): ToolResult {
  if (!p.schema) {
    // List all schemas
    const schemas = listSchemas();
    const summaries = schemas.map(id => {
      try {
        const info = getSchemaInfo(id);
        return { id, title: info.title, required: info.requiredFields.length, format: info.format };
      } catch {
        return { id, title: '(load error)', required: 0, format: 'json' };
      }
    });
    return { success: true, result: { schemas: summaries } };
  }

  const info = getSchemaInfo(p.schema);
  return { success: true, result: info };
}

// ─── Utilities ───────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function detectSchema(doc: Record<string, unknown>, filePath: string): string | undefined {
  // Try _metadata.source
  const meta = doc._metadata as Record<string, unknown> | undefined;
  if (meta?.source === 'cli-explore-agent') {
    if (doc.symptom || doc.root_cause) return 'diagnosis';
    return 'explore';
  }

  // Try file name patterns
  const lower = (filePath || '').toLowerCase();
  if (lower.includes('exploration') || lower.includes('explore')) return 'explore';
  if (lower.includes('diagnosis') || lower.includes('diagnos')) return 'diagnosis';
  if (lower.includes('finding') || lower.includes('discovery')) return 'finding';
  if (lower.includes('fix-plan') || lower.includes('fixplan')) return 'fix-legacy';
  if (lower.includes('plan')) return 'plan';
  if (lower.includes('task') || lower.includes('impl-')) return 'task';
  if (lower.includes('solution')) return 'solution';
  if (lower.includes('queue')) return 'queue';
  if (lower.includes('review-dim')) return 'review-dim';
  if (lower.includes('review-deep')) return 'review-deep';

  return undefined;
}
