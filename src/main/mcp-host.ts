import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import { z } from 'zod';
import {
  CanvasOperationSchema,
  createId,
  nowIso,
  type Actor,
  type AsyncJob,
  type CanvasOperation,
  type CanvasTransaction,
} from '@aidraw/core';
import { DocumentService } from './document-service';
import { PlaybackScheduler } from './playback-scheduler';
import { renderDocument } from './render-document';
import { plannedExportCompanionPaths, type ExportFormat } from './export-document';

const PORT_START = 48200;
const PORT_END = 48231;
const MAX_HTTP_BODY = 2 * 1024 * 1024;
const AGENT_COLORS = ['#8268dd', '#e65f7d', '#2fa7a0', '#d58a35', '#4d83d1', '#a65dab'];

interface McpSession {
  mcp: McpServer;
  transport: NodeStreamableHTTPServerTransport;
  actor: Actor;
}

interface PortSettings { version: 1; preferredPort: number }
interface FolderTrustSettings { version: 1; folders: string[] }
type ApprovalDecision = 'allow-once' | 'allow-session' | 'allow-always' | 'deny';

function jsonText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function normalizeColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

async function canonicalizeRequestedPath(filePath: string): Promise<string> {
  const absolute = resolve(filePath);
  try {
    return await realpath(absolute);
  } catch {
    const segments = [basename(absolute)];
    let cursor = dirname(absolute);
    while (true) {
      try {
        return resolve(await realpath(cursor), ...segments);
      } catch {
        const parent = dirname(cursor);
        if (parent === cursor) return absolute;
        segments.unshift(basename(cursor));
        cursor = parent;
      }
    }
  }
}

function approvalReview(
  kind: AsyncJob['kind'],
  title: string,
  request: Record<string, unknown>,
  target: string | undefined,
  overwritePaths: string[],
  trustable: boolean,
): NonNullable<NonNullable<AsyncJob['approval']>['review']> {
  const fields: NonNullable<NonNullable<AsyncJob['approval']>['review']>['fields'] = [];
  const add = (label: string, value: unknown, tone?: 'default' | 'warning' | 'paid') => {
    if (value === undefined || value === '' || value === false) return;
    fields.push({ label, value: Array.isArray(value) ? value.join(', ') || 'None' : String(value), tone });
  };
  if (kind === 'generation') {
    add('Provider', request.provider);
    add('Mode', request.mode);
    add('Prompt', request.prompt);
    add('Negative prompt', request.negativePrompt);
    add('Source assets', Array.isArray(request.sourceAssetIds) ? request.sourceAssetIds : []);
    add('Mask asset', request.maskAssetId);
    add('Requested results', request.resultCount);
    add('Potential paid requests', request.resultCount, 'paid');
    add('Size', typeof request.size === 'object' ? JSON.stringify(request.size) : request.size);
    add('Seed', request.seed);
  } else {
    add('Action', request.action ?? title);
    add('Format', request.format);
    add('Presentation scale', request.scale ? `${request.scale}×` : undefined);
    add('Pixel import', request.pixelMode === true ? 'Yes' : undefined);
    if (overwritePaths.length) add('Will overwrite', overwritePaths.join('\n'), 'warning');
    else if (target && (kind === 'save' || kind === 'export')) add('Overwrite check', 'No existing target detected');
  }
  return {
    action: title,
    target,
    trustFolder: trustable && target ? dirname(target) : undefined,
    overwritePaths,
    fields,
  };
}

export class McpHost {
  readonly scheduler: PlaybackScheduler;
  private readonly sessions = new Map<string, McpSession>();
  private httpServer?: HttpServer;
  private token = '';
  private port?: number;
  private lastRevisions = new Map<string, number>();
  private readonly sessionTrustedFolders = new Map<string, Set<string>>();
  private readonly persistentTrustedFolders = new Set<string>();
  private readonly launchTrustedFolders = new Set<string>();

