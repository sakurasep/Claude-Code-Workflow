import * as http from 'http';
import { URL } from 'url';
import { getCoreMemoryStore } from '../core-memory-store.js';
import type { CoreMemory, SessionCluster, ClusterMember, ClusterRelation } from '../core-memory-store.js';
import { getEmbeddingStatus, generateEmbeddings } from '../memory-embedder-bridge.js';
import { MemoryJobScheduler } from '../memory-job-scheduler.js';
import type { JobStatus } from '../memory-job-scheduler.js';
import { StoragePaths } from '../../config/storage-paths.js';
import { join } from 'path';
import { getDefaultTool } from '../../tools/claude-cli-tools.js';

// ========================================
// Error Handling Utilities
// ========================================

/**
 * Sanitize error message for client response
 * Logs full error server-side, returns user-friendly message to client
 */
function sanitizeErrorMessage(error: unknown, context: string): string {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Log full error for debugging (server-side only)
  if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
    console.error(`[CoreMemoryRoutes] ${context}:`, error);
  }

  // Map common internal errors to user-friendly messages
  const lowerMessage = errorMessage.toLowerCase();

  if (lowerMessage.includes('enoent') || lowerMessage.includes('no such file')) {
    return 'Resource not found';
  }
  if (lowerMessage.includes('eacces') || lowerMessage.includes('permission denied')) {
    return 'Access denied';
  }
  if (lowerMessage.includes('sqlite') || lowerMessage.includes('database')) {
    return 'Database operation failed';
  }
  if (lowerMessage.includes('json') || lowerMessage.includes('parse')) {
    return 'Invalid data format';
  }

  // Return generic message for unexpected errors (don't expose internals)
  return 'An unexpected error occurred';
}

/**
 * Write error response with sanitized message
 */
