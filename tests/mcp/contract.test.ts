import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';
import { McpHost, parseFolderTrustSettings, parsePreferredPortSettings } from '@main/mcp-host';
import { BatchManager } from '@main/batch-manager';
import { TransactionTraceStore } from '@main/trace-store';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createId, createIllustrationDocument, createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, decodeTiledGid, encodeTiledGid, nowIso, readPixel, readTileAt } from '@aidraw/core';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { MCP_BRIDGE_PROVISIONAL_HEADER } from '@main/mcp-authority';
import { renderIllustration } from '@main/render-document';
import { illustrationToSvg } from '@main/export-document';
import { TransactionImageWorkContext } from '@main/transaction-policy';

const temporaryPaths: string[] = [];
const hosts: McpHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function parseMcp(text: string): { result?: Record<string, unknown>; error?: unknown } {
  const data = text.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim() ?? text;
  return JSON.parse(data);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settled) => { resolve = settled; });
  return { promise, resolve };
}

async function initializeClient(url: string, token: string, name: string) {
  const initialize = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name, version: '1.0.0' } } }) });
  const initialized = parseMcp(await initialize.text());
  const protocolVersion = initialized.result?.protocolVersion;
  if (initialize.status !== 200 || protocolVersion !== LATEST_PROTOCOL_VERSION) throw new Error(`MCP initialize did not negotiate ${LATEST_PROTOCOL_VERSION}.`);
  const sessionId = initialize.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('MCP session ID missing');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion };
  await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  return { sessionId, headers };
}

function toolPayload(message: { result?: Record<string, unknown> }): Record<string, unknown> {
  const content = message.result?.content as Array<{ text?: string }> | undefined; return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

async function callToolMessage(url: string, headers: Record<string, string>, id: number, name: string, args: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  return parseMcp(await response.text());
}

async function callTool(url: string, headers: Record<string, string>, id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return toolPayload(await callToolMessage(url, headers, id, name, args));
}

interface DiscoverySchema {
  anyOf?: DiscoverySchema[];
  allOf?: DiscoverySchema[];
  const?: unknown;
  default?: unknown;
  description?: string;
  enum?: unknown[];
  items?: DiscoverySchema;
  maxItems?: number;
  maxLength?: number;
  maximum?: number;
  minimum?: number;
  oneOf?: DiscoverySchema[];
  pattern?: string;
  properties?: Record<string, DiscoverySchema>;
  required?: string[];
  additionalProperties?: boolean;
  type?: string | string[];
}

function findDiscoverySchema(schema: DiscoverySchema | undefined, predicate: (candidate: DiscoverySchema) => boolean): DiscoverySchema | undefined {
  if (!schema) return undefined;
  if (predicate(schema)) return schema;
  for (const candidate of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? []), ...Object.values(schema.properties ?? {}), ...(schema.items ? [schema.items] : [])]) {
    const found = findDiscoverySchema(candidate, predicate);
    if (found) return found;
  }
  return undefined;
}

function expectFlatActionSchema(schema: DiscoverySchema | undefined, actions: string[], properties: string[]): void {
  expect(schema).toMatchObject({ type: 'object', required: ['action'], additionalProperties: false });
  expect(schema?.properties?.action?.enum).toEqual(actions);
  expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(['action', ...properties]));
  expect(JSON.stringify(schema)).not.toMatch(/"(?:oneOf|anyOf|allOf)"/);
}

function expectTransportDiagnostic(
  value: unknown,
  error: 'invalid_token' | 'initialization_required' | 'unsupported_protocol_version' | 'unknown_session',
  message: string,
  next: string,
): void {
  expect(value).toEqual({
    error,
    profile: 'stateful-legacy',
    protocolVersion: LATEST_PROTOCOL_VERSION,
    message: expect.stringContaining(message),
    next: expect.stringContaining(next),
  });
  if (error === 'invalid_token') {
    expect(value).toMatchObject({ next: expect.stringContaining('unchanged AIDraw stdio bridge') });
    expect(value).toMatchObject({ next: expect.stringContaining('fresh private handoff') });
    expect(value).toMatchObject({ next: expect.stringContaining('fresh transport') });
  }
}

async function readSseUntil(response: Response, pattern: RegExp, timeoutMs = 4_000): Promise<string> {
  if (!response.body) throw new Error('MCP event stream has no response body.');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now(); let timer: ReturnType<typeof setTimeout> | undefined; const result = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for MCP resource notification.')), remaining); })]).finally(() => { if (timer) clearTimeout(timer); });
      if (result.done) break; text += decoder.decode(result.value, { stream: true }); if (pattern.test(text)) return text;
    }
  } finally { void reader.cancel().catch(() => undefined); }
  throw new Error(`Expected MCP SSE notification matching ${String(pattern)}. Received: ${text}`);
}