  constructor(
    private readonly documents: DocumentService,
    private readonly appVersion: string,
    private readonly preferredPortPath: string,
    private readonly cancelJob?: (jobId: string) => void,
    private readonly runApprovedJob?: (job: AsyncJob) => void,
  ) {
    this.scheduler = new PlaybackScheduler(documents);
    this.documents.on('event', (event) => {
      if (event.type !== 'workspace') return;
      for (const tab of event.snapshot.documents) {
        const prior = this.lastRevisions.get(tab.id);
        if (prior !== tab.revision) {
          this.lastRevisions.set(tab.id, tab.revision);
          void this.notifyDocumentUpdated(tab.id, tab.revision);
        }
      }
    });
    this.documents.on('approval-resolved', (job: AsyncJob, decision: ApprovalDecision) => { void this.rememberTrust(job, decision); });
  }

  async start(token: string): Promise<{ port: number; url: string; tokenHint: string }> {
    this.token = token;
    await this.readFolderTrust();
    const preferred = await this.readPreferredPort();
    const candidates = [preferred, ...Array.from({ length: PORT_END - PORT_START + 1 }, (_, index) => PORT_START + index)]
      .filter((value, index, values) => value >= PORT_START && value <= PORT_END && values.indexOf(value) === index);
    let lastError: Error | undefined;
    for (const port of candidates) {
      try {
        await this.listen(port);
        this.port = port;
        await this.writePreferredPort(port);
        return { port, url: `http://127.0.0.1:${port}/mcp`, tokenHint: `••••${token.slice(-6)}` };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error('No AIDraw MCP port is available.');
  }

  credentials(): { url?: string; token: string } {
    return { url: this.port ? `http://127.0.0.1:${this.port}/mcp` : undefined, token: this.token };
  }

  /**
   * Grants process-lifetime file authority that was explicitly supplied by the
   * user who launched a headless engine. This is intentionally separate from
   * persistent in-app trust and is never written to disk by McpHost.
   */
  grantLaunchFolderTrust(folders: string[]): string[] {
    for (const folder of folders) this.launchTrustedFolders.add(this.normalizeFolder(folder));
    return [...this.launchTrustedFolders];
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) await session.mcp.close().catch(() => undefined);
    this.sessions.clear();
    this.sessionTrustedFolders.clear();
    if (this.httpServer) await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    this.httpServer = undefined;
  }

  private async listen(port: number): Promise<void> {
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const server = createServer((request, response) => {
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      void this.handleRequest(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'MCP request failed.' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    this.httpServer = server;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port ?? PORT_START}`);
    if (url.pathname === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ name: 'AIDraw Engine', version: this.appVersion, status: 'ok', uiRequired: false }));
      return;
    }
    if (url.pathname !== '/mcp') {
      response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"not_found"}'); return;
    }
    const authorization = request.headers.authorization ?? '';
    if (!authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), this.token)) {
      response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="AIDraw MCP"', 'cache-control': 'no-store' });
      response.end('{"error":"invalid_token"}');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { allow: 'GET, POST, DELETE, OPTIONS' }); response.end(); return;
    }

    const sessionHeader = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    let body: unknown;
    if (request.method === 'POST') body = await this.readBody(request);

    if (!session) {
      const method = body && typeof body === 'object' && 'method' in body ? (body as { method?: unknown }).method : undefined;
      if (request.method !== 'POST' || method !== 'initialize') {
        response.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: sessionId ? 'unknown_session' : 'initialization_required' }));
        return;
      }
      session = await this.createSession();
    }

    await session.transport.handleRequest(request, response, body);
    const assignedId = session.transport.sessionId;
    if (assignedId && !this.sessions.has(assignedId)) this.sessions.set(assignedId, session);
  }

  private async readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_HTTP_BODY) throw new Error('MCP request body exceeds 2 MiB.');
      chunks.push(buffer);
    }
    if (chunks.length === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  private async createSession(): Promise<McpSession> {
    const actorIndex = this.sessions.size % AGENT_COLORS.length;
    const state: McpSession = {
      actor: { id: createId('agent'), kind: 'agent', name: `Agent ${this.sessions.size + 1}`, color: AGENT_COLORS[actorIndex] },
      mcp: undefined as unknown as McpServer,
      transport: new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() }),
    };
    state.mcp = this.buildServer(state);
    await state.mcp.connect(state.transport);
    return state;
  }

  private buildServer(session: McpSession): McpServer {
    const server = new McpServer({ name: 'aidraw', version: this.appVersion }, {
      capabilities: { resources: { subscribe: true, listChanged: true }, tools: { listChanged: true } },
    });
    const approvalJob = async (kind: AsyncJob['kind'], title: string, description: string, documentId: string | undefined, rawRequest: Record<string, unknown>, trustable = true) => {
      const rawPath = typeof rawRequest.path === 'string' ? resolve(rawRequest.path) : undefined;
      const extensionAdjustedPath = rawPath && kind === 'save' && extname(rawPath).toLowerCase() !== '.aidraw' ? `${rawPath}.aidraw` : rawPath;
      const requestedPath = extensionAdjustedPath ? await canonicalizeRequestedPath(extensionAdjustedPath) : undefined;
      const document = documentId ? this.documents.getDocument(documentId) : undefined;
      const companionPaths = requestedPath && document && kind === 'export' && typeof rawRequest.format === 'string'
        ? plannedExportCompanionPaths(document, rawRequest.format as ExportFormat, requestedPath)
        : [];
      const targetPaths = requestedPath ? [requestedPath, ...companionPaths] : [];
      const overwritePaths = (await Promise.all(targetPaths.map(async (target) => await stat(target).then(() => target, () => undefined)))).filter((target): target is string => Boolean(target));
      const request = requestedPath ? { ...rawRequest, path: requestedPath, overwritePaths } : rawRequest;
      const timestamp = nowIso();
      const job: AsyncJob = {
        id: createId('job'), kind, status: 'waiting-for-user', actor: structuredClone(session.actor), createdAt: timestamp, updatedAt: timestamp,
        progress: 0, message: `${title} is waiting for in-app approval.`, result: { documentId, request },
        approval: {
          title,
          description,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          options: trustable ? ['allow-once', 'allow-session', 'allow-always', 'deny'] : ['allow-once', 'deny'],
          review: approvalReview(kind, title, request, requestedPath, overwritePaths, trustable),
        },
      };
      if (trustable && requestedPath && overwritePaths.length === 0 && this.isTrustedPath(session.actor.id, requestedPath)) { const approved = { ...job, status: 'queued' as const, message: 'Approved by trusted folder policy.', approval: undefined, result: { documentId, request, approvalDecision: 'trusted-folder' } }; this.documents.upsertJob(approved); this.runApprovedJob?.(approved); return jsonText({ jobId: approved.id, status: approved.status, trust: 'folder' }); }
      this.documents.upsertJob(job);
      return jsonText({ jobId: job.id, status: job.status, expiresAt: job.approval?.expiresAt });
    };

    server.registerResource('Open AIDraw documents', 'aidraw://documents', {
      title: 'Open AIDraw documents', mimeType: 'application/json', description: 'Open documents and current revisions.',
    }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(this.documents.snapshot(session.actor.id).documents) }] }));

    const manifestTemplate = new ResourceTemplate('aidraw://documents/{id}/manifest', { list: undefined });
    server.registerResource('AIDraw document manifest', manifestTemplate, { title: 'Document manifest', mimeType: 'application/json' }, async (uri, variables) => {
      const document = this.documents.getDocument(String(variables.id));
      if (!document) throw new Error('Document is not open.');
      const manifest = { schemaVersion: document.schemaVersion, id: document.id, revision: document.revision, kind: document.kind, name: document.name, dirty: document.dirty, updatedAt: document.updatedAt, assetCount: Object.keys(document.assets).length };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(manifest) }] };
    });
    const snapshotTemplate = new ResourceTemplate('aidraw://documents/{id}/snapshot', { list: undefined });
    server.registerResource('AIDraw document snapshot', snapshotTemplate, { title: 'Document snapshot', mimeType: 'application/json' }, async (uri, variables) => {
      const document = this.documents.getDocument(String(variables.id));
      if (!document) throw new Error('Document is not open.');
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(document) }] };
    });
    const changesTemplate = new ResourceTemplate('aidraw://documents/{id}/changes/{revision}', { list: undefined });
    server.registerResource('AIDraw document changes', changesTemplate, { title: 'Document changes', mimeType: 'application/json' }, async (uri, variables) => {
      const changes = this.documents.getChanges(String(variables.id), Number(variables.revision));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(changes) }] };
    });
    const traceTemplate = new ResourceTemplate('aidraw://documents/{id}/trace', { list: undefined });
    server.registerResource('AIDraw transaction trace', traceTemplate, { title: 'Durable transaction trace', mimeType: 'application/x-ndjson' }, async (uri, variables) => {
      const entries = await this.documents.listTrace(String(variables.id));
      return { contents: [{ uri: uri.href, mimeType: 'application/x-ndjson', text: entries.map((entry) => JSON.stringify(entry)).join('\n') }] };
    });

    server.registerTool('session_manage', {
      title: 'Manage AIDraw agent session',
      description: 'Join, identify, inspect, or leave the live AIDraw workspace.',
      inputSchema: z.object({ action: z.enum(['join', 'inspect', 'leave']), name: z.string().min(1).max(80).optional(), color: z.string().optional(), documentId: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ action, name, color, documentId }) => {
      if (action === 'join') {
        if (name) session.actor.name = name;
        session.actor.color = normalizeColor(color, session.actor.color);
        this.documents.updatePresence({ actor: session.actor, documentId, queueDepth: 0, status: 'idle' });
      } else if (action === 'leave') this.documents.removePresence(session.actor.id);
      return jsonText({ actor: session.actor, presence: this.documents.getMcpInfo().sessions });
    });

    server.registerTool('canvas_observe', {
      title: 'Observe AIDraw canvas',
      description: 'Read a structured document snapshot or revision diff. PNG capture is reported when available.',
      inputSchema: z.object({ documentId: z.string().optional(), sinceRevision: z.number().int().nonnegative().optional(), includePng: z.boolean().default(false) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ documentId, sinceRevision, includePng }) => {
      const id = documentId ?? this.documents.getActiveDocumentId();
      if (!id) return jsonText({ error: 'no_open_document' });
      const document = this.documents.getDocument(id);
      if (!document) return jsonText({ error: 'document_not_open' });
      const changes = sinceRevision === undefined ? undefined : this.documents.getChanges(id, sinceRevision);
      const png = includePng ? (await renderDocument(document)).toBuffer('image/png').toString('base64') : undefined;
      return jsonText({ document: changes === undefined ? document : undefined, changes, revision: document.revision, png: png ? { available: true, mimeType: 'image/png', data: png } : undefined });
    });

    server.registerTool('canvas_apply', {
      title: 'Apply visible AIDraw transaction',
      description: 'Submit up to 256 idempotent canvas operations. Agent work plays visibly and respects human locks and entity revisions.',
      inputSchema: z.object({ documentId: z.string(), clientOperationId: z.string().min(1).max(200), label: z.string().min(1).max(200), operations: z.array(z.record(z.string(), z.unknown())).min(1).max(256), playback: z.object({ mode: z.enum(['animated', 'instant']).default('animated'), speed: z.number().min(0.25).max(4).default(1) }).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ documentId, clientOperationId, label, operations, playback }) => {
      const parsedOperations = operations.map((operation) => CanvasOperationSchema.parse(operation)) as CanvasOperation[];
      const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId, documentId, actor: structuredClone(session.actor), label, createdAt: nowIso(), operations: parsedOperations, playback: playback ?? { mode: 'animated', speed: 1 } };
      const result = await this.scheduler.submit(transaction);
      return jsonText(result);
    });

    server.registerTool('history_manage', {
      title: 'Manage this agent’s AIDraw history',
      description: 'Undo or redo only transactions authored by the calling agent session.',
      inputSchema: z.object({ action: z.enum(['undo', 'redo']), documentId: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ action, documentId }) => jsonText(action === 'undo' ? await this.documents.undo(documentId, session.actor) : await this.documents.redo(documentId, session.actor)));

    server.registerTool('document_manage', {
      title: 'Manage AIDraw documents',
      description: 'List, create, activate, open, save, save-as, or close documents. New file paths and overwrites become visible in-app approval jobs.',
      inputSchema: z.object({ action: z.enum(['list', 'new', 'activate', 'open', 'save', 'save-as', 'close']), documentId: z.string().optional(), path: z.string().optional(), kind: z.enum(['illustration', 'sprite', 'tilemap', 'project']).optional(), name: z.string().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ action, documentId, path, kind, name, width, height }) => {
      if (action === 'list') return jsonText({ documents: this.documents.snapshot(session.actor.id).documents });
      if (action === 'new') return jsonText(this.documents.create({ kind: kind ?? 'illustration', name, width, height }));
      if (action === 'activate' && documentId) return jsonText(this.documents.activate(documentId));
      if (action === 'open' && path) return approvalJob('import', 'Open AIDraw document', 'Review the exact path before AIDraw reads this native document.', documentId, { action, path });
      if (action === 'save' && documentId) {
        const document = this.documents.getDocument(documentId);
        if (!document?.filePath) return jsonText({ error: 'approval_required', message: 'Use the AIDraw UI to choose a save path first.' });
        return approvalJob('save', 'Overwrite AIDraw document', 'Review the existing destination before the agent overwrites it.', documentId, { action, path: document.filePath });
      }
      if (action === 'save-as' && documentId && path) return approvalJob('save', 'Save AIDraw document as', 'Review the destination and overwrite impact before AIDraw writes this native document.', documentId, { action, path });
      if (action === 'close' && documentId) return jsonText(await this.documents.close(documentId, false));
      return jsonText({ error: 'invalid_arguments' });
    });

    server.registerTool('asset_import', {
      title: 'Import asset', description: 'Import an exact path after in-app review; this tool never enumerates or deletes files.',
      inputSchema: z.object({ documentId: z.string().optional(), path: z.string().min(1), pixelMode: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ documentId, path, pixelMode }) => approvalJob('import', 'Import asset', 'Review the requested path and target mode before AIDraw reads it.', documentId, { action: 'import', path, pixelMode }));

    server.registerTool('document_export', {
      title: 'Export document', description: 'Export to an exact path after in-app review, including every overwrite. Pixel presentation exports can use integer nearest-neighbor scaling.',
      inputSchema: z.object({ documentId: z.string(), path: z.string().min(1), format: z.enum(['png', 'jpeg', 'webp', 'svg', 'pdf', 'psd', 'gif', 'apng', 'sprite-sheet', 'tiled-json', 'tiled-xml']), scale: z.number().int().min(1).max(64).default(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ documentId, path, format, scale }) => extname(path) ? approvalJob('export', 'Export document', 'Review format, scale, destination, and overwrite impact before AIDraw writes it.', documentId, { action: 'export', path, format, scale }) : jsonText({ error: 'extension_required', message: 'Provide an exact export filename including its extension.' }));

    server.registerTool('generation_start', {
      title: 'Generate imagery', description: 'Create a provider-specific generation approval showing prompt, sources, result count, and potential paid requests.',
      inputSchema: z.object({ documentId: z.string(), provider: z.enum(['openai', 'stability', 'comfyui']), mode: z.enum(['create', 'edit', 'inpaint', 'outpaint', 'variation']), prompt: z.string().min(1), negativePrompt: z.string().optional(), sourceAssetIds: z.array(z.string()).default([]), maskAssetId: z.string().optional(), size: z.union([z.literal('auto'), z.object({ width: z.number().int().positive(), height: z.number().int().positive() })]).default('auto'), aspectIntent: z.enum(['canvas', 'square', 'portrait', 'landscape']).optional(), resultCount: z.number().int().min(1).max(4).default(1), seed: z.number().int().optional(), providerOptions: z.record(z.string(), z.unknown()).default({}) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (request) => approvalJob('generation', 'Generate imagery', 'Review provider, prompt, sources, mask, result count, and the potentially paid request count.', request.documentId, request, false));

    server.registerTool('job_manage', {
      title: 'Inspect or cancel AIDraw jobs',
      description: 'Inspect, briefly wait for, or cancel asynchronous playback, approval, import/export, and generation work.',
      inputSchema: z.object({ action: z.enum(['inspect', 'wait', 'approve-dependent', 'cancel']), jobId: z.string(), timeoutMs: z.number().int().min(0).max(30_000).default(0) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ action, jobId, timeoutMs }) => {
      let job = this.documents.getJob(jobId);
      if (action === 'cancel' && job && !['completed', 'failed', 'cancelled'].includes(job.status)) {
        this.cancelJob?.(jobId); job = this.documents.getJob(jobId) ?? job;
        if (!['cancelled', 'completed', 'failed'].includes(job.status)) { job = { ...job, status: 'cancelled', updatedAt: nowIso(), message: 'Cancelled by the originating agent.' }; this.documents.upsertJob(job); }
      } else if (action === 'wait' && job && timeoutMs > 0) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && ['queued', 'running', 'waiting-for-user'].includes(job.status)) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          job = this.documents.getJob(jobId) ?? job;
        }
      }
      return jsonText(job ?? { error: 'job_not_found' });
    });
    return server;
  }

  private async notifyDocumentUpdated(documentId: string, revision: number): Promise<void> {
    for (const session of this.sessions.values()) {
      await Promise.allSettled([
        session.mcp.server.sendResourceUpdated({ uri: `aidraw://documents/${documentId}/manifest` }),
        session.mcp.server.sendResourceUpdated({ uri: `aidraw://documents/${documentId}/snapshot` }),
        session.mcp.server.sendResourceUpdated({ uri: `aidraw://documents/${documentId}/changes/${revision - 1}` }),
        session.mcp.server.sendResourceUpdated({ uri: `aidraw://documents/${documentId}/trace` }),
      ]);
    }
  }