function writeErrorResponse(
  res: http.ServerResponse,
  statusCode: number,
  message: string
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Route context interface
 */
interface RouteContext {
  pathname: string;
  url: URL;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  initialPath: string;
  handlePostRequest: (req: http.IncomingMessage, res: http.ServerResponse, handler: (body: any) => Promise<any>) => void;
  broadcastToClients: (data: any) => void;
}

/**
 * Handle Core Memory API routes
 * @returns true if route was handled, false otherwise
 */
export async function handleCoreMemoryRoutes(ctx: RouteContext): Promise<boolean> {
  const { pathname, url, req, res, initialPath, handlePostRequest, broadcastToClients } = ctx;

  // API: Core Memory - Get all memories
  if (pathname === '/api/core-memory/memories' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const archivedParam = url.searchParams.get('archived');
    // undefined means fetch all, 'true' means only archived, 'false' means only non-archived
    const archived = archivedParam === null ? undefined : archivedParam === 'true';
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const tagsParam = url.searchParams.get('tags');

    try {
      const store = getCoreMemoryStore(projectPath);

      // Use tag filter if tags query parameter is provided
      let memories;
      if (tagsParam) {
        const tags = tagsParam.split(',').map(t => t.trim()).filter(Boolean);
        memories = tags.length > 0
          ? store.getMemoriesByTags(tags, { archived, limit, offset })
          : store.getMemories({ archived, limit, offset });
      } else {
        memories = store.getMemories({ archived, limit, offset });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, memories }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Core Memory - Get single memory
  if (pathname.startsWith('/api/core-memory/memories/') && req.method === 'GET') {
    const memoryId = pathname.replace('/api/core-memory/memories/', '');
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const store = getCoreMemoryStore(projectPath);
      const memory = store.getMemory(memoryId);

      if (memory) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, memory }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Memory not found' }));
      }
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Core Memory - Create or update memory
  if (pathname === '/api/core-memory/memories' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { content, summary, raw_output, id, archived, metadata, tags, path: projectPath } = body;

      if (!content) {
        return { error: 'content is required', status: 400 };
      }

      const basePath = projectPath || initialPath;

      try {
        const store = getCoreMemoryStore(basePath);
        const memory = store.upsertMemory({
          id,
          content,
          summary,
          raw_output,
          archived,
          metadata: metadata ? JSON.stringify(metadata) : undefined,
          tags
        });

        // Broadcast update event
        broadcastToClients({
          type: 'CORE_MEMORY_UPDATED',
          payload: {
            memory,
            timestamp: new Date().toISOString()
          }
        });

        return {
          success: true,
          memory
        };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Core Memory - Archive memory
  if (pathname.startsWith('/api/core-memory/memories/') && pathname.endsWith('/archive') && req.method === 'POST') {
    const memoryId = pathname.replace('/api/core-memory/memories/', '').replace('/archive', '');
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const store = getCoreMemoryStore(projectPath);
      store.archiveMemory(memoryId);

      // Broadcast update event
      broadcastToClients({
        type: 'CORE_MEMORY_UPDATED',
        payload: {
          memoryId,
          archived: true,
          timestamp: new Date().toISOString()
        }
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Core Memory - Unarchive memory
  if (pathname.startsWith('/api/core-memory/memories/') && pathname.endsWith('/unarchive') && req.method === 'POST') {
    const memoryId = pathname.replace('/api/core-memory/memories/', '').replace('/unarchive', '');
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const store = getCoreMemoryStore(projectPath);
      store.unarchiveMemory(memoryId);

      // Broadcast update event
      broadcastToClients({
        type: 'CORE_MEMORY_UPDATED',
        payload: {
          memoryId,
          archived: false,
          timestamp: new Date().toISOString()
        }
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Core Memory - Delete memory
  if (pathname.startsWith('/api/core-memory/memories/') && req.method === 'DELETE') {
    const memoryId = pathname.replace('/api/core-memory/memories/', '');
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const store = getCoreMemoryStore(projectPath);
      store.deleteMemory(memoryId);

      // Broadcast update event
      broadcastToClients({
        type: 'CORE_MEMORY_UPDATED',
        payload: {
          memoryId,
          deleted: true,
          timestamp: new Date().toISOString()
        }
      });

      res.writeHead(204, { 'Content-Type': 'application/json' });
      res.end();
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Core Memory - Generate summary
  if (pathname.startsWith('/api/core-memory/memories/') && pathname.endsWith('/summary') && req.method === 'POST') {
    const memoryId = pathname.replace('/api/core-memory/memories/', '').replace('/summary', '');

    handlePostRequest(req, res, async (body) => {
      const { tool, path: projectPath } = body;
      const basePath = projectPath || initialPath;
      const resolvedTool = tool || getDefaultTool(basePath);

      try {
        const store = getCoreMemoryStore(basePath);
        const summary = await store.generateSummary(memoryId, resolvedTool);

        // Broadcast update event
        broadcastToClients({
          type: 'CORE_MEMORY_UPDATED',
          payload: {
            memoryId,
            summary,
            timestamp: new Date().toISOString()
          }
        });

        return {
          success: true,
          summary
        };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // ============================================================
  // Memory V2 Pipeline API Endpoints
  // ============================================================

  // API: Trigger batch extraction (fire-and-forget)
  if (pathname === '/api/core-memory/extract' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { maxSessions, path: projectPath } = body;
      const basePath = projectPath || initialPath;

      try {
        const { MemoryExtractionPipeline } = await import('../memory-extraction-pipeline.js');
        const pipeline = new MemoryExtractionPipeline(basePath);

        // Broadcast start event
        broadcastToClients({
          type: 'MEMORY_EXTRACTION_STARTED',
          payload: {
            timestamp: new Date().toISOString(),
            maxSessions: maxSessions || 'default',
          }
        });

        // Fire-and-forget: trigger async, notify on completion
        const batchPromise = pipeline.runBatchExtraction();
        batchPromise.then(() => {
          broadcastToClients({
            type: 'MEMORY_EXTRACTION_COMPLETED',
            payload: { timestamp: new Date().toISOString() }
          });
        }).catch((err: Error) => {
          broadcastToClients({
            type: 'MEMORY_EXTRACTION_FAILED',
            payload: {
              timestamp: new Date().toISOString(),
              error: err.message,
            }
          });
        });

        // Scan eligible sessions to report count
        const eligible = pipeline.scanEligibleSessions();

        return {
          success: true,
          triggered: true,
          eligibleCount: eligible.length,
          message: `Extraction triggered for ${eligible.length} eligible sessions`,
        };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Preview eligible sessions for selective extraction
  if (pathname === '/api/core-memory/extract/preview' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const includeNative = url.searchParams.get('includeNative') === 'true';
    const maxSessionsParam = url.searchParams.get('maxSessions');
    const maxSessions = maxSessionsParam ? parseInt(maxSessionsParam, 10) : undefined;

    // Validate maxSessions parameter
    if (maxSessionsParam && (isNaN(maxSessions as number) || (maxSessions as number) < 1)) {
      writeErrorResponse(res, 400, 'Invalid maxSessions parameter: must be a positive integer');
      return true;
    }

    try {
      const { MemoryExtractionPipeline } = await import('../memory-extraction-pipeline.js');
      const pipeline = new MemoryExtractionPipeline(projectPath);

      const preview = pipeline.previewEligibleSessions({
        includeNative,
        maxSessions,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        sessions: preview.sessions,
        summary: preview.summary,
      }));
    } catch (error: unknown) {
      // Log full error server-side, return sanitized message to client
      writeErrorResponse(res, 500, sanitizeErrorMessage(error, 'extract/preview'));
    }
    return true;
  }

  // API: Selective extraction for specific sessions
  if ((pathname === '/api/core-memory/extract/selected' || pathname === '/api/core-memory/extract/selective') && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const sessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds : body?.session_ids;
      const includeNative = typeof body?.includeNative === 'boolean' ? body.includeNative : body?.include_native;
      const projectPath = body?.path;
      const basePath = projectPath || initialPath;

      // Validate sessionIds - return 400 for invalid input
      if (!Array.isArray(sessionIds)) {
        return { error: 'sessionIds must be an array', status: 400 };
      }
      if (sessionIds.length === 0) {
        return { error: 'sessionIds cannot be empty', status: 400 };
      }
      // Validate each sessionId is a non-empty string
      for (const id of sessionIds) {
        if (typeof id !== 'string' || id.trim() === '') {
          return { error: 'Each sessionId must be a non-empty string', status: 400 };
        }
      }

      try {
        const store = getCoreMemoryStore(basePath);
        const scheduler = new MemoryJobScheduler(store.getDb());

        const { MemoryExtractionPipeline, SessionAccessDeniedError } = await import('../memory-extraction-pipeline.js');
        const pipeline = new MemoryExtractionPipeline(basePath);

        // Get preview to validate sessions (project-scoped)
        const preview = pipeline.previewEligibleSessions({ includeNative });
        const validSessionIds = new Set(preview.sessions.map(s => s.sessionId));

        // Return 404 if no eligible sessions exist at all
        if (validSessionIds.size === 0) {
          return { error: 'No eligible sessions found for extraction', status: 404 };
        }

        const queued: string[] = [];
        const skipped: string[] = [];
        const invalidIds: string[] = [];
        const unauthorizedIds: string[] = [];

        for (const sessionId of sessionIds) {
          // SECURITY: Verify session belongs to this project
          // This double-checks that the sessionId is from the project-scoped preview
          if (!validSessionIds.has(sessionId)) {
            // Check if it's unauthorized (exists but not in this project)
            if (!pipeline.verifySessionBelongsToProject(sessionId)) {
              unauthorizedIds.push(sessionId);
            } else {
              invalidIds.push(sessionId);
            }
            continue;
          }

          // Check if already extracted
          const existingOutput = store.getStage1Output(sessionId);
          if (existingOutput) {
            skipped.push(sessionId);
            continue;
          }

          // Get session info for watermark
          const historyStore = (await import('../../tools/cli-history-store.js')).getHistoryStore(basePath);
          const session = historyStore.getConversation(sessionId);
          if (!session) {
            invalidIds.push(sessionId);
            continue;
          }

          // Enqueue job
          const watermark = Math.floor(new Date(session.updated_at).getTime() / 1000);
          scheduler.enqueueJob('phase1_extraction', sessionId, watermark);
          queued.push(sessionId);
        }

        // Return 409 Conflict if all sessions were already extracted
        if (queued.length === 0 && skipped.length === sessionIds.length) {
          return {
            error: 'All specified sessions have already been extracted',
            status: 409,
            skipped
          };
        }

        // Return 404 if no valid sessions were found (all were invalid or unauthorized)
        if (queued.length === 0 && skipped.length === 0) {
          return { error: 'No valid sessions found among the provided IDs', status: 404 };
        }

        // Generate batch job ID
        const jobId = `batch-${Date.now()}`;

        // Broadcast start event
        broadcastToClients({
          type: 'MEMORY_EXTRACTION_STARTED',
          payload: {
            timestamp: new Date().toISOString(),
            jobId,
            queuedCount: queued.length,
            selective: true,
          }
        });

        // Fire-and-forget: process queued sessions
        // Sessions already validated above, skip auth check for efficiency
        (async () => {
          try {
            for (const sessionId of queued) {
              try {
                await pipeline.runExtractionJob(sessionId, { skipAuthorization: true });
              } catch (err) {
                if (process.env.DEBUG) {
                  console.warn(`[SelectiveExtraction] Failed for ${sessionId}:`, (err as Error).message);
                }
              }
            }
            broadcastToClients({
              type: 'MEMORY_EXTRACTION_COMPLETED',
              payload: { timestamp: new Date().toISOString(), jobId }
            });
          } catch (err) {
            broadcastToClients({
              type: 'MEMORY_EXTRACTION_FAILED',
              payload: {
                timestamp: new Date().toISOString(),
                jobId,
                error: (err as Error).message,
              }
            });
          }
        })();

        // Include unauthorizedIds in response for security transparency
        return {
          success: true,
          jobId,
          queued: queued.length,
          skipped: skipped.length,
          invalidIds,
          ...(unauthorizedIds.length > 0 && { unauthorizedIds }),
        };
      } catch (error: unknown) {
        // Log full error server-side, return sanitized message to client
        return { error: sanitizeErrorMessage(error, 'extract/selected'), status: 500 };
      }
    });
    return true;
  }

  // API: Get extraction pipeline status
  if (pathname === '/api/core-memory/extract/status' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const store = getCoreMemoryStore(projectPath);
      const scheduler = new MemoryJobScheduler(store.getDb());

      const stage1Count = store.countStage1Outputs();
      const extractionJobs = scheduler.listJobs('phase1_extraction');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        total_stage1: stage1Count,
        jobs: extractionJobs.map(j => ({
          job_key: j.job_key,
          status: j.status,
          started_at: j.started_at,
          finished_at: j.finished_at,
          last_error: j.last_error,
          retry_remaining: j.retry_remaining,
        })),
      }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Trigger consolidation (fire-and-forget)
  if (pathname === '/api/core-memory/consolidate' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { path: projectPath } = body;
      const basePath = projectPath || initialPath;

      try {
        const { MemoryConsolidationPipeline } = await import('../memory-consolidation-pipeline.js');
        const pipeline = new MemoryConsolidationPipeline(basePath);

        // Broadcast start event
        broadcastToClients({
          type: 'MEMORY_CONSOLIDATION_STARTED',
          payload: { timestamp: new Date().toISOString() }
        });

        // Fire-and-forget
        const consolidatePromise = pipeline.runConsolidation();
        consolidatePromise.then(() => {
          broadcastToClients({
            type: 'MEMORY_CONSOLIDATION_COMPLETED',
            payload: { timestamp: new Date().toISOString() }
          });
        }).catch((err: Error) => {
          broadcastToClients({
            type: 'MEMORY_CONSOLIDATION_FAILED',
            payload: {
              timestamp: new Date().toISOString(),
              error: err.message,
            }
          });
        });

        return {
          success: true,
          triggered: true,
          message: 'Consolidation triggered',
        };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Get consolidation status
  if (pathname === '/api/core-memory/consolidate/status' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const { MemoryConsolidationPipeline } = await import('../memory-consolidation-pipeline.js');
      const pipeline = new MemoryConsolidationPipeline(projectPath);
      const status = pipeline.getStatus();
      const memoryMd = pipeline.getMemoryMdContent();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        status: status?.status || 'unknown',
        memoryMdAvailable: !!memoryMd,
        memoryMdPreview: memoryMd ? memoryMd.substring(0, 500) : undefined,
      }));
    } catch (error: unknown) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        status: 'unavailable',
        memoryMdAvailable: false,
        error: (error as Error).message,
      }));
    }
    return true;
  }

  // API: List all V2 pipeline jobs
  if (pathname === '/api/core-memory/jobs' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const kind = url.searchParams.get('kind') || undefined;
    const statusFilter = url.searchParams.get('status') as JobStatus | undefined;

    try {
      const store = getCoreMemoryStore(projectPath);
      const scheduler = new MemoryJobScheduler(store.getDb());

      const jobs = scheduler.listJobs(kind, statusFilter);

      // Compute byStatus counts
      const byStatus: Record<string, number> = {};
      for (const job of jobs) {
        byStatus[job.status] = (byStatus[job.status] || 0) + 1;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        jobs,
        total: jobs.length,
        byStatus,
      }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // ============================================================
  // Session Clustering API Endpoints
  // ============================================================

  // API: Get all clusters
  if (pathname === '/api/core-memory/clusters' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const status = url.searchParams.get('status') || undefined;

    try {
      const store = getCoreMemoryStore(projectPath);
      const clusters = store.listClusters(status);

      // Add member count to each cluster
      const clustersWithCount = clusters.map(c => ({
        ...c,
        memberCount: store.getClusterMembers(c.id).length
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, clusters: clustersWithCount }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Get cluster detail with members
  if (pathname.match(/^\/api\/core-memory\/clusters\/[^\/]+$/) && req.method === 'GET') {
    const clusterId = pathname.split('/').pop()!;
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const store = getCoreMemoryStore(projectPath);
      const cluster = store.getCluster(clusterId);

      if (!cluster) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cluster not found' }));
        return true;
      }

      const members = store.getClusterMembers(clusterId);
      const relations = store.getClusterRelations(clusterId);

      // Get metadata for each member
      const membersWithMetadata = members.map(m => ({
        ...m,
        metadata: store.getSessionMetadata(m.session_id)
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        cluster,
        members: membersWithMetadata,
        relations
      }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Auto-cluster sessions
  if (pathname === '/api/core-memory/clusters/auto' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { scope = 'recent', minClusterSize = 2, path: projectPath } = body;
      const basePath = projectPath || initialPath;

      try {
        const { SessionClusteringService } = await import('../session-clustering-service.js');
        const service = new SessionClusteringService(basePath);

        const validScope: 'all' | 'recent' | 'unclustered' =
          scope === 'all' || scope === 'recent' || scope === 'unclustered' ? scope : 'recent';

        const result = await service.autocluster({
          scope: validScope,
          minClusterSize
        });

        // Broadcast update event
        broadcastToClients({
          type: 'CLUSTERS_UPDATED',
          payload: {
            ...result,
            timestamp: new Date().toISOString()
          }
        });

        return {
          success: true,
          ...result
        };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Get embedding status
  if (pathname === '/api/core-memory/embed-status' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      // Semantic status: codexlens v1 removed, always unavailable via this path
      const semanticStatus = { available: false, error: 'Use codexlens MCP server instead' };

      if (!semanticStatus.available) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          available: false,
          total_chunks: 0,
          embedded_chunks: 0,
          pending_chunks: 0,
          by_type: {},
          error: semanticStatus.error
        }));
        return true;
      }

      const paths = StoragePaths.project(projectPath);
      const dbPath = join(paths.root, 'core-memory', 'core_memory.db');
      const status = await getEmbeddingStatus(dbPath);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...status, available: true }));
    } catch (error: unknown) {
      // Return status with available=true even on error (embedder exists but query failed)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        available: true,
        total_chunks: 0,
        embedded_chunks: 0,
        pending_chunks: 0,
        by_type: {},
        error: (error as Error).message
      }));
    }
    return true;
  }

  // API: Generate embeddings
  if (pathname === '/api/core-memory/embed' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { sourceId, force, batchSize, path: projectPath } = body;
      const basePath = projectPath || initialPath;

      try {
        const semanticStatus = { available: false, error: 'Use codexlens MCP server instead' };
        if (!semanticStatus.available) {
          return { error: semanticStatus.error || 'Semantic search not available. Install it from CLI > CodexLens > Semantic page.', status: 503 };
        }

        const paths = StoragePaths.project(basePath);
        const dbPath = join(paths.root, 'core-memory', 'core_memory.db');

        const result = await generateEmbeddings(dbPath, {
          sourceId,
          force: force || false,
          batchSize: batchSize || 8
        });

        return {
          success: result.success,
          chunks_processed: result.chunks_processed,
          elapsed_time: result.elapsed_time
        };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Create new cluster
  if (pathname === '/api/core-memory/clusters' && req.method === 'POST') {
    handlePostRequest(req, res, async (body) => {
      const { name, description, intent, metadata, path: projectPath } = body;

      if (!name) {
        return { error: 'name is required', status: 400 };
      }

      const basePath = projectPath || initialPath;

      try {
        const store = getCoreMemoryStore(basePath);
        const cluster = store.createCluster({
          name,
          description,
          intent,
          metadata: metadata ? JSON.stringify(metadata) : undefined
        });

        // Broadcast update event
        broadcastToClients({
          type: 'CLUSTER_UPDATED',
          payload: {
            cluster,
            timestamp: new Date().toISOString()
          }
        });

        return {
          success: true,
          cluster
        };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Update cluster (supports both PUT and PATCH)
  if (pathname.match(/^\/api\/core-memory\/clusters\/[^\/]+$/) && (req.method === 'PUT' || req.method === 'PATCH')) {
    const clusterId = pathname.split('/').pop()!;

    handlePostRequest(req, res, async (body) => {
      const { name, description, intent, status, metadata, path: projectPath } = body;
      const basePath = projectPath || initialPath;

      try {
        const store = getCoreMemoryStore(basePath);
        const cluster = store.updateCluster(clusterId, {
          name,
          description,
          intent,
          status,
          metadata: metadata ? JSON.stringify(metadata) : undefined
        });

        if (!cluster) {
          return { error: 'Cluster not found', status: 404 };
        }

        // Broadcast update event
        broadcastToClients({
          type: 'CLUSTER_UPDATED',
          payload: {
            cluster,
            timestamp: new Date().toISOString()
          }
        });

        return {
          success: true,
          cluster
        };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Delete cluster
  if (pathname.match(/^\/api\/core-memory\/clusters\/[^\/]+$/) && req.method === 'DELETE') {
    const clusterId = pathname.split('/').pop()!;
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const store = getCoreMemoryStore(projectPath);
      const deleted = store.deleteCluster(clusterId);

      if (!deleted) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cluster not found' }));
        return true;
      }

      // Broadcast update event
      broadcastToClients({
        type: 'CLUSTER_UPDATED',
        payload: {
          clusterId,
          deleted: true,
          timestamp: new Date().toISOString()
        }
      });

      res.writeHead(204, { 'Content-Type': 'application/json' });
      res.end();
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Add member to cluster
  if (pathname.match(/^\/api\/core-memory\/clusters\/[^\/]+\/members$/) && req.method === 'POST') {
    const clusterId = pathname.split('/')[4];

    handlePostRequest(req, res, async (body) => {
      const { session_id, session_type, sequence_order, relevance_score, path: projectPath } = body;

      if (!session_id || !session_type) {
        return { error: 'session_id and session_type are required', status: 400 };
      }

      const basePath = projectPath || initialPath;

      try {
        const store = getCoreMemoryStore(basePath);
        const member = store.addClusterMember({
          cluster_id: clusterId,
          session_id,
          session_type,
          sequence_order: sequence_order ?? 0,
          relevance_score: relevance_score ?? 1.0
        });

        // Broadcast update event
        broadcastToClients({
          type: 'CLUSTER_UPDATED',
          payload: {
            clusterId,
            member,
            timestamp: new Date().toISOString()
          }
        });

        return {
          success: true,
          member
        };
      } catch (error: unknown) {
        return { error: (error as Error).message, status: 500 };
      }
    });
    return true;
  }

  // API: Remove member from cluster
  if (pathname.match(/^\/api\/core-memory\/clusters\/[^\/]+\/members\/[^\/]+$/) && req.method === 'DELETE') {
    const parts = pathname.split('/');
    const clusterId = parts[4];
    const sessionId = parts[6];
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const store = getCoreMemoryStore(projectPath);
      const removed = store.removeClusterMember(clusterId, sessionId);

      if (!removed) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Member not found' }));
        return true;
      }

      // Broadcast update event
      broadcastToClients({
        type: 'CLUSTER_UPDATED',
        payload: {
          clusterId,
          removedSessionId: sessionId,
          timestamp: new Date().toISOString()
        }
      });

      res.writeHead(204, { 'Content-Type': 'application/json' });
      res.end();
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Search sessions by keyword
  if (pathname === '/api/core-memory/sessions/search' && req.method === 'GET') {
    const keyword = url.searchParams.get('q') || '';
    const projectPath = url.searchParams.get('path') || initialPath;

    if (!keyword) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query parameter q is required' }));
      return true;
    }

    try {
      const store = getCoreMemoryStore(projectPath);
      const results = store.searchSessionsByKeyword(keyword);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Get session summaries (list)
  if (pathname === '/api/core-memory/sessions/summaries' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path') || initialPath;
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    try {
      const store = getCoreMemoryStore(projectPath);
      const summaries = store.getSessionSummaries(limit);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, summaries }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  // API: Get single session summary by thread ID
  if (pathname.match(/^\/api\/core-memory\/sessions\/[^\/]+\/summary$/) && req.method === 'GET') {
    const parts = pathname.split('/');
    const threadId = parts[4]; // /api/core-memory/sessions/:id/summary
    const projectPath = url.searchParams.get('path') || initialPath;

    try {
      const store = getCoreMemoryStore(projectPath);
      const summary = store.getSessionSummary(threadId);

      if (!summary) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session summary not found' }));
        return true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...summary }));
    } catch (error: unknown) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;
  }

  return false;
}