describe('authenticated stateful MCP contract', () => {
  it('atomically rejects a duplicate provisional correlation while its owner is still initializing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-provisional-admission-'));
    temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const host = new McpHost(
      documents,
      '1.0.0',
      join(root, 'port.json'),
      undefined,
      undefined,
      undefined,
      undefined,
      { provisionalSessionTtlMs: 50 },
    );
    hosts.push(host);
    const started = await host.start('provisional-admission-token');
    const internals = host as unknown as {
      createSession: () => Promise<unknown>;
      sessions: Map<string, unknown>;
      provisionalSessions: Map<string, unknown>;
      provisionalAdmissions: Set<string>;
    };
    const createSession = internals.createSession.bind(host);
    const entered = deferred();
    const release = deferred();
    internals.createSession = async () => {
      entered.resolve();
      await release.promise;
      return createSession();
    };
    const provisionalId = '4b2680cb-3e27-47ae-b67f-c081c64d99bc';
    const headers = {
      authorization: 'Bearer provisional-admission-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      [MCP_BRIDGE_PROVISIONAL_HEADER]: provisionalId,
    };
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 'provisional-owner', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'provisional-owner', version: '1.0.0' } },
    });
    const owner = fetch(started.url, { method: 'POST', headers, body });
    await entered.promise;
    expect(internals.provisionalAdmissions).toEqual(new Set([provisionalId]));
    const duplicate = await fetch(started.url, { method: 'POST', headers, body });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({ error: 'bridge_provisional_session_cancelled' });
    expect(internals.sessions.size).toBe(0);

    release.resolve();
    const initialized = await owner;
    expect(initialized.status).toBe(200);
    await initialized.text();
    expect(internals.provisionalAdmissions.size).toBe(0);
    expect(internals.sessions.size).toBe(1);
    expect(internals.provisionalSessions.size).toBe(1);
    await expect.poll(() => internals.sessions.size, { timeout: 1_000 }).toBe(0);
    expect(internals.provisionalSessions.size).toBe(0);
  });

  it('honors provisional cleanup tombstones before and during asynchronous initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-provisional-cleanup-race-'));
    temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json'));
    hosts.push(host);
    const started = await host.start('provisional-cleanup-token');
    const internals = host as unknown as {
      createSession: () => Promise<unknown>;
      sessions: Map<string, unknown>;
      provisionalSessions: Map<string, unknown>;
      provisionalAdmissions: Set<string>;
      cancelledProvisionalSessions: Map<string, unknown>;
    };
    const baseHeaders = {
      authorization: 'Bearer provisional-cleanup-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0', id: 'cleanup-owner', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'cleanup-owner', version: '1.0.0' } },
    });
    const beforeId = 'facf16fd-abd0-4f8a-9ef5-8fb0e92230ea';
    const beforeDelete = await fetch(started.url, {
      method: 'DELETE',
      headers: { ...baseHeaders, [MCP_BRIDGE_PROVISIONAL_HEADER]: beforeId },
    });
    expect(beforeDelete.status).toBe(204);
    const beforeInitialize = await fetch(started.url, {
      method: 'POST',
      headers: { ...baseHeaders, [MCP_BRIDGE_PROVISIONAL_HEADER]: beforeId },
      body: initializeBody,
    });
    expect(beforeInitialize.status).toBe(409);
    expect(internals.sessions.size).toBe(0);
    expect(internals.cancelledProvisionalSessions.size).toBe(0);

    const createSession = internals.createSession.bind(host);
    const entered = deferred();
    const release = deferred();
    internals.createSession = async () => {
      entered.resolve();
      await release.promise;
      return createSession();
    };
    const duringId = '5d6880f9-d6bd-4601-a0c3-70967d36b729';
    const duringInitialize = fetch(started.url, {
      method: 'POST',
      headers: { ...baseHeaders, [MCP_BRIDGE_PROVISIONAL_HEADER]: duringId },
      body: initializeBody,
    });
    await entered.promise;
    expect(internals.provisionalAdmissions).toEqual(new Set([duringId]));
    const duringDelete = await fetch(started.url, {
      method: 'DELETE',
      headers: { ...baseHeaders, [MCP_BRIDGE_PROVISIONAL_HEADER]: duringId },
    });
    expect(duringDelete.status).toBe(204);
    release.resolve();
    const ownerResponse = await duringInitialize;
    expect(ownerResponse.status).toBe(200);
    await ownerResponse.text();
    expect(internals.provisionalAdmissions.size).toBe(0);
    expect(internals.provisionalSessions.size).toBe(0);
    expect(internals.cancelledProvisionalSessions.size).toBe(0);
    expect(internals.sessions.size).toBe(0);
  });

  it('rejects missing auth, creates a session, and exposes the planned tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-'));
    temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json'));
    hosts.push(host);
    const started = await host.start('test-secret-token');

    const unauthenticated = await fetch(started.url, { method: 'POST' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('cache-control')).toBe('no-store');
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer realm="AIDraw MCP"');
    const unauthenticatedDiagnostic = await unauthenticated.json();
    expectTransportDiagnostic(unauthenticatedDiagnostic, 'invalid_token', 'process-lifetime bearer', 'unchanged AIDraw stdio bridge');
    const unauthenticatedProvisionalDelete = await fetch(started.url, {
      method: 'DELETE',
      headers: { [MCP_BRIDGE_PROVISIONAL_HEADER]: '3f389a8e-e6d7-4f26-93d5-72233592bc83' },
    });
    expect(unauthenticatedProvisionalDelete.status).toBe(401);
    await expect(unauthenticatedProvisionalDelete.json()).resolves.toMatchObject({ error: 'invalid_token' });
    expect(JSON.stringify(unauthenticatedDiagnostic)).not.toContain('test-secret-token');
    const healthUrl = new URL(started.url); healthUrl.pathname = '/health';
    expect((await fetch(healthUrl)).status).toBe(401);
    const health = await fetch(healthUrl, { headers: { authorization: 'Bearer test-secret-token' } });
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', uiRequired: false });
    const initialize = await fetch(started.url, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'contract-test', version: '1.0.0' } } }),
    });
    expect(initialize.status).toBe(200);
    const initialized = parseMcp(await initialize.text());
    expect(initialized.result).toBeTruthy();
    expect(initialized.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(initialized.result?.instructions).toEqual(expect.stringContaining('aidraw_help'));
    expect(initialized.result?.instructions).toEqual(expect.stringContaining('human alone approves'));
    expect(initialized.result?.instructions).toEqual(expect.stringContaining('Automatic MCP availability grants no file authority'));
    expect(initialized.result?.instructions).toEqual(expect.stringContaining('canvas_observe'));
    expect(initialized.result?.instructions).toEqual(expect.stringContaining('404 unknown_session'));
    const sessionId = initialize.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const negotiatedProtocolVersion = initialized.result?.protocolVersion;
    expect(typeof negotiatedProtocolVersion).toBe('string');
    const headers = { authorization: 'Bearer test-secret-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId!, 'mcp-protocol-version': String(negotiatedProtocolVersion) };
    await fetch(started.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const listed = await fetch(started.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    const message = parseMcp(await listed.text());
    const tools = (message.result?.tools ?? []) as Array<{ name: string; description?: string; inputSchema?: DiscoverySchema; outputSchema?: DiscoverySchema }>;
    const names = tools.map((tool) => tool.name);
    const expectedPublicTools = [
      'aidraw_help', 'session_manage', 'canvas_observe', 'canvas_apply', 'history_manage',
      'document_manage', 'asset_import', 'document_export', 'job_manage',
    ];
    expect(names).toEqual(expectedPublicTools);
    expect(new Set(names).size).toBe(9);
    expect(tools.find((tool) => tool.name === 'document_export')?.inputSchema?.properties?.scale).toMatchObject({ default: 1, maximum: 64 });
    expect(tools.find((tool) => tool.name === 'asset_import')?.inputSchema?.properties).toEqual(expect.objectContaining({ spriteSheet: expect.any(Object), paletteMode: expect.any(Object), projectLinkId: expect.any(Object) }));
    expect(tools.find((tool) => tool.name === 'document_export')?.inputSchema?.properties).toEqual(expect.objectContaining({ paletteCycleId: expect.any(Object), paletteCycleFrameId: expect.any(Object), projectLinkId: expect.any(Object) }));
    const documentSchema = tools.find((tool) => tool.name === 'document_manage')?.inputSchema;
    expectFlatActionSchema(documentSchema, ['list', 'new', 'activate', 'open', 'save', 'save-as', 'close'], ['documentId', 'path', 'kind', 'name', 'width', 'height', 'background', 'orientation', 'infinite', 'tileWidth', 'tileHeight']);
    expectFlatActionSchema(tools.find((tool) => tool.name === 'history_manage')?.inputSchema, ['undo', 'redo', 'replay', 'checkpoint-list', 'checkpoint-create', 'checkpoint-restore', 'checkpoint-merge', 'checkpoint-delete'], ['documentId', 'transactionId', 'name', 'checkpointId', 'sourceIds']);
    expectFlatActionSchema(tools.find((tool) => tool.name === 'job_manage')?.inputSchema, ['list', 'inspect', 'wait', 'approve-dependent', 'cancel', 'start-batch', 'resume-batch'], ['jobId', 'timeoutMs', 'documentId', 'totalTransactions', 'label', 'resumeToken']);
    expectFlatActionSchema(tools.find((tool) => tool.name === 'session_manage')?.inputSchema, ['join', 'inspect', 'leave'], ['name', 'color', 'documentId', 'model', 'reasoningEffort', 'taskId']);
    expect(documentSchema?.properties?.kind).toMatchObject({ default: 'illustration', description: expect.stringContaining('new only') });
    expect(documentSchema?.properties?.path?.description).toContain('open/save-as only');
    expect(tools.find((tool) => tool.name === 'job_manage')?.inputSchema?.properties?.timeoutMs).toMatchObject({ default: 0, maximum: 30_000, description: expect.stringContaining('wait only') });
    const canvasApplySchema = tools.find((tool) => tool.name === 'canvas_apply')?.inputSchema;
    expect(canvasApplySchema?.properties?.clientOperationId?.description).toContain('idempotency');
    const operationItems = canvasApplySchema?.properties?.operations?.items;
    const validateAdvertisedOperation = new Ajv2020({ strict: false, allErrors: true }).compile(operationItems as object);
    for (const incomplete of [
      { kind: 'illustration.object.add' },
      { kind: 'illustration.object.replace' },
      { kind: 'illustration.object.move' },
      { kind: 'illustration.object.delete' },
      { kind: 'pixel.cel.region' },
      { kind: 'pixel.tilemap.region' },
      { kind: 'pixel.tile-stamps.replace' },
      { kind: 'pixel.tile-stamp.place' },
    ]) expect(validateAdvertisedOperation(incomplete), JSON.stringify(incomplete)).toBe(false);
    expect(validateAdvertisedOperation({ kind: 'illustration.object.add', object: { id: 'schema-object', name: 'Schema object', layerId: 'vector-layer', type: 'shape', shape: 'rectangle', width: 10, height: 12 } })).toBe(true);
    expect(validateAdvertisedOperation({ kind: 'pixel.cel.region', spriteId: 'sprite', celId: 'cel', runs: [{ x: 0, y: 0, length: 4, index: 3 }], expectedRevision: 2 })).toBe(true);
    expect(validateAdvertisedOperation({ kind: 'pixel.tilemap.region', mapId: 'map', layerId: 'tiles', runs: [{ x: 0, y: 0, length: 4, gid: 7 }], expectedRevision: 3 })).toBe(true);
    expect(validateAdvertisedOperation({ kind: 'pixel.tile-stamps.replace', stamps: [{ id: 'stamp', name: 'Stamp', width: 2, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: 7 }] }] })).toBe(true);
    expect(validateAdvertisedOperation({ kind: 'pixel.tile-stamp.place', stampId: 'stamp', mapId: 'map', layerId: 'tiles', x: 4, y: 5, transform: 'rotate-clockwise', expectedRevision: 3 })).toBe(true);
    expect(validateAdvertisedOperation({ kind: 'document.rename', name: 'Other exact runtime family' })).toBe(true);
    const addOperationSchema = findDiscoverySchema(operationItems, (candidate) => candidate.properties?.kind?.const === 'illustration.object.add');
    expect(addOperationSchema).toMatchObject({ required: expect.arrayContaining(['kind', 'object']), additionalProperties: false });
    expect(addOperationSchema?.properties?.object?.description).toContain('Omit revision/createdAt/updatedAt/createdBy');
    const shapeSchema = findDiscoverySchema(addOperationSchema?.properties?.object, (candidate) => candidate.properties?.type?.const === 'shape' && candidate.properties?.shape?.const === 'rectangle');
    expect(shapeSchema).toMatchObject({ required: expect.arrayContaining(['id', 'name', 'layerId', 'type', 'shape', 'width', 'height']), additionalProperties: false });
    expect(shapeSchema?.properties).toMatchObject({
      visible: { default: true }, locked: { default: false }, opacity: { default: 1 }, blendMode: { default: 'normal' },
      fill: { default: { kind: 'solid', color: '#000000' } },
      stroke: { default: { paint: { kind: 'solid', color: '#000000' }, width: 1, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } },
      cornerRadius: { default: 0 },
    });
    expect(shapeSchema?.properties?.sides).toBeUndefined();
    expect(shapeSchema?.properties?.innerRadius).toBeUndefined();
    expect(shapeSchema?.properties?.stroke?.properties).toEqual(expect.objectContaining({ paint: expect.any(Object), width: expect.any(Object), opacity: expect.any(Object), lineCap: expect.any(Object), lineJoin: expect.any(Object), dash: expect.any(Object) }));
    expect(shapeSchema?.properties?.transform?.properties).toMatchObject({
      x: { default: 0 }, y: { default: 0 }, scaleX: { default: 1 }, scaleY: { default: 1 }, rotation: { default: 0 }, skewX: { default: 0 }, skewY: { default: 0 },
    });
    const pathSchema = findDiscoverySchema(addOperationSchema?.properties?.object, (candidate) => candidate.properties?.type?.const === 'path');
    expect(pathSchema).toMatchObject({ required: expect.arrayContaining(['pathData']) });
    expect(pathSchema?.properties?.pathData).toMatchObject({
      maxLength: 1_000_000,
      description: expect.stringContaining('2–7,000 effective native nodes after arc conversion and close coalescing'),
    });
    expect(pathSchema?.properties?.pathData?.description).toContain('spans more than 0.00001° after ellipse normalization');
    expect(pathSchema?.properties?.stroke).toMatchObject({ default: { paint: { kind: 'solid', color: '#000000' }, width: 1, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } });
    expect(pathSchema?.properties?.closed).toMatchObject({ description: expect.stringContaining('derives it from the final SVG close-path command') });
    expect(pathSchema?.properties?.closed?.default).toBeUndefined();
    const lineSchema = findDiscoverySchema(addOperationSchema?.properties?.object, (candidate) => candidate.properties?.shape?.const === 'line');
    expect(lineSchema?.properties?.fill).toMatchObject({ default: { kind: 'none' } });
    expect(lineSchema?.properties?.sides).toBeUndefined();
    expect(lineSchema?.properties?.innerRadius).toBeUndefined();
    expect(lineSchema?.properties?.cornerRadius).toBeUndefined();
    const polygonSchema = findDiscoverySchema(addOperationSchema?.properties?.object, (candidate) => candidate.properties?.shape?.const === 'polygon');
    expect(polygonSchema?.properties?.sides).toMatchObject({ default: 6, minimum: 3, maximum: 1_000 });
    expect(polygonSchema?.properties?.innerRadius).toBeUndefined();
    expect(polygonSchema?.properties?.cornerRadius).toBeUndefined();
    const starSchema = findDiscoverySchema(addOperationSchema?.properties?.object, (candidate) => candidate.properties?.shape?.const === 'star');
    expect(starSchema?.properties).toMatchObject({ sides: { default: 5 }, innerRadius: { default: 0.45 } });
    expect(starSchema?.properties?.cornerRadius).toBeUndefined();
    const vectorStrokeSchema = findDiscoverySchema(addOperationSchema?.properties?.object, (candidate) => candidate.properties?.type?.const === 'vector-stroke');
    expect(vectorStrokeSchema).toMatchObject({ required: expect.arrayContaining(['points']) });
    expect(vectorStrokeSchema?.properties?.brush).toMatchObject({ default: { size: 4, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true, color: '#000000' } });
    const textSchema = findDiscoverySchema(addOperationSchema?.properties?.object, (candidate) => candidate.properties?.type?.const === 'text');
    expect(textSchema?.properties).toMatchObject({ width: { default: 600 }, height: { default: 80 }, align: { default: 'left' }, lineHeight: { default: 1.2 }, ranges: { default: [] } });
    const imageSchema = findDiscoverySchema(addOperationSchema?.properties?.object, (candidate) => candidate.properties?.type?.const === 'image');
    expect(imageSchema).toMatchObject({ required: expect.arrayContaining(['assetId', 'width', 'height']), additionalProperties: false });
    expect(imageSchema?.properties?.filters).toMatchObject({ default: [] });
    expect(imageSchema?.properties?.crop?.description).toContain('derives source dimensions from the embedded asset');
    const groupSchema = findDiscoverySchema(addOperationSchema?.properties?.object, (candidate) => candidate.properties?.type?.const === 'group');
    expect(groupSchema?.properties?.childIds).toMatchObject({ default: [] });
    const replaceOperationSchema = findDiscoverySchema(operationItems, (candidate) => candidate.properties?.kind?.const === 'illustration.object.replace');
    expect(replaceOperationSchema).toMatchObject({ required: expect.arrayContaining(['kind', 'object', 'expectedRevision']), additionalProperties: false, description: expect.stringContaining('partial patches are rejected') });
    const replacementShapes = Object.fromEntries(['rectangle', 'ellipse', 'line', 'arrow', 'polygon', 'star'].map((shape) => [shape, findDiscoverySchema(
      replaceOperationSchema?.properties?.object,
      (candidate) => candidate.properties?.type?.const === 'shape' && candidate.properties?.shape?.const === shape,
    )]));
    expect(Object.values(replacementShapes).every(Boolean)).toBe(true);
    expect(replacementShapes.rectangle?.required).toContain('cornerRadius');
    expect(replacementShapes.polygon?.required).toContain('sides');
    expect(replacementShapes.star?.required).toEqual(expect.arrayContaining(['sides', 'innerRadius']));
    expect(replacementShapes.rectangle?.properties?.cornerRadius?.default).toBeUndefined();
    expect(replacementShapes.polygon?.properties?.sides?.default).toBeUndefined();
    expect(replacementShapes.star?.properties?.sides?.default).toBeUndefined();
    expect(replacementShapes.star?.properties?.innerRadius?.default).toBeUndefined();
    expect(replacementShapes.rectangle?.properties?.cornerRadius?.description).toContain('supply 0');
    expect(replacementShapes.polygon?.properties?.sides?.description).toContain('supply 6');
    expect(replacementShapes.star?.properties?.sides?.description).toContain('supply 5');
    expect(replacementShapes.star?.properties?.innerRadius?.description).toContain('supply 0.45');
    for (const shape of ['line', 'arrow']) {
      const fill = replacementShapes[shape]?.properties?.fill;
      expect(findDiscoverySchema(fill, (candidate) => candidate.properties?.kind?.const === 'none')).toBeTruthy();
      expect(findDiscoverySchema(fill, (candidate) => candidate.properties?.kind?.const === 'solid')).toBeUndefined();
      expect(fill?.description).toContain('no fill-rendering surface');
    }
    expect(replacementShapes.rectangle?.properties?.sides).toBeUndefined();
    expect(replacementShapes.rectangle?.properties?.innerRadius).toBeUndefined();
    for (const shape of ['ellipse', 'line', 'arrow']) {
      expect(replacementShapes[shape]?.properties?.sides).toBeUndefined();
      expect(replacementShapes[shape]?.properties?.innerRadius).toBeUndefined();
      expect(replacementShapes[shape]?.properties?.cornerRadius).toBeUndefined();
    }
    expect(replacementShapes.polygon?.properties?.innerRadius).toBeUndefined();
    expect(replacementShapes.polygon?.properties?.cornerRadius).toBeUndefined();
    expect(replacementShapes.star?.properties?.cornerRadius).toBeUndefined();
    const groupedAddSchema = findDiscoverySchema(operationItems, (candidate) => candidate.properties?.kind?.const === 'illustration.object.add' && candidate.required?.includes('parentGroupId') === true);
    expect(groupedAddSchema).toMatchObject({ required: expect.arrayContaining(['parentGroupId']), additionalProperties: false });
    const groupedMoveSchema = findDiscoverySchema(operationItems, (candidate) => candidate.properties?.kind?.const === 'illustration.object.move' && candidate.required?.includes('parentGroupId') === true);
    expect(groupedMoveSchema).toMatchObject({ required: expect.arrayContaining(['parentGroupId']), additionalProperties: false });
    const pixelRegionSchema = findDiscoverySchema(operationItems, (candidate) => candidate.properties?.kind?.const === 'pixel.cel.region');
    expect(pixelRegionSchema).toMatchObject({ required: ['kind', 'spriteId', 'celId', 'runs', 'expectedRevision'], additionalProperties: false });
    expect(pixelRegionSchema?.properties?.runs?.maxItems).toBe(65_536);
    expect(pixelRegionSchema?.properties?.runs?.items?.properties?.index).toMatchObject({ minimum: 0, maximum: 255 });
    const tileRegionSchema = findDiscoverySchema(operationItems, (candidate) => candidate.properties?.kind?.const === 'pixel.tilemap.region');
    expect(tileRegionSchema).toMatchObject({ required: ['kind', 'mapId', 'layerId', 'runs', 'expectedRevision'], additionalProperties: false });
    expect(tileRegionSchema?.properties?.runs?.items?.properties?.gid).toMatchObject({ minimum: 0, maximum: 0xffff_ffff, description: expect.stringContaining('observed attached tileset') });
    const tileStampsSchema = findDiscoverySchema(operationItems, (candidate) => candidate.properties?.kind?.const === 'pixel.tile-stamps.replace');
    expect(tileStampsSchema).toMatchObject({ required: ['kind', 'stamps'], additionalProperties: false });
    expect(tileStampsSchema?.properties?.stamps?.maxItems).toBe(1_024);
    expect(tileStampsSchema?.properties?.stamps?.items).toMatchObject({ required: ['id', 'name', 'width', 'height', 'anchorX', 'anchorY', 'cells'], additionalProperties: false });
    const tilePlaceSchema = findDiscoverySchema(operationItems, (candidate) => candidate.properties?.kind?.const === 'pixel.tile-stamp.place');
    expect(tilePlaceSchema).toMatchObject({ required: ['kind', 'stampId', 'mapId', 'layerId', 'x', 'y', 'expectedRevision'], additionalProperties: false });
    expect(tilePlaceSchema?.properties?.transform?.enum).toEqual(['flip-horizontal', 'flip-vertical', 'rotate-clockwise', 'rotate-counterclockwise']);
    const fallbackSchema = findDiscoverySchema(operationItems, (candidate) => typeof candidate.properties?.kind?.pattern === 'string');
    expect(fallbackSchema?.properties?.kind?.pattern).toContain('illustration\\.object');
    expect(fallbackSchema?.properties?.kind?.pattern).toContain('pixel\\.');
    expect(tools.find((tool) => tool.name === 'aidraw_help')?.outputSchema).toMatchObject({ required: expect.arrayContaining(['topic', 'steps', 'invariants', 'guideUri']), properties: { guideUri: { const: 'aidraw://guide' } } });
    const canvasApplyOutput = tools.find((tool) => tool.name === 'canvas_apply')?.outputSchema;
    expect(canvasApplyOutput?.properties?.next?.description ?? canvasApplyOutput?.properties?.next).toBeTruthy();
    expect(canvasApplyOutput?.properties?.conflict).toMatchObject({
      description: expect.stringContaining('revision or lock conflict'),
      additionalProperties: false,
      required: ['retryable'],
      properties: {
        entityId: { description: expect.stringContaining('Canonical entity') },
        expectedRevision: { description: expect.stringContaining('Revision supplied') },
        actualRevision: { description: expect.stringContaining('Current canonical entity revision') },
        retryable: { description: expect.stringContaining('re-observing state') },
      },
    });
    expect(tools.find((tool) => tool.name === 'job_manage')?.outputSchema?.properties).toEqual(expect.objectContaining({ status: expect.any(Object), next: expect.any(Object) }));
    const invalidActionInputs = await Promise.all([
      callToolMessage(started.url, headers, 3, 'session_manage', { action: 'leave', name: 'must-not-be-accepted' }),
      callToolMessage(started.url, headers, 4, 'history_manage', { action: 'undo', transactionId: 'must-not-be-accepted' }),
      callToolMessage(started.url, headers, 5, 'document_manage', { action: 'list', path: join(root, 'must-not-be-accepted.aidraw') }),
      callToolMessage(started.url, headers, 6, 'document_manage', { action: 'save-as', documentId: 'invented' }),
      callToolMessage(started.url, headers, 7, 'job_manage', { action: 'list', jobId: 'must-not-be-accepted' }),
      callToolMessage(started.url, headers, 8, 'job_manage', { action: 'wait' }),
      callToolMessage(started.url, headers, 9, 'document_manage', { action: 'new', background: 42 }),
    ]);
    expect(invalidActionInputs.every((message) => message.result?.isError === true)).toBe(true);
    expect(JSON.stringify(invalidActionInputs)).toContain('Invalid arguments');
  });

  it('validates an exact palette-cycle sheet schedule before creating a human export approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-cycle-export-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const document = createPixelDocument('sprite', 'MCP cycle export');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.frames[sprite.frameIds[0]].name = 'Agent source frame';
    sprite.tags = [
      { id: 'agent-tag-one', name: 'Shared', fromFrameId: sprite.frameIds[0], toFrameId: sprite.frameIds[0], direction: 'forward', color: '#31a6a0' },
      { id: 'agent-tag-two', name: 'Shared', fromFrameId: sprite.frameIds[0], toFrameId: sprite.frameIds[0], direction: 'reverse', color: '#8268dd' },
    ];
    document.paletteCycles = [{ id: 'agent-cycle', name: 'Agent cycle', fromIndex: 1, toIndex: 3, direction: 'forward', stepMs: 83 }];
    documents.addDocument(document);
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('cycle-export-token');
    const client = await initializeClient(started.url, 'cycle-export-token', 'cycle-export-client');
    const fileHelp = await callTool(started.url, client.headers, 1_001, 'aidraw_help', { topic: 'files' });
    expect(fileHelp.steps).toEqual(expect.arrayContaining([expect.stringContaining('paletteCycleId plus one paletteCycleFrameId')]));
    expect(fileHelp.steps).toEqual(expect.arrayContaining([expect.stringContaining('refused before approval otherwise')]));
    expect(fileHelp.examples).toEqual(expect.arrayContaining([expect.objectContaining({
      tool: 'document_export', arguments: expect.objectContaining({ format: 'sprite-sheet', paletteCycleId: '<cycleId>', paletteCycleFrameId: '<frameId>' }),
    })]));
    const canonicalRoot = await realpath(root);
    const outputPath = join(canonicalRoot, 'agent-cycle.png');
    const companionPath = join(canonicalRoot, 'agent-cycle.json');
    await writeFile(companionPath, 'approval must disclose this predecessor');
    const initialJobCount = documents.snapshot().jobs.length;

    expect(await callTool(started.url, client.headers, 2, 'document_export', {
      documentId: document.id, path: outputPath, format: 'sprite-sheet', paletteCycleId: 'agent-cycle',
    })).toMatchObject({ error: 'invalid_arguments', message: expect.stringContaining('both paletteCycleId and paletteCycleFrameId') });
    expect(await callTool(started.url, client.headers, 3, 'document_export', {
      documentId: document.id, path: outputPath, format: 'sprite-sheet', animationTagId: 'some-tag', paletteCycleId: 'agent-cycle', paletteCycleFrameId: sprite.frameIds[0],
    })).toMatchObject({ error: 'invalid_arguments', message: expect.stringContaining('either animationTagId or a palette cycle') });
    expect(await callTool(started.url, client.headers, 4, 'document_export', {
      documentId: document.id, path: outputPath, format: 'png', paletteCycleId: 'agent-cycle', paletteCycleFrameId: sprite.frameIds[0],
    })).toMatchObject({ error: 'unsupported_palette_cycle_format' });
    expect(await callTool(started.url, client.headers, 5, 'document_export', {
      documentId: document.id, path: outputPath, format: 'sprite-sheet', paletteCycleId: 'missing-cycle', paletteCycleFrameId: sprite.frameIds[0],
    })).toMatchObject({ error: 'palette_cycle_not_found', paletteCycleId: 'missing-cycle' });
    expect(await callTool(started.url, client.headers, 6, 'document_export', {
      documentId: document.id, path: outputPath, format: 'sprite-sheet', paletteCycleId: 'agent-cycle', paletteCycleFrameId: 'missing-frame',
    })).toMatchObject({ error: 'palette_cycle_frame_not_found', paletteCycleFrameId: 'missing-frame' });
    expect(await callTool(started.url, client.headers, 6_001, 'document_export', {
      documentId: document.id, path: outputPath, format: 'sprite-sheet', animationTagId: 'Shared',
    })).toMatchObject({ error: 'animation_tag_not_found', animationTagId: 'Shared', message: expect.stringMatching(/exact/i) });
    expect(await callTool(started.url, client.headers, 6_002, 'document_export', {
      documentId: document.id, path: outputPath, format: 'png', animationTagId: 'agent-tag-one',
    })).toMatchObject({ error: 'unsupported_animation_tag_format' });
    expect(documents.snapshot().jobs).toHaveLength(initialJobCount);
    const inexactGifPath = join(canonicalRoot, 'agent-cycle.gif');
    const inexactGif = await callTool(started.url, client.headers, 7, 'document_export', {
      documentId: document.id, path: inexactGifPath, format: 'gif', paletteCycleId: 'agent-cycle', paletteCycleFrameId: sprite.frameIds[0],
    });
    expect(inexactGif).toMatchObject({ error: 'inexact_gif_timing', paletteCycleId: 'agent-cycle', stepMs: 83 });
    expect(inexactGif).not.toHaveProperty('jobId');
    await expect(access(inexactGifPath)).rejects.toThrow();
    expect(documents.snapshot().jobs).toHaveLength(initialJobCount);

    const requested = await callTool(started.url, client.headers, 8, 'document_export', {
      documentId: document.id, path: outputPath, format: 'sprite-sheet', scale: 2, paletteCycleId: 'agent-cycle', paletteCycleFrameId: sprite.frameIds[0],
    });
    expect(requested).toMatchObject({ status: 'waiting-for-user' });
    const job = documents.getJob(String(requested.jobId))!;
    expect(job.result).toMatchObject({
      documentId: document.id,
      request: {
        action: 'export', path: outputPath, format: 'sprite-sheet', scale: 2,
        paletteCycleId: 'agent-cycle', paletteCycleFrameId: sprite.frameIds[0], overwritePaths: [companionPath],
      },
    });
    expect(job.approval?.review).toMatchObject({ target: outputPath, overwritePaths: [companionPath] });
    expect(job.approval?.review?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Palette cycle', value: 'agent-cycle' }),
      expect.objectContaining({ label: 'Palette-cycle source frame', value: sprite.frameIds[0] }),
      expect.objectContaining({ label: 'Will overwrite', value: companionPath, tone: 'warning' }),
    ]));
    const mainSource = await readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
    expect(mainSource).toContain("paletteCycleId: typeof request.paletteCycleId === 'string' ? request.paletteCycleId : undefined");
    expect(mainSource).toContain("paletteCycleFrameId: typeof request.paletteCycleFrameId === 'string' ? request.paletteCycleFrameId : undefined");
    expect(await callTool(started.url, client.headers, 9, 'job_manage', { action: 'cancel', jobId: job.id })).toMatchObject({ status: 'cancelled' });
    await expect(access(outputPath)).rejects.toThrow();
    expect(await readFile(companionPath, 'utf8')).toBe('approval must disclose this predecessor');
  });

  it('closes a bound listener when private port publication fails and remains retryable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-start-publication-failure-'));
    temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json'));
    hosts.push(host);
    const internals = host as unknown as {
      httpServer?: { listening: boolean };
      writePreferredPort(port: number): Promise<void>;
    };
    let failedPort: number | undefined;
    let failedListener: { listening: boolean } | undefined;
    const writePreferredPort = vi.spyOn(internals, 'writePreferredPort').mockImplementationOnce(async (port) => {
      failedPort = port;
      failedListener = internals.httpServer;
      throw new Error('injected private publication detail');
    });
    const rejectedToken = Buffer.alloc(32, 0x33).toString('base64url');

    await expect(host.start(rejectedToken)).rejects.toThrow('The listener was closed and runtime authority was not enabled.');
    expect(host.connection()).toEqual({ url: undefined, token: '' });
    expect(failedPort).toBeTypeOf('number');
    expect(failedListener).toBeTruthy();
    expect(failedListener?.listening).toBe(false);
    expect(internals.httpServer).toBeUndefined();
    writePreferredPort.mockRestore();

    const replacementToken = Buffer.alloc(32, 0x44).toString('base64url');
    const started = await host.start(replacementToken);
    expect(started.port).toBeGreaterThanOrEqual(48_200);
    expect(started.port).toBeLessThanOrEqual(48_231);
    expect(host.connection()).toEqual({ url: started.url, token: replacementToken });
    const rejected = await fetch(started.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${rejectedToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'failed-start-token', version: '1.0.0' } } }),
    });
    expect(rejected.status).toBe(401);
    await expect(initializeClient(started.url, replacementToken, 'retry-after-publication-failure')).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it('negotiates the pinned legacy protocol and rejects an unsupported version header after initialize', async () => {
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-protocol-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('protocol-token');
    const initializationRequired = await fetch(started.url, {
      method: 'POST',
      headers: { authorization: 'Bearer protocol-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
    });
    expect(initializationRequired.status).toBe(400);
    expect(initializationRequired.headers.get('cache-control')).toBe('no-store');
    expectTransportDiagnostic(await initializationRequired.json(), 'initialization_required', 'requires initialization', `negotiated ${LATEST_PROTOCOL_VERSION}`);
    const initialize = await fetch(started.url, {
      method: 'POST',
      headers: { authorization: 'Bearer protocol-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'protocol-boundary-client', version: '1.0.0' } } }),
    });
    expect(initialize.status).toBe(200);
    const initialized = parseMcp(await initialize.text());
    expect(initialized.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    const sessionId = initialize.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    const missingVersion = await fetch(started.url, {
      method: 'POST',
      headers: { authorization: 'Bearer protocol-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(missingVersion.status).toBe(400);
    expectTransportDiagnostic(await missingVersion.json(), 'unsupported_protocol_version', 'missing or unsupported', `exact negotiated ${LATEST_PROTOCOL_VERSION}`);
    const unsupported = await fetch(started.url, {
      method: 'POST',
      headers: { authorization: 'Bearer protocol-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId!, 'mcp-protocol-version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.headers.get('cache-control')).toBe('no-store');
    expectTransportDiagnostic(await unsupported.json(), 'unsupported_protocol_version', 'missing or unsupported', `exact negotiated ${LATEST_PROTOCOL_VERSION}`);
  });

  it('teaches a cold tools-only client to join, observe, mutate, and follow a human approval job without private leakage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-cold-client-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('cold-client-token');
    const client = await initializeClient(started.url, 'cold-client-token', 'cold-tools-only-client');

    const helpMessage = await callToolMessage(started.url, client.headers, 2, 'aidraw_help', { topic: 'quickstart' });
    const help = toolPayload(helpMessage);
    expect(helpMessage.result?.structuredContent).toEqual(help);
    expect(help).toMatchObject({ topic: 'quickstart', guideUri: 'aidraw://guide', relatedTools: expect.arrayContaining(['session_manage', 'document_manage', 'canvas_observe', 'canvas_apply', 'job_manage']) });
    expect(help.steps).toEqual(expect.arrayContaining([expect.stringContaining('human must approve')]));
    expect(JSON.stringify(help)).not.toContain('repository');

    const joined = await callTool(started.url, client.headers, 3, 'session_manage', { action: 'join', name: 'Cold discovery agent', color: '#5177cc' });
    expect(joined).toMatchObject({ actor: { name: 'Cold discovery agent', color: '#5177cc' }, next: { tool: 'canvas_observe' } });
    const listed = await callTool(started.url, client.headers, 4, 'document_manage', { action: 'list' });
    const documentId = String(listed.activeDocumentId);
    expect((listed.documents as Array<{ id: string }>).map((entry) => entry.id)).toContain(documentId);
    const observed = await callTool(started.url, client.headers, 5, 'canvas_observe', { documentId });
    expect(observed).toMatchObject({ document: { id: documentId }, revision: expect.any(Number), currentRevision: expect.any(Number) });

    const appliedMessage = await callToolMessage(started.url, client.headers, 6, 'canvas_apply', {
      documentId, clientOperationId: 'cold-client-rename-v1', label: 'Cold-client rename', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'document.rename', name: 'Discovered canvas' }],
    });
    const applied = toolPayload(appliedMessage);
    expect(appliedMessage.result?.structuredContent).toEqual(applied);
    expect(applied).toMatchObject({ status: 'committed', revision: Number(observed.revision) + 1, transactionId: expect.any(String) });

    const exportPath = join(root, 'cold-client-never-approved.png');
    const requestedMessage = await callToolMessage(started.url, client.headers, 7, 'document_export', { documentId, path: exportPath, format: 'png', scale: 1 });
    const requested = toolPayload(requestedMessage);
    const jobId = String(requested.jobId);
    expect(requestedMessage.result?.structuredContent).toEqual(requested);
    expect(requested).toMatchObject({ status: 'waiting-for-user', next: { tool: 'job_manage', arguments: { action: 'wait', jobId, timeoutMs: 1_000 }, guidance: expect.stringContaining('Agents cannot approve') } });

    const waited = await callTool(started.url, client.headers, 8, 'job_manage', { action: 'wait', jobId, timeoutMs: 0 });
    expect(waited).toMatchObject({ id: jobId, status: 'waiting-for-user', dependency: { kind: 'user-approval', guidance: expect.stringContaining('cannot approve') }, next: { tool: 'job_manage', arguments: { action: 'wait', jobId } } });
    const publicSummary = JSON.stringify(waited);
    expect(publicSummary).not.toContain(exportPath);
    expect(publicSummary).not.toContain('cold-client-never-approved.png');
    expect(publicSummary).not.toContain('result');
    expect(await callTool(started.url, client.headers, 9, 'job_manage', { action: 'approve-dependent', jobId })).toMatchObject({ id: jobId, status: 'waiting-for-user' });
    expect(await callTool(started.url, client.headers, 10, 'job_manage', { action: 'cancel', jobId })).toMatchObject({ id: jobId, status: 'cancelled' });
    await expect(access(exportPath)).rejects.toThrow();

    const resourcesResponse = await fetch(started.url, { method: 'POST', headers: client.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'resources/list', params: {} }) });
    const resources = (parseMcp(await resourcesResponse.text()).result?.resources ?? []) as Array<{ uri: string; description?: string }>;
    expect(resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri: 'aidraw://guide', description: expect.stringContaining('Complete optional') })]));
    const guideResponse = await fetch(started.url, { method: 'POST', headers: client.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'aidraw://guide' } }) });
    const guide = ((parseMcp(await guideResponse.text()).result?.contents ?? []) as Array<{ text?: string }>)[0]?.text ?? '';
    expect(guide).toContain('Conditional action contracts');
    expect(guide).toContain('Strict server validation rejects fields from other actions');
    expect(guide).toContain('Automatic MCP connection grants no file authority');
    expect(guide).toContain('only a human can approve');
    expect(guide).toContain('Transport and tool failures');
    expect(guide).toContain('Direct HTTP 401 invalid_token');
    expect(guide).toContain('unchanged stdio client configuration');
    expect(guide).toContain('Ordinary clients use the product stdio bridge');
    expect(guide).toContain('HTTP 404 unknown_session');
    expect(guide).toContain('Tool-level Invalid arguments');
    expect(guide).toContain('Configuration-profile availability remains separate from installed-client acceptance');
    expect(guide).toContain('pixel.wang-terrain.stroke');
    expect(guide).toContain('pixel.image-collection.create');
    expect(guide).toContain('pixel.image-collection.append');
    expect(guide).toContain('pixel.image-collection.source.replace');
    expect(guide).toContain('pixel.image-collection.source.remove');
    expect(guide).toContain('pixel.image-collection.tile.move');
    expect(guide).toContain('pixel.tile-object.create');
    expect(guide).toContain('intent-derived deterministic stream');
    expect(guide).toContain('every shape defaults to a visible 1 px black round stroke');
    expect(guide).toContain('line and arrow shapes default to no fill');
    expect(guide).toContain('polygon sides to 6');
    expect(guide).toContain('star sides/innerRadius to 5/0.45');
    expect(guide).toContain('derive closed from the final Z command');
    expect(guide).toContain('Arc flags are literal one-character 0/1 grammar terminals');
    expect(guide).toContain('Exact repeated references to one unchanged asset reuse one inspected buffer and supervised decode');
    expect(guide).toContain('refuses a seventeenth distinct image projection before base64 decoding or hashing');
    expect(guide).toContain('require one simple subpath retaining 2–7,000 effective native nodes after actual arc conversion and close coalescing inside the 1,000,000-character ceiling');
    expect(guide).toContain('Every arc command needs endpoints at least 0.000002 document units apart');
    expect(guide).toContain('every nonzero-radius arc must span more than 0.00001 degrees after ellipse normalization');
    expect(guide).toContain('exact recovered document incarnation across engine restart');
    expect(guide).toContain('replacement requires those subtype values explicitly');
    expect(guide).toContain('delete/undo remains available for readable legacy/imported objects');
    expect(guide).toContain('source dimensions are derived from its bytes');
    expect(guide).toContain('groupIndex is accepted only with parentGroupId');
    expect(guide).not.toContain('Shapes default to a solid black fill and no stroke');
    const safetyHelp = await callTool(started.url, client.headers, 13, 'aidraw_help', { topic: 'safety' });
    expect(safetyHelp.steps).toEqual(expect.arrayContaining([
      expect.stringContaining('direct HTTP 401 means an explicit QA bearer'),
      expect.stringContaining('unchanged AIDraw stdio bridge'),
      expect.stringContaining('HTTP 404 unknown_session is a stale process-lifetime session'),
      expect.stringContaining('tool Invalid arguments'),
    ]));
    const operationsHelp = await callTool(started.url, client.headers, 14, 'aidraw_help', { topic: 'operations' });
    expect(operationsHelp.steps).toEqual(expect.arrayContaining([
      expect.stringContaining('pixel.wang-terrain.stroke requires one exact map'),
      expect.stringContaining('creates no revision for an unmatched or already-matching stroke'),
      expect.stringContaining('every shape defaults to a visible 1 px solid black round stroke'),
      expect.stringContaining('groupIndex is valid only together with parentGroupId'),
      expect.stringContaining('Arc flags are literal one-character 0/1 values'),
      expect.stringContaining('2–7,000 nodes retained by actual native arc conversion and close coalescing'),
      expect.stringContaining('each nonzero-radius arc must span more than 0.00001 degrees after ellipse normalization'),
      expect.stringContaining('Same-endpoint, eccentric native-collapsed arcs and closed geometry that collapses below two native nodes reject'),
      expect.stringContaining('Repeated references to one unchanged asset reuse one inspection buffer and supervised decode'),
      expect.stringContaining('admits at most 16 distinct projections before base64 decoding or hashing'),
      expect.stringContaining('Add-time geometry defaults do not apply to replacement'),
      expect.stringContaining('exact delete inverses remain undoable'),
      expect.stringContaining('tools/list publishes complete closed branches for pixel.cel.region'),
      expect.stringContaining('Derive nonzero GIDs from observed attached tilesets rather than guessing'),
    ]));
    const jobsHelp = await callTool(started.url, client.headers, 15, 'aidraw_help', { topic: 'jobs' });
    expect(jobsHelp.steps).toEqual(expect.arrayContaining([
      expect.stringContaining('Proven pre-dispatch abandonment reopens'),
      expect.stringContaining('otherwise fails as ambiguous without replay'),
      expect.stringContaining('Cancellation after dispatch remains pending until settlement'),
    ]));
    expect(JSON.stringify(operationsHelp.examples)).toContain('pixel.wang-terrain.stroke');
    expect(JSON.stringify(operationsHelp.examples)).toContain('pixel.image-collection.create');
    expect(JSON.stringify(operationsHelp.examples)).toContain('pixel.image-collection.source.replace');
    expect(JSON.stringify(operationsHelp.examples)).toContain('pixel.image-collection.source.remove');
    expect(JSON.stringify(operationsHelp.examples)).toContain('pixel.image-collection.tile.move');
    expect(JSON.stringify(operationsHelp.examples)).toContain('pixel.tile-object.create');
    expect(JSON.stringify(operationsHelp.examples)).toContain('pixel.cel.region');
    expect(JSON.stringify(operationsHelp.examples)).toContain('pixel.tile-stamp.place');
    const filesHelp = await callTool(started.url, client.headers, 16, 'aidraw_help', { topic: 'files' });
    expect(filesHelp.steps).toEqual(expect.arrayContaining([
      expect.stringContaining('Automatic stdio MCP connection grants no file authority'),
      expect.stringContaining('--trust-folder option is run-scoped launch authority'),
      expect.stringContaining('not a zero-per-launch file-access promise'),
    ]));
  });

  it('lets a clean public client discover, author, revise, save, and export editable vector objects without metadata placeholders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-public-vector-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('public-vector-token');
    const client = await initializeClient(started.url, 'public-vector-token', 'public-vector-client');
    const joined = await callTool(started.url, client.headers, 2, 'session_manage', { action: 'join', name: 'Public vector agent', color: '#5177cc' });
    const actorId = String((joined.actor as { id: string }).id);
    const created = await callTool(started.url, client.headers, 3, 'document_manage', { action: 'new', kind: 'illustration', name: 'Public vector board', width: 640, height: 480, background: null });
    const documentId = String((created.activeDocument as { id: string }).id);
    const before = await callTool(started.url, client.headers, 4, 'canvas_observe', { documentId });
    const beforeDocument = before.document as { revision: number; layers: Record<string, { id: string; type: string }> };
    const layer = Object.values(beforeDocument.layers).find((entry) => entry.type === 'vector');
    if (!layer) throw new Error('Public vector workflow did not discover a vector layer.');

    const operationsHelp = await callTool(started.url, client.headers, 5, 'aidraw_help', { topic: 'operations' });
    expect(operationsHelp.steps).toEqual(expect.arrayContaining([
      expect.stringContaining('illustration.object.add'),
      expect.stringContaining('server-owned revision'),
      expect.stringContaining('copy the complete observed object'),
    ]));
    expect(JSON.stringify(operationsHelp.examples)).toContain('Public rectangle');

    const added = await callTool(started.url, client.headers, 6, 'canvas_apply', {
      documentId,
      clientOperationId: 'public-vector-add-v1',
      label: 'Author public editable vectors',
      playback: { mode: 'instant', speed: 1 },
      operations: [
        { kind: 'illustration.object.add', object: { id: 'public-rectangle', name: 'Public rectangle', layerId: layer.id, type: 'shape', shape: 'rectangle', width: 180, height: 96, transform: { x: 40, y: 50 }, fill: { kind: 'solid', color: '#8268dd' } } },
        { kind: 'illustration.object.add', object: { id: 'public-path', name: 'Public path', layerId: layer.id, type: 'path', pathData: 'M 20 20 C 80 0 120 100 180 40' } },
        { kind: 'illustration.object.add', object: { id: 'public-stroke', name: 'Public stroke', layerId: layer.id, type: 'vector-stroke', points: [{ x: 20, y: 220 }, { x: 100, y: 250, pressure: 0.8 }, { x: 200, y: 210 }] } },
        { kind: 'illustration.object.add', object: { id: 'public-text', name: 'Public text', layerId: layer.id, type: 'text', text: 'Editable' } },
        { kind: 'illustration.object.add', object: { id: 'public-group', name: 'Public group', layerId: layer.id, type: 'group', childIds: ['public-rectangle', 'public-path'] } },
      ],
    });
    expect(added).toMatchObject({ status: 'committed', revision: beforeDocument.revision + 1 });

    const afterAdd = await callTool(started.url, client.headers, 7, 'canvas_observe', { documentId });
    const authored = (afterAdd.document as { objects: Record<string, Record<string, unknown>> }).objects;
    expect(authored['public-rectangle']).toMatchObject({
      id: 'public-rectangle', name: 'Public rectangle', createdBy: actorId, revision: 0, visible: true, locked: false, opacity: 1, blendMode: 'normal',
      transform: { x: 40, y: 50, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
      fill: { kind: 'solid', color: '#8268dd' }, stroke: { paint: { kind: 'solid', color: '#000000' }, width: 1, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    });
    expect(authored['public-path']).toMatchObject({ fill: { kind: 'none' }, stroke: { paint: { kind: 'solid', color: '#000000' }, width: 1 }, closed: false, fillRule: 'nonzero' });
    expect(authored['public-stroke']).toMatchObject({ brush: { size: 4, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true, color: '#000000' }, points: [{ x: 20, y: 220, pressure: 0.5 }, { x: 100, y: 250, pressure: 0.8 }, { x: 200, y: 210, pressure: 0.5 }] });
    expect(authored['public-text']).toMatchObject({ width: 600, height: 80, align: 'left', lineHeight: 1.2, ranges: [] });
    expect(authored['public-group']).toMatchObject({ type: 'group', childIds: ['public-rectangle', 'public-path'] });
    for (const object of Object.values(authored).filter((entry) => String(entry.id).startsWith('public-'))) {
      expect(object.createdAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
      expect(object.updatedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    }

    const rectangle = structuredClone(authored['public-rectangle']);
    rectangle.fill = { kind: 'solid', color: '#ff6b7a' };
    const replaced = await callTool(started.url, client.headers, 8, 'canvas_apply', {
      documentId,
      clientOperationId: 'public-vector-replace-v1',
      label: 'Revise public rectangle',
      playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'illustration.object.replace', object: rectangle, expectedRevision: rectangle.revision }],
    });
    expect(replaced).toMatchObject({ status: 'committed', revision: Number(afterAdd.revision) + 1 });
    const afterReplace = await callTool(started.url, client.headers, 9, 'canvas_observe', { documentId });
    expect(((afterReplace.document as { objects: Record<string, Record<string, unknown>> }).objects['public-rectangle'])).toMatchObject({ revision: 1, createdBy: actorId, fill: { kind: 'solid', color: '#ff6b7a' } });

    const invalidRevision = Number(afterReplace.revision);
    for (const [id, object] of [
      ['unknown-field', { id: 'public-invalid-extra', name: 'Invalid extra', layerId: layer.id, type: 'shape', shape: 'rectangle', width: 10, height: 10, surprise: true }],
      ['invalid-stroke', { id: 'public-invalid-stroke', name: 'Invalid stroke', layerId: layer.id, type: 'path', pathData: 'M0 0 L10 10', stroke: { paint: { kind: 'solid', color: '#000000' }, width: -1, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } }],
    ] as const) {
      const rejected = await callToolMessage(started.url, client.headers, id === 'unknown-field' ? 10 : 11, 'canvas_apply', {
        documentId, clientOperationId: `public-vector-reject-${id}`, label: `Reject ${id}`, operations: [{ kind: 'illustration.object.add', object }],
      });
      expect(rejected.result?.isError).toBe(true);
      expect(JSON.stringify(rejected)).toContain('Invalid arguments');
    }
    expect((await callTool(started.url, client.headers, 12, 'canvas_observe', { documentId })).revision).toBe(invalidRevision);

    const savePath = join(root, 'public-vector.aidraw');
    const exportPath = join(root, 'public-vector.svg');
    const save = await callTool(started.url, client.headers, 13, 'document_manage', { action: 'save-as', documentId, path: savePath });
    const exported = await callTool(started.url, client.headers, 14, 'document_export', { documentId, path: exportPath, format: 'svg', scale: 1 });
    expect(save).toMatchObject({ status: 'waiting-for-user', jobId: expect.any(String) });
    expect(exported).toMatchObject({ status: 'waiting-for-user', jobId: expect.any(String) });
    expect(await callTool(started.url, client.headers, 15, 'job_manage', { action: 'cancel', jobId: save.jobId })).toMatchObject({ status: 'cancelled' });
    expect(await callTool(started.url, client.headers, 16, 'job_manage', { action: 'cancel', jobId: exported.jobId })).toMatchObject({ status: 'cancelled' });
    await expect(access(savePath)).rejects.toThrow();
    await expect(access(exportPath)).rejects.toThrow();
  });

  it('rejects malformed public illustration objects without a revision and renders/exports only byte-bound canonical geometry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-public-geometry-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const sourceDocument = createIllustrationDocument('Public geometry boundary');
    sourceDocument.assets['metadata-only-image'] = { id: 'metadata-only-image', name: 'Recovered missing payload', mimeType: 'image/png', byteLength: 0, sha256: '0'.repeat(64), source: 'embedded' };
    documents.addDocument(sourceDocument);
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('public-geometry-token');
    const client = await initializeClient(started.url, 'public-geometry-token', 'public-geometry-client');
    const layer = Object.values(sourceDocument.layers).find((entry) => entry.type === 'vector');
    if (!layer) throw new Error('Expected vector layer');

    const source = createCanvas(4, 3); const sourceContext = source.getContext('2d'); sourceContext.fillStyle = '#e5b84b'; sourceContext.fillRect(0, 0, 4, 3);
    const bytes = source.toBuffer('image/png');
    const asset = { id: 'public-image-bytes', name: 'Public image bytes', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', data: bytes.toString('base64') };
    expect(await callTool(started.url, client.headers, 2, 'canvas_apply', {
      documentId: sourceDocument.id, clientOperationId: 'public-geometry-asset', label: 'Add validated image source', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'asset.add', asset }],
    })).toMatchObject({ status: 'committed' });

    let requestId = 3;
    const expectRejectedWithoutMutation = async (clientOperationId: string, operation: Record<string, unknown>) => {
      const before = documents.getDocument(sourceDocument.id)!;
      const message = await callToolMessage(started.url, client.headers, requestId++, 'canvas_apply', {
        documentId: sourceDocument.id, clientOperationId, label: `Reject ${clientOperationId}`, playback: { mode: 'instant', speed: 1 }, operations: [operation],
      });
      expect(message.result?.isError, JSON.stringify(message)).toBe(true);
      expect(documents.getDocument(sourceDocument.id)).toEqual(before);
    };
    const objectBase = { name: 'Rejected object', layerId: layer.id };
    await expectRejectedWithoutMutation('invalid-svg-path', { kind: 'illustration.object.add', object: { ...objectBase, id: 'invalid-svg-path', type: 'path', pathData: 'not-valid-path-data' } });
    await expectRejectedWithoutMutation('inconsistent-path-closure', { kind: 'illustration.object.add', object: { ...objectBase, id: 'inconsistent-path-closure', type: 'path', pathData: 'M0 0 L10 0', closed: true } });
    await expectRejectedWithoutMutation('exponent-arc-flag', { kind: 'illustration.object.add', object: { ...objectBase, id: 'exponent-arc-flag', type: 'path', pathData: 'M0 0 A1 2 0 1e0 0 3 4' } });
    await expectRejectedWithoutMutation('decimal-arc-flag', { kind: 'illustration.object.add', object: { ...objectBase, id: 'decimal-arc-flag', type: 'path', pathData: 'M0 0 A1 2 0 0.0 1 3 4' } });
    await expectRejectedWithoutMutation('signed-arc-flag', { kind: 'illustration.object.add', object: { ...objectBase, id: 'signed-arc-flag', type: 'path', pathData: 'M0 0 A1 2 0 -0 1 3 4' } });
    for (const [id, pathData] of [
      ['coincident-closed-line', 'M0 0 L0 0 Z'],
      ['epsilon-closed-line', 'M0 0 L0.00000001 0 Z'],
      ['closed-curve-to-start', 'M0 0 C1 1 2 2 0 0 Z'],
      ['zero-displacement-arc', 'M0 0 A10 10 0 0 1 0 0'],
      ['native-collapsed-tiny-arc', 'M0 0 A10 10 0 0 1 0.000001 0'],
    ]) {
      await expectRejectedWithoutMutation(id, { kind: 'illustration.object.add', object: { ...objectBase, id, type: 'path', pathData } });
    }
    const overEditingLimit = `M0 0 A1 1 0 0 1 2 2 ${'L0 0 '.repeat(200_000)}`;
    expect(overEditingLimit.length).toBeGreaterThan(1_000_000);
    await expectRejectedWithoutMutation('path-above-editing-limit', { kind: 'illustration.object.add', object: { ...objectBase, id: 'path-above-editing-limit', type: 'path', pathData: overEditingLimit } });
    await expectRejectedWithoutMutation('missing-image-asset', { kind: 'illustration.object.add', object: { ...objectBase, id: 'missing-image-asset', type: 'image', assetId: 'does-not-exist', width: 20, height: 10 } });
    await expectRejectedWithoutMutation('missing-image-payload', { kind: 'illustration.object.add', object: { ...objectBase, id: 'missing-image-payload', type: 'image', assetId: 'metadata-only-image', width: 20, height: 10 } });
    await expectRejectedWithoutMutation('invalid-image-crop', { kind: 'illustration.object.add', object: { ...objectBase, id: 'invalid-image-crop', type: 'image', assetId: asset.id, width: 20, height: 10, crop: { x: 3, y: 1, width: 2, height: 2 } } });
    await expectRejectedWithoutMutation('partial-source-geometry', { kind: 'illustration.object.add', object: { ...objectBase, id: 'partial-source-geometry', type: 'image', assetId: asset.id, width: 20, height: 10, sourceWidth: 4 } });
    await expectRejectedWithoutMutation('irrelevant-shape-field', { kind: 'illustration.object.add', object: { ...objectBase, id: 'irrelevant-shape-field', type: 'shape', shape: 'rectangle', width: 20, height: 10, sides: 7 } });
    await expectRejectedWithoutMutation('orphan-add-group-index', { kind: 'illustration.object.add', groupIndex: 0, object: { ...objectBase, id: 'orphan-add-group-index', type: 'shape', shape: 'rectangle', width: 20, height: 10 } });
    await expectRejectedWithoutMutation('orphan-move-group-index', { kind: 'illustration.object.move', objectId: 'not-dispatched', layerId: layer.id, groupIndex: 0, expectedRevision: 0 });

    const added = await callTool(started.url, client.headers, requestId++, 'canvas_apply', {
      documentId: sourceDocument.id, clientOperationId: 'valid-public-geometry', label: 'Add validated public geometry', playback: { mode: 'instant', speed: 1 },
      operations: [
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'validated-closed-path', name: 'Validated closed path', type: 'path', pathData: 'M 10 10 L 70 10 L 70 60 Z' } },
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'compact-arc-path', name: 'Compact arc path', type: 'path', pathData: 'M0 0 A20 10 30 0140 20', transform: { x: 10, y: 90 } } },
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'spaced-compact-arc-path', name: 'Spaced compact arc path', type: 'path', pathData: 'M0 0 A20 10 30 01 40 20', transform: { x: 30, y: 90 } } },
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'strict-rectangle', name: 'Strict rectangle', type: 'shape', shape: 'rectangle', width: 40, height: 30, transform: { x: 10, y: 120 } } },
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'strict-ellipse', name: 'Strict ellipse', type: 'shape', shape: 'ellipse', width: 40, height: 30, transform: { x: 60, y: 120 } } },
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'strict-line', name: 'Strict line', type: 'shape', shape: 'line', width: 40, height: 30, transform: { x: 110, y: 120 } } },
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'strict-arrow', name: 'Strict arrow', type: 'shape', shape: 'arrow', width: 40, height: 30, transform: { x: 160, y: 120 } } },
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'default-polygon', name: 'Default polygon', type: 'shape', shape: 'polygon', width: 60, height: 60, transform: { x: 90, y: 10 } } },
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'default-star', name: 'Default star', type: 'shape', shape: 'star', width: 60, height: 60, transform: { x: 170, y: 10 } } },
        { kind: 'illustration.object.add', object: { ...objectBase, id: 'validated-image', name: 'Validated image', type: 'image', assetId: asset.id, width: 40, height: 20, transform: { x: 250, y: 10 }, crop: { x: 1, y: 1, width: 2, height: 1 } } },
      ],
    });
    expect(added).toMatchObject({ status: 'committed' });
    const committed = documents.getDocument(sourceDocument.id);
    if (!committed || committed.kind !== 'illustration') throw new Error('Expected canonical illustration');
    expect(committed.objects['validated-closed-path']).toMatchObject({ closed: true });
    expect(committed.objects['compact-arc-path']).toMatchObject({ pathData: 'M0 0 A20 10 30 0140 20', closed: false });
    expect(committed.objects['spaced-compact-arc-path']).toMatchObject({ pathData: 'M0 0 A20 10 30 01 40 20', closed: false });
    expect(committed.objects['default-polygon']).toMatchObject({ shape: 'polygon', sides: 6 });
    expect(committed.objects['default-star']).toMatchObject({ shape: 'star', sides: 5, innerRadius: 0.45 });
    expect(committed.objects['validated-image']).toMatchObject({ sourceWidth: 4, sourceHeight: 3, crop: { x: 1, y: 1, width: 2, height: 1 } });
    const degenerateReplacement = structuredClone(committed.objects['compact-arc-path']);
    if (degenerateReplacement.type !== 'path') throw new Error('Expected replaceable compact arc');
    degenerateReplacement.pathData = 'M0 0 A10 10 0 0 1 0.000001 0';
    await expectRejectedWithoutMutation('native-collapsed-path-replacement', {
      kind: 'illustration.object.replace', object: degenerateReplacement, expectedRevision: degenerateReplacement.revision,
    });
    expect(await callTool(started.url, client.headers, requestId++, 'canvas_apply', {
      documentId: sourceDocument.id, clientOperationId: 'convert-admitted-compact-arcs', label: 'Convert compact arcs', playback: { mode: 'instant', speed: 1 },
      operations: [
        { kind: 'illustration.path.arcs.convert', objectId: 'compact-arc-path', expectedRevision: 0 },
        { kind: 'illustration.path.arcs.convert', objectId: 'spaced-compact-arc-path', expectedRevision: 0 },
      ],
    })).toMatchObject({ status: 'committed' });
    const convertedDocument = documents.getDocument(sourceDocument.id);
    if (!convertedDocument || convertedDocument.kind !== 'illustration') throw new Error('Expected converted compact arcs');
    expect(convertedDocument.objects['compact-arc-path'].type === 'path' ? convertedDocument.objects['compact-arc-path'].pathData : '').not.toMatch(/[aA]/);
    expect(convertedDocument.objects['spaced-compact-arc-path'].type === 'path' ? convertedDocument.objects['spaced-compact-arc-path'].pathData : '').not.toMatch(/[aA]/);
    for (const [clientOperationId, objectId, omittedField] of [
      ['incomplete-rectangle-replace', 'strict-rectangle', 'cornerRadius'],
      ['incomplete-polygon-replace', 'default-polygon', 'sides'],
      ['incomplete-star-sides-replace', 'default-star', 'sides'],
      ['incomplete-star-radius-replace', 'default-star', 'innerRadius'],
    ] as const) {
      const object = structuredClone(convertedDocument.objects[objectId]) as unknown as Record<string, unknown>;
      delete object[omittedField];
      await expectRejectedWithoutMutation(clientOperationId, { kind: 'illustration.object.replace', object, expectedRevision: object.revision });
    }
    for (const objectId of ['strict-line', 'strict-arrow']) {
      const object = structuredClone(convertedDocument.objects[objectId]);
      if (object.type !== 'shape') throw new Error('Expected open shape');
      object.fill = { kind: 'solid', color: '#ff6b7a' };
      await expectRejectedWithoutMutation(`inert-fill-${objectId}`, { kind: 'illustration.object.replace', object, expectedRevision: object.revision });
    }
    const forbiddenShapeFields = [
      ['strict-rectangle', 'sides', 7],
      ['strict-ellipse', 'cornerRadius', 4],
      ['strict-line', 'innerRadius', 0.4],
      ['strict-arrow', 'sides', 7],
      ['default-polygon', 'innerRadius', 0.4],
      ['default-star', 'cornerRadius', 4],
    ] as const;
    for (const [objectId, field, value] of forbiddenShapeFields) {
      const current = documents.getDocument(sourceDocument.id);
      if (!current || current.kind !== 'illustration') throw new Error('Expected shape replacement document');
      const object = structuredClone(current.objects[objectId]) as unknown as Record<string, unknown>;
      object[field] = value;
      await expectRejectedWithoutMutation(`irrelevant-replace-${objectId}`, { kind: 'illustration.object.replace', object, expectedRevision: object.revision });
    }
    const beforeValidReplacements = documents.getDocument(sourceDocument.id);
    if (!beforeValidReplacements || beforeValidReplacements.kind !== 'illustration') throw new Error('Expected shape replacement document');
    expect(await callTool(started.url, client.headers, requestId++, 'canvas_apply', {
      documentId: sourceDocument.id, clientOperationId: 'valid-shape-subtype-replacements', label: 'Replace every strict shape subtype', playback: { mode: 'instant', speed: 1 },
      operations: forbiddenShapeFields.map(([objectId]) => {
        const object = structuredClone(beforeValidReplacements.objects[objectId]);
        object.transform.x += 1;
        return { kind: 'illustration.object.replace', object, expectedRevision: object.revision };
      }),
    })).toMatchObject({ status: 'committed' });
    const finalDocument = documents.getDocument(sourceDocument.id);
    if (!finalDocument || finalDocument.kind !== 'illustration') throw new Error('Expected final canonical illustration');
    await expect(renderIllustration(finalDocument)).resolves.toBeTruthy();
    const svg = illustrationToSvg(finalDocument);
    expect(svg).toContain('d="M 10 10 L 70 10 L 70 60 Z"');
    expect(finalDocument.objects['compact-arc-path'].type === 'path' ? finalDocument.objects['compact-arc-path'].pathData : '').not.toMatch(/[aA]/);
    expect(finalDocument.objects['spaced-compact-arc-path'].type === 'path' ? finalDocument.objects['spaced-compact-arc-path'].pathData : '').not.toMatch(/[aA]/);
    expect(svg).toContain('data-aidraw-source-width="4"');
    expect(svg).toContain('data-aidraw-source-height="3"');
  });

  it('decodes one projected image asset once across the maximum public transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-image-cache-')); temporaryPaths.push(root);
    const decoder = vi.fn(async () => undefined);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', undefined, decoder); documents.initialize();
    const document = createIllustrationDocument('Public image cache');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer) throw new Error('Expected vector layer');
    const canvas = createCanvas(1, 1); canvas.getContext('2d').fillRect(0, 0, 1, 1);
    const bytes = canvas.toBuffer('image/png');
    const asset = { id: 'public-shared-image', name: 'Shared image', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', data: bytes.toString('base64') } as const;
    document.assets[asset.id] = asset;
    documents.addDocument(document);
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('public-image-cache-token');
    const client = await initializeClient(started.url, 'public-image-cache-token', 'public-image-cache-client');
    const response = await callTool(started.url, client.headers, 2, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'public-image-cache-256', label: 'Reuse one public image asset', playback: { mode: 'instant', speed: 1 },
      operations: Array.from({ length: 256 }, (_, index) => ({
        kind: 'illustration.object.add',
        object: { id: `public-shared-image-${index}`, name: `Shared image ${index}`, layerId: layer.id, type: 'image', assetId: asset.id, width: 1, height: 1, transform: { x: index % 32, y: Math.floor(index / 32) } },
      })),
    });
    expect(response).toMatchObject({ status: 'committed' });
    expect(decoder).toHaveBeenCalledOnce();
    const committed = documents.getDocument(document.id);
    expect(committed?.kind === 'illustration' ? Object.keys(committed.objects).filter((id) => id.startsWith('public-shared-image-')) : []).toHaveLength(256);
  });

  it('rejects the seventeenth public image projection before its bytes are decoded or hashed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-image-preflight-')); temporaryPaths.push(root);
    const decoder = vi.fn(async () => undefined);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', undefined, decoder); documents.initialize();
    const document = createIllustrationDocument('Public image preflight');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer) throw new Error('Expected vector layer');
    const canvas = createCanvas(1, 1); canvas.getContext('2d').fillRect(0, 0, 1, 1);
    const bytes = canvas.toBuffer('image/png'); const data = bytes.toString('base64'); const digest = createHash('sha256').update(bytes).digest('hex');
    for (let index = 0; index < 17; index += 1) {
      const id = `public-distinct-image-${index}`;
      document.assets[id] = {
        id, name: `Distinct image ${index}`, mimeType: 'image/png', byteLength: bytes.byteLength,
        sha256: index === 16 ? '0'.repeat(64) : digest, source: 'embedded', data,
      };
    }
    documents.addDocument(document);
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('public-image-preflight-token');
    const client = await initializeClient(started.url, 'public-image-preflight-token', 'public-image-preflight-client');
    const before = documents.getDocument(document.id);
    const message = await callToolMessage(started.url, client.headers, 2, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'public-image-preflight-17', label: 'Reject excessive public image work', playback: { mode: 'instant', speed: 1 },
      operations: Array.from({ length: 17 }, (_, index) => ({
        kind: 'illustration.object.add',
        object: { id: `public-distinct-object-${index}`, name: `Distinct object ${index}`, layerId: layer.id, type: 'image', assetId: `public-distinct-image-${index}`, width: 1, height: 1 },
      })),
    });
    expect(message.result?.isError, JSON.stringify(message)).toBe(true);
    expect(JSON.stringify(message)).toContain('at most 16 distinct image-asset projections');
    expect(JSON.stringify(message)).not.toContain('public-distinct-image-16 SHA-256');
    expect(decoder).not.toHaveBeenCalled();
    expect(documents.getDocument(document.id)).toEqual(before);
  });

  it('initializes the same raw Streamable HTTP profile under each configured client name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-clients-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('cross-client-token');
    for (const clientName of ['Codex', 'Claude Code', 'OpenCode', 'Antigravity']) {
      const client = await initializeClient(started.url, 'cross-client-token', clientName);
      const listed = await fetch(started.url, { method: 'POST', headers: client.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
      const tools = (parseMcp(await listed.text()).result?.tools ?? []) as Array<{ name: string }>;
      expect(tools.map((tool) => tool.name), clientName).toContain('canvas_apply');
    }
  });

  it('caps concurrent clients at 32, retires terminated sessions, and preserves resources plus idempotent transactions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root); const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); documents.initialize(); const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('parallel-token');
    const attempts = await Promise.all(Array.from({ length: 33 }, async (_, index) => {
      const response = await fetch(started.url, { method: 'POST', headers: { authorization: 'Bearer parallel-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: `client-${index}`, version: '1.0.0' } } }) });
      return { status: response.status, sessionId: response.headers.get('mcp-session-id'), cacheControl: response.headers.get('cache-control'), body: await response.text() };
    }));
    const accepted = attempts.filter((attempt) => attempt.status === 200); const refused = attempts.filter((attempt) => attempt.status === 429);
    expect(accepted).toHaveLength(32); expect(new Set(accepted.map((attempt) => attempt.sessionId)).size).toBe(32); expect(accepted.every((attempt) => parseMcp(attempt.body).result?.protocolVersion === LATEST_PROTOCOL_VERSION)).toBe(true);
    expect(refused).toHaveLength(1); expect(refused[0]).toMatchObject({ sessionId: null, cacheControl: 'no-store' }); expect(JSON.parse(refused[0].body)).toEqual({ error: 'session_limit_reached', limit: 32, message: 'Terminate an existing MCP session with authenticated DELETE before retrying.' });
    const clients = accepted.map((attempt) => {
      const protocolVersion = parseMcp(attempt.body).result?.protocolVersion;
      if (typeof protocolVersion !== 'string') throw new Error('Parallel MCP initialize did not return a negotiated protocol version.');
      return { sessionId: attempt.sessionId!, headers: { authorization: 'Bearer parallel-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': attempt.sessionId!, 'mcp-protocol-version': protocolVersion } };
    });
    await Promise.all(clients.map((client) => fetch(started.url, { method: 'POST', headers: client.headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })));
    const first = clients[0]; const resource = await fetch(started.url, { method: 'POST', headers: first.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'aidraw://documents' } }) }); expect(parseMcp(await resource.text()).result).toBeTruthy();
    const document = documents.snapshot().activeDocument!; const params = { name: 'canvas_apply', arguments: { documentId: document.id, clientOperationId: 'mcp-idempotent-op', label: 'MCP rename', operations: [{ kind: 'document.rename', name: 'Shared drawing' }], playback: { mode: 'instant', speed: 1 } } };
    const apply = async (id: number) => parseMcp(await (await fetch(started.url, { method: 'POST', headers: first.headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }) })).text());
    expect(toolPayload(await apply(3)).status).toBe('committed'); expect(toolPayload(await apply(4)).status).toBe('duplicate'); expect(documents.getDocument(document.id)?.name).toBe('Shared drawing');
    const traceResponse = await fetch(started.url, { method: 'POST', headers: first.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: `aidraw://documents/${document.id}/trace` } }) });
    const traceMessage = parseMcp(await traceResponse.text()); const traceContents = traceMessage.result?.contents as Array<{ text?: string }> | undefined;
    expect(traceContents?.[0]?.text).toContain('mcp-idempotent-op');
    const joined = await callTool(started.url, first.headers, 6, 'session_manage', { action: 'join', name: 'Capacity probe' }); const retiredActorId = String((joined.actor as { id: string }).id);
    const terminated = await fetch(started.url, { method: 'DELETE', headers: first.headers }); expect(terminated.status).toBe(200);
    expect(documents.getMcpInfo().sessions.map((entry) => entry.actor.id)).not.toContain(retiredActorId);
    const stale = await fetch(started.url, { method: 'POST', headers: first.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }) });
    expect(stale.status).toBe(404);
    expect(stale.headers.get('cache-control')).toBe('no-store');
    expectTransportDiagnostic(await stale.json(), 'unknown_session', 'process-lifetime MCP session is unknown or stale', 'Discard Mcp-Session-Id');
    const replacement = await initializeClient(started.url, 'parallel-token', 'replacement-client'); expect(replacement.sessionId).not.toBe(first.sessionId);
  });

  it('serves manifest/snapshot/change resources and emits negotiated resource updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root); const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); documents.initialize(); const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('subscription-token'); const client = await initializeClient(started.url, 'subscription-token', 'subscription-client'); const document = documents.snapshot().activeDocument!;
    const readResource = async (id: number, uri: string) => parseMcp(await (await fetch(started.url, { method: 'POST', headers: client.headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri } }) })).text());
    const manifest = await readResource(2, `aidraw://documents/${document.id}/manifest`); expect(JSON.parse(String((manifest.result?.contents as Array<{ text: string }>)[0].text))).toMatchObject({ id: document.id, revision: document.revision, kind: document.kind });
    const snapshot = await readResource(3, `aidraw://documents/${document.id}/snapshot`); expect(JSON.parse(String((snapshot.result?.contents as Array<{ text: string }>)[0].text))).toMatchObject({ id: document.id, revision: document.revision });
    const controller = new AbortController(); const events = await fetch(started.url, { method: 'GET', headers: client.headers, signal: controller.signal }); expect(events.status).toBe(200);
    const subscribed = await fetch(started.url, { method: 'POST', headers: client.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/subscribe', params: { uri: `aidraw://documents/${document.id}/snapshot` } }) }); const subscribedMessage = parseMcp(await subscribed.text()); expect(subscribedMessage).toMatchObject({ result: {} });
    expect(await callTool(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'subscription-change', label: 'Subscription change', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'document.rename', name: 'Subscribed drawing' }] })).toMatchObject({ status: 'committed', revision: document.revision + 1 });
    const eventText = await readSseUntil(events, new RegExp(`notifications/resources/updated[\\s\\S]*${document.id}/snapshot`)); controller.abort(); expect(eventText).toContain(`aidraw://documents/${document.id}/snapshot`);
    const changes = await readResource(6, `aidraw://documents/${document.id}/changes/${document.revision}`); const changePayload = JSON.parse(String((changes.result?.contents as Array<{ text: string }>)[0].text)); expect(changePayload).toEqual([expect.objectContaining({ revision: document.revision + 1, transaction: expect.objectContaining({ documentId: document.id, clientOperationId: 'subscription-change' }) })]);
  });

  it('caps each session at 128 distinct resource subscriptions and frees capacity on unsubscribe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-subscription-cap-')); temporaryPaths.push(root); const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize(); const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('subscription-cap-token'); const client = await initializeClient(started.url, 'subscription-cap-token', 'subscription-cap-client'); const document = documents.snapshot().activeDocument!;
    const request = async (id: number, method: 'resources/subscribe' | 'resources/unsubscribe', uri: string) => parseMcp(await (await fetch(started.url, { method: 'POST', headers: client.headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { uri } }) })).text());
    const uris = Array.from({ length: 129 }, (_, index) => `aidraw://documents/${document.id}/changes/${index}`);
    for (let index = 0; index < 128; index += 1) expect(await request(index + 2, 'resources/subscribe', uris[index])).toMatchObject({ result: {} });
    expect(await request(130, 'resources/subscribe', uris[0])).toMatchObject({ result: {} });
    expect(JSON.stringify(await request(131, 'resources/subscribe', uris[128]))).toContain('at most 128 AIDraw resources');
    expect(await request(132, 'resources/unsubscribe', uris[0])).toMatchObject({ result: {} });
    expect(await request(133, 'resources/subscribe', uris[128])).toMatchObject({ result: {} });
  });

  it('lets an authenticated agent start one bounded non-mutating durable trace replay with explicit busy state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root); const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); documents.initialize(); const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('replay-token'); const client = await initializeClient(started.url, 'replay-token', 'replay-client'); const document = documents.snapshot().activeDocument!;
    const first = await callTool(started.url, client.headers, 2, 'canvas_apply', { documentId: document.id, clientOperationId: 'replay-source-one', label: 'Replay source one', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'document.rename', name: 'Replay source one' }] });
    const second = await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'replay-source-two', label: 'Replay source two', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'document.rename', name: 'Replay source two' }] });
    const revision = documents.getDocument(document.id)!.revision;
    const replayed = await callTool(started.url, client.headers, 4, 'history_manage', { action: 'replay', documentId: document.id, transactionId: first.transactionId });
    expect(replayed).toMatchObject({ replaying: true, documentId: document.id, transactionId: first.transactionId });
    expect(await callTool(started.url, client.headers, 5, 'history_manage', { action: 'replay', documentId: document.id, transactionId: first.transactionId })).toMatchObject({ replaying: false, reason: 'already-replaying' });
    expect(await callTool(started.url, client.headers, 6, 'history_manage', { action: 'replay', documentId: document.id, transactionId: second.transactionId })).toMatchObject({ replaying: false, reason: 'replay-busy' });
    expect(documents.getDocument(document.id)!.revision).toBe(revision);
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(documents.getDocument(document.id)!.revision).toBe(revision);
  });

  it('creates, visually observes, restores, and retains named agent checkpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('checkpoint-token'); const client = await initializeClient(started.url, 'checkpoint-token', 'checkpoint-client');
    const document = documents.snapshot().activeDocument!;
    const created = await callTool(started.url, client.headers, 2, 'history_manage', { action: 'checkpoint-create', documentId: document.id, name: 'Agent baseline' });
    const checkpoint = created.checkpoint as { id: string; sourceRevision: number };
    expect(checkpoint).toMatchObject({ sourceRevision: document.revision });
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'checkpoint-risky-branch', label: 'Risky branch', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'document.rename', name: 'Experimental branch' }] })).toMatchObject({ status: 'committed' });
    const observed = await callTool(started.url, client.headers, 4, 'canvas_observe', { documentId: document.id, checkpointId: checkpoint.id, includePng: true, scale: 1, background: 'document' });
    expect(observed).toMatchObject({ checkpoint: { id: checkpoint.id, name: 'Agent baseline' }, document: { name: document.name }, currentRevision: document.revision + 1, png: { mimeType: 'image/png' } });
    expect(await callTool(started.url, client.headers, 5, 'history_manage', { action: 'checkpoint-restore', documentId: document.id, checkpointId: checkpoint.id })).toMatchObject({ status: 'committed', revision: document.revision + 2 });
    expect(documents.getDocument(document.id)?.name).toBe(document.name);
    const listed = await callTool(started.url, client.headers, 6, 'history_manage', { action: 'checkpoint-list', documentId: document.id });
    expect(listed.checkpoints).toEqual(expect.arrayContaining([expect.objectContaining({ id: checkpoint.id, kind: 'manual' }), expect.objectContaining({ kind: 'automatic', sourceRevision: document.revision + 1 })]));
    const checkpointDocument = documents.getCheckpoint(document.id, checkpoint.id)!.document; if (checkpointDocument.kind !== 'illustration') throw new Error('Expected illustration checkpoint');
    expect(await callTool(started.url, client.headers, 7, 'history_manage', { action: 'checkpoint-merge', documentId: document.id, checkpointId: checkpoint.id, sourceIds: [checkpointDocument.layerIds[0]] })).toMatchObject({ status: 'committed', revision: document.revision + 3 });
    const merged = documents.getDocument(document.id); if (!merged || merged.kind !== 'illustration') throw new Error('Expected illustration document'); expect(merged.layerIds).toHaveLength(checkpointDocument.layerIds.length + 1);
  });

  it('uses one complete new-document contract and reports explicit active workspace state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const options = { kind: 'tilemap' as const, name: 'Exact isometric map', width: 37, height: 29, orientation: 'isometric' as const, infinite: true, tileWidth: 24, tileHeight: 12 };
    const direct = documents.create(options).activeDocument!;
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('new-contract-token');
    const client = await initializeClient(started.url, 'new-contract-token', 'new-contract-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', ...options });
    const viaMcp = created.activeDocument as typeof direct;
    const project = (document: typeof direct) => {
      if (document.kind !== 'pixel') throw new Error('Expected pixel document');
      const map = document.pixelAssets[document.activeAssetId];
      if (map.type !== 'tilemap') throw new Error('Expected tilemap');
      return { documentName: document.name, scope: document.scope, standaloneType: document.standaloneType, width: map.width, height: map.height, orientation: map.orientation, infinite: map.infinite, tileWidth: map.tileWidth, tileHeight: map.tileHeight };
    };
    expect(project(viaMcp)).toEqual(project(direct));
    const listed = await callTool(started.url, client.headers, 3, 'document_manage', { action: 'list' });
    expect(listed.activeDocumentId).toBe(viaMcp.id);
    expect((listed.documents as Array<{ id: string }>).some((entry) => entry.id === viaMcp.id)).toBe(true);

    const illustration = await callTool(started.url, client.headers, 4, 'document_manage', { action: 'new', kind: 'illustration', name: 'Transparent board', width: 321, height: 123, background: null });
    expect(illustration.activeDocument).toMatchObject({ kind: 'illustration', name: 'Transparent board', artboard: { width: 321, height: 123, background: null } });
  });

  it('captures a bounded frame, layer, region, and integer nearest-neighbor scale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('observe-token');
    const client = await initializeClient(started.url, 'observe-token', 'observe-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'sprite', name: 'Observed sprite', width: 4, height: 4 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument'];
    if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const layerId = sprite.layerIds[0]; const firstCel = Object.values(sprite.cels)[0]; const timestamp = nowIso(); const secondFrameId = createId('frame'); const secondCelId = createId('cel');
    const applied = await callTool(started.url, client.headers, 3, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'two-frame-observation', label: 'Create a targeted frame', playback: { mode: 'instant', speed: 1 },
      operations: [
        { kind: 'pixel.cel.set', spriteId: sprite.id, celId: firstCel.id, changes: [{ x: 1, y: 1, index: 4 }] },
        { kind: 'pixel.frame.add', spriteId: sprite.id, frame: { id: secondFrameId, revision: 0, name: 'Frame 2', createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged', durationMs: 120 }, cels: [{ id: secondCelId, revision: 0, name: 'Frame 2 pixels', createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged', layerId, frameId: secondFrameId, chunks: {} }] },
        { kind: 'pixel.cel.set', spriteId: sprite.id, celId: secondCelId, changes: [{ x: 2, y: 2, index: 8 }] },
      ],
    });
    expect(applied.status).toBe('committed');
    const observed = await callTool(started.url, client.headers, 4, 'canvas_observe', {
      documentId: document.id, includePng: true, assetId: sprite.id, frameId: secondFrameId, layerId,
      region: { x: 2, y: 2, width: 1, height: 1 }, scale: 4, background: '#ffffff',
    });
    expect(observed.png).toMatchObject({ available: true, width: 4, height: 4, scale: 4, assetId: sprite.id, frameId: secondFrameId, layerId, region: { x: 2, y: 2, width: 1, height: 1 } });
    const data = Buffer.from((observed.png as { data: string }).data, 'base64');
    const image = await loadImage(data); const canvas = createCanvas(4, 4); const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    expect([...context.getImageData(1, 1, 1, 1).data]).toEqual([49, 166, 160, 255]);

    const compared = await callTool(started.url, client.headers, 5, 'canvas_observe', {
      documentId: document.id, includePng: true, assetId: sprite.id, frameId: sprite.frameIds[0], layerId,
      region: { x: 1, y: 1, width: 1, height: 1 }, scale: 1, background: '#ffffff', compareTransactionId: applied.transactionId,
    });
    expect(compared.png).toBeUndefined();
    expect(compared.comparison).toMatchObject({ available: true, transactionId: applied.transactionId, beforeRevision: 0, afterRevision: 1, before: { available: true, width: 1, height: 1 }, after: { available: true, width: 1, height: 1 } });
    const beforeImage = await loadImage(Buffer.from(((compared.comparison as { before: { data: string } }).before.data), 'base64'));
    const afterImage = await loadImage(Buffer.from(((compared.comparison as { after: { data: string } }).after.data), 'base64'));
    const pairCanvas = createCanvas(2, 1); const pairContext = pairCanvas.getContext('2d'); pairContext.drawImage(beforeImage, 0, 0); pairContext.drawImage(afterImage, 1, 0);
    expect([...pairContext.getImageData(0, 0, 2, 1).data]).toEqual([255, 255, 255, 255, 255, 107, 122, 255]);

    const oversized = await callTool(started.url, client.headers, 6, 'canvas_observe', {
      documentId: documents.getDocuments().find((entry) => entry.kind === 'illustration')!.id,
      includePng: true, region: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 2,
    });
    expect(oversized.png).toMatchObject({ error: 'observation_too_large', limit: { pixels: 4_194_304 } });
  });

  it('authors animation frames, links, tags, timing, ordering, and palette overrides through semantic operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('animation-token');
    const client = await initializeClient(started.url, 'animation-token', 'animation-client');
    const joined = await callTool(started.url, client.headers, 2, 'session_manage', { action: 'join', name: 'Animation agent', model: 'contract-model', reasoningEffort: 'high', taskId: 'animation-contract' });
    const actorId = String((joined.actor as { id: string }).id);
    const created = await callTool(started.url, client.headers, 3, 'document_manage', { action: 'new', kind: 'sprite', name: 'Semantic animation', width: 8, height: 8 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const initial = document.pixelAssets[document.activeAssetId]; if (initial.type !== 'sprite') throw new Error('Expected sprite');
    const firstFrameId = initial.frameIds[0]; const firstCel = Object.values(initial.cels)[0];
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'animation-source-pixel', label: 'Add source pixel', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.cel.set', spriteId: initial.id, celId: firstCel.id, changes: [{ x: 2, y: 3, index: 4 }], expectedRevision: firstCel.revision }] })).toMatchObject({ status: 'committed' });

    let currentDocument = documents.getDocument(document.id); if (!currentDocument || currentDocument.kind !== 'pixel') throw new Error('Expected pixel document'); let sprite = currentDocument.pixelAssets[initial.id]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(await callTool(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'animation-duplicate', label: 'Duplicate frame', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.frame.duplicate', spriteId: sprite.id, frameId: firstFrameId, expectedRevision: sprite.revision }] })).toMatchObject({ status: 'committed' });
    currentDocument = documents.getDocument(document.id); if (!currentDocument || currentDocument.kind !== 'pixel') throw new Error('Expected pixel document'); sprite = currentDocument.pixelAssets[initial.id]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const secondFrameId = sprite.frameIds[1]; const secondCel = Object.values(sprite.cels).find((cel) => cel.frameId === secondFrameId)!;
    expect(sprite.frames[secondFrameId]).toMatchObject({ createdBy: actorId, name: expect.stringContaining('copy') }); expect(readPixel(secondCel, 2, 3)).toBe(4);

    expect(await callTool(started.url, client.headers, 6, 'canvas_apply', { documentId: document.id, clientOperationId: 'animation-duration', label: 'Set frame duration', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.frame.duration.set', spriteId: sprite.id, frameId: secondFrameId, durationMs: 240, expectedRevision: sprite.frames[secondFrameId].revision }] })).toMatchObject({ status: 'committed' });
    currentDocument = documents.getDocument(document.id)!; if (currentDocument.kind !== 'pixel') throw new Error('Expected pixel document'); sprite = currentDocument.pixelAssets[initial.id]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(await callTool(started.url, client.headers, 7, 'canvas_apply', { documentId: document.id, clientOperationId: 'animation-link', label: 'Link frame cels', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.frame.cels.link', spriteId: sprite.id, frameId: secondFrameId, linked: true, expectedRevision: sprite.revision }] })).toMatchObject({ status: 'committed' });
    currentDocument = documents.getDocument(document.id)!; if (currentDocument.kind !== 'pixel') throw new Error('Expected pixel document'); sprite = currentDocument.pixelAssets[initial.id]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const linkedCel = Object.values(sprite.cels).find((cel) => cel.frameId === secondFrameId)!; expect(linkedCel.linkedToCelId).toBe(firstCel.id);

    const overrideColors = currentDocument.palette.map((entry, index) => index === 4 ? '#abcdef' : entry.color);
    expect(await callTool(started.url, client.headers, 8, 'canvas_apply', { documentId: document.id, clientOperationId: 'animation-palette', label: 'Set frame palette', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.palette-override.set', spriteId: sprite.id, frameId: secondFrameId, colors: overrideColors, expectedRevision: sprite.revision }] })).toMatchObject({ status: 'committed' });
    currentDocument = documents.getDocument(document.id)!; if (currentDocument.kind !== 'pixel') throw new Error('Expected pixel document'); sprite = currentDocument.pixelAssets[initial.id]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const tag = { id: 'semantic-loop', name: 'Reverse loop', fromFrameId: firstFrameId, toFrameId: secondFrameId, direction: 'reverse', color: '#31a6a0' };
    expect(await callTool(started.url, client.headers, 9, 'canvas_apply', { documentId: document.id, clientOperationId: 'animation-tag', label: 'Add animation tag', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.animation.tag.upsert', spriteId: sprite.id, tag, expectedRevision: sprite.revision }] })).toMatchObject({ status: 'committed' });
    currentDocument = documents.getDocument(document.id)!; if (currentDocument.kind !== 'pixel') throw new Error('Expected pixel document'); sprite = currentDocument.pixelAssets[initial.id]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(await callTool(started.url, client.headers, 10, 'canvas_apply', { documentId: document.id, clientOperationId: 'animation-move', label: 'Move frame left', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.frame.move', spriteId: sprite.id, frameId: secondFrameId, direction: 'left', expectedRevision: sprite.revision }] })).toMatchObject({ status: 'committed' });
    currentDocument = documents.getDocument(document.id)!; if (currentDocument.kind !== 'pixel') throw new Error('Expected pixel document'); sprite = currentDocument.pixelAssets[initial.id]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(sprite.frameIds[0]).toBe(secondFrameId); expect(sprite.frames[secondFrameId].durationMs).toBe(240); expect(sprite.paletteOverrides[secondFrameId][4].color).toBe('#abcdef'); expect(sprite.tags[0]).toMatchObject({ id: tag.id, fromFrameId: secondFrameId, toFrameId: firstFrameId });

    expect(await callTool(started.url, client.headers, 11, 'canvas_apply', { documentId: document.id, clientOperationId: 'animation-unlink', label: 'Unlink frame cels', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.frame.cels.link', spriteId: sprite.id, frameId: secondFrameId, linked: false, expectedRevision: sprite.revision }] })).toMatchObject({ status: 'committed' });
    currentDocument = documents.getDocument(document.id)!; if (currentDocument.kind !== 'pixel') throw new Error('Expected pixel document'); sprite = currentDocument.pixelAssets[initial.id]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(Object.values(sprite.cels).find((cel) => cel.frameId === secondFrameId)?.linkedToCelId).toBeUndefined();
    expect(await callTool(started.url, client.headers, 12, 'canvas_apply', { documentId: document.id, clientOperationId: 'animation-tag-delete', label: 'Delete animation tag', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.animation.tag.delete', spriteId: sprite.id, tagId: tag.id, expectedRevision: sprite.revision }] })).toMatchObject({ status: 'committed' });
    const finalDocument = documents.getDocument(document.id); if (!finalDocument || finalDocument.kind !== 'pixel') throw new Error('Expected pixel document'); const finalSprite = finalDocument.pixelAssets[initial.id]; if (finalSprite.type !== 'sprite') throw new Error('Expected sprite'); expect(finalSprite.tags).toEqual([]);
    const stamp = { id: 'agent-stamp', name: 'Agent stamp', width: 2, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: 5 }, { x: 1, y: 0, index: 6 }] };
    expect(await callTool(started.url, client.headers, 13, 'canvas_apply', { documentId: document.id, clientOperationId: 'stamp-library', label: 'Save reusable stamp', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.stamps.replace', stamps: [stamp] }] })).toMatchObject({ status: 'committed' });
    const stampDocument = documents.getDocument(document.id); if (!stampDocument || stampDocument.kind !== 'pixel') throw new Error('Expected pixel document'); const stampSprite = stampDocument.pixelAssets[initial.id]; if (stampSprite.type !== 'sprite') throw new Error('Expected sprite'); const stampCel = Object.values(stampSprite.cels).find((cel) => cel.frameId === secondFrameId)!;
    expect(await callTool(started.url, client.headers, 14, 'canvas_apply', { documentId: document.id, clientOperationId: 'stamp-placement', label: 'Place rotated reusable stamp', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.stamp.place', stampId: stamp.id, spriteId: stampSprite.id, celId: stampCel.id, x: 6, y: 6, transform: 'rotate-clockwise', expectedRevision: stampCel.revision }] })).toMatchObject({ status: 'committed' });
    const placedDocument = documents.getDocument(document.id); if (!placedDocument || placedDocument.kind !== 'pixel') throw new Error('Expected pixel document'); const placedSprite = placedDocument.pixelAssets[initial.id]; if (placedSprite.type !== 'sprite') throw new Error('Expected sprite'); const placedCel = placedSprite.cels[stampCel.id]; expect(readPixel(placedCel, 6, 6)).toBe(5); expect(readPixel(placedCel, 6, 7)).toBe(6);
    expect(await callTool(started.url, client.headers, 15, 'canvas_apply', { documentId: document.id, clientOperationId: 'bitmap-text-placement', label: 'Paint deterministic bitmap text', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.bitmap-text.paint', spriteId: placedSprite.id, celId: placedCel.id, fontId: placedDocument.bitmapFonts[0].id, text: 'A', x: 1, y: 0, index: 7, scale: 1, align: 'left', expectedRevision: placedCel.revision }] })).toMatchObject({ status: 'committed' });
    const textDocument = documents.getDocument(document.id); if (!textDocument || textDocument.kind !== 'pixel') throw new Error('Expected pixel document'); const textSprite = textDocument.pixelAssets[initial.id]; if (textSprite.type !== 'sprite') throw new Error('Expected sprite'); expect(readPixel(textSprite.cels[placedCel.id], 2, 0)).toBe(7);
    expect(await callTool(started.url, client.headers, 16, 'canvas_apply', { documentId: document.id, clientOperationId: 'palette-replace-delete', label: 'Replace and delete indexed color', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.palette.replace-delete', sourceIndex: 4, replacementIndex: 3, expectedRevision: textDocument.revision }] })).toMatchObject({ status: 'committed' });
    const reducedPalette = documents.getDocument(document.id); if (!reducedPalette || reducedPalette.kind !== 'pixel') throw new Error('Expected pixel document'); const reducedSprite = reducedPalette.pixelAssets[initial.id]; if (reducedSprite.type !== 'sprite') throw new Error('Expected sprite'); expect(reducedPalette.palette).toHaveLength(textDocument.palette.length - 1); expect(readPixel(Object.values(reducedSprite.cels).find((cel) => cel.frameId === firstFrameId)!, 2, 3)).toBe(3);
    expect(await callTool(started.url, client.headers, 17, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const restoredPalette = documents.getDocument(document.id); if (!restoredPalette || restoredPalette.kind !== 'pixel') throw new Error('Expected pixel document'); const restoredSprite = restoredPalette.pixelAssets[initial.id]; if (restoredSprite.type !== 'sprite') throw new Error('Expected sprite'); expect(restoredPalette.palette).toHaveLength(textDocument.palette.length); expect(readPixel(Object.values(restoredSprite.cels).find((cel) => cel.frameId === firstFrameId)!, 2, 3)).toBe(4);
  });

  it('embeds and packs hash-checked pixel project links through semantic operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const project = documents.create({ kind: 'project', name: 'Linked project' }).activeDocument!;
    if (project.kind !== 'pixel') throw new Error('Expected pixel project');
    const bytes = createCanvas(2, 2).toBuffer('image/png'); const sha256 = createHash('sha256').update(bytes).digest('hex');
    const asset = { id: 'project-cache', name: 'tiles.png', mimeType: 'image/png', byteLength: bytes.byteLength, sha256, source: 'embedded' as const, data: bytes.toString('base64') };
    const links = [
      { id: 'link-one', name: 'one.png', mode: 'linked' as const, relativePath: 'art/one.png', sha256, cachedPreviewAssetId: asset.id },
      { id: 'link-two', name: 'two.png', mode: 'linked' as const, relativePath: 'art/two.png', sha256, cachedPreviewAssetId: asset.id },
    ];
    expect((await documents.apply({ id: createId('tx'), clientOperationId: 'seed-project-links', documentId: project.id, actor: HUMAN_ACTOR, label: 'Seed project links', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'asset.add', asset }, { kind: 'pixel.links.replace', linkedAssets: links, expectedRevision: project.revision }] })).status).toBe('committed');
    await documents.save(project.id, join(root, 'linked-project.aidraw'));

    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('project-link-token'); const client = await initializeClient(started.url, 'project-link-token', 'project-link-client');
    let current = documents.getDocument(project.id); if (!current || current.kind !== 'pixel') throw new Error('Expected pixel project');
    expect(await callTool(started.url, client.headers, 2, 'canvas_apply', { documentId: project.id, clientOperationId: 'embed-project-link', label: 'Embed first link', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.project-link.embed', linkId: 'link-one', expectedRevision: current.revision }] })).toMatchObject({ status: 'committed' });
    current = documents.getDocument(project.id); if (!current || current.kind !== 'pixel') throw new Error('Expected pixel project');
    expect(current.linkedAssets.find((link) => link.id === 'link-one')).toMatchObject({ mode: 'embedded' });
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: project.id, clientOperationId: 'pack-project-links', label: 'Pack remaining links', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.project-links.pack', expectedRevision: current.revision }] })).toMatchObject({ status: 'committed' });
    current = documents.getDocument(project.id); if (!current || current.kind !== 'pixel') throw new Error('Expected pixel project');
    expect(current.linkedAssets.every((link) => link.mode === 'embedded' && link.relativePath === undefined)).toBe(true);
    const relink = await callTool(started.url, client.headers, 4, 'asset_import', { documentId: project.id, path: join(root, 'replacement.png'), projectLinkId: 'link-one' });
    expect(relink.status).toBe('waiting-for-user');
    expect(documents.getJob(String(relink.jobId))?.approval?.review?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Project link', value: 'link-one' })]));
    const extract = await callTool(started.url, client.headers, 5, 'document_export', { documentId: project.id, path: join(root, 'extracted.png'), projectLinkId: 'link-two' });
    expect(extract.status).toBe('waiting-for-user');
    expect(documents.getJob(String(extract.jobId))?.result).toMatchObject({ request: { action: 'project-link-extract', projectLinkId: 'link-two' } });
  });

  it('authors, observes, and independently undoes a keyframed illustration timeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('illustration-animation-token');
    const client = await initializeClient(started.url, 'illustration-animation-token', 'illustration-animation-client');
    const joined = await callTool(started.url, client.headers, 2, 'session_manage', { action: 'join', name: 'Timeline agent', model: 'contract-model', reasoningEffort: 'high', taskId: 'timeline-contract' });
    const actorId = String((joined.actor as { id: string }).id);
    const created = await callTool(started.url, client.headers, 3, 'document_manage', { action: 'new', kind: 'illustration', name: 'Agent vector animation', width: 16, height: 8, background: null });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'illustration') throw new Error('Expected illustration document');
    const layer = document.layerIds.map((id) => document.layers[id]).find((entry) => entry.type === 'vector'); if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer'); const timestamp = nowIso();
    const object = { id: 'timeline-shape', revision: 99, name: 'Timeline shape', createdAt: 'forged', updatedAt: 'forged', createdBy: 'forged', layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'shape', shape: 'rectangle', width: 3, height: 3, fill: { kind: 'solid', color: '#ff6b7a' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    const frame = (id: string, timeMs: number, x: number) => ({ id, revision: 55, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged', objectId: object.id, timeMs, transform: { ...IDENTITY_TRANSFORM, x }, opacity: 1, visible: true, easing: 'linear' });
    const applied = await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'illustration-animation-author', label: 'Author vector animation', playback: { mode: 'instant', speed: 1 }, operations: [
      { kind: 'illustration.animation.settings.replace', settings: { durationMs: 1_000, framesPerSecond: 4, playback: 'loop' }, expectedRevision: document.revision },
      { kind: 'illustration.object.add', object },
      { kind: 'illustration.animation.keyframe.upsert', keyframe: frame('timeline-start', 0, 0) },
      { kind: 'illustration.animation.keyframe.upsert', keyframe: frame('timeline-end', 1_000, 10) },
    ] });
    expect(applied).toMatchObject({ status: 'committed' });
    const committed = documents.getDocument(document.id); if (!committed || committed.kind !== 'illustration') throw new Error('Expected illustration document');
    expect(committed.animation).toMatchObject({ durationMs: 1_000, framesPerSecond: 4, playback: 'loop', keyframeIds: ['timeline-start', 'timeline-end'] });
    expect(committed.animation.keyframes['timeline-start']).toMatchObject({ createdBy: actorId, revision: 0 });
    const observed = await callTool(started.url, client.headers, 5, 'canvas_observe', { documentId: document.id, includePng: true, illustrationTimeMs: 1_000, region: { x: 10, y: 0, width: 1, height: 1 }, scale: 1, background: 'transparent' });
    expect(observed.png).toMatchObject({ available: true, illustrationTimeMs: 1_000 });
    const image = await loadImage(Buffer.from((observed.png as { data: string }).data, 'base64')); const canvas = createCanvas(1, 1); const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 107, 122, 255]);
    expect(await callTool(started.url, client.headers, 6, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const undone = documents.getDocument(document.id); if (!undone || undone.kind !== 'illustration') throw new Error('Expected illustration document'); expect(undone.animation.keyframeIds).toEqual([]); expect(undone.objects[object.id]).toBeUndefined();
  });

  it('places reusable transformed tile stamps through the authenticated semantic contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('tile-stamp-token');
    const client = await initializeClient(started.url, 'tile-stamp-token', 'tile-stamp-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'tilemap', name: 'Semantic tile stamp', width: 4, height: 4, orientation: 'orthogonal', infinite: false, tileWidth: 16, tileHeight: 16 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    const layer = Object.values(map.layers).find((entry) => entry.type === 'tile'); if (!layer || layer.type !== 'tile') throw new Error('Expected tile layer');
    const flagged = encodeTiledGid(2, { hFlip: true, diagonal: true });
    const stamp = { id: 'agent-tile-stamp', name: 'Agent tile stamp', width: 2, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: flagged }, { x: 1, y: 0, gid: 3 }] };
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'tile-stamp-library', label: 'Save tile stamp', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.tile-stamps.replace', stamps: [stamp] }] })).toMatchObject({ status: 'committed' });
    const current = documents.getDocument(document.id); if (!current || current.kind !== 'pixel') throw new Error('Expected pixel document'); const currentMap = current.pixelAssets[map.id]; if (currentMap.type !== 'tilemap') throw new Error('Expected tilemap'); const currentLayer = currentMap.layers[layer.id];
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'tile-stamp-placement', label: 'Place rotated tile stamp', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.tile-stamp.place', stampId: stamp.id, mapId: map.id, layerId: layer.id, x: 1, y: 1, transform: 'rotate-clockwise', expectedRevision: currentLayer.revision }] })).toMatchObject({ status: 'committed' });
    const placed = documents.getDocument(document.id); if (!placed || placed.kind !== 'pixel') throw new Error('Expected pixel document'); const placedMap = placed.pixelAssets[map.id]; if (placedMap.type !== 'tilemap') throw new Error('Expected tilemap'); const placedLayer = placedMap.layers[layer.id]; if (placedLayer.type !== 'tile') throw new Error('Expected tile layer');
    expect(readTileAt(placedLayer.chunks ?? {}, 1, 1)).toBe(flagged);
    expect(readTileAt(placedLayer.chunks ?? {}, 1, 2)).toBe(3);

    const timestamp = nowIso();
    const objectLayer = { id: 'agent-object-layer', revision: 0, name: 'Objects', createdAt: timestamp, updatedAt: timestamp, createdBy: 'tile-stamp-client', type: 'object' as const, visible: true, locked: false, opacity: 1, objects: [], offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1 };
    const mapWithObjectLayer = structuredClone(placedMap);
    mapWithObjectLayer.layers[objectLayer.id] = objectLayer;
    mapWithObjectLayer.layerIds.push(objectLayer.id);
    expect(await callTool(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'object-layer-add', label: 'Add map object layer', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.asset.replace', asset: mapWithObjectLayer, expectedRevision: placedMap.revision }] })).toMatchObject({ status: 'committed' });

    const layered = documents.getDocument(document.id); if (!layered || layered.kind !== 'pixel') throw new Error('Expected pixel document'); const layeredMap = layered.pixelAssets[map.id]; if (layeredMap.type !== 'tilemap') throw new Error('Expected tilemap');
    const mapObject = { id: 'agent-map-object', type: 'rectangle', x: 12, y: 20, width: 32, height: 16, properties: { solid: true } };
    expect(await callTool(started.url, client.headers, 6, 'canvas_apply', { documentId: document.id, clientOperationId: 'map-object-upsert', label: 'Create map object', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.map-object.upsert', mapId: map.id, layerId: objectLayer.id, object: mapObject, expectedRevision: layeredMap.revision }] })).toMatchObject({ status: 'committed' });
    const objectCreated = documents.getDocument(document.id); if (!objectCreated || objectCreated.kind !== 'pixel') throw new Error('Expected pixel document'); const objectMap = objectCreated.pixelAssets[map.id]; if (objectMap.type !== 'tilemap') throw new Error('Expected tilemap'); const createdObjectLayer = objectMap.layers[objectLayer.id]; if (createdObjectLayer.type !== 'object') throw new Error('Expected object layer'); expect(createdObjectLayer.objects).toContainEqual(mapObject);
    expect(await callTool(started.url, client.headers, 7, 'canvas_apply', { documentId: document.id, clientOperationId: 'map-object-delete', label: 'Delete map object', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.map-object.delete', mapId: map.id, layerId: objectLayer.id, objectId: mapObject.id, expectedRevision: objectMap.revision }] })).toMatchObject({ status: 'committed' });
    const objectDeleted = documents.getDocument(document.id); if (!objectDeleted || objectDeleted.kind !== 'pixel') throw new Error('Expected pixel document'); const deletedMap = objectDeleted.pixelAssets[map.id]; if (deletedMap.type !== 'tilemap') throw new Error('Expected tilemap'); const deletedObjectLayer = deletedMap.layers[objectLayer.id]; if (deletedObjectLayer.type !== 'object') throw new Error('Expected object layer'); expect(deletedObjectLayer.objects).toEqual([]);
  });

  it('paints deterministic weighted non-Wang tile variants through the authenticated semantic contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('variant-token');
    const client = await initializeClient(started.url, 'variant-token', 'variant-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'tilemap', name: 'Variant map', width: 8, height: 4, orientation: 'orthogonal', infinite: false, tileWidth: 16, tileHeight: 16 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    const tileset = createPixelTileset('Grass variants', 'variant-source', 16, 16, 2, 1); tileset.firstGid = 1;
    tileset.tiles[0] = { id: 0, sourceX: 0, sourceY: 0, probability: 1, animation: [], collisions: [], properties: { 'aidraw:variantGroup': 'grass' } }; tileset.tiles[1] = { id: 1, sourceX: 16, sourceY: 0, probability: 3, animation: [], collisions: [], properties: { 'aidraw:variantGroup': 'grass' } };
    const attachedMap = structuredClone(map); attachedMap.tilesetIds = [tileset.id];
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'variant-setup', label: 'Attach variant tileset', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.asset.add', asset: tileset }, { kind: 'pixel.asset.replace', asset: attachedMap, expectedRevision: map.revision }] })).toMatchObject({ status: 'committed' });
    const attached = documents.getDocument(document.id); if (!attached || attached.kind !== 'pixel') throw new Error('Expected pixel document'); const currentMap = attached.pixelAssets[map.id]; if (currentMap.type !== 'tilemap') throw new Error('Expected tilemap'); const layer = Object.values(currentMap.layers).find((entry) => entry.type === 'tile'); if (!layer || layer.type !== 'tile') throw new Error('Expected tile layer');
    const points = Array.from({ length: 16 }, (_, x) => ({ x, y: 0 })).filter((point) => point.x < currentMap.width);
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'variant-paint', label: 'Paint weighted grass', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.tile-variants.paint', mapId: currentMap.id, layerId: layer.id, tilesetId: tileset.id, tileId: 0, points, seed: 42, expectedRevision: layer.revision }] })).toMatchObject({ status: 'committed' });
    const painted = documents.getDocument(document.id); if (!painted || painted.kind !== 'pixel') throw new Error('Expected pixel document'); const paintedMap = painted.pixelAssets[map.id]; if (paintedMap.type !== 'tilemap') throw new Error('Expected tilemap'); const paintedLayer = paintedMap.layers[layer.id]; if (paintedLayer.type !== 'tile') throw new Error('Expected tile layer');
    const gids = points.map((point) => decodeTiledGid(readTileAt(paintedLayer.chunks ?? {}, point.x, point.y)).gid); expect(new Set(gids)).toEqual(new Set([1, 2]));
  });

  it('plans authenticated Wang terrain strokes atomically through one canonical actor transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('terrain-token');
    const client = await initializeClient(started.url, 'terrain-token', 'terrain-client');
    const joined = await callTool(started.url, client.headers, 2, 'session_manage', { action: 'join', name: 'Terrain agent', color: '#547fc4' });
    const actor = joined.actor as { id: string };
    const created = await callTool(started.url, client.headers, 3, 'document_manage', { action: 'new', kind: 'tilemap', name: 'Semantic terrain', width: 2, height: 2, orientation: 'orthogonal', infinite: false, tileWidth: 16, tileHeight: 16 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    const layer = Object.values(map.layers).find((entry) => entry.type === 'tile'); if (!layer || layer.type !== 'tile') throw new Error('Expected tile layer');
    const wangIdFromMask = (mask: number) => Array.from({ length: 8 }, (_, slot) => (mask & (1 << slot)) === 0 ? 0 : 1) as [number, number, number, number, number, number, number, number];
    const completeTiles = Array.from({ length: 256 }, (_, mask) => ({ tileId: mask, wangId: wangIdFromMask(mask) }));
    const weightedTiles = [...completeTiles, { tileId: 256, wangId: wangIdFromMask(255) }];
    const color = { id: 1, name: 'Grass', color: '#55aa44', tileId: 255, probability: 1 };
    const tileset = createPixelTileset('Semantic terrain tiles', 'semantic-terrain-source', 16, 16, 257, 1); tileset.firstGid = 37;
    tileset.wangSets = [
      { id: 'complete-terrain', name: 'Complete terrain', type: 'mixed', colors: [color], tiles: weightedTiles },
      { id: 'unmapped-terrain', name: 'Unmapped terrain', type: 'mixed', colors: [color], tiles: [{ tileId: 0, wangId: wangIdFromMask(0) }] },
    ];
    const attachedMap = structuredClone(map); attachedMap.tilesetIds = [tileset.id];
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'terrain-setup', label: 'Attach terrain definitions', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.asset.add', asset: tileset }, { kind: 'pixel.asset.replace', asset: attachedMap, expectedRevision: map.revision }] })).toMatchObject({ status: 'committed' });

    const currentLayer = () => {
      const current = documents.getDocument(document.id); if (!current || current.kind !== 'pixel') throw new Error('Expected pixel document');
      const currentMap = current.pixelAssets[map.id]; if (currentMap.type !== 'tilemap') throw new Error('Expected tilemap');
      const currentLayer = currentMap.layers[layer.id]; if (currentLayer.type !== 'tile' || !currentLayer.chunks) throw new Error('Expected tile layer');
      return { document: current, map: currentMap, layer: currentLayer };
    };
    const stroke = (wangSetId: string, mode: 'paint' | 'erase', expectedRevision: number, points = [{ x: 0, y: 0 }, { x: 1, y: 1 }]) => ({
      kind: 'pixel.wang-terrain.stroke', mapId: map.id, layerId: layer.id, tilesetId: tileset.id, wangSetId, colorId: 1, mode, points, expectedRevision,
    });

    const beforePaint = currentLayer();
    expect(await callTool(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'terrain-paint', label: 'Paint semantic terrain', playback: { mode: 'instant', speed: 1 }, operations: [stroke('complete-terrain', 'paint', beforePaint.layer.revision)] })).toMatchObject({ status: 'committed' });
    const painted = currentLayer();
    const coordinates = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
    const paintedGids = coordinates.map(({ x, y }) => readTileAt(painted.layer.chunks!, x, y));
    expect(paintedGids.every((gid) => decodeTiledGid(gid).gid >= tileset.firstGid)).toBe(true);
    expect(painted.document.activity.find((entry) => entry.label === 'Paint semantic terrain')).toMatchObject({ actor: { id: actor.id }, operationCount: 1 });

    const beforeNoop = structuredClone(painted.document);
    const noop = await callToolMessage(started.url, client.headers, 6, 'canvas_apply', { documentId: document.id, clientOperationId: 'terrain-noop', label: 'Repeat semantic terrain', playback: { mode: 'instant', speed: 1 }, operations: [stroke('complete-terrain', 'paint', painted.layer.revision)] });
    expect(noop.result?.isError).toBe(true);
    expect(JSON.stringify(noop)).toContain('no tiles changed and no revision was created');
    expect(documents.getDocument(document.id)).toEqual(beforeNoop);

    expect(await callTool(started.url, client.headers, 7, 'canvas_apply', { documentId: document.id, clientOperationId: 'terrain-erase', label: 'Erase semantic terrain', playback: { mode: 'instant', speed: 1 }, operations: [stroke('complete-terrain', 'erase', painted.layer.revision)] })).toMatchObject({ status: 'committed' });
    const erased = currentLayer();
    expect(coordinates.map(({ x, y }) => readTileAt(erased.layer.chunks!, x, y))).toEqual([tileset.firstGid, tileset.firstGid, tileset.firstGid, tileset.firstGid]);

    expect(await callTool(started.url, client.headers, 8, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    expect(coordinates.map(({ x, y }) => readTileAt(currentLayer().layer.chunks!, x, y))).toEqual(paintedGids);
    expect(await callTool(started.url, client.headers, 9, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const restored = currentLayer();
    expect(coordinates.map(({ x, y }) => readTileAt(restored.layer.chunks!, x, y))).toEqual([0, 0, 0, 0]);

    const beforeRefusals = structuredClone(restored.document);
    const unmatched = await callToolMessage(started.url, client.headers, 10, 'canvas_apply', { documentId: document.id, clientOperationId: 'terrain-unmatched', label: 'Reject incomplete terrain', playback: { mode: 'instant', speed: 1 }, operations: [stroke('unmapped-terrain', 'paint', restored.layer.revision, [{ x: 0, y: 0 }])] });
    expect(unmatched.result?.isError).toBe(true);
    expect(JSON.stringify(unmatched)).toContain('need exact Wang mappings');
    expect(JSON.stringify(unmatched)).toContain('No terrain tiles changed');
    const outside = await callToolMessage(started.url, client.headers, 11, 'canvas_apply', { documentId: document.id, clientOperationId: 'terrain-outside', label: 'Reject outside terrain', playback: { mode: 'instant', speed: 1 }, operations: [stroke('complete-terrain', 'paint', restored.layer.revision, [{ x: 2, y: 2 }])] });
    expect(outside.result?.isError).toBe(true);
    expect(JSON.stringify(outside)).toContain('outside the map');
    const stale = await callToolMessage(started.url, client.headers, 12, 'canvas_apply', { documentId: document.id, clientOperationId: 'terrain-stale', label: 'Reject stale terrain', playback: { mode: 'instant', speed: 1 }, operations: [stroke('complete-terrain', 'paint', 0)] });
    expect(stale.result?.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain('observe and retry');
    const invalid = await callToolMessage(started.url, client.headers, 13, 'canvas_apply', { documentId: document.id, clientOperationId: 'terrain-invalid', label: 'Reject invented terrain seed', playback: { mode: 'instant', speed: 1 }, operations: [{ ...stroke('complete-terrain', 'paint', restored.layer.revision), seed: 42 }] });
    expect(invalid.result?.isError).toBe(true);
    expect(JSON.stringify(invalid)).toContain('Unrecognized key');
    expect(documents.getDocument(document.id)).toEqual(beforeRefusals);

    const lock = documents.acquireLock({ documentId: document.id, region: { kind: 'tile', assetId: map.id, x: 0, y: 0, width: 2, height: 2 } });
    expect(lock.acquired).toBe(true);
    expect(await callTool(started.url, client.headers, 14, 'canvas_apply', { documentId: document.id, clientOperationId: 'terrain-locked', label: 'Respect terrain lock', playback: { mode: 'instant', speed: 1 }, operations: [stroke('complete-terrain', 'paint', restored.layer.revision)] })).toMatchObject({ status: 'locked', conflict: { retryable: true } });
    if (lock.lockId) documents.releaseLock(lock.lockId);
    expect(documents.getDocument(document.id)).toEqual(beforeRefusals);
  });

  it('authors and paints exact sparse image-collection Wang terrain through document-bound semantic requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-collection-wang-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const document = createPixelDocument('project', 'Semantic collection terrain'); document.assetIds = []; document.pixelAssets = {};
    const source0 = createPixelSprite('Terrain zero', 8, 8); const source3 = createPixelSprite('Terrain three', 11, 7);
    const tileset = createPixelTileset('Sparse terrain', source0.id, 11, 8, 1, 1); delete tileset.spriteAssetId; tileset.firstGid = 20; tileset.columns = 0; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0;
    const wangIdFromMask = (mask: number) => Array.from({ length: 8 }, (_, slot) => (mask & (1 << slot)) === 0 ? 0 : 1) as [number, number, number, number, number, number, number, number];
    tileset.tiles = Object.fromEntries(Array.from({ length: 256 }, (_, mask) => {
      const tileId = mask * 2;
      return [tileId, { id: tileId, sourceX: 0, sourceY: 0, imageAssetId: mask === 0 ? source0.id : source3.id, probability: 1, animation: [], collisions: [], properties: {} }];
    }));
    tileset.wangSets = [{ id: 'sparse-wang', name: 'Sparse Wang', type: 'mixed', colors: [{ id: 1, name: 'Ground', color: '#55aa44', tileId: 510, probability: 1 }], tiles: Array.from({ length: 256 }, (_, mask) => ({ tileId: mask * 2, wangId: wangIdFromMask(mask) })) }];
    const map = createPixelTilemap('Sparse-infinite terrain'); map.orientation = 'isometric'; map.infinite = true; map.width = 1; map.height = 1; map.tilesetIds = [tileset.id]; const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile') throw new Error('Expected tile layer');
    document.assetIds = [source0.id, source3.id, tileset.id, map.id]; document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [tileset.id]: tileset, [map.id]: map }; document.activeAssetId = map.id; documents.addDocument(document);
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('collection-terrain-token');
    const client = await initializeClient(started.url, 'collection-terrain-token', 'collection-terrain-client');

    const missingGuard = await callToolMessage(started.url, client.headers, 2, 'canvas_apply', { documentId: document.id, clientOperationId: 'collection-terrain-missing-guard', label: 'Refuse unguarded collection terrain', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.wang-terrain.stroke', mapId: map.id, layerId: layer.id, tilesetId: tileset.id, wangSetId: 'sparse-wang', colorId: 1, mode: 'paint', points: [{ x: -33, y: 34 }], expectedRevision: layer.revision }] });
    expect(missingGuard.result?.isError).toBe(true); expect(JSON.stringify(missingGuard)).toContain('expectedDocumentRevision');
    expect(documents.getDocument(document.id)?.activity).toEqual([]);

    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'collection-terrain-paint', label: 'Paint collection terrain', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.wang-terrain.stroke', mapId: map.id, layerId: layer.id, tilesetId: tileset.id, wangSetId: 'sparse-wang', colorId: 1, mode: 'paint', points: [{ x: -33, y: 34 }], expectedRevision: layer.revision, expectedDocumentRevision: document.revision }] })).toMatchObject({ status: 'committed' });
    const painted = documents.getDocument(document.id); if (!painted || painted.kind !== 'pixel') throw new Error('Expected pixel document'); const paintedMap = painted.pixelAssets[map.id]; if (paintedMap.type !== 'tilemap') throw new Error('Expected map'); const paintedLayer = paintedMap.layers[layer.id]; if (paintedLayer.type !== 'tile' || !paintedLayer.chunks) throw new Error('Expected tile layer');
    expect(readTileAt(paintedLayer.chunks, -33, 34)).toBe(tileset.firstGid + 510);

    const currentTileset = painted.pixelAssets[tileset.id]; if (currentTileset.type !== 'tileset') throw new Error('Expected tileset');
    const renamedSet = { ...structuredClone(currentTileset.wangSets[0]), name: 'Semantic sparse terrain' };
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'collection-terrain-metadata', label: 'Rename collection Wang set', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.wang-set.upsert', tilesetId: tileset.id, wangSet: renamedSet, expectedRevision: currentTileset.revision, expectedDocumentRevision: painted.revision }] })).toMatchObject({ status: 'committed' });
    const renamed = documents.getDocument(document.id); if (!renamed || renamed.kind !== 'pixel') throw new Error('Expected pixel document'); const renamedTileset = renamed.pixelAssets[tileset.id]; if (renamedTileset.type !== 'tileset') throw new Error('Expected tileset'); expect(renamedTileset.wangSets[0].name).toBe('Semantic sparse terrain');
  });

  it('propagates authenticated Wang repairs beyond one cell and refuses a foreign-GID frontier atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('propagated-terrain-token');
    const client = await initializeClient(started.url, 'propagated-terrain-token', 'propagated-terrain-client');
    const joined = await callTool(started.url, client.headers, 2, 'session_manage', { action: 'join', name: 'Terrain propagation agent', color: '#6b8f45' });
    const actor = joined.actor as { id: string };
    const created = await callTool(started.url, client.headers, 3, 'document_manage', { action: 'new', kind: 'tilemap', name: 'Propagated terrain', width: 4, height: 1, orientation: 'orthogonal', infinite: false, tileWidth: 16, tileHeight: 16 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    const layer = Object.values(map.layers).find((entry) => entry.type === 'tile'); if (!layer || layer.type !== 'tile') throw new Error('Expected tile layer');
    const wangIdFromMask = (mask: number) => Array.from({ length: 8 }, (_, slot) => (mask & (1 << slot)) === 0 ? 0 : 1) as [number, number, number, number, number, number, number, number];
    const terrainTileset = createPixelTileset('Propagated terrain tiles', 'propagated-terrain-source', 16, 16, 256, 1); terrainTileset.firstGid = 41;
    terrainTileset.wangSets = [{
      id: 'line-terrain', name: 'Line terrain', type: 'mixed',
      colors: [{ id: 1, name: 'Grass', color: '#55aa44', tileId: 255, probability: 1 }],
      tiles: [
        { tileId: 0, wangId: wangIdFromMask(0) },
        { tileId: 255, wangId: wangIdFromMask(255) },
        { tileId: 238, wangId: wangIdFromMask(238) },
      ],
    }];
    const foreignTileset = createPixelTileset('Foreign terrain tiles', 'foreign-terrain-source', 16, 16, 1, 1); foreignTileset.firstGid = 401;
    const attachedMap = structuredClone(map); attachedMap.tilesetIds = [terrainTileset.id, foreignTileset.id];
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'propagated-terrain-setup', label: 'Attach propagated terrain definitions', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.asset.add', asset: terrainTileset }, { kind: 'pixel.asset.add', asset: foreignTileset }, { kind: 'pixel.asset.replace', asset: attachedMap, expectedRevision: map.revision }] })).toMatchObject({ status: 'committed' });

    const currentLayer = () => {
      const current = documents.getDocument(document.id); if (!current || current.kind !== 'pixel') throw new Error('Expected pixel document');
      const currentMap = current.pixelAssets[map.id]; if (currentMap.type !== 'tilemap') throw new Error('Expected tilemap');
      const currentLayer = currentMap.layers[layer.id]; if (currentLayer.type !== 'tile' || !currentLayer.chunks) throw new Error('Expected tile layer');
      return { document: current, map: currentMap, layer: currentLayer };
    };
    const stroke = (mode: 'paint' | 'erase', expectedRevision: number) => ({
      kind: 'pixel.wang-terrain.stroke', mapId: map.id, layerId: layer.id, tilesetId: terrainTileset.id, wangSetId: 'line-terrain', colorId: 1, mode, points: [{ x: 0, y: 0 }], expectedRevision,
    });

    const beforePaint = currentLayer();
    expect(await callTool(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'propagated-terrain-paint', label: 'Paint propagated terrain', playback: { mode: 'instant', speed: 1 }, operations: [stroke('paint', beforePaint.layer.revision)] })).toMatchObject({ status: 'committed' });
    const painted = currentLayer();
    expect(Array.from({ length: 4 }, (_, x) => decodeTiledGid(readTileAt(painted.layer.chunks!, x, 0)).gid - terrainTileset.firstGid)).toEqual([255, 238, 238, 238]);
    expect(painted.document.activity.find((entry) => entry.label === 'Paint propagated terrain')).toMatchObject({ actor: { id: actor.id }, operationCount: 1 });

    expect(await callTool(started.url, client.headers, 6, 'canvas_apply', { documentId: document.id, clientOperationId: 'propagated-terrain-erase', label: 'Erase propagated terrain', playback: { mode: 'instant', speed: 1 }, operations: [stroke('erase', painted.layer.revision)] })).toMatchObject({ status: 'committed' });
    expect(Array.from({ length: 4 }, (_, x) => readTileAt(currentLayer().layer.chunks!, x, 0))).toEqual(Array.from({ length: 4 }, () => terrainTileset.firstGid));
    expect(await callTool(started.url, client.headers, 7, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    expect(await callTool(started.url, client.headers, 8, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    expect(Array.from({ length: 4 }, (_, x) => readTileAt(currentLayer().layer.chunks!, x, 0))).toEqual([0, 0, 0, 0]);

    const beforeForeignSetup = currentLayer();
    expect(await callTool(started.url, client.headers, 9, 'canvas_apply', { documentId: document.id, clientOperationId: 'propagated-terrain-foreign-setup', label: 'Place foreign terrain cell', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.tilemap.set', mapId: map.id, layerId: layer.id, changes: [{ x: 2, y: 0, gid: foreignTileset.firstGid }], expectedRevision: beforeForeignSetup.layer.revision }] })).toMatchObject({ status: 'committed' });
    const beforeForeignStroke = currentLayer();
    const foreign = await callToolMessage(started.url, client.headers, 10, 'canvas_apply', { documentId: document.id, clientOperationId: 'propagated-terrain-foreign-refusal', label: 'Refuse foreign terrain frontier', playback: { mode: 'instant', speed: 1 }, operations: [stroke('paint', beforeForeignStroke.layer.revision)] });
    expect(foreign.result?.isError).toBe(true);
    expect(JSON.stringify(foreign)).toContain(`outside tileset ${terrainTileset.id}`);
    expect(JSON.stringify(foreign)).toContain('No terrain tiles changed');
    expect(documents.getDocument(document.id)).toEqual(beforeForeignStroke.document);
  });

  it('authors typed per-tile collisions through the authenticated semantic contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('collision-token');
    const client = await initializeClient(started.url, 'collision-token', 'collision-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'sprite', name: 'Collision source', width: 32, height: 32 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const tileset = createPixelTileset('Collision tileset', sprite.id, 16, 16, 2, 2);
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'collision-tileset-add', label: 'Add collision tileset', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.asset.add', asset: tileset }] })).toMatchObject({ status: 'committed' });
    const added = documents.getDocument(document.id); if (!added || added.kind !== 'pixel') throw new Error('Expected pixel document'); const addedTileset = added.pixelAssets[tileset.id]; if (addedTileset.type !== 'tileset') throw new Error('Expected tileset');
    const shape = { id: 'agent-tile-collision', type: 'polygon', x: 1, y: 2, points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 4, y: 10 }], properties: { damage: 2, solid: true } };
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'collision-upsert', label: 'Add tile collision', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.tileset-collision.upsert', tilesetId: tileset.id, tileId: 1, shape, expectedRevision: addedTileset.revision }] })).toMatchObject({ status: 'committed' });
    const authored = documents.getDocument(document.id); if (!authored || authored.kind !== 'pixel') throw new Error('Expected pixel document'); const authoredTileset = authored.pixelAssets[tileset.id]; if (authoredTileset.type !== 'tileset') throw new Error('Expected tileset'); expect(authoredTileset.tiles[1].collisions).toContainEqual(shape);
    expect(await callTool(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'collision-delete', label: 'Delete tile collision', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.tileset-collision.delete', tilesetId: tileset.id, tileId: 1, shapeId: shape.id, expectedRevision: authoredTileset.revision }] })).toMatchObject({ status: 'committed' });
    const deleted = documents.getDocument(document.id); if (!deleted || deleted.kind !== 'pixel') throw new Error('Expected pixel document'); const deletedTileset = deleted.pixelAssets[tileset.id]; if (deletedTileset.type !== 'tileset') throw new Error('Expected tileset'); expect(deletedTileset.tiles[1].collisions).toEqual([]);
    const wangSet = { id: 'agent-wang-set', name: 'Agent terrain', type: 'mixed', colors: [], tiles: [] };
    expect(await callTool(started.url, client.headers, 6, 'canvas_apply', { documentId: document.id, clientOperationId: 'wang-set-upsert', label: 'Create Wang set', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.wang-set.upsert', tilesetId: tileset.id, wangSet, expectedRevision: deletedTileset.revision }] })).toMatchObject({ status: 'committed' });
    let wangDocument = documents.getDocument(document.id); if (!wangDocument || wangDocument.kind !== 'pixel') throw new Error('Expected pixel document'); let wangTileset = wangDocument.pixelAssets[tileset.id]; if (wangTileset.type !== 'tileset') throw new Error('Expected tileset');
    const wangColor = { id: 1, name: 'Grass', color: '#55aa44', tileId: 0, probability: 1 };
    expect(await callTool(started.url, client.headers, 7, 'canvas_apply', { documentId: document.id, clientOperationId: 'wang-color-upsert', label: 'Create Wang color', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.wang-color.upsert', tilesetId: tileset.id, wangSetId: wangSet.id, color: wangColor, expectedRevision: wangTileset.revision }] })).toMatchObject({ status: 'committed' });
    wangDocument = documents.getDocument(document.id); if (!wangDocument || wangDocument.kind !== 'pixel') throw new Error('Expected pixel document'); wangTileset = wangDocument.pixelAssets[tileset.id]; if (wangTileset.type !== 'tileset') throw new Error('Expected tileset');
    expect(await callTool(started.url, client.headers, 8, 'canvas_apply', { documentId: document.id, clientOperationId: 'wang-tile-assign', label: 'Assign Wang tile', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.wang-tile.assign', tilesetId: tileset.id, wangSetId: wangSet.id, tile: { tileId: 2, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }, expectedRevision: wangTileset.revision }] })).toMatchObject({ status: 'committed' });
    wangDocument = documents.getDocument(document.id); if (!wangDocument || wangDocument.kind !== 'pixel') throw new Error('Expected pixel document'); wangTileset = wangDocument.pixelAssets[tileset.id]; if (wangTileset.type !== 'tileset') throw new Error('Expected tileset'); expect(wangTileset.wangSets[0].tiles[0]).toMatchObject({ tileId: 2, wangId: [1, 0, 1, 0, 1, 0, 1, 0] });
    expect(await callTool(started.url, client.headers, 9, 'canvas_apply', { documentId: document.id, clientOperationId: 'wang-color-delete', label: 'Delete Wang color', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.wang-color.delete', tilesetId: tileset.id, wangSetId: wangSet.id, colorId: 1, expectedRevision: wangTileset.revision }] })).toMatchObject({ status: 'committed' });
    wangDocument = documents.getDocument(document.id); if (!wangDocument || wangDocument.kind !== 'pixel') throw new Error('Expected pixel document'); wangTileset = wangDocument.pixelAssets[tileset.id]; if (wangTileset.type !== 'tileset') throw new Error('Expected tileset'); expect(wangTileset.wangSets[0]).toMatchObject({ colors: [], tiles: [] });
  });

  it('exports and imports bounded self-contained fragments with remapped IDs and session attribution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('fragment-token');
    const client = await initializeClient(started.url, 'fragment-token', 'fragment-client');
    const joined = await callTool(started.url, client.headers, 2, 'session_manage', { action: 'join', name: 'Fragment agent', model: 'contract-model', reasoningEffort: 'high', taskId: 'fragment-contract' });
    const actor = joined.actor as { id: string };
    const created = await callTool(started.url, client.headers, 3, 'document_manage', { action: 'new', kind: 'illustration', name: 'Fragment source', width: 128, height: 96, background: null });
    const source = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument'];
    if (!source || source.kind !== 'illustration') throw new Error('Expected illustration source');
    const sourceLayer = Object.values(source.layers).find((entry) => entry.type === 'vector')!;
    const timestamp = nowIso();
    const object = {
      id: 'portable-shape', revision: 0, name: 'Portable shape', createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged-actor', layerId: sourceLayer.id,
      visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 12, y: 14 }, type: 'shape', shape: 'rectangle', width: 20, height: 10,
      fill: { kind: 'solid', color: '#ff6b7a' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: source.id, clientOperationId: 'fragment-source-shape', label: 'Create portable shape', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.add', object }] })).toMatchObject({ status: 'committed' });

    const observed = await callTool(started.url, client.headers, 5, 'canvas_observe', { documentId: source.id, fragment: { kind: 'illustration-objects', objectIds: [object.id] } });
    expect(observed.document).toBeUndefined();
    expect(observed.fragment).toMatchObject({ available: true, data: { version: 1, kind: 'illustration-objects' } });
    expect((observed.fragment as { byteLength: number }).byteLength).toBeGreaterThan(0);
    const fragment = (observed.fragment as { data: Record<string, unknown> }).data;

    const targetResult = await callTool(started.url, client.headers, 6, 'document_manage', { action: 'new', kind: 'illustration', name: 'Fragment target', width: 128, height: 96, background: null });
    const target = targetResult.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument'];
    if (!target || target.kind !== 'illustration') throw new Error('Expected illustration target');
    expect(await callTool(started.url, client.headers, 7, 'canvas_apply', { documentId: target.id, clientOperationId: 'fragment-target-import', label: 'Import portable fragment', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'document.fragment.import', fragment, offsetX: 7, offsetY: 9 }] })).toMatchObject({ status: 'committed' });
    const imported = documents.getDocument(target.id);
    if (!imported || imported.kind !== 'illustration') throw new Error('Expected imported illustration');
    const importedObject = Object.values(imported.objects).find((entry) => entry.name === 'Portable shape')!;
    expect(importedObject.id).not.toBe(object.id);
    expect(importedObject.createdBy).toBe(actor.id);
    expect(importedObject.transform).toMatchObject({ x: 19, y: 23 });

    const mismatch = await callTool(started.url, client.headers, 8, 'canvas_observe', { documentId: target.id, fragment: { kind: 'pixel-assets' } });
    expect(mismatch.fragment).toMatchObject({ available: false, error: 'fragment_kind_mismatch' });
  });

  it('accepts compact region writes and applies lock and actor-history semantics to their cells', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('region-token');
    const client = await initializeClient(started.url, 'region-token', 'region-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'sprite', name: 'Compact field', width: 64, height: 64 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    const runs = Array.from({ length: 64 }, (_, y) => ({ x: 0, y, length: 64, index: 4 }));
    expect(JSON.stringify(runs).length).toBeLessThan(4_000);
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'compact-full-frame', label: 'Compact full frame', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.cel.region', spriteId: sprite.id, celId: cel.id, runs, expectedRevision: 0 }] })).toMatchObject({ status: 'committed' });
    const committed = documents.getDocument(document.id); if (!committed || committed.kind !== 'pixel') throw new Error('Expected pixel document'); const committedSprite = committed.pixelAssets[sprite.id]; if (committedSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(readPixel(committedSprite.cels[cel.id], 63, 63)).toBe(4);
    const lock = documents.acquireLock({ documentId: document.id, region: { kind: 'pixel', assetId: sprite.id, x: 10, y: 10, width: 5, height: 5 } });
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'compact-locked-row', label: 'Locked compact row', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.cel.region', spriteId: sprite.id, celId: cel.id, runs: [{ x: 0, y: 12, length: 64, index: 8 }], expectedRevision: 1 }] })).toMatchObject({ status: 'locked', conflict: { retryable: true } });
    if (lock.lockId) documents.releaseLock(lock.lockId);
    expect(await callTool(started.url, client.headers, 5, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const undone = documents.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel document'); const undoneSprite = undone.pixelAssets[sprite.id]; if (undoneSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(readPixel(undoneSprite.cels[cel.id], 63, 63)).toBe(0);
  });

  it('quantizes an embedded raster into a target cel using document defaults and records reproducible trace metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('quantize-token');
    const client = await initializeClient(started.url, 'quantize-token', 'quantize-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'sprite', name: 'Quantized sprite', width: 2, height: 2 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    const source = createCanvas(2, 2); const context = source.getContext('2d'); context.clearRect(0, 0, 2, 2); context.fillStyle = '#ff6b7a'; context.fillRect(0, 0, 1, 1); context.fillRect(1, 1, 1, 1); context.fillStyle = '#31a6a0'; context.fillRect(1, 0, 1, 1);
    const bytes = source.toBuffer('image/png'); const assetId = 'quantize-source';
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'add-quantize-source', label: 'Add quantize source', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'asset.add', asset: { id: assetId, name: 'Palette source', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', data: bytes.toString('base64') } }] })).toMatchObject({ status: 'committed' });
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'quantize-existing-asset', label: 'Quantize embedded source', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.image.quantize', assetId, spriteId: sprite.id, celId: cel.id, expectedRevision: 0 }] })).toMatchObject({ status: 'committed' });
    const committed = documents.getDocument(document.id); if (!committed || committed.kind !== 'pixel') throw new Error('Expected pixel document'); const committedSprite = committed.pixelAssets[sprite.id]; if (committedSprite.type !== 'sprite') throw new Error('Expected sprite'); const committedCel = committedSprite.cels[cel.id];
    expect([[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => readPixel(committedCel, x, y))).toEqual([4, 8, 0, 4]);
    const trace = await documents.listTrace(document.id); const conversion = trace.find((entry) => entry.transaction.clientOperationId === 'quantize-existing-asset')?.transaction.operations[0];
    expect(conversion).toMatchObject({ kind: 'pixel.cel.region', conversion: { sourceAssetId: assetId, resample: 'area', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: 0.5, width: 2, height: 2 } });
    expect(await callTool(started.url, client.headers, 5, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const undone = documents.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel document'); const undoneSprite = undone.pixelAssets[sprite.id]; if (undoneSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect([[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => readPixel(undoneSprite.cels[cel.id], x, y))).toEqual([0, 0, 0, 0]);
  });

  it('fails an authenticated edit when its document incarnation changes during asynchronous preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-preparation-incarnation-')); temporaryPaths.push(root);
    const traces = new TransactionTraceStore(join(root, 'traces'));
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', traces); documents.initialize();
    const predecessor = createPixelDocument(); predecessor.name = 'Preparation predecessor';
    const sprite = predecessor.pixelAssets[predecessor.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    const source = createCanvas(1, 1); source.getContext('2d').fillRect(0, 0, 1, 1);
    const bytes = source.toBuffer('image/png');
    predecessor.assets['preparation-source'] = {
      id: 'preparation-source', name: 'Preparation source', mimeType: 'image/png', byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', data: bytes.toString('base64'),
    };
    documents.addDocument(predecessor);
    const predecessorIncarnation = documents.getDocumentIncarnation(predecessor.id);
    const entered = deferred(); const release = deferred();
    const quantize = vi.fn(async () => { entered.resolve(); await release.promise; return [{ x: 0, y: 0, index: 4 }]; });
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json'), undefined, quantize); hosts.push(host);
    const started = await host.start('preparation-incarnation-token');
    const client = await initializeClient(started.url, 'preparation-incarnation-token', 'preparation-incarnation-client');

    const pending = callTool(started.url, client.headers, 2, 'canvas_apply', {
      documentId: predecessor.id,
      clientOperationId: 'preparation-incarnation-edit',
      label: 'Must remain bound to predecessor',
      playback: { mode: 'instant', speed: 1 },
      operations: [{
        kind: 'pixel.image.quantize', assetId: 'preparation-source', spriteId: sprite.id, celId: cel.id,
        x: 0, y: 0, width: 1, height: 1, expectedRevision: cel.revision,
      }],
    });
    await entered.promise;

    await expect(documents.close(predecessor.id, true)).resolves.toMatchObject({ closed: true });
    const replacement = structuredClone(predecessor); replacement.name = 'Same-ID preparation replacement';
    documents.addDocument(replacement);
    expect(documents.getDocumentIncarnation(predecessor.id)).not.toBe(predecessorIncarnation);
    release.resolve();

    await expect(pending).resolves.toMatchObject({
      status: 'conflict',
      message: expect.stringMatching(/incarnation changed.*old edit was not applied/i),
    });
    const unchanged = documents.getDocument(predecessor.id); if (!unchanged || unchanged.kind !== 'pixel') throw new Error('Expected replacement pixel document');
    const unchangedSprite = unchanged.pixelAssets[sprite.id]; if (unchangedSprite.type !== 'sprite') throw new Error('Expected replacement sprite');
    expect(unchanged).toMatchObject({ name: 'Same-ID preparation replacement', revision: 0 });
    expect(readPixel(unchangedSprite.cels[cel.id], 0, 0)).toBe(0);
    expect(await documents.listTrace(predecessor.id)).toEqual([]);
    expect(host.scheduler.publicMutationStatus()).toEqual({ active: 0, reservedSamples: 0, reservedImageBytes: 0 });
    expect(quantize).toHaveBeenCalledOnce();
  });

  it('admits aggregate instant and animated work before cloning, quantization, or image inspection and releases it after commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-public-admission-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const source = createCanvas(1, 1); source.getContext('2d').fillRect(0, 0, 1, 1);
    const bytes = source.toBuffer('image/png');
    const sourceAsset = { id: 'bounded-source', name: 'Bounded source', mimeType: 'image/png' as const, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded' as const, data: bytes.toString('base64') };
    const pixelDocuments = Array.from({ length: 4 }, (_, index) => {
      const document = createPixelDocument(); document.name = `Admission ${index}`; document.assets[sourceAsset.id] = structuredClone(sourceAsset); return document;
    });
    const imageDocument = createIllustrationDocument(); imageDocument.name = 'Rejected image work'; imageDocument.assets[sourceAsset.id] = structuredClone(sourceAsset);
    documents.addDocuments([...pixelDocuments, imageDocument]);
    const gates: Array<ReturnType<typeof deferred>> = [];
    const quantize = vi.fn(async () => {
      const gate = deferred(); gates.push(gate); await gate.promise;
      return [{ x: 0, y: 0, index: 0 }];
    });
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json'), undefined, quantize); hosts.push(host);
    const started = await host.start('public-admission-token');
    const client = await initializeClient(started.url, 'public-admission-token', 'public-admission-client');
    const getDocument = vi.spyOn(documents, 'getDocument');
    const inspectProjection = vi.spyOn(TransactionImageWorkContext.prototype, 'inspectProjection');

    const pending = pixelDocuments.map((document, index) => {
      const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
      const cel = Object.values(sprite.cels)[0];
      return callTool(started.url, client.headers, 20 + index, 'canvas_apply', {
        documentId: document.id, clientOperationId: `held-quantize-${index}`, label: `Held quantize ${index}`, playback: { mode: index % 2 === 0 ? 'instant' : 'animated', speed: 4 },
        operations: [{ kind: 'pixel.image.quantize', assetId: sourceAsset.id, spriteId: sprite.id, celId: cel.id, x: 0, y: 0, width: 1, height: 1, expectedRevision: 0 }],
      });
    });
    await vi.waitFor(() => expect(quantize).toHaveBeenCalledTimes(4));
    expect(getDocument).toHaveBeenCalledTimes(4);
    expect(inspectProjection).not.toHaveBeenCalled();
    expect(host.scheduler.publicMutationStatus()).toMatchObject({ active: 4, reservedImageBytes: 96_000_000 });

    const layer = Object.values(imageDocument.layers).find((entry) => entry.type === 'vector'); if (!layer) throw new Error('Expected vector layer');
    const rejected = await callTool(started.url, client.headers, 30, 'canvas_apply', {
      documentId: imageDocument.id, clientOperationId: 'rejected-image-work', label: 'Reject before image work', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'illustration.object.add', object: { id: 'bounded-image', name: 'Bounded image', layerId: layer.id, type: 'image', assetId: sourceAsset.id, width: 1, height: 1 } }],
    });
    expect(rejected).toMatchObject({ status: 'busy', message: expect.stringContaining('preparation capacity') });
    expect(getDocument).toHaveBeenCalledTimes(4);
    expect(quantize).toHaveBeenCalledTimes(4);
    expect(inspectProjection).not.toHaveBeenCalled();

    gates.forEach((gate) => gate.resolve());
    await expect(Promise.all(pending)).resolves.toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ status: 'committed' })));
    expect(host.scheduler.publicMutationStatus()).toEqual({ active: 0, reservedSamples: 0, reservedImageBytes: 0 });
    expect(await callTool(started.url, client.headers, 31, 'canvas_apply', {
      documentId: imageDocument.id, clientOperationId: 'accepted-image-work', label: 'Accept after release', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'illustration.object.add', object: { id: 'bounded-image', name: 'Bounded image', layerId: layer.id, type: 'image', assetId: sourceAsset.id, width: 1, height: 1 } }],
    })).toMatchObject({ status: 'committed' });
    expect(inspectProjection).toHaveBeenCalledTimes(2);
    expect(inspectProjection.mock.instances[0]).toBe(inspectProjection.mock.instances[1]);
    expect(host.scheduler.publicMutationStatus()).toEqual({ active: 0, reservedSamples: 0, reservedImageBytes: 0 });
  });

  it('expands semantic pixel fill, dither, replacement, and palette-index adjustment against canonical cel state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root); const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize(); const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('pixel-semantic-token'); const client = await initializeClient(started.url, 'pixel-semantic-token', 'pixel-semantic-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'sprite', name: 'Semantic sprite', width: 8, height: 8 }); const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    const apply = (id: number, clientOperationId: string, operation: Record<string, unknown>) => callTool(started.url, client.headers, id, 'canvas_apply', { documentId: document.id, clientOperationId, label: clientOperationId, playback: { mode: 'instant', speed: 1 }, operations: [operation] });
    expect(await apply(3, 'semantic-flood', { kind: 'pixel.flood-fill', spriteId: sprite.id, celId: cel.id, x: 0, y: 0, index: 4, expectedRevision: 0 })).toMatchObject({ status: 'committed' });
    expect(await apply(4, 'semantic-dither', { kind: 'pixel.ordered-dither', spriteId: sprite.id, celId: cel.id, region: { x: 0, y: 0, width: 4, height: 4 }, indexA: 4, indexB: 8, coverage: 0.5, expectedRevision: 1 })).toMatchObject({ status: 'committed' });
    expect(await apply(5, 'semantic-replace', { kind: 'pixel.replace-color', spriteId: sprite.id, celId: cel.id, fromIndex: 4, toIndex: 5, expectedRevision: 2 })).toMatchObject({ status: 'committed' });
    expect(await apply(6, 'semantic-adjust', { kind: 'pixel.adjust-index', spriteId: sprite.id, celId: cel.id, delta: 1, expectedRevision: 3 })).toMatchObject({ status: 'committed' });
    expect(await apply(7, 'semantic-selection-flip', { kind: 'pixel.selection.transform', spriteId: sprite.id, celId: cel.id, runs: [{ x: 0, y: 0, length: 2 }], transform: 'flip-horizontal', expectedRevision: 4 })).toMatchObject({ status: 'committed' });
    expect(await apply(8, 'semantic-selection-scale', { kind: 'pixel.selection.transform', spriteId: sprite.id, celId: cel.id, runs: [{ x: 0, y: 0, length: 2 }], transform: 'scale', scaleX: 2, scaleY: 1, expectedRevision: 5 })).toMatchObject({ status: 'committed' });
    const committed = documents.getDocument(document.id); if (!committed || committed.kind !== 'pixel') throw new Error('Expected pixel document'); const committedSprite = committed.pixelAssets[sprite.id]; if (committedSprite.type !== 'sprite') throw new Error('Expected sprite'); const committedCel = committedSprite.cels[cel.id];
    expect(readPixel(committedCel, 0, 0)).toBe(6);
    expect(readPixel(committedCel, 1, 0)).toBe(6);
    expect(readPixel(committedCel, 2, 0)).toBe(9);
    expect(readPixel(committedCel, 3, 0)).toBe(9);
    expect(readPixel(committedCel, 7, 7)).toBe(6);
  });

  it('creates, appends, replaces, and removes exact image-collection sources through one guarded semantic lifecycle transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-image-collection-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('image-collection-token');
    const client = await initializeClient(started.url, 'image-collection-token', 'image-collection-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'project', name: 'Semantic collection project' });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel project');
    const first = document.pixelAssets[document.activeAssetId]; if (first.type !== 'sprite') throw new Error('Expected first sprite');
    const second = createPixelSprite('Second semantic source', 12, 7);
    const third = createPixelSprite('Third semantic source', 5, 18);
    const fourth = createPixelSprite('Replacement semantic source', 4, 6);
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'collection-source-assets', label: 'Add collection source sprites', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.asset.add', asset: second }, { kind: 'pixel.asset.add', asset: third }, { kind: 'pixel.asset.add', asset: fourth }],
    })).toMatchObject({ status: 'committed' });
    const afterSources = documents.getDocument(document.id); if (!afterSources || afterSources.kind !== 'pixel') throw new Error('Expected pixel project');
    const sourceBytes = JSON.stringify([afterSources.pixelAssets[first.id], afterSources.pixelAssets[second.id], afterSources.pixelAssets[third.id], afterSources.pixelAssets[fourth.id]]);
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'semantic-collection-create', label: 'Create semantic image collection', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.image-collection.create', tilesetId: 'semantic-collection', name: 'Semantic objects', sourceSpriteIds: [third.id, first.id], expectedDocumentRevision: afterSources.revision }],
    })).toMatchObject({ status: 'committed' });
    const afterCreate = documents.getDocument(document.id); if (!afterCreate || afterCreate.kind !== 'pixel') throw new Error('Expected pixel project');
    const collection = afterCreate.pixelAssets['semantic-collection']; if (collection.type !== 'tileset') throw new Error('Expected image collection');
    expect(collection).toMatchObject({ firstGid: 1, tileWidth: Math.max(first.width, third.width), tileHeight: Math.max(first.height, third.height), columns: 0, rows: 0, createdBy: expect.stringMatching(/^agent[_-]/) });
    expect(collection.spriteAssetId).toBeUndefined();
    expect([collection.tiles[0].imageAssetId, collection.tiles[1].imageAssetId]).toEqual([third.id, first.id]);
    expect(JSON.stringify([afterCreate.pixelAssets[first.id], afterCreate.pixelAssets[second.id], afterCreate.pixelAssets[third.id], afterCreate.pixelAssets[fourth.id]])).toBe(sourceBytes);

    const mixedBefore = structuredClone(afterCreate);
    const mixed = await callToolMessage(started.url, client.headers, 5, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'semantic-collection-mixed', label: 'Reject mixed lifecycle', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.image-collection.append', tilesetId: collection.id, sourceSpriteId: second.id, expectedTilesetRevision: collection.revision, expectedDocumentRevision: afterCreate.revision }, { kind: 'document.rename', name: 'Must not rename' }],
    });
    expect(mixed.result?.isError).toBe(true);
    expect(JSON.stringify(mixed)).toContain('must be the only request');
    expect(documents.getDocument(document.id)).toEqual(mixedBefore);

    expect(await callTool(started.url, client.headers, 6, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'semantic-collection-append', label: 'Append semantic collection source', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.image-collection.append', tilesetId: collection.id, sourceSpriteId: second.id, expectedTilesetRevision: collection.revision, expectedDocumentRevision: afterCreate.revision }],
    })).toMatchObject({ status: 'committed' });
    const afterAppend = documents.getDocument(document.id); if (!afterAppend || afterAppend.kind !== 'pixel') throw new Error('Expected pixel project');
    const appended = afterAppend.pixelAssets[collection.id]; if (appended.type !== 'tileset') throw new Error('Expected image collection');
    expect(appended.tiles[2].imageAssetId).toBe(second.id);
    expect(appended.firstGid).toBe(collection.firstGid);
    expect(JSON.stringify([afterAppend.pixelAssets[first.id], afterAppend.pixelAssets[second.id], afterAppend.pixelAssets[third.id], afterAppend.pixelAssets[fourth.id]])).toBe(sourceBytes);

    expect(await callTool(started.url, client.headers, 7, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'semantic-collection-source-replace', label: 'Replace semantic collection source', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.image-collection.source.replace', tilesetId: collection.id, tileId: 0, sourceSpriteId: fourth.id, expectedTilesetRevision: appended.revision, expectedDocumentRevision: afterAppend.revision }],
    })).toMatchObject({ status: 'committed' });
    const afterReplacement = documents.getDocument(document.id); if (!afterReplacement || afterReplacement.kind !== 'pixel') throw new Error('Expected pixel project');
    const replaced = afterReplacement.pixelAssets[collection.id]; if (replaced.type !== 'tileset') throw new Error('Expected image collection');
    expect(replaced).toMatchObject({ firstGid: collection.firstGid, tiles: { 0: { id: 0, imageAssetId: fourth.id }, 1: { id: 1, imageAssetId: first.id }, 2: { id: 2, imageAssetId: second.id } } });
    expect(JSON.stringify([afterReplacement.pixelAssets[first.id], afterReplacement.pixelAssets[second.id], afterReplacement.pixelAssets[third.id], afterReplacement.pixelAssets[fourth.id]])).toBe(sourceBytes);

    expect(await callTool(started.url, client.headers, 8, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'semantic-collection-source-remove', label: 'Remove semantic collection source', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.image-collection.source.remove', tilesetId: collection.id, tileId: 1, expectedTilesetRevision: replaced.revision, expectedDocumentRevision: afterReplacement.revision }],
    })).toMatchObject({ status: 'committed' });
    const afterRemoval = documents.getDocument(document.id); if (!afterRemoval || afterRemoval.kind !== 'pixel') throw new Error('Expected pixel project');
    const removed = afterRemoval.pixelAssets[collection.id]; if (removed.type !== 'tileset') throw new Error('Expected image collection');
    expect(Object.keys(removed.tiles)).toEqual(['0', '2']);
    expect(removed).toMatchObject({ firstGid: collection.firstGid, tiles: { 0: { id: 0, imageAssetId: fourth.id }, 2: { id: 2, imageAssetId: second.id } } });
    expect(JSON.stringify([afterRemoval.pixelAssets[first.id], afterRemoval.pixelAssets[second.id], afterRemoval.pixelAssets[third.id], afterRemoval.pixelAssets[fourth.id]])).toBe(sourceBytes);

    const mixedMove = await callToolMessage(started.url, client.headers, 9, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'semantic-collection-move-mixed', label: 'Reject mixed collection tile move', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.image-collection.tile.move', tilesetId: collection.id, sourceTileId: 0, destinationTileId: 1, expectedTilesetRevision: removed.revision, expectedDocumentRevision: afterRemoval.revision }, { kind: 'document.rename', name: 'Must remain unchanged' }],
    });
    expect(mixedMove.result?.isError).toBe(true);
    expect(JSON.stringify(mixedMove)).toContain('must be the only request');
    expect(documents.getDocument(document.id)).toEqual(afterRemoval);

    expect(await callTool(started.url, client.headers, 10, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'semantic-collection-tile-move', label: 'Move semantic collection tile ID', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.image-collection.tile.move', tilesetId: collection.id, sourceTileId: 0, destinationTileId: 1, expectedTilesetRevision: removed.revision, expectedDocumentRevision: afterRemoval.revision }],
    })).toMatchObject({ status: 'committed' });
    const afterMove = documents.getDocument(document.id); if (!afterMove || afterMove.kind !== 'pixel') throw new Error('Expected pixel project');
    const moved = afterMove.pixelAssets[collection.id]; if (moved.type !== 'tileset') throw new Error('Expected image collection');
    expect(Object.keys(moved.tiles)).toEqual(['1', '2']);
    expect(moved).toMatchObject({ firstGid: collection.firstGid, tiles: { 1: { id: 1, imageAssetId: fourth.id }, 2: { id: 2, imageAssetId: second.id } } });
    expect(JSON.stringify([afterMove.pixelAssets[first.id], afterMove.pixelAssets[second.id], afterMove.pixelAssets[third.id], afterMove.pixelAssets[fourth.id]])).toBe(sourceBytes);

    const stale = await callToolMessage(started.url, client.headers, 11, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'semantic-collection-stale', label: 'Reject stale collection append', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.image-collection.append', tilesetId: collection.id, sourceSpriteId: second.id, expectedTilesetRevision: appended.revision, expectedDocumentRevision: afterCreate.revision }],
    });
    expect(stale.result?.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain('document revision changed');
    expect(documents.getDocument(document.id)).toEqual(afterMove);
    expect(await callTool(started.url, client.headers, 12, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const moveUndone = documents.getDocument(document.id); if (!moveUndone || moveUndone.kind !== 'pixel') throw new Error('Expected pixel project');
    const moveUndoneCollection = moveUndone.pixelAssets[collection.id]; if (moveUndoneCollection.type !== 'tileset') throw new Error('Expected image collection');
    expect(Object.keys(moveUndoneCollection.tiles)).toEqual(['0', '2']);
    expect(moveUndoneCollection.tiles[0].imageAssetId).toBe(fourth.id);
    expect(await callTool(started.url, client.headers, 13, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const removalUndone = documents.getDocument(document.id); if (!removalUndone || removalUndone.kind !== 'pixel') throw new Error('Expected pixel project');
    const removalUndoneCollection = removalUndone.pixelAssets[collection.id]; if (removalUndoneCollection.type !== 'tileset') throw new Error('Expected image collection');
    expect(removalUndoneCollection.tiles[1].imageAssetId).toBe(first.id);
    expect(removalUndoneCollection.tiles[0].imageAssetId).toBe(fourth.id);
    expect(await callTool(started.url, client.headers, 14, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const replacementUndone = documents.getDocument(document.id); if (!replacementUndone || replacementUndone.kind !== 'pixel') throw new Error('Expected pixel project');
    const replacementUndoneCollection = replacementUndone.pixelAssets[collection.id]; if (replacementUndoneCollection.type !== 'tileset') throw new Error('Expected image collection');
    expect(replacementUndoneCollection.tiles[0].imageAssetId).toBe(third.id);
    expect(replacementUndoneCollection.tiles[2].imageAssetId).toBe(second.id);
    expect(await callTool(started.url, client.headers, 15, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const undone = documents.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel project');
    const undoneCollection = undone.pixelAssets[collection.id]; if (undoneCollection.type !== 'tileset') throw new Error('Expected image collection');
    expect(Object.keys(undoneCollection.tiles)).toEqual(['0', '1']);
  });

  it('creates one exact sparse-infinite isometric image-collection tile object through the shared semantic planner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-collection-object-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('collection-object-token');
    const client = await initializeClient(started.url, 'collection-object-token', 'collection-object-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'project', name: 'Semantic collection object' });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel project');
    const source = document.pixelAssets[document.activeAssetId]; if (source.type !== 'sprite') throw new Error('Expected source sprite');
    const collection = createPixelTileset('Semantic sparse collection', source.id, source.width, source.height, 1, 1); collection.spriteAssetId = undefined; collection.firstGid = 31; collection.columns = 0; collection.rows = 0; collection.wangSets = [];
    collection.tiles = { 3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source.id, probability: 1, animation: [], collisions: [], properties: {} } };
    const map = createPixelTilemap('Semantic sparse-infinite map'); map.orientation = 'isometric'; map.infinite = true; map.tilesetIds = [collection.id]; const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.objects = [];
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'collection-object-setup', label: 'Add exact collection map', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.asset.add', asset: collection }, { kind: 'pixel.asset.add', asset: map }] })).toMatchObject({ status: 'committed' });
    const setup = documents.getDocument(document.id); if (!setup || setup.kind !== 'pixel') throw new Error('Expected pixel project'); const setupMap = setup.pixelAssets[map.id]; const setupCollection = setup.pixelAssets[collection.id]; if (setupMap.type !== 'tilemap' || setupCollection.type !== 'tileset') throw new Error('Expected collection map');
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'semantic-collection-object-create', label: 'Place exact collection tile object', playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.tile-object.create', mapId: map.id, layerId: layer.id, tilesetId: collection.id, tileId: 3, objectId: 'semantic-tile-object', x: -35, y: 37, transforms: { hFlip: true, vFlip: false, diagonal: true }, expectedMapRevision: setupMap.revision, expectedTilesetRevision: setupCollection.revision, expectedDocumentRevision: setup.revision }],
    })).toMatchObject({ status: 'committed' });
    const placed = documents.getDocument(document.id); if (!placed || placed.kind !== 'pixel') throw new Error('Expected pixel project'); const placedMap = placed.pixelAssets[map.id]; if (placedMap.type !== 'tilemap') throw new Error('Expected map'); const placedLayer = placedMap.layers[layer.id]; if (placedLayer.type !== 'object') throw new Error('Expected object layer');
    expect(placedLayer.objects).toEqual([{ id: 'semantic-tile-object', type: 'tile', gid: encodeTiledGid(34, { hFlip: true, diagonal: true }), x: -35, y: 37, width: source.width, height: source.height, rotation: 0, name: '', className: '', properties: {} }]);
    const mixed = await callToolMessage(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'collection-object-mixed', label: 'Reject mixed exact intent', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.tile-object.create', mapId: map.id, layerId: layer.id, tilesetId: collection.id, tileId: 3, objectId: 'second', x: 0, y: 0, expectedMapRevision: placedMap.revision, expectedTilesetRevision: setupCollection.revision, expectedDocumentRevision: placed.revision }, { kind: 'document.rename', name: 'Must not rename' }] });
    expect(mixed.result?.isError).toBe(true); expect(JSON.stringify(mixed)).toContain('must be the only request'); expect(documents.getDocument(document.id)).toEqual(placed);
    expect(await callTool(started.url, client.headers, 6, 'history_manage', { action: 'undo', documentId: document.id })).toMatchObject({ status: 'committed' });
    const undone = documents.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel project'); const undoneMap = undone.pixelAssets[map.id]; if (undoneMap.type !== 'tilemap') throw new Error('Expected map'); expect(undoneMap.layers[layer.id].objects).toEqual([]);
  });

  it('flood-fills a bounded connected island inside a sprite larger than one million cells', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('large-flood-token');
    const client = await initializeClient(started.url, 'large-flood-token', 'large-flood-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'sprite', name: 'Large sparse sprite', width: 1_001, height: 1_000 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'large-flood-seed', label: 'Seed isolated pixel', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x: 500, y: 500, index: 4 }], expectedRevision: 0 }] })).toMatchObject({ status: 'committed' });
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'large-flood-island', label: 'Fill isolated pixel', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.flood-fill', spriteId: sprite.id, celId: cel.id, x: 500, y: 500, index: 5, expectedRevision: 1 }] })).toMatchObject({ status: 'committed' });
    const committed = documents.getDocument(document.id); if (!committed || committed.kind !== 'pixel') throw new Error('Expected pixel document'); const committedSprite = committed.pixelAssets[sprite.id]; if (committedSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(readPixel(committedSprite.cels[cel.id], 500, 500)).toBe(5);
    expect(readPixel(committedSprite.cels[cel.id], 499, 500)).toBe(0);
    const beforeOverflow = structuredClone(committed);
    const overflow = await callToolMessage(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'large-flood-overflow', label: 'Reject oversized blank region', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.flood-fill', spriteId: sprite.id, celId: cel.id, x: 0, y: 0, index: 6, expectedRevision: 2 }] });
    expect(overflow.result?.isError).toBe(true);
    expect(JSON.stringify(overflow)).toContain('Pixel flood fill is limited to 1,000,000 cells; no pixels were changed.');
    expect(documents.getDocument(document.id)).toEqual(beforeOverflow);
  });

  it('expands semantic alignment, distribution, and editable material construction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root); const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize(); const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('illustration-semantic-token'); const client = await initializeClient(started.url, 'illustration-semantic-token', 'illustration-semantic-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'illustration', name: 'Semantic illustration', width: 400, height: 200, background: null }); const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'illustration') throw new Error('Expected illustration'); const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const positions = [{ id: 'semantic-a', x: 10, y: 30 }, { id: 'semantic-b', x: 100, y: 60 }, { id: 'semantic-c', x: 250, y: 90 }];
    const objects = positions.map(({ id, x, y }) => ({ id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged', layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y }, type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#e5b84b' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } }));
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-shapes', label: 'Add semantic shapes', playback: { mode: 'instant', speed: 1 }, operations: objects.map((object) => ({ kind: 'illustration.object.add', object })) })).toMatchObject({ status: 'committed' });
    const expected0 = Object.fromEntries(positions.map(({ id }) => [id, 0]));
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-align', label: 'Align semantic shapes', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.objects.align', objectIds: positions.map(({ id }) => id), expectedRevisions: expected0, mode: 'top', target: 'selection' }] })).toMatchObject({ status: 'committed' });
    const expected1 = Object.fromEntries(positions.map(({ id }) => [id, 1]));
    expect(await callTool(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-distribute', label: 'Distribute semantic shapes', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.objects.distribute', objectIds: positions.map(({ id }) => id), expectedRevisions: expected1, axis: 'x', mode: 'spacing' }] })).toMatchObject({ status: 'committed' });
    let current = documents.getDocument(document.id); if (!current || current.kind !== 'illustration') throw new Error('Expected illustration');
    const laidOut = current;
    expect(positions.map(({ id }) => laidOut.objects[id].transform.y)).toEqual([30, 30, 30]);
    expect(current.objects['semantic-b'].transform.x).toBeCloseTo(130);
    expect(await callTool(started.url, client.headers, 6, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-material', label: 'Apply polished gold', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.material.apply', objectId: 'semantic-c', expectedRevision: 2, preset: 'polished-gold' }] })).toMatchObject({ status: 'committed' });
    current = documents.getDocument(document.id); if (!current || current.kind !== 'illustration') throw new Error('Expected illustration');
    expect(current.objects['semantic-a']).toBeDefined(); expect(current.objects['semantic-b']).toBeDefined();
    expect(Object.values(current.layers).some((entry) => entry.type === 'group' && entry.name.includes('Polished Gold'))).toBe(true);
    expect(Object.values(current.objects).filter((object) => object.name.startsWith('Gold ·'))).toHaveLength(5);
    const source = createCanvas(40, 20); const sourceContext = source.getContext('2d'); sourceContext.fillStyle = '#e5b84b'; sourceContext.fillRect(0, 0, 40, 20); const bytes = source.toBuffer('image/png'); const asset = { id: 'crop-asset', name: 'Crop source', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'imported', data: bytes.toString('base64') }; const image = { id: 'crop-image', revision: 0, name: 'Crop image', createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged', layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 20, y: 20 }, type: 'image', assetId: asset.id, width: 40, height: 20, sourceWidth: 40, sourceHeight: 20, filters: [] };
    expect(await callTool(started.url, client.headers, 7, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-image-add', label: 'Add crop image', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'asset.add', asset }, { kind: 'illustration.object.add', object: image }] })).toMatchObject({ status: 'committed' });
    expect(await callTool(started.url, client.headers, 8, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-image-crop', label: 'Square crop image', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.image.crop', objectId: image.id, action: 'aspect', aspect: 1, expectedRevision: 0 }] })).toMatchObject({ status: 'committed' });
    expect(await callTool(started.url, client.headers, 9, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-image-filters', label: 'Stack image filters', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.image.filters.replace', objectId: image.id, expectedRevision: 1, filters: [{ type: 'blur', value: 2 }, { type: 'brightness', value: 0.2 }, { type: 'contrast', value: 0.1 }] }] })).toMatchObject({ status: 'committed' });
    current = documents.getDocument(document.id); if (!current || current.kind !== 'illustration') throw new Error('Expected illustration'); expect(current.objects[image.id]).toMatchObject({ width: 20, height: 20, crop: { x: 10, y: 0, width: 20, height: 20 }, transform: { x: 30, y: 20 }, filters: [{ type: 'blur', value: 2 }, { type: 'brightness', value: 0.2 }, { type: 'contrast', value: 0.1 }] });
    expect(await callTool(started.url, client.headers, 10, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-object-mask', label: 'Set object mask', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.mask.set', objectIds: ['semantic-a'], maskObjectId: 'semantic-b', expectedRevisions: { 'semantic-a': current.objects['semantic-a'].revision } }] })).toMatchObject({ status: 'committed' });
    current = documents.getDocument(document.id); if (!current || current.kind !== 'illustration') throw new Error('Expected illustration'); expect(current.objects['semantic-a'].maskObjectId).toBe('semantic-b');
    const booleanInputs = [{ ...objects[0], id: 'boolean-a', name: 'Boolean A', revision: 0, transform: { ...IDENTITY_TRANSFORM, x: 40, y: 130 }, width: 60, height: 40 }, { ...objects[1], id: 'boolean-b', name: 'Boolean B', revision: 0, transform: { ...IDENTITY_TRANSFORM, x: 70, y: 140 }, width: 60, height: 40 }];
    expect(await callTool(started.url, client.headers, 11, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-boolean-inputs', label: 'Add boolean inputs', playback: { mode: 'instant', speed: 1 }, operations: booleanInputs.map((object) => ({ kind: 'illustration.object.add', object })) })).toMatchObject({ status: 'committed' });
    expect(await callTool(started.url, client.headers, 12, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-boolean-union', label: 'Union paths', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.path.boolean', objectIds: ['boolean-a', 'boolean-b'], expectedRevisions: { 'boolean-a': 0, 'boolean-b': 0 }, mode: 'union' }] })).toMatchObject({ status: 'committed' });
    current = documents.getDocument(document.id); if (!current || current.kind !== 'illustration') throw new Error('Expected illustration'); expect(current.objects['boolean-a']).toBeUndefined(); expect(current.objects['boolean-b']).toBeUndefined(); expect(Object.values(current.objects).some((object) => object.type === 'path' && object.name === 'Union')).toBe(true);
    expect(await callTool(started.url, client.headers, 13, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-object-filters', label: 'Adjust vector object', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.filters.replace', objectId: 'semantic-a', expectedRevision: current.objects['semantic-a'].revision, filters: [{ type: 'hue', value: 24 }, { type: 'brightness', value: 0.15 }] }] })).toMatchObject({ status: 'committed' });
    current = documents.getDocument(document.id); if (!current || current.kind !== 'illustration') throw new Error('Expected illustration'); expect(current.objects['semantic-a'].filters).toEqual([{ type: 'hue', value: 24 }, { type: 'brightness', value: 0.15 }]);
    expect(await callTool(started.url, client.headers, 14, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-layer-filters', label: 'Adjust vector layer', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.layer.filters.replace', layerId: layer.id, expectedRevision: current.layers[layer.id].revision, filters: [{ type: 'contrast', value: 0.2 }, { type: 'blur', value: 1.5 }] }] })).toMatchObject({ status: 'committed' });
    current = documents.getDocument(document.id); if (!current || current.kind !== 'illustration') throw new Error('Expected illustration'); expect(current.layers[layer.id].filters).toEqual([{ type: 'contrast', value: 0.2 }, { type: 'blur', value: 1.5 }]);
  });

  it('serves every operation schema on demand and admits a semantic edit constructed from public discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-operation-help-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('operation-help-token'); const client = await initializeClient(started.url, 'operation-help-token', 'operation-help-client');
    let requestId = 2;
    const call = (name: string, args: Record<string, unknown>) => callTool(started.url, client.headers, requestId++, name, args);
    const catalog = await call('aidraw_help', { topic: 'operations' });
    const kinds = catalog.operationKinds as string[];
    expect(kinds.length).toBeGreaterThan(80);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).not.toContain('provenance.add'); expect(kinds).not.toContain('provenance.delete');
    const hostSource = await readFile(join(process.cwd(), 'src/main/mcp-host.ts'), 'utf8');
    const semanticDispatch = [...hostSource.matchAll(/value\.kind === '([^']+)'/g)].map((match) => match[1]).filter((kind) => !kind.startsWith('provenance.'));
    expect(kinds).toEqual(expect.arrayContaining(semanticDispatch));
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    const schemas = new Map<string, Record<string, unknown>>();
    for (const kind of kinds) {
      const help = await call('aidraw_help', { topic: 'operations', operation: kind });
      const detail = help.operation as { kind: string; inputSchema: Record<string, unknown>; preconditions: string[] };
      expect(detail.kind).toBe(kind); expect(detail.preconditions.length).toBeGreaterThan(0);
      expect(() => validator.compile(detail.inputSchema)).not.toThrow(); schemas.set(kind, detail.inputSchema);
    }
    expect(await callToolMessage(started.url, client.headers, requestId++, 'aidraw_help', { topic: 'operations', operation: 'provenance.add' })).toMatchObject({ result: { isError: true } });
    expect(await callToolMessage(started.url, client.headers, requestId++, 'aidraw_help', { topic: 'canvas', operation: 'illustration.gradient.set' })).toMatchObject({ result: { isError: true } });
    const created = await call('document_manage', { action: 'new', kind: 'illustration', name: 'Discovered semantic gradient', width: 128, height: 128 });
    const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument'];
    if (!document || document.kind !== 'illustration') throw new Error('Expected illustration');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
    const apply = (operations: unknown[], id: string) => call('canvas_apply', { documentId: document.id, clientOperationId: id, label: id, playback: { mode: 'instant', speed: 1 }, operations });
    const add = { kind: 'illustration.object.add', object: { id: 'discovered-shape', name: 'Discovered shape', layerId: layer.id, type: 'shape', shape: 'ellipse', width: 120, height: 120 } };
    expect(validator.validate(schemas.get(add.kind)!, add)).toBe(true);
    expect(await apply([add], 'discovered-add')).toMatchObject({ status: 'committed' });
    const observed = await call('canvas_observe', { documentId: document.id });
    const current = observed.document as typeof document;
    const gradientSchema = schemas.get('illustration.gradient.set')!;
    const gradientHelp = await call('aidraw_help', { topic: 'operations', operation: 'illustration.gradient.set' });
    expect(JSON.stringify(gradientHelp).length).toBeLessThan(4_096);
    expect(gradientHelp.operationKinds).toBeUndefined();
    const properties = gradientSchema.properties as Record<string, { const?: string; enum?: string[] }>;
    const gradient = { kind: properties.kind.const, objectId: 'discovered-shape', gradientKind: properties.gradientKind.enum!.find((value) => value === 'radial-gradient'), x1: 60, y1: 60, x2: 120, y2: 60, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }], expectedRevision: current.objects['discovered-shape'].revision };
    expect(validator.validate(gradientSchema, gradient)).toBe(true);
    expect(await apply([gradient], 'discovered-gradient')).toMatchObject({ status: 'committed' });
    const after = (await call('canvas_observe', { documentId: document.id })).document as typeof document;
    expect(after.objects['discovered-shape']).toMatchObject({ fill: { kind: 'radial-gradient', x1: 60, y1: 60, x2: 120, y2: 60 } });
    expect((await call('aidraw_help', { topic: 'operations', operation: 'illustration.gradient.set' })).operation).toMatchObject({ preconditions: expect.arrayContaining([expect.stringContaining('local object pixels')]) });
  });

  it('refuses compound boolean results and cross-layer group subtrees without mutation or retry advice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-capability-refusal-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host);
    const started = await host.start('capability-token'); const client = await initializeClient(started.url, 'capability-token', 'capability-client');
    let requestId = 2;
    const call = (name: string, args: Record<string, unknown>) => callTool(started.url, client.headers, requestId++, name, args);
    const made = await call('document_manage', { action: 'new', kind: 'illustration', name: 'Capability boundaries' });
    const document = made.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument'];
    if (!document || document.kind !== 'illustration') throw new Error('Expected illustration');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
    const apply = (operations: unknown[], id: string) => call('canvas_apply', { documentId: document.id, clientOperationId: id, label: id, playback: { mode: 'instant', speed: 1 }, operations });
    expect(await apply(['a', 'b'].map((id, i) => ({ kind: 'illustration.object.add', object: { id, name: id, layerId: layer.id, type: 'shape', shape: 'rectangle', width: 40, height: 40, transform: { x: 10 + i * 20, y: 10 } } })), 'boolean-operands')).toMatchObject({ status: 'committed' });
    const before = structuredClone(documents.getDocument(document.id));
    const excluded = await apply([{ kind: 'illustration.path.boolean', objectIds: ['a', 'b'], expectedRevisions: { a: 0, b: 0 }, mode: 'exclude' }], 'unsupported-exclude');
    expect(excluded).toMatchObject({ status: 'conflict', conflict: { retryable: false }, next: { tool: 'aidraw_help' } });
    expect(String(excluded.message)).toContain('Both operands are unchanged');
    expect(documents.getDocument(document.id)).toEqual(before);
    expect(await apply([{ kind: 'illustration.object.add', object: { id: 'group', name: 'Populated group', layerId: layer.id, type: 'group', childIds: ['a', 'b'] } }, { kind: 'illustration.layer.add', layer: { ...layer, id: 'target-vector', name: 'Target', objectIds: [] } }], 'group-and-layer')).toMatchObject({ status: 'committed' });
    const grouped = structuredClone(documents.getDocument(document.id));
    if (!grouped || grouped.kind !== 'illustration') throw new Error('Expected illustration');
    expect(await apply([{ kind: 'illustration.object.move', objectId: 'group', layerId: 'target-vector', expectedRevision: grouped.objects.group.revision }], 'unsupported-group-move')).toMatchObject({ status: 'conflict', conflict: { retryable: false }, next: { tool: 'aidraw_help' } });
    expect(documents.getDocument(document.id)).toEqual(grouped);
    expect(await apply([{ kind: 'illustration.object.move', objectId: 'a', layerId: 'target-vector', expectedRevision: grouped.objects.a.revision }], 'supported-single-move')).toMatchObject({ status: 'committed' });
  });

  it('authors multi-stop gradients and exact styled text ranges through semantic operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root); const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize(); const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('styled-content-token'); const client = await initializeClient(started.url, 'styled-content-token', 'styled-content-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'illustration', name: 'Styled content', width: 320, height: 180, background: null }); const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'illustration') throw new Error('Expected illustration'); const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const base = { revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged', layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: IDENTITY_TRANSFORM };
    const shape = { ...base, id: 'gradient-shape', name: 'Gradient shape', type: 'shape' as const, shape: 'rectangle' as const, width: 160, height: 80, fill: { kind: 'solid' as const, color: '#ffffff' }, stroke: { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] } };
    const text = { ...base, id: 'styled-text', name: 'Styled text', type: 'text' as const, text: 'Gold', width: 220, height: 100, align: 'left' as const, lineHeight: 1.2, ranges: [{ start: 0, end: 4, fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 400, fontStyle: 'normal' as const, color: '#27213c', letterSpacing: 0 }] };
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'styled-content-source', label: 'Add styled sources', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.add', object: shape }, { kind: 'illustration.object.add', object: text }] })).toMatchObject({ status: 'committed' });
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-gradient', label: 'Author gradient', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.gradient.set', objectId: shape.id, gradientKind: 'linear-gradient', x1: 0, y1: 0, x2: 160, y2: 0, stops: [{ offset: 1, color: '#7a3f12' }, { offset: 0, color: '#fff1a8', opacity: 0.45 }, { offset: 0.55, color: '#d89c27' }], expectedRevision: 0 }] })).toMatchObject({ status: 'committed' });
    expect(await callTool(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-text-content', label: 'Change text', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.text.content.set', objectId: text.id, text: 'Copper express', expectedRevision: 0 }] })).toMatchObject({ status: 'committed' });
    expect(await callTool(started.url, client.headers, 6, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-text-style', label: 'Style text range', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.text.style', objectId: text.id, start: 0, end: 6, style: { fontWeight: 800, fontStyle: 'italic', color: '#c47721', underline: true }, expectedRevision: 1 }] })).toMatchObject({ status: 'committed' });
    const result = documents.getDocument(document.id); if (!result || result.kind !== 'illustration') throw new Error('Expected illustration'); const gradient = result.objects[shape.id]; if (gradient.type !== 'shape' || gradient.fill.kind !== 'linear-gradient') throw new Error('Expected gradient shape'); expect(gradient.fill.stops).toEqual([{ offset: 0, color: '#fff1a8', opacity: 0.45 }, { offset: 0.55, color: '#d89c27' }, { offset: 1, color: '#7a3f12' }]);
    const styled = result.objects[text.id]; if (styled.type !== 'text') throw new Error('Expected text'); expect(styled.text).toBe('Copper express'); expect(styled.ranges[0]).toMatchObject({ start: 0, end: 6, fontWeight: 800, fontStyle: 'italic', color: '#c47721', underline: true }); expect(styled.ranges.at(-1)?.end).toBe(styled.text.length);
  });

  it('inspects and edits semantic Bézier anchors, handles, subdivisions, node kinds, and closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root); const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize(); const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('path-node-token'); const client = await initializeClient(started.url, 'path-node-token', 'path-node-client');
    const created = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'new', kind: 'illustration', name: 'Semantic path', width: 160, height: 100, background: null }); const document = created.activeDocument as ReturnType<DocumentService['snapshot']>['activeDocument']; if (!document || document.kind !== 'illustration') throw new Error('Expected illustration'); const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const pathObject = { id: 'semantic-path', revision: 0, name: 'Semantic curve', createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged', layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'path', pathData: 'M 0 0 C 20 0 20 20 40 20 C 60 20 60 0 80 0', closed: false, fillRule: 'nonzero', fill: { kind: 'none' }, stroke: { paint: { kind: 'solid', color: '#8268dd' }, width: 2, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    const arcObject = { ...pathObject, id: 'semantic-arc', name: 'Semantic arc', pathData: 'M 0 0 A 30 20 25 0 1 70 30' };
    expect(await callTool(started.url, client.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'semantic-path-add', label: 'Add semantic paths', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.add', object: pathObject }, { kind: 'illustration.object.add', object: arcObject }] })).toMatchObject({ status: 'committed' });
    const observed = await callTool(started.url, client.headers, 4, 'canvas_observe', { documentId: document.id, pathObjectId: pathObject.id });
    expect(observed.path).toMatchObject({ available: true, objectId: pathObject.id, revision: 0, closed: false, nodes: [{ index: 0 }, { index: 1, anchor: { x: 40, y: 20 }, kind: 'smooth' }, { index: 2 }] });
    const apply = (id: number, clientOperationId: string, operation: Record<string, unknown>) => callTool(started.url, client.headers, id, 'canvas_apply', { documentId: document.id, clientOperationId, label: clientOperationId, playback: { mode: 'instant', speed: 1 }, operations: [operation] });
    expect(await apply(5, 'semantic-path-move', { kind: 'illustration.path.node.move', objectId: pathObject.id, nodeIndex: 1, point: 'anchor', x: 45, y: 25, expectedRevision: 0 })).toMatchObject({ status: 'committed' });
    expect(await apply(6, 'semantic-path-insert', { kind: 'illustration.path.node.insert', objectId: pathObject.id, segmentIndex: 0, time: 0.5, expectedRevision: 1 })).toMatchObject({ status: 'committed' });
    expect(await apply(7, 'semantic-path-corner', { kind: 'illustration.path.node.convert', objectId: pathObject.id, nodeIndex: 1, nodeKind: 'corner', expectedRevision: 2 })).toMatchObject({ status: 'committed' });
    expect(await apply(8, 'semantic-path-delete', { kind: 'illustration.path.node.delete', objectId: pathObject.id, nodeIndex: 1, expectedRevision: 3 })).toMatchObject({ status: 'committed' });
    expect(await apply(9, 'semantic-path-close', { kind: 'illustration.path.closed.set', objectId: pathObject.id, closed: true, expectedRevision: 4 })).toMatchObject({ status: 'committed' });
    const final = await callTool(started.url, client.headers, 10, 'canvas_observe', { documentId: document.id, pathObjectId: pathObject.id });
    expect(final.path).toMatchObject({ available: true, revision: 5, closed: true, nodes: [{ index: 0 }, { index: 1, anchor: { x: 45, y: 25 } }, { index: 2 }] });
    const committed = documents.getDocument(document.id); if (!committed || committed.kind !== 'illustration') throw new Error('Expected semantic path'); const committedPath = committed.objects[pathObject.id]; if (committedPath.type !== 'path') throw new Error('Expected semantic path');
    expect(committedPath.pathData.trim().endsWith('Z')).toBe(true);
    expect(await apply(11, 'semantic-path-arcs', { kind: 'illustration.path.arcs.convert', objectId: arcObject.id, expectedRevision: 0 })).toMatchObject({ status: 'committed' });
    const converted = documents.getDocument(document.id); if (!converted || converted.kind !== 'illustration') throw new Error('Expected converted arc'); const convertedArc = converted.objects[arcObject.id]; if (convertedArc.type !== 'path') throw new Error('Expected converted arc'); expect(convertedArc.pathData).not.toMatch(/[aA]/);
    expect(await apply(12, 'semantic-path-split', { kind: 'illustration.path.split', objectId: arcObject.id, nodeIndex: 1, newObjectId: 'semantic-arc-tail', expectedRevision: 1 })).toMatchObject({ status: 'committed' });
    const split = documents.getDocument(document.id); if (!split || split.kind !== 'illustration') throw new Error('Expected split path'); expect(split.objects['semantic-arc-tail']).toMatchObject({ type: 'path', revision: 0, closed: false });
    expect(await apply(13, 'semantic-path-join', { kind: 'illustration.path.join', primaryObjectId: arcObject.id, secondaryObjectId: 'semantic-arc-tail', endpoints: 'nearest', expectedRevisions: { [arcObject.id]: 2, 'semantic-arc-tail': 0 } })).toMatchObject({ status: 'committed' });
    const joined = documents.getDocument(document.id); if (!joined || joined.kind !== 'illustration') throw new Error('Expected joined path'); expect(joined.objects['semantic-arc-tail']).toBeUndefined(); expect(joined.objects[arcObject.id]).toMatchObject({ type: 'path', revision: 3, closed: false });
  });

  it('reports human occupancy and returns a retryable lock conflict to agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('lock-token');
    const client = await initializeClient(started.url, 'lock-token', 'lock-client');
    const document = documents.snapshot().activeDocument!; if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
    const added = await callTool(started.url, client.headers, 2, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'lock-object-add', label: 'Add lock target', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.add', object: { id: 'locked-object', revision: 0, name: 'Lock target', createdAt: nowIso(), updatedAt: nowIso(), createdBy: 'forged', layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#ff6b7a' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } } }],
    });
    expect(added.status).toBe('committed');
    const lock = documents.acquireLock({ documentId: document.id, objectIds: ['locked-object'] });
    documents.setEditorAttached(true);
    documents.updateEditorAdvisory({ documentId: document.id, tool: 'select', selectedEntityIds: ['locked-object'], zoom: 2.5, viewport: { x: -99_000_000, y: 4, width: 500, height: 300 }, animation: { activeAssetId: 'sprite', activeFrameId: 'frame', activeTagId: 'walk', playing: true, onionSkin: true, direction: 'ping-pong' } });
    const inspected = await callTool(started.url, client.headers, 3, 'session_manage', { action: 'inspect', documentId: document.id });
    expect(inspected.workspace).toMatchObject({ activeDocumentId: document.id, humanOccupancy: { active: true, locks: [{ objectIds: ['locked-object'] }] }, editorAdvisory: { advisory: true, attached: true, documentId: document.id, tool: 'select', selectedEntityIds: ['locked-object'], zoom: 2.5, viewport: { x: -16_777_216, y: 4, width: 500, height: 300 }, animation: { activeAssetId: 'sprite', activeFrameId: 'frame', activeTagId: 'walk', playing: true, onionSkin: true, direction: 'ping-pong' } } });
    const observed = await callTool(started.url, client.headers, 4, 'canvas_observe', { documentId: document.id });
    expect(observed.humanOccupancy).toMatchObject({ active: true });
    const blocked = await callTool(started.url, client.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'locked-delete', label: 'Delete locked object', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.delete', objectId: 'locked-object', expectedRevision: 0 }] });
    expect(blocked).toMatchObject({ status: 'locked', conflict: { retryable: true } });
    if (lock.lockId) documents.releaseLock(lock.lockId);
    documents.setEditorAttached(false);
    expect(await callTool(started.url, client.headers, 6, 'session_manage', { action: 'inspect' })).toMatchObject({ workspace: { editorAdvisory: { advisory: true, attached: false } } });
  });

  it('keeps MCP active identity and editor advisory atomic when a stale renderer tab update arrives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-active-identity-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const first = documents.snapshot().activeDocument!;
    const second = documents.create({ kind: 'illustration', name: 'Second renderer tab' }).activeDocument!;
    documents.setEditorAttached(true);
    documents.updateEditorAdvisory({ documentId: second.id, tool: 'bezier', selectedEntityIds: ['second-tab-preview'], zoom: 2 });
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('active-identity-token');
    const client = await initializeClient(started.url, 'active-identity-token', 'active-identity-client');

    const activated = await callTool(started.url, client.headers, 2, 'document_manage', { action: 'activate', documentId: first.id });
    expect(activated).toMatchObject({ activeDocumentId: first.id, activeDocument: { id: first.id }, workspaceRevision: expect.any(Number) });
    documents.updateEditorAdvisory({ documentId: second.id, tool: 'pencil', selectedEntityIds: ['stale-second-preview'], zoom: 4 });
    const [listed, inspected] = await Promise.all([
      callTool(started.url, client.headers, 3, 'document_manage', { action: 'list' }),
      callTool(started.url, client.headers, 4, 'session_manage', { action: 'inspect' }),
    ]);
    expect(listed).toMatchObject({ activeDocumentId: first.id });
    expect(inspected).toMatchObject({ workspace: { activeDocumentId: first.id, editorAdvisory: { attached: true, documentId: first.id, selectedEntityIds: [] } } });
  });

  it('returns exact stale-revision details and a canonical observe-before-retry step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-revision-conflict-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('revision-conflict-token');
    const client = await initializeClient(started.url, 'revision-conflict-token', 'revision-conflict-client');
    const document = documents.snapshot().activeDocument!; if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector'); if (!layer) throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const added = await callTool(started.url, client.headers, 2, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'revision-conflict-add', label: 'Add conflict target', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.add', object: { id: 'revision-conflict-object', revision: 0, name: 'Conflict target', createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged', layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#5f82ff' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } } }],
    });
    expect(added).toMatchObject({ status: 'committed' });
    const afterAdd = documents.getDocument(document.id); if (!afterAdd || afterAdd.kind !== 'illustration') throw new Error('Expected canonical illustration');
    const initialObject = afterAdd.objects['revision-conflict-object'];
    const firstEdit = await callTool(started.url, client.headers, 3, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'revision-conflict-first-edit', label: 'Commit first edit', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.replace', object: { ...initialObject, name: 'Current canonical target' }, expectedRevision: 0 }],
    });
    expect(firstEdit).toMatchObject({ status: 'committed' });
    const beforeConflict = structuredClone(documents.getDocument(document.id)!);

    const staleMessage = await callToolMessage(started.url, client.headers, 4, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'revision-conflict-stale-edit', label: 'Reject stale edit', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.replace', object: { ...initialObject, name: 'Stale target must not commit' }, expectedRevision: 0 }],
    });
    const stale = toolPayload(staleMessage);
    expect(staleMessage.result?.structuredContent).toEqual(stale);
    expect(stale).toEqual({
      status: 'conflict',
      message: 'Revision conflict for Current canonical target',
      conflict: { entityId: 'revision-conflict-object', expectedRevision: 0, actualRevision: 1, retryable: true },
      next: {
        tool: 'canvas_observe',
        arguments: { documentId: document.id },
        guidance: 'Re-observe canonical state, honor human/agent locks and current revisions, then retry the same logical intent with a fresh clientOperationId only when appropriate.',
      },
    });
    expect(documents.getDocument(document.id)).toEqual(beforeConflict);

    const observed = await callTool(started.url, client.headers, 5, 'canvas_observe', { documentId: document.id });
    const observedDocument = observed.document as { objects: Record<string, typeof initialObject> };
    const currentObject = observedDocument.objects['revision-conflict-object'];
    expect(currentObject).toMatchObject({ name: 'Current canonical target', revision: 1 });
    const retried = await callTool(started.url, client.headers, 6, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'revision-conflict-retry-fresh', label: 'Retry observed intent', playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'illustration.object.replace', object: { ...currentObject, name: 'Observed retry target' }, expectedRevision: currentObject.revision }],
    });
    expect(retried).toMatchObject({ status: 'committed', revision: beforeConflict.revision + 1 });
    const afterRetry = documents.getDocument(document.id); if (!afterRetry || afterRetry.kind !== 'illustration') throw new Error('Expected retried illustration');
    expect(afterRetry.objects['revision-conflict-object']).toMatchObject({ name: 'Observed retry target', revision: 2 });
  });

  it('keeps job discovery and control private to the originating authenticated actor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('job-token');
    const owner = await initializeClient(started.url, 'job-token', 'job-owner'); const stranger = await initializeClient(started.url, 'job-token', 'job-stranger');
    const documentId = documents.snapshot().activeDocument!.id;
    const privatePath = join(root, 'private-owner-output.png');
    const startedJob = await callTool(started.url, owner.headers, 2, 'document_export', { documentId, path: privatePath, format: 'png', scale: 1 });
    const jobId = String(startedJob.jobId);
    const ownerList = await callTool(started.url, owner.headers, 3, 'job_manage', { action: 'list' });
    expect(ownerList.jobs).toEqual([expect.objectContaining({ id: jobId, status: 'waiting-for-user', dependency: expect.objectContaining({ kind: 'user-approval' }) })]);
    expect(JSON.stringify(ownerList)).not.toContain(privatePath);
    expect((ownerList.jobs as Array<Record<string, unknown>>)[0]).not.toHaveProperty('approval');
    expect((ownerList.jobs as Array<Record<string, unknown>>)[0]).not.toHaveProperty('result');
    expect(await callTool(started.url, stranger.headers, 4, 'job_manage', { action: 'list' })).toEqual({ jobs: [] });
    expect(await callTool(started.url, stranger.headers, 5, 'job_manage', { action: 'inspect', jobId })).toEqual({ error: 'job_not_found' });
    expect(await callTool(started.url, stranger.headers, 6, 'job_manage', { action: 'cancel', jobId })).toEqual({ error: 'job_not_found' });
    const dependency = await callTool(started.url, owner.headers, 7, 'job_manage', { action: 'approve-dependent', jobId });
    expect(dependency).toMatchObject({ id: jobId, status: 'waiting-for-user', dependency: { kind: 'user-approval', guidance: expect.stringContaining('cannot approve') } });
    expect(await callTool(started.url, owner.headers, 8, 'job_manage', { action: 'cancel', jobId })).toMatchObject({ id: jobId, status: 'cancelled' });
  });

  it('keeps completed file output canonical while authenticated job summaries omit raw results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0'); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('completed-job-token');
    const client = await initializeClient(started.url, 'completed-job-token', 'completed-job-owner');
    const documentId = documents.snapshot().activeDocument!.id;
    const outputPath = join(root, 'private-completed-output.png');
    const requested = await callTool(started.url, client.headers, 2, 'document_export', { documentId, path: outputPath, format: 'png', scale: 1 });
    const jobId = String(requested.jobId); const waiting = documents.getJob(jobId)!; const queued = documents.resolveJob(jobId, 'allow-once')!;
    const output = { path: outputPath, companionPaths: [], warnings: ['private export detail'], reportId: 'report-private' };
    documents.upsertJob({ ...queued, status: 'completed', progress: 1, updatedAt: nowIso(), message: 'Approved export completed.', result: { ...(queued.result as Record<string, unknown>), output } });

    const summary = await callTool(started.url, client.headers, 3, 'job_manage', { action: 'wait', jobId, timeoutMs: 1 });
    expect(summary).toMatchObject({ id: jobId, kind: 'export', status: 'completed', actor: { id: waiting.actor.id }, progress: 1 });
    expect(summary).not.toHaveProperty('result');
    expect(JSON.stringify(summary)).not.toContain(outputPath);
    expect(documents.getJob(jobId)).toMatchObject({ result: { output } });
    expect(documents.snapshot().jobs.find((job) => job.id === jobId)).toMatchObject({ result: { output } });
  });

  it('runs resumable numbered batches across MCP sessions and engine-host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); documents.initialize();
    const portPath = join(root, 'port.json');
    const firstHost = new McpHost(documents, '1.0.0', portPath); hosts.push(firstHost); const firstStart = await firstHost.start('batch-token-one');
    const firstClient = await initializeClient(firstStart.url, 'batch-token-one', 'batch-client-one');
    const document = documents.snapshot().activeDocument!;
    const startedBatch = await callTool(firstStart.url, firstClient.headers, 2, 'job_manage', { action: 'start-batch', documentId: document.id, totalTransactions: 2, label: 'Two-step durable drawing' });
    const job = startedBatch.job as { id: string; status: string; batch: { nextSequence: number } };
    const resumeToken = startedBatch.resumeToken as string;
    expect(job).toMatchObject({ status: 'queued', batch: { nextSequence: 0 } });
    expect(resumeToken.length).toBeGreaterThanOrEqual(32);

    const ahead = await callTool(firstStart.url, firstClient.headers, 3, 'canvas_apply', { documentId: document.id, clientOperationId: 'durable-batch-step-1', label: 'Out of order', playback: { mode: 'instant', speed: 1 }, batch: { jobId: job.id, resumeToken, sequence: 1 }, operations: [{ kind: 'document.rename', name: 'Should not commit' }] });
    expect(ahead).toMatchObject({ status: 'conflict', batch: { expectedSequence: 0 } });
    const first = await callTool(firstStart.url, firstClient.headers, 4, 'canvas_apply', { documentId: document.id, clientOperationId: 'durable-batch-step-0', label: 'Durable step one', playback: { mode: 'instant', speed: 1 }, batch: { jobId: job.id, resumeToken, sequence: 0 }, operations: [{ kind: 'document.rename', name: 'Durable step one' }] });
    expect(first).toMatchObject({ status: 'committed', batch: { jobId: job.id, status: 'queued', progress: 0.5, nextSequence: 1 } });
    const revisionAfterFirst = documents.getDocument(document.id)!.revision;
    expect(await callTool(firstStart.url, firstClient.headers, 5, 'canvas_apply', { documentId: document.id, clientOperationId: 'durable-batch-step-0', label: 'Idempotent retry', playback: { mode: 'instant', speed: 1 }, batch: { jobId: job.id, resumeToken, sequence: 0 }, operations: [{ kind: 'document.rename', name: 'Must remain unchanged' }] })).toMatchObject({ status: 'duplicate', batch: { expectedSequence: 1, duplicate: true } });
    expect(documents.getDocument(document.id)!.revision).toBe(revisionAfterFirst);
    expect(await callTool(firstStart.url, firstClient.headers, 6, 'canvas_apply', { documentId: document.id, clientOperationId: 'durable-batch-step-0', label: 'Wrong sequence reuse', playback: { mode: 'instant', speed: 1 }, batch: { jobId: job.id, resumeToken, sequence: 1 }, operations: [{ kind: 'document.rename', name: 'Must still remain unchanged' }] })).toMatchObject({ status: 'conflict', message: expect.stringContaining('fresh idempotency key'), batch: { expectedSequence: 1 } });
    expect(documents.getDocument(document.id)!.revision).toBe(revisionAfterFirst);

    await firstHost.stop();
    const secondHost = new McpHost(documents, '1.0.0', portPath); hosts.push(secondHost); const secondStart = await secondHost.start('batch-token-two');
    const secondClient = await initializeClient(secondStart.url, 'batch-token-two', 'batch-client-two');
    expect(await callTool(secondStart.url, secondClient.headers, 7, 'job_manage', { action: 'resume-batch', jobId: job.id, resumeToken: 'invalid-resume-token-that-is-long-enough' })).toEqual({ error: 'job_not_found' });
    const resumed = await callTool(secondStart.url, secondClient.headers, 8, 'job_manage', { action: 'resume-batch', jobId: job.id, resumeToken });
    expect(resumed).toMatchObject({ nextSequence: 1, job: { status: 'queued', batch: { nextSequence: 1, totalTransactions: 2 } } });
    const second = await callTool(secondStart.url, secondClient.headers, 9, 'canvas_apply', { documentId: document.id, clientOperationId: 'durable-batch-step-1', label: 'Durable step two', playback: { mode: 'instant', speed: 1 }, batch: { jobId: job.id, resumeToken, sequence: 1 }, operations: [{ kind: 'document.rename', name: 'Durable batch complete' }] });
    expect(second).toMatchObject({ status: 'committed', batch: { status: 'completed', progress: 1, nextSequence: 2 } });
    expect(documents.getDocument(document.id)?.name).toBe('Durable batch complete');

    const cancelStart = await callTool(secondStart.url, secondClient.headers, 10, 'job_manage', { action: 'start-batch', documentId: document.id, totalTransactions: 2, label: 'Cancelled batch' });
    const cancelJob = cancelStart.job as { id: string }; const cancelToken = cancelStart.resumeToken as string;
    expect(await callTool(secondStart.url, secondClient.headers, 11, 'job_manage', { action: 'cancel', jobId: cancelJob.id })).toMatchObject({ kind: 'batch', status: 'cancelled', progress: 0 });
    expect(await callTool(secondStart.url, secondClient.headers, 12, 'canvas_apply', { documentId: document.id, clientOperationId: 'cancelled-batch-step', label: 'Must stay cancelled', playback: { mode: 'instant', speed: 1 }, batch: { jobId: cancelJob.id, resumeToken: cancelToken, sequence: 0 }, operations: [{ kind: 'document.rename', name: 'Must not commit' }] })).toMatchObject({ status: 'cancelled' });
    expect(documents.getDocument(document.id)?.name).toBe('Durable batch complete');
  });

  it('reopens a durable chunk cancelled after preparation but before first dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-batch-predispatch-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('batch-predispatch-token');
    const client = await initializeClient(started.url, 'batch-predispatch-token', 'batch-predispatch-client');
    const document = documents.snapshot().activeDocument!;
    const startedBatch = await callTool(started.url, client.headers, 2, 'job_manage', { action: 'start-batch', documentId: document.id, totalTransactions: 1, label: 'Pre-dispatch cancellation' });
    const job = startedBatch.job as { id: string }; const resumeToken = String(startedBatch.resumeToken);
    const batches = (host as unknown as { batches: BatchManager }).batches;
    const prepare = batches.prepare.bind(batches); const entered = deferred(); const release = deferred(); let blockOnce = true;
    batches.prepare = async (...args: Parameters<BatchManager['prepare']>) => {
      const result = await prepare(...args);
      if (blockOnce && result.accepted) { blockOnce = false; entered.resolve(); await release.promise; }
      return result;
    };
    const request = {
      documentId: document.id, clientOperationId: 'cancelled-before-dispatch-step', label: 'Cancelled before dispatch', playback: { mode: 'instant', speed: 1 },
      batch: { jobId: job.id, resumeToken, sequence: 0 }, operations: [{ kind: 'document.rename', name: 'Must not commit before retry' }],
    };
    const pending = fetch(started.url, {
      method: 'POST', headers: client.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'canvas_apply', arguments: request } }),
    }).then(async (response) => ({ status: response.status, body: await response.text() })).catch((error: unknown) => ({ status: 0, body: String(error) }));
    await entered.promise;
    expect(documents.getDocument(document.id)?.revision).toBe(0);
    expect((await fetch(started.url, { method: 'DELETE', headers: client.headers })).status).toBe(200);
    release.resolve();
    await pending;
    await expect.poll(async () => (await batches.preflight({ jobId: job.id, resumeToken, sequence: 0 }, document.id, 'cancelled-before-dispatch-step')).accepted, { timeout: 2_000 }).toBe(true);
    expect(documents.getDocument(document.id)?.revision).toBe(0);

    const replacement = await initializeClient(started.url, 'batch-predispatch-token', 'batch-predispatch-replacement');
    expect(await callTool(started.url, replacement.headers, 4, 'canvas_apply', request)).toMatchObject({ status: 'committed', batch: { status: 'completed', nextSequence: 1 } });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Must not commit before retry', revision: 1 });
    expect((await documents.listTrace(document.id)).filter((entry) => entry.transaction.clientOperationId === 'cancelled-before-dispatch-step')).toHaveLength(1);
  });

  it('reconciles a committed durable chunk after ledger finalization fails without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-batch-finalize-')); temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('batch-finalize-token');
    const client = await initializeClient(started.url, 'batch-finalize-token', 'batch-finalize-client');
    const document = documents.snapshot().activeDocument!;
    const startedBatch = await callTool(started.url, client.headers, 2, 'job_manage', { action: 'start-batch', documentId: document.id, totalTransactions: 1, label: 'Finalization recovery' });
    const job = startedBatch.job as { id: string }; const resumeToken = String(startedBatch.resumeToken);
    const batches = (host as unknown as { batches: BatchManager }).batches;
    const internals = batches as unknown as { replaceFile: (source: string, destination: string) => Promise<void> };
    const replaceFile = internals.replaceFile; const finish = batches.finish.bind(batches); let insideFinish = false; let rejected = false;
    internals.replaceFile = async (source, destination) => {
      if (insideFinish && !rejected) { rejected = true; throw new Error('Injected post-commit batch-ledger finalization failure.'); }
      await replaceFile(source, destination);
    };
    batches.finish = async (...args: Parameters<BatchManager['finish']>) => {
      insideFinish = true;
      try { return await finish(...args); }
      finally { insideFinish = false; }
    };
    const request = {
      documentId: document.id, clientOperationId: 'committed-before-ledger-finalize', label: 'Commit before ledger finalize', playback: { mode: 'instant', speed: 1 },
      batch: { jobId: job.id, resumeToken, sequence: 0 }, operations: [{ kind: 'document.rename', name: 'Committed exactly once' }],
    };
    const failed = await callToolMessage(started.url, client.headers, 3, 'canvas_apply', request);
    expect(JSON.stringify(failed)).toContain('Injected post-commit batch-ledger finalization failure');
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Committed exactly once', revision: 1 });
    expect((await documents.listTrace(document.id)).filter((entry) => entry.transaction.clientOperationId === 'committed-before-ledger-finalize')).toHaveLength(1);

    batches.finish = finish;
    internals.replaceFile = replaceFile;
    expect(await callTool(started.url, client.headers, 4, 'canvas_apply', request)).toMatchObject({ status: 'duplicate', batch: { expectedSequence: 1, duplicate: true } });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Committed exactly once', revision: 1 });
    expect((await documents.listTrace(document.id)).filter((entry) => entry.transaction.clientOperationId === 'committed-before-ledger-finalize')).toHaveLength(1);
  });

  it('keeps a dispatched batch cancellation pending until the exact committed result is durably recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-batch-cancel-settlement-')); temporaryPaths.push(root);
    const appendEntered = deferred(); const appendRelease = deferred();
    class BlockingJournal extends RecoveryJournal {
      override async append(...args: Parameters<RecoveryJournal['append']>): Promise<void> {
        appendEntered.resolve();
        await appendRelease.promise;
        return super.append(...args);
      }
    }
    const documents = new DocumentService(new BlockingJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('batch-cancel-settlement-token');
    const client = await initializeClient(started.url, 'batch-cancel-settlement-token', 'batch-cancel-settlement-client'); const document = documents.snapshot().activeDocument!;
    const startedBatch = await callTool(started.url, client.headers, 2, 'job_manage', { action: 'start-batch', documentId: document.id, totalTransactions: 1, label: 'Cancellation settlement' });
    const job = startedBatch.job as { id: string }; const resumeToken = String(startedBatch.resumeToken);
    const pending = callTool(started.url, client.headers, 3, 'canvas_apply', {
      documentId: document.id, clientOperationId: 'cancel-after-canonical-dispatch', label: 'Retain committed cancellation progress', playback: { mode: 'instant', speed: 1 },
      batch: { jobId: job.id, resumeToken, sequence: 0 }, operations: [{ kind: 'document.rename', name: 'Committed before cancellation settled' }],
    });
    await appendEntered.promise;
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Committed before cancellation settled', revision: 1 });
    expect(await callTool(started.url, client.headers, 4, 'job_manage', { action: 'cancel', jobId: job.id })).toMatchObject({ status: 'running', progress: 0 });
    appendRelease.resolve();
    expect(await pending).toMatchObject({ status: 'committed', transactionId: expect.any(String), batch: { status: 'cancelled', progress: 1, nextSequence: 1, transactionIds: [expect.any(String)] } });
    expect(await callTool(started.url, client.headers, 5, 'job_manage', { action: 'resume-batch', jobId: job.id, resumeToken })).toMatchObject({
      nextSequence: 1, job: { status: 'cancelled', progress: 1, batch: { nextSequence: 1, transactionIds: [expect.any(String)] } },
    });
    expect((await documents.listTrace(document.id)).filter((entry) => entry.transaction.clientOperationId === 'cancel-after-canonical-dispatch')).toHaveLength(1);
  });

  it('derives new-entity attribution from the authenticated session and blocks forged provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-'));
    temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json'));
    hosts.push(host);
    const started = await host.start('trust-token');
    const client = await initializeClient(started.url, 'trust-token', 'trust-client');
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      const response = await fetch(started.url, {
        method: 'POST', headers: client.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      });
      return toolPayload(parseMcp(await response.text()));
    };
    const session = await call(2, 'session_manage', { action: 'join', name: 'Luna', model: 'luna', reasoningEffort: 'high', taskId: 'task-identity-test' });
    const actor = session.actor as { id: string };
    const document = documents.snapshot().activeDocument!;
    if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
    const result = await call(3, 'canvas_apply', {
      documentId: document.id,
      clientOperationId: 'authenticated-attribution',
      label: 'Add authenticated shape',
      playback: { mode: 'instant', speed: 1 },
      operations: [{
        kind: 'illustration.object.add',
        object: {
          id: 'authenticated-shape', revision: 99, name: 'Authenticated shape', createdAt: 'forged', updatedAt: 'forged', createdBy: 'forged',
          layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM,
          type: 'shape', shape: 'rectangle', width: 8, height: 8, fill: { kind: 'solid', color: '#ff6b7a' },
          stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
        },
      }],
    });
    expect(result.status).toBe('committed');
    const committed = documents.getDocument(document.id);
    if (!committed || committed.kind !== 'illustration') throw new Error('Expected illustration');
    expect(committed.objects['authenticated-shape']).toMatchObject({ createdBy: actor.id, revision: 0 });
    expect(committed.activity.at(-1)?.actor).toMatchObject({ name: 'Luna', client: { model: 'luna', reasoningEffort: 'high', taskId: 'task-identity-test' } });

    const forged = await call(4, 'canvas_apply', {
      documentId: document.id,
      clientOperationId: 'forged-provenance',
      label: 'Forge provider record',
      playback: { mode: 'instant', speed: 1 },
      operations: [{
        kind: 'provenance.add',
        provenance: { id: 'forged-provenance', assetId: 'missing', provider: 'openai', modelOrWorkflow: 'forged', sourceAssetIds: [], createdAt: 'forged' },
      }],
    });
    expect(forged).toMatchObject({ status: 'conflict', message: expect.stringContaining('read-only compatibility metadata') });
  });

  it('provides structured approval details and honors scoped folder trust without bypassing overwrites', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aidraw-mcp-')));
    temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json'));
    hosts.push(host);
    const started = await host.start('approval-token');
    const client = await initializeClient(started.url, 'approval-token', 'approval-client');
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      const response = await fetch(started.url, {
        method: 'POST', headers: client.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      });
      return toolPayload(parseMcp(await response.text()));
    };
    const documentId = documents.snapshot().activeDocument!.id;
    const folder = join(root, 'trusted-output');
    const firstPath = join(folder, 'first.png');
    const first = await call(2, 'document_export', { documentId, path: firstPath, format: 'png', scale: 1 });
    expect(first.status).toBe('waiting-for-user');
    const firstJob = documents.getJob(String(first.jobId))!;
    expect(firstJob.approval?.options).toEqual(['allow-once', 'allow-session', 'allow-always', 'deny']);
    expect(firstJob.approval?.description).not.toContain('Requested details');
    expect(firstJob.approval?.review).toMatchObject({ target: firstPath, trustFolder: folder, overwritePaths: [] });
    expect(firstJob.approval?.review?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Format', value: 'png' })]));

    expect(documents.resolveJob(firstJob.id, 'allow-session')?.status).toBe('queued');
    const secondPath = join(folder, 'second.png');
    const second = await call(3, 'document_export', { documentId, path: secondPath, format: 'png', scale: 1 });
    expect(second).toMatchObject({ status: 'queued', trust: 'folder' });

    await mkdir(folder, { recursive: true });
    const trustedInput = join(folder, 'trusted-input.png');
    const trustedInputCanvas = createCanvas(1, 1); trustedInputCanvas.getContext('2d').fillRect(0, 0, 1, 1);
    await writeFile(trustedInput, trustedInputCanvas.toBuffer('image/png'));
    const imported = await call(31, 'asset_import', { path: trustedInput });
    expect(imported).toMatchObject({ status: 'queued', trust: 'folder' });
    expect(documents.getJob(String(imported.jobId))?.result).toMatchObject({
      request: { path: trustedInput, overwritePaths: [] }, approvalDecision: 'trusted-folder',
    });

    const existingPath = join(folder, 'existing.png');
    await writeFile(existingPath, 'do not overwrite without approval');
    const existing = await call(4, 'document_export', { documentId, path: existingPath, format: 'png', scale: 1 });
    expect(existing.status).toBe('waiting-for-user');
    const overwriteJob = documents.getJob(String(existing.jobId))!;
    expect(overwriteJob.approval?.review?.overwritePaths).toEqual([existingPath]);
    expect(overwriteJob.approval?.review?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Will overwrite', tone: 'warning' })]));

    const realFolder = join(root, 'real-output');
    const aliasFolder = join(root, 'output-alias');
    await mkdir(realFolder, { recursive: true });
    await symlink(realFolder, aliasFolder, 'junction');
    const throughAlias = await call(5, 'document_export', { documentId, path: join(aliasFolder, 'alias.png'), format: 'png', scale: 1 });
    const aliasJob = documents.getJob(String(throughAlias.jobId))!;
    expect(String(aliasJob.approval?.review?.target).toLowerCase()).toBe(join(realFolder, 'alias.png').toLowerCase());

    expect(await host.grantLaunchFolderTrust([aliasFolder])).toContain(process.platform === 'win32' ? realFolder.toLowerCase() : realFolder);
    const aliasedInput = join(realFolder, 'aliased-input.png');
    await writeFile(aliasedInput, trustedInputCanvas.toBuffer('image/png'));
    const importThroughAlias = await call(32, 'asset_import', { path: join(aliasFolder, 'aliased-input.png') });
    expect(importThroughAlias).toMatchObject({ status: 'queued', trust: 'folder' });
    expect(documents.getJob(String(importThroughAlias.jobId))?.result).toMatchObject({
      request: { path: aliasedInput, overwritePaths: [] }, approvalDecision: 'trusted-folder',
    });

    const outsideInput = join(root, 'outside-input.png');
    const escapedInput = join(realFolder, 'escaped-input.png');
    await writeFile(outsideInput, trustedInputCanvas.toBuffer('image/png'));
    await symlink(outsideInput, escapedInput, 'file');
    const importThroughEscape = await call(33, 'asset_import', { path: escapedInput });
    expect(importThroughEscape).toMatchObject({ status: 'waiting-for-user' });
    expect(documents.getJob(String(importThroughEscape.jobId))?.approval?.review?.target).toBe(outsideInput);
    expect(await call(35, 'job_manage', { action: 'cancel', jobId: importThroughEscape.jobId })).toMatchObject({
      status: 'cancelled', message: 'Cancelled by the originating agent.',
    });
    documents.upsertJob({
      ...firstJob,
      status: 'failed',
      updatedAt: nowIso(),
      message: 'The representative import failed safely.',
      error: { code: 'import_failed', message: 'Malformed representative input.', retryable: false },
    });
    expect(await call(34, 'job_manage', { action: 'inspect', jobId: firstJob.id })).toMatchObject({
      id: firstJob.id,
      status: 'failed',
      error: { code: 'import_failed', message: 'Malformed representative input.', retryable: false },
    });

  });

  it('keeps denied saves inert and allow-once authority exact and nonpersistent', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aidraw-mcp-approval-once-')));
    temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const portPath = join(root, 'mcp-port.json');
    const host = new McpHost(documents, '1.0.0', portPath);
    hosts.push(host);
    const started = await host.start('approval-once-token');
    const client = await initializeClient(started.url, 'approval-once-token', 'approval-once-client');
    const call = async (id: number, name: string, args: Record<string, unknown>) => callTool(started.url, client.headers, id, name, args);
    const documentId = documents.snapshot().activeDocument!.id;
    const actor = await call(2, 'session_manage', { action: 'join', name: 'QA-06 file approval agent', color: '#b64f75', documentId });
    expect(actor.actor).toMatchObject({ kind: 'agent', name: 'QA-06 file approval agent', color: '#b64f75' });

    const targetRoot = join(root, 'approval-targets');
    const deniedPath = join(targetRoot, 'denied-agent-save.aidraw');
    const allowedPath = join(targetRoot, 'allowed-once-agent-save.aidraw');
    const trustProbePath = join(targetRoot, 'untrusted-follow-up.aidraw');
    const canonicalBefore = documents.getDocument(documentId)!;
    const denied = await call(3, 'document_manage', { action: 'save-as', documentId, path: deniedPath });
    expect(denied).toMatchObject({ status: 'waiting-for-user' });
    const deniedJob = documents.getJob(String(denied.jobId))!;
    expect(deniedJob).toMatchObject({
      kind: 'save',
      actor: { name: 'QA-06 file approval agent', color: '#b64f75' },
      approval: { options: ['allow-once', 'allow-session', 'allow-always', 'deny'], review: { target: deniedPath, trustFolder: targetRoot, overwritePaths: [] } },
    });
    expect(documents.resolveJob(deniedJob.id, 'deny')).toMatchObject({ status: 'cancelled', message: 'Denied in AIDraw.' });
    expect(documents.getDocument(documentId)).toEqual(canonicalBefore);
    expect(await access(deniedPath).then(() => true, () => false)).toBe(false);
    expect(await access(targetRoot).then(() => true, () => false)).toBe(false);

    const allowed = await call(4, 'document_manage', { action: 'save-as', documentId, path: allowedPath });
    expect(allowed).toMatchObject({ status: 'waiting-for-user' });
    const allowedJob = documents.getJob(String(allowed.jobId))!;
    const queued = documents.resolveJob(allowedJob.id, 'allow-once')!;
    expect(queued).toMatchObject({ status: 'queued', result: { approvalDecision: 'allow-once' } });
    expect(await documents.save(documentId, allowedPath)).toBe(allowedPath);
    documents.upsertJob({ ...queued, status: 'completed', progress: 1, updatedAt: nowIso(), message: 'Approved save completed.' });
    expect((await readFile(allowedPath)).byteLength).toBeGreaterThan(0);
    expect(await readdir(targetRoot)).toEqual(['allowed-once-agent-save.aidraw']);
    expect(documents.getDocument(documentId)).toMatchObject({ id: documentId, filePath: allowedPath, dirty: false, revision: canonicalBefore.revision });

    const trustProbe = await call(5, 'document_manage', { action: 'save-as', documentId, path: trustProbePath });
    expect(trustProbe).toMatchObject({ status: 'waiting-for-user' });
    const trustProbeJob = documents.getJob(String(trustProbe.jobId))!;
    expect(trustProbeJob.approval?.review).toMatchObject({ target: trustProbePath, trustFolder: targetRoot, overwritePaths: [] });
    expect(documents.resolveJob(trustProbeJob.id, 'deny')).toMatchObject({ status: 'cancelled' });
    expect(await access(trustProbePath).then(() => true, () => false)).toBe(false);
    expect(await readdir(targetRoot)).toEqual(['allowed-once-agent-save.aidraw']);
    expect(await access(join(root, 'trusted-folders.json')).then(() => true, () => false)).toBe(false);
  });

  it('accepts only exact writer-shaped MCP control settings', () => {
    const absoluteFolder = join(tmpdir(), 'aidraw-writer-shaped-trust');
    expect(parsePreferredPortSettings({ version: 1, preferredPort: 48_200 })).toBe(48_200);
    expect(parsePreferredPortSettings({ version: 1, preferredPort: '48200' })).toBeUndefined();
    expect(parsePreferredPortSettings({ version: 1, preferredPort: 48_199 })).toBeUndefined();
    expect(parsePreferredPortSettings({ version: 2, preferredPort: 48_200 })).toBeUndefined();
    expect(parsePreferredPortSettings({ version: 1, preferredPort: 48_200, fallback: 48_201 })).toBeUndefined();

    expect(parseFolderTrustSettings({ version: 1, folders: [absoluteFolder] })).toEqual([absoluteFolder]);
    expect(parseFolderTrustSettings({ version: 1, folders: absoluteFolder })).toBeUndefined();
    expect(parseFolderTrustSettings({ version: 1, folders: ['relative-folder'] })).toBeUndefined();
    expect(parseFolderTrustSettings({ version: 1, folders: [absoluteFolder, 'relative-folder'] })).toBeUndefined();
    expect(parseFolderTrustSettings({ version: 1, folders: [absoluteFolder, absoluteFolder] })).toBeUndefined();
    expect(parseFolderTrustSettings({ version: 1, folders: [absoluteFolder], inherited: true })).toBeUndefined();
  });

  it('admits persistent folder trust atomically and clears stale authority on restart', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aidraw-mcp-trust-admission-')));
    temporaryPaths.push(root);
    const folder = join(root, 'trusted-output');
    await mkdir(folder, { recursive: true });
    const trustPath = join(root, 'trusted-folders.json');
    const portPath = join(root, 'mcp-port.json');
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const documentId = documents.snapshot().activeDocument!.id;
    const request = async (host: McpHost, token: string, clientName: string, id: number, fileName: string) => {
      const started = await host.start(token);
      const client = await initializeClient(started.url, token, clientName);
      return callTool(started.url, client.headers, id, 'document_export', { documentId, path: join(folder, fileName), format: 'png', scale: 1 });
    };

    await writeFile(trustPath, JSON.stringify({ version: 1, folders: folder }));
    const corruptHost = new McpHost(documents, '1.0.0', portPath);
    hosts.push(corruptHost);
    await expect(request(corruptHost, 'partial-trust-token', 'partial-trust-client', 2, 'partial.png')).resolves.toMatchObject({ status: 'waiting-for-user' });
    await corruptHost.stop();

    await writeFile(trustPath, JSON.stringify({ version: 1, folders: [folder] }));
    const restartableHost = new McpHost(documents, '1.0.0', portPath);
    hosts.push(restartableHost);
    await expect(request(restartableHost, 'valid-trust-token', 'valid-trust-client', 3, 'valid.png')).resolves.toMatchObject({ status: 'queued', trust: 'folder' });
    await restartableHost.stop();

    await writeFile(trustPath, JSON.stringify({ version: 1, folders: folder }));
    await expect(request(restartableHost, 'stale-trust-token', 'stale-trust-client', 4, 'stale.png')).resolves.toMatchObject({ status: 'waiting-for-user' });
  });

  it('persists explicitly granted folder trust across MCP host restarts', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aidraw-mcp-')));
    temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const portPath = join(root, 'port.json');
    const firstHost = new McpHost(documents, '1.0.0', portPath);
    hosts.push(firstHost);
    const started = await firstHost.start('persistent-token');
    const firstClient = await initializeClient(started.url, 'persistent-token', 'persistent-client');
    const call = async (url: string, headers: Record<string, string>, id: number, name: string, args: Record<string, unknown>) => {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
      return toolPayload(parseMcp(await response.text()));
    };
    const documentId = documents.snapshot().activeDocument!.id;
    const folder = join(root, 'persistent-output');
    const requested = await call(started.url, firstClient.headers, 2, 'document_export', { documentId, path: join(folder, 'first.png'), format: 'png', scale: 1 });
    const job = documents.getJob(String(requested.jobId))!;
    expect(documents.resolveJob(job.id, 'allow-always')?.status).toBe('queued');
    const persistedFolder = process.platform === 'win32' ? folder.toLowerCase() : folder;
    await expect.poll(async () => await readFile(join(root, 'trusted-folders.json'), 'utf8').then((text) => (JSON.parse(text) as { folders?: string[] }).folders ?? [], () => [])).toContain(persistedFolder);
    expect(JSON.parse(await readFile(join(root, 'trusted-folders.json'), 'utf8'))).toEqual({ version: 1, folders: [persistedFolder] });
    expect(parsePreferredPortSettings(JSON.parse(await readFile(portPath, 'utf8')))).toBe(started.port);
    expect((await readdir(root)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'trusted-folders.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(portPath)).mode & 0o777).toBe(0o600);
    }

    await firstHost.stop();
    hosts.splice(hosts.indexOf(firstHost), 1);
    const restartedHost = new McpHost(documents, '1.0.0', portPath);
    hosts.push(restartedHost);
    const restarted = await restartedHost.start('persistent-token-2');
    const secondClient = await initializeClient(restarted.url, 'persistent-token-2', 'new-client-after-restart');
    const trusted = await call(restarted.url, secondClient.headers, 3, 'document_export', { documentId, path: join(folder, 'after-restart.png'), format: 'png', scale: 1 });
    expect(trusted).toMatchObject({ status: 'queued', trust: 'folder' });
  });
});