  private trustSettingsPath(): string { return join(dirname(this.preferredPortPath), 'trusted-folders.json'); }

  private normalizeFolder(folder: string): string { const value = resolve(folder); return process.platform === 'win32' ? value.toLowerCase() : value; }

  private isWithinFolder(folder: string, filePath: string): boolean { const relativePath = relative(folder, this.normalizeFolder(filePath)); return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath)); }

  private isTrustedPath(actorId: string, filePath: string): boolean {
    const folders = [...this.launchTrustedFolders, ...this.persistentTrustedFolders, ...(this.sessionTrustedFolders.get(actorId) ?? [])]; return folders.some((folder) => this.isWithinFolder(folder, filePath));
  }

  private async rememberTrust(job: AsyncJob, decision: ApprovalDecision): Promise<void> {
    if (!['import', 'export', 'save'].includes(job.kind) || (decision !== 'allow-session' && decision !== 'allow-always')) return;
    const result = job.result as { request?: { path?: unknown } } | undefined; if (typeof result?.request?.path !== 'string') return; const folder = this.normalizeFolder(dirname(resolve(result.request.path)));
    if (decision === 'allow-session') { const folders = this.sessionTrustedFolders.get(job.actor.id) ?? new Set<string>(); folders.add(folder); this.sessionTrustedFolders.set(job.actor.id, folders); return; }
    this.persistentTrustedFolders.add(folder); await mkdir(dirname(this.trustSettingsPath()), { recursive: true }); await writeFile(this.trustSettingsPath(), JSON.stringify({ version: 1, folders: [...this.persistentTrustedFolders] } satisfies FolderTrustSettings, null, 2), 'utf8');
  }

  private async readFolderTrust(): Promise<void> {
    try { const settings = JSON.parse(await readFile(this.trustSettingsPath(), 'utf8')) as FolderTrustSettings; if (settings.version === 1) for (const folder of settings.folders) this.persistentTrustedFolders.add(this.normalizeFolder(folder)); } catch { /* No persistent trust has been granted yet. */ }
  }

  private async readPreferredPort(): Promise<number> {
    try {
      const settings = JSON.parse(await readFile(this.preferredPortPath, 'utf8')) as PortSettings;
      return settings.preferredPort;
    } catch {
      return PORT_START;
    }
  }

  private async writePreferredPort(port: number): Promise<void> {
    await mkdir(dirname(this.preferredPortPath), { recursive: true });
    await writeFile(this.preferredPortPath, JSON.stringify({ version: 1, preferredPort: port } satisfies PortSettings, null, 2), 'utf8');
  }
}
