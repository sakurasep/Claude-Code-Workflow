#!/usr/bin/env node
/**
 * CCW MCP Server Executable
 * Entry point for running CCW tools as an MCP server
 */

// IMPORTANT:
// MCP stdio servers must not write arbitrary text to stdout.
// stdout is reserved for JSON-RPC protocol messages.
// Redirect common console output to stderr to avoid breaking handshake.
const toStderr = (...args) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.dir = toStderr;

try {
  await import('../dist/mcp-server/index.js');
} catch (err) {
  console.error('[ccw-mcp] Failed to start MCP server:', err);
  process.exit(1);
}
