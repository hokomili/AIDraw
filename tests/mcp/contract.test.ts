import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';
import { McpHost } from '@main/mcp-host';
import { TransactionTraceStore } from '@main/trace-store';
import { IDENTITY_TRANSFORM } from '@aidraw/core';

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

async function initializeClient(url: string, token: string, name: string) {
  const initialize = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name, version: '1.0.0' } } }) });
  const sessionId = initialize.headers.get('mcp-session-id'); if (!sessionId) throw new Error('MCP session ID missing'); const headers = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId }; await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }); return { sessionId, headers };
}

function toolPayload(message: { result?: Record<string, unknown> }): Record<string, unknown> {
  const content = message.result?.content as Array<{ text?: string }> | undefined; return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('authenticated stateful MCP contract', () => {
  it('rejects missing auth, creates a session, and exposes the planned tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-'));
    temporaryPaths.push(root);
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0');
    documents.initialize();
    const host = new McpHost(documents, '1.0.0', join(root, 'port.json'));
    hosts.push(host);
    const started = await host.start('test-secret-token');

    expect((await fetch(started.url, { method: 'POST' })).status).toBe(401);
    const initialize = await fetch(started.url, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'contract-test', version: '1.0.0' } } }),
    });
    expect(initialize.status).toBe(200);
    expect(parseMcp(await initialize.text()).result).toBeTruthy();
    const sessionId = initialize.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const headers = { authorization: 'Bearer test-secret-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId! };
    await fetch(started.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const listed = await fetch(started.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    const message = parseMcp(await listed.text());
    const tools = (message.result?.tools ?? []) as Array<{ name: string; inputSchema?: { properties?: Record<string, { default?: unknown; maximum?: number }> } }>;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['session_manage', 'canvas_observe', 'canvas_apply', 'history_manage', 'document_manage', 'asset_import', 'document_export', 'generation_start', 'job_manage']));
    expect(tools.find((tool) => tool.name === 'document_export')?.inputSchema?.properties?.scale).toMatchObject({ default: 1, maximum: 64 });
  });

  it('supports 32 concurrent clients, resources, and idempotent transactions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-')); temporaryPaths.push(root); const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); documents.initialize(); const host = new McpHost(documents, '1.0.0', join(root, 'port.json')); hosts.push(host); const started = await host.start('parallel-token');
    const clients = await Promise.all(Array.from({ length: 32 }, (_, index) => initializeClient(started.url, 'parallel-token', `client-${index}`))); expect(new Set(clients.map((client) => client.sessionId)).size).toBe(32);
    const first = clients[0]; const resource = await fetch(started.url, { method: 'POST', headers: first.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'aidraw://documents' } }) }); expect(parseMcp(await resource.text()).result).toBeTruthy();
    const document = documents.snapshot().activeDocument!; const params = { name: 'canvas_apply', arguments: { documentId: document.id, clientOperationId: 'mcp-idempotent-op', label: 'MCP rename', operations: [{ kind: 'document.rename', name: 'Shared drawing' }], playback: { mode: 'instant', speed: 1 } } };
    const apply = async (id: number) => parseMcp(await (await fetch(started.url, { method: 'POST', headers: first.headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }) })).text());
    expect(toolPayload(await apply(3)).status).toBe('committed'); expect(toolPayload(await apply(4)).status).toBe('duplicate'); expect(documents.getDocument(document.id)?.name).toBe('Shared drawing');
    const traceResponse = await fetch(started.url, { method: 'POST', headers: first.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: `aidraw://documents/${document.id}/trace` } }) });
    const traceMessage = parseMcp(await traceResponse.text()); const traceContents = traceMessage.result?.contents as Array<{ text?: string }> | undefined;
    expect(traceContents?.[0]?.text).toContain('mcp-idempotent-op');
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
    const session = await call(2, 'session_manage', { action: 'inspect' });
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
    expect(forged).toMatchObject({ status: 'conflict', message: expect.stringContaining('generation engine') });
  });

  it('provides structured approval details and honors scoped folder trust without bypassing overwrites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-'));
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

    const generation = await call(6, 'generation_start', {
      documentId, provider: 'openai', mode: 'create', prompt: 'Structured prompt review', sourceAssetIds: [], resultCount: 2,
    });
    const generationJob = documents.getJob(String(generation.jobId))!;
    expect(generationJob.approval?.options).toEqual(['allow-once', 'deny']);
    expect(generationJob.approval?.review?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Prompt', value: 'Structured prompt review' }),
      expect.objectContaining({ label: 'Potential paid requests', value: '2', tone: 'paid' }),
    ]));
  });

  it('persists explicitly granted folder trust across MCP host restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-mcp-'));
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
    await expect.poll(async () => await readFile(join(root, 'trusted-folders.json'), 'utf8').then((text) => (JSON.parse(text) as { folders?: string[] }).folders ?? [], () => [])).toContain(folder.toLowerCase());

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
