import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { HUMAN_ACTOR, createId, nowIso } from '@aidraw/core';
import { LATEST_PROTOCOL_VERSION, parseJSONRPCMessage, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { agentClientSetupSnippet } from '@main/agent-client-config';
import { EngineRuntime } from '@main/engine-runtime';
import { MCP_BRIDGE_PROVISIONAL_HEADER } from '@main/mcp-authority';
import { McpBridgeSession, runMcpStdioBridge } from '@main/mcp-stdio-bridge';
import { mcpRunStatePaths, readCurrentMcpEngineRunState } from '@main/mcp-run-state';

const temporaryPaths: string[] = [];
const runtimes: EngineRuntime[] = [];
const bridges: McpBridgeSession[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function rpc(value: unknown): JSONRPCMessage {
  return parseJSONRPCMessage(value);
}

function responseFor(messages: JSONRPCMessage[], id: string | number): Extract<JSONRPCMessage, { id: string | number }> {
  const response = messages.find((message) => 'id' in message && message.id === id);
  expect(response).toBeTruthy();
  return response as Extract<JSONRPCMessage, { id: string | number }>;
}

function parseMcp(text: string): Record<string, unknown> {
  const data = text.split(/\r?\n/u).find((line) => line.startsWith('data:'))?.slice(5).trim() ?? text;
  return JSON.parse(data) as Record<string, unknown>;
}

function bridgeToolValue(messages: JSONRPCMessage[], id: string | number): Record<string, unknown> {
  const response = responseFor(messages, id);
  if (!('result' in response) || !response.result || typeof response.result !== 'object') throw new Error(`Bridge response ${String(id)} has no result.`);
  const content = 'content' in response.result ? response.result.content as Array<{ type?: string; text?: string }> : undefined;
  const text = content?.find((entry) => entry.type === 'text')?.text;
  if (!text) throw new Error(`Bridge response ${String(id)} has no JSON tool content.`);
  return JSON.parse(text) as Record<string, unknown>;
}

function responseFailureAfterCommit(response: Response, message: string): Promise<Response> {
  return response.text().then(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error(message)); },
  }), { status: response.status, statusText: response.statusText, headers: response.headers }));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settled) => { resolve = settled; });
  return { promise, resolve };
}

function controlledServerEvents(): {
  body: ReadableStream<Uint8Array>;
  enqueue: (message: JSONRPCMessage) => void;
  close: () => void;
} {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
  });
  return {
    body,
    enqueue: (message) => {
      streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
    },
    close: () => { streamController?.close(); },
  };
}

async function wholeResponseLossAfterCommit(response: Response, message: string, consumed?: () => void): Promise<Response> {
  await response.text();
  consumed?.();
  throw new Error(message);
}

async function waitForMessage(messages: JSONRPCMessage[], id: string | number): Promise<JSONRPCMessage> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const message = messages.find((candidate) => 'id' in candidate && candidate.id === id);
    if (message) return message;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for stdio response ${String(id)}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function initializeDirect(url: string, token: string): Promise<{ sessionId: string; headers: Record<string, string> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'direct-init', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stale-direct-client', version: '1.0.0' } },
    }),
  });
  expect(response.status).toBe(200);
  const initializedResult = parseMcp(await response.text()).result as { protocolVersion?: unknown } | undefined;
  expect(initializedResult).toBeTruthy();
  const protocolVersion = initializedResult?.protocolVersion;
  expect(protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  const sessionId = response.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-session-id': sessionId!,
    'mcp-protocol-version': String(protocolVersion),
  };
  const initialized = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  await initialized.text();
  expect(initialized.status).toBeLessThan(300);
  return { sessionId: sessionId!, headers };
}

describe('stable MCP stdio bridge lifecycle', () => {
  it('wires the stable launcher mode to newline-delimited MCP stdio', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-stdio-wire-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-stdio-test' });
    runtimes.push(runtime);
    await runtime.start();

    const input = new PassThrough();
    const output = new PassThrough();
    const messages: JSONRPCMessage[] = [];
    let pending = '';
    output.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      for (;;) {
        const boundary = pending.indexOf('\n');
        if (boundary < 0) break;
        const line = pending.slice(0, boundary).trim();
        pending = pending.slice(boundary + 1);
        if (line) messages.push(rpc(JSON.parse(line) as unknown));
      }
    });
    const running = runMcpStdioBridge({ input, output, userDataPath, readyTimeoutMs: 2_000, pollIntervalMs: 10 });
    input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 'stdio-init', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stdio-wire-client', version: '1.0.0' } },
    })}\n`);
    expect(await waitForMessage(messages, 'stdio-init')).toHaveProperty('result');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'stdio-tools', method: 'tools/list', params: {} })}\n`);
    expect(await waitForMessage(messages, 'stdio-tools')).toHaveProperty('result');
    input.end();
    await running;
  });

  it('cancels blocked automatic recovery as soon as real stdio closes', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-stdio-close-recovery-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-stdio-close-recovery-test' });
    runtimes.push(runtime);
    await runtime.start();
    const hostSessions = (runtime.mcpHost as unknown as {
      sessions: Map<string, { bridgeLifetimeResponse?: ServerResponse }>;
    }).sessions;
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: JSONRPCMessage[] = [];
    const reportedErrors: Error[] = [];
    let pending = '';
    output.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      for (;;) {
        const boundary = pending.indexOf('\n');
        if (boundary < 0) break;
        const line = pending.slice(0, boundary).trim();
        pending = pending.slice(boundary + 1);
        if (line) messages.push(rpc(JSON.parse(line) as unknown));
      }
    });
    let identitySelections = 0;
    let blockRecoverySelection = false;
    let recoverySelectionBlocked = false;
    let replacementInitializes = 0;
    let replacementLifetimes = 0;
    let queuedDispatches = 0;
    let blockedSelectionSignal: AbortSignal | undefined;
    let releaseSelection = (): void => undefined;
    const selectionRelease = new Promise<void>((resolve) => { releaseSelection = resolve; });
    let markSelectionBlocked = (): void => undefined;
    const selectionBlocked = new Promise<void>((resolve) => { markSelectionBlocked = resolve; });
    const running = runMcpStdioBridge({
      input,
      output,
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (request, init) => {
        const url = new URL(request.toString());
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === 'string'
          ? JSON.parse(init.body) as { id?: unknown; method?: string }
          : undefined;
        if (url.pathname === '/mcp/identity') {
          identitySelections += 1;
          if (blockRecoverySelection && !recoverySelectionBlocked) {
            recoverySelectionBlocked = true;
            blockedSelectionSignal = init?.signal ?? undefined;
            markSelectionBlocked();
            await selectionRelease;
          }
        }
        if (init?.method === 'POST' && body?.method === 'initialize') {
          if (blockRecoverySelection) replacementInitializes += 1;
        }
        if (init?.method === 'GET' && url.pathname === '/mcp' && headers.has('mcp-session-id')) {
          if (blockRecoverySelection) replacementLifetimes += 1;
        }
        if (body?.id === 'close-queued') queuedDispatches += 1;
        return fetch(request, init);
      },
      reportError: (error) => { reportedErrors.push(error); },
    });
    input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 'close-init', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stdio-close-client', version: '1.0.0' } },
    })}\n`);
    expect(await waitForMessage(messages, 'close-init')).toHaveProperty('result');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'close-ready', method: 'tools/list', params: {} })}\n`);
    expect(await waitForMessage(messages, 'close-ready')).toHaveProperty('result');
    expect(identitySelections).toBeGreaterThan(0);
    expect(hostSessions.size).toBe(1);
    const initialSession = [...hostSessions.values()][0]!;
    expect(initialSession.bridgeLifetimeResponse).toBeTruthy();

    blockRecoverySelection = true;
    initialSession.bridgeLifetimeResponse!.end();
    await selectionBlocked;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'close-queued', method: 'tools/list', params: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(queuedDispatches).toBe(0);

    input.end();
    await expect.poll(() => blockedSelectionSignal?.aborted ?? false).toBe(true);
    releaseSelection();
    await running;

    expect(replacementInitializes).toBe(0);
    expect(replacementLifetimes).toBe(0);
    expect(queuedDispatches).toBe(0);
    expect(messages.some((message) => 'id' in message && message.id === 'close-queued')).toBe(false);
    expect(hostSessions.size).toBe(0);
    expect(reportedErrors.some((error) => error.message.includes('could not recover its interrupted lifetime stream'))).toBe(false);
  });

  it('uses one static no-secret setup before launch and reconnects it across fresh engine authority', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-'));
    temporaryPaths.push(userDataPath);
    const staticLaunch = { command: '/bin/sh', args: [join(userDataPath, 'mcp', 'bridge-launcher.sh')] } as const;
    const staticSnippet = agentClientSetupSnippet('codex', staticLaunch);
    const clientConfiguration = join(userDataPath, 'external-client-config.toml');
    await writeFile(clientConfiguration, staticSnippet, { encoding: 'utf8', mode: 0o600 });
    expect(staticSnippet).not.toMatch(/Bearer|Authorization|127\.0\.0\.1|token|password/iu);

    const messages: JSONRPCMessage[] = [];
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 3_000,
      pollIntervalMs: 10,
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    const initialize = bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'static-bridge-client', version: '1.0.0' } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const firstRuntime = new EngineRuntime({ userDataPath, appVersion: 'bridge-test' });
    runtimes.push(firstRuntime);
    await firstRuntime.start();
    await initialize;
    expect(responseFor(messages, 1)).toHaveProperty('result');
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    const documentId = firstRuntime.service.getActiveDocumentId();
    expect(documentId).toBeTruthy();
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'session_manage', arguments: { action: 'join', name: 'Static bridge artist', color: '#5874c6', documentId, model: 'external-agent', reasoningEffort: 'high', taskId: 'stable-client' } },
    }));
    const firstActor = bridgeToolValue(messages, 2).actor as { id: string; name: string; color: string };
    expect(firstActor).toMatchObject({ name: 'Static bridge artist', color: '#5874c6' });
    const resourceUri = `aidraw://documents/${documentId}/snapshot`;
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 3, method: 'resources/subscribe', params: { uri: resourceUri } }));
    expect(responseFor(messages, 3)).toHaveProperty('result');
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }));
    const firstTools = responseFor(messages, 4);
    expect(firstTools).toHaveProperty('result');
    const toolNames = 'result' in firstTools && firstTools.result && typeof firstTools.result === 'object' && 'tools' in firstTools.result
      ? (firstTools.result.tools as Array<{ name: string }>).map((tool) => tool.name)
      : [];
    expect(toolNames).toEqual([
      'aidraw_help', 'session_manage', 'canvas_observe', 'canvas_apply', 'history_manage',
      'document_manage', 'asset_import', 'document_export', 'job_manage',
    ]);

    const firstState = await readCurrentMcpEngineRunState(userDataPath);
    expect(firstState).toBeTruthy();
    const healthUrl = new URL(firstState!.url); healthUrl.pathname = '/health';
    expect((await fetch(healthUrl)).status).toBe(401);
    const authenticatedHealth = await fetch(healthUrl, { headers: { authorization: `Bearer ${firstState!.token}` } });
    expect(authenticatedHealth.status).toBe(200);
    await expect(authenticatedHealth.json()).resolves.toMatchObject({ status: 'ok', uiRequired: false });
    const paths = mcpRunStatePaths(userDataPath);
    if (process.platform !== 'win32') {
      expect((await stat(paths.directory)).mode & 0o077).toBe(0);
      expect((await stat(paths.current)).mode & 0o077).toBe(0);
      expect((await stat(paths.instance(firstState!.instanceId))).mode & 0o077).toBe(0);
    }
    const firstDirect = await initializeDirect(firstState!.url, firstState!.token);

    await firstRuntime.stop();
    expect(await readCurrentMcpEngineRunState(userDataPath)).toBeUndefined();
    const secondRuntime = new EngineRuntime({ userDataPath, appVersion: 'bridge-test' });
    runtimes.push(secondRuntime);
    await secondRuntime.start();
    const secondState = await readCurrentMcpEngineRunState(userDataPath);
    expect(secondState).toBeTruthy();
    expect(secondState!.instanceId).not.toBe(firstState!.instanceId);
    expect(secondState!.token).not.toBe(firstState!.token);

    const staleAuthority = await fetch(secondState!.url, {
      method: 'POST',
      headers: firstDirect.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(staleAuthority.status).toBe(401);
    await expect(staleAuthority.json()).resolves.toMatchObject({ error: 'invalid_token' });
    const staleSession = await fetch(secondState!.url, {
      method: 'POST',
      headers: { ...firstDirect.headers, authorization: `Bearer ${secondState!.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    expect(staleSession.status).toBe(404);
    await expect(staleSession.json()).resolves.toMatchObject({ error: 'unknown_session' });

    const restartMessageOffset = messages.length;
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }));
    expect(responseFor(messages, 5)).toHaveProperty('result');
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'inspect', documentId } } }));
    const restoredActor = bridgeToolValue(messages, 6).actor as { id: string; name: string; color: string; client?: Record<string, unknown> };
    expect(restoredActor).toMatchObject({
      name: 'Static bridge artist',
      color: '#5874c6',
      client: { model: 'external-agent', reasoningEffort: 'high', taskId: 'stable-client' },
    });
    expect(restoredActor.id).not.toBe(firstActor.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        name: 'canvas_apply',
        arguments: {
          documentId,
          clientOperationId: 'bridge-restart-attribution-v1',
          label: 'Bridge restart attribution',
          operations: [{ kind: 'document.rename', name: 'Bridge restart canvas' }],
          playback: { mode: 'instant', speed: 1 },
        },
      },
    }));
    expect(bridgeToolValue(messages, 7)).toMatchObject({ status: 'committed' });
    await expect.poll(() => messages.slice(restartMessageOffset).some((message) => (
      'method' in message && message.method === 'notifications/resources/updated'
      && message.params && typeof message.params === 'object' && 'uri' in message.params && message.params.uri === resourceUri
    ))).toBe(true);
    const renamed = secondRuntime.service.getDocument(documentId!);
    expect(renamed?.name).toBe('Bridge restart canvas');
    expect(renamed?.activity.at(-1)?.actor).toMatchObject({ name: 'Static bridge artist', color: '#5874c6' });
    expect(await readFile(clientConfiguration, 'utf8')).toBe(staticSnippet);
    expect(agentClientSetupSnippet('codex', staticLaunch)).toBe(staticSnippet);
  });

  it.each([
    { interruption: 'unexpected EOF', readerError: false, interrupt: (response: ServerResponse) => { response.end(); } },
    { interruption: 'reader error', readerError: true, interrupt: (response: ServerResponse) => { response.destroy(); } },
  ])('proactively restores an idle subscribed client after $interruption without a new client request', async ({ interrupt, readerError }) => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-idle-recovery-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-idle-recovery-test' });
    runtimes.push(runtime);
    await runtime.start();
    const documentId = runtime.service.getActiveDocumentId()!;
    const resourceUri = `aidraw://documents/${documentId}/snapshot`;
    type HostSession = {
      actor: { name: string; color: string; client?: Record<string, unknown> };
      subscriptions: Set<string>;
      bridgeLifetimeResponse?: ServerResponse;
    };
    const hostSessions = (runtime.mcpHost as unknown as { sessions: Map<string, HostSession> }).sessions;
    const messages: JSONRPCMessage[] = [];
    const reportedErrors: Error[] = [];
    let initializeDispatches = 0;
    let lifetimeStreams = 0;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const url = new URL(input.toString());
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : undefined;
        if (init?.method === 'POST' && body?.method === 'initialize') initializeDispatches += 1;
        if (init?.method === 'GET' && url.pathname === '/mcp' && headers.has('mcp-session-id')) lifetimeStreams += 1;
        return fetch(input, init);
      },
      emit: (message) => { messages.push(message); },
      reportError: (error) => { reportedErrors.push(error); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'idle-recovery-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'session_manage',
        arguments: {
          action: 'join', name: 'Idle recovery artist', color: '#5b71c8', documentId,
          model: 'external-agent', reasoningEffort: 'high', taskId: 'idle-recovery',
        },
      },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 3, method: 'resources/subscribe', params: { uri: resourceUri } }));
    expect(responseFor(messages, 3)).toHaveProperty('result');
    expect(hostSessions.size).toBe(1);
    const [initialSessionId, initialSession] = [...hostSessions.entries()][0]!;
    expect(initialSession.bridgeLifetimeResponse).toBeTruthy();

    interrupt(initialSession.bridgeLifetimeResponse!);

    let restoredSessionId: string | undefined;
    await expect.poll(() => {
      const replacement = [...hostSessions.entries()].find(([sessionId]) => sessionId !== initialSessionId);
      if (!replacement) return false;
      const [sessionId, session] = replacement;
      const presence = runtime.service.getMcpInfo().sessions.find((entry) => entry.actor.name === 'Idle recovery artist');
      const restored = hostSessions.size === 1
        && session.actor.name === 'Idle recovery artist'
        && session.actor.color === '#5b71c8'
        && session.actor.client?.model === 'external-agent'
        && session.actor.client?.reasoningEffort === 'high'
        && session.actor.client?.taskId === 'idle-recovery'
        && presence?.documentId === documentId
        && session.subscriptions.has(resourceUri);
      if (restored) restoredSessionId = sessionId;
      return restored;
    }, { timeout: 3_000 }).toBe(true);
    expect(restoredSessionId).toBeTruthy();
    expect(initializeDispatches).toBe(2);
    expect(lifetimeStreams).toBe(2);
    if (readerError) {
      expect(reportedErrors.some((error) => error.message !== 'AIDraw MCP bridge lifetime stream ended unexpectedly.')).toBe(true);
    } else {
      expect(reportedErrors.map((error) => error.message)).toContain('AIDraw MCP bridge lifetime stream ended unexpectedly.');
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect([...hostSessions.keys()]).toEqual([restoredSessionId]);
    expect(initializeDispatches).toBe(2);
    expect(lifetimeStreams).toBe(2);

    const notificationOffset = messages.length;
    const applied = await runtime.service.apply({
      id: createId('tx'),
      clientOperationId: createId('op'),
      documentId,
      actor: HUMAN_ACTOR,
      label: 'Idle bridge recovery notification',
      createdAt: nowIso(),
      operations: [{ kind: 'document.rename', name: 'Idle recovery notification source' }],
    });
    expect(applied.status).toBe('committed');
    await expect.poll(() => messages.slice(notificationOffset).some((message) => (
      'method' in message && message.method === 'notifications/resources/updated'
      && message.params && typeof message.params === 'object' && 'uri' in message.params
      && message.params.uri === resourceUri
    ))).toBe(true);
    expect(initializeDispatches).toBe(2);
  });

  it('recovers after the dispatched request and before an already-queued request', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-queued-recovery-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-queued-recovery-test' });
    runtimes.push(runtime);
    await runtime.start();
    const documentId = runtime.service.getActiveDocumentId()!;
    const resourceUri = `aidraw://documents/${documentId}/snapshot`;
    type HostSession = {
      actor: { name: string; color: string; client?: Record<string, unknown> };
      subscriptions: Set<string>;
      bridgeLifetimeResponse?: ServerResponse;
    };
    const hostSessions = (runtime.mcpHost as unknown as { sessions: Map<string, HostSession> }).sessions;
    const messages: JSONRPCMessage[] = [];
    const order: string[] = [];
    let initializeDispatches = 0;
    let lifetimeStreams = 0;
    let restoredJoins = 0;
    let restoredSubscriptions = 0;
    let firstRequestDispatches = 0;
    let secondRequestDispatches = 0;
    let releaseFirstResponse = (): void => undefined;
    const firstResponseRelease = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
    let markFirstResponseHeld = (): void => undefined;
    const firstResponseHeld = new Promise<void>((resolve) => { markFirstResponseHeld = resolve; });
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const url = new URL(input.toString());
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === 'string'
          ? JSON.parse(init.body) as { id?: unknown; method?: string; params?: { name?: string } }
          : undefined;
        const isInitialize = init?.method === 'POST' && body?.method === 'initialize';
        if (isInitialize) initializeDispatches += 1;
        const isRecoveryInitialize = isInitialize && initializeDispatches === 2;
        const isRecoveryLifetime = init?.method === 'GET' && url.pathname === '/mcp'
          && headers.has('mcp-session-id') && ++lifetimeStreams === 2;
        const isRecoveryInitialized = initializeDispatches === 2
          && init?.method === 'POST' && body?.method === 'notifications/initialized';
        const isRestoredJoin = typeof body?.id === 'string' && body.id.startsWith('aidraw-bridge-')
          && body.method === 'tools/call' && body.params?.name === 'session_manage';
        const isRestoredSubscription = typeof body?.id === 'string' && body.id.startsWith('aidraw-bridge-')
          && body.method === 'resources/subscribe';
        if (body?.id === 'queued-a') {
          firstRequestDispatches += 1;
          order.push('A dispatched');
          const response = await fetch(input, init);
          const responseText = await response.text();
          markFirstResponseHeld();
          await firstResponseRelease;
          return new Response(responseText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        if (body?.id === 'queued-b') {
          secondRequestDispatches += 1;
          order.push('B dispatched');
        }
        const response = await fetch(input, init);
        if (isRecoveryInitialize) order.push('recovery initialized a fresh session');
        if (isRecoveryLifetime) order.push('recovery established its lifetime stream');
        if (isRecoveryInitialized) order.push('recovery sent initialized');
        if (isRestoredJoin) {
          restoredJoins += 1;
          order.push('recovery restored joined attribution');
        }
        if (isRestoredSubscription) {
          restoredSubscriptions += 1;
          order.push('recovery restored resource subscription');
        }
        return response;
      },
      emit: (message) => {
        messages.push(message);
        if ('id' in message && message.id === 'queued-a') order.push('A settled');
      },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'queued-recovery-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'session_manage',
        arguments: {
          action: 'join', name: 'Queued recovery artist', color: '#4f70c4', documentId,
          model: 'external-agent', reasoningEffort: 'high', taskId: 'queued-recovery',
        },
      },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 3, method: 'resources/subscribe', params: { uri: resourceUri } }));
    const [initialSessionId, initialSession] = [...hostSessions.entries()][0]!;
    expect(initialSession.bridgeLifetimeResponse).toBeTruthy();

    const first = bridge.accept(rpc({ jsonrpc: '2.0', id: 'queued-a', method: 'tools/list', params: {} }));
    await firstResponseHeld;
    const second = bridge.accept(rpc({ jsonrpc: '2.0', id: 'queued-b', method: 'tools/list', params: {} }));
    expect(firstRequestDispatches).toBe(1);
    expect(secondRequestDispatches).toBe(0);
    initialSession.bridgeLifetimeResponse!.end();
    await expect.poll(() => Boolean((bridge as unknown as { serverEventRecovery?: unknown }).serverEventRecovery)).toBe(true);

    releaseFirstResponse();
    await Promise.all([first, second]);

    expect(responseFor(messages, 'queued-a')).toHaveProperty('result');
    expect(responseFor(messages, 'queued-b')).toHaveProperty('result');
    expect(order).toEqual([
      'A dispatched',
      'A settled',
      'recovery initialized a fresh session',
      'recovery established its lifetime stream',
      'recovery sent initialized',
      'recovery restored joined attribution',
      'recovery restored resource subscription',
      'B dispatched',
    ]);
    expect(firstRequestDispatches).toBe(1);
    expect(secondRequestDispatches).toBe(1);
    expect(initializeDispatches).toBe(2);
    expect(lifetimeStreams).toBe(2);
    expect(restoredJoins).toBe(1);
    expect(restoredSubscriptions).toBe(1);
    const replacement = [...hostSessions.entries()].find(([sessionId]) => sessionId !== initialSessionId);
    expect(replacement?.[1]).toMatchObject({
      actor: {
        name: 'Queued recovery artist',
        color: '#4f70c4',
        client: { model: 'external-agent', reasoningEffort: 'high', taskId: 'queued-recovery' },
      },
    });
    expect(replacement?.[1].subscriptions.has(resourceUri)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(initializeDispatches).toBe(2);
    expect(lifetimeStreams).toBe(2);
  });

  it('cancels later state restoration and retires its replacement session on close', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-close-restoration-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-close-restoration-test' });
    runtimes.push(runtime);
    await runtime.start();
    const documentId = runtime.service.getActiveDocumentId()!;
    const resourceUri = `aidraw://documents/${documentId}/snapshot`;
    const hostSessions = (runtime.mcpHost as unknown as {
      sessions: Map<string, { bridgeLifetimeResponse?: ServerResponse }>;
    }).sessions;
    const messages: JSONRPCMessage[] = [];
    const reportedErrors: Error[] = [];
    let recoveryPhase = false;
    let replacementInitializes = 0;
    let replacementLifetimes = 0;
    let restoredJoins = 0;
    let restoredSubscriptions = 0;
    let releaseRestoredJoin = (): void => undefined;
    const restoredJoinRelease = new Promise<void>((resolve) => { releaseRestoredJoin = resolve; });
    let markRestoredJoinHeld = (): void => undefined;
    const restoredJoinHeld = new Promise<void>((resolve) => { markRestoredJoinHeld = resolve; });
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (request, init) => {
        const url = new URL(request.toString());
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === 'string'
          ? JSON.parse(init.body) as { id?: unknown; method?: string; params?: { name?: string } }
          : undefined;
        if (recoveryPhase && init?.method === 'POST' && body?.method === 'initialize') replacementInitializes += 1;
        if (recoveryPhase && init?.method === 'GET' && url.pathname === '/mcp' && headers.has('mcp-session-id')) {
          replacementLifetimes += 1;
        }
        const internalRequest = typeof body?.id === 'string' && body.id.startsWith('aidraw-bridge-');
        if (recoveryPhase && internalRequest && body?.method === 'resources/subscribe') restoredSubscriptions += 1;
        if (recoveryPhase && internalRequest && body?.method === 'tools/call' && body.params?.name === 'session_manage') {
          restoredJoins += 1;
          const response = await fetch(request, init);
          const responseText = await response.text();
          markRestoredJoinHeld();
          await restoredJoinRelease;
          return new Response(responseText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return fetch(request, init);
      },
      emit: (message) => { messages.push(message); },
      reportError: (error) => { reportedErrors.push(error); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'close-restoration-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'session_manage', arguments: { action: 'join', name: 'Close restoration artist', documentId } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 3, method: 'resources/subscribe', params: { uri: resourceUri } }));
    const initialSession = [...hostSessions.values()][0]!;
    expect(initialSession.bridgeLifetimeResponse).toBeTruthy();

    recoveryPhase = true;
    initialSession.bridgeLifetimeResponse!.end();
    await restoredJoinHeld;
    expect(replacementInitializes).toBe(1);
    expect(replacementLifetimes).toBe(1);
    expect(restoredJoins).toBe(1);
    expect(restoredSubscriptions).toBe(0);

    const closing = bridge.close();
    expect((bridge as unknown as { closed: boolean }).closed).toBe(true);
    releaseRestoredJoin();
    await closing;

    expect(restoredSubscriptions).toBe(0);
    expect(hostSessions.size).toBe(0);
    expect(reportedErrors.some((error) => error.message.includes('could not recover its interrupted lifetime stream'))).toBe(false);
  });

  it('never replays a committed mutation when its response outcome becomes ambiguous', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-ambiguous-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-ambiguous-test' });
    runtimes.push(runtime);
    await runtime.start();
    const documentId = runtime.service.getActiveDocumentId()!;
    const before = runtime.service.getDocument(documentId)!;
    let mutationDispatches = 0;
    const messages: JSONRPCMessage[] = [];
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string; params?: { name?: string } } : undefined;
        const response = await fetch(input, init);
        if (body?.method === 'tools/call' && body.params?.name === 'canvas_apply') {
          mutationDispatches += 1;
          return responseFailureAfterCommit(response, 'Injected post-commit response read failure.');
        }
        return response;
      },
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ambiguous-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'join', name: 'Ambiguous artist', documentId } } }));
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'canvas_apply',
        arguments: {
          documentId,
          clientOperationId: 'ambiguous-commit-v1',
          label: 'Exactly once ambiguous mutation',
          operations: [{ kind: 'document.rename', name: 'Committed once' }],
          playback: { mode: 'instant', speed: 1 },
        },
      },
    }));
    expect(mutationDispatches).toBe(1);
    const failure = responseFor(messages, 3);
    expect(failure).toMatchObject({ error: { code: -32_002, data: { ambiguousOutcome: true, retryable: false } } });
    const after = runtime.service.getDocument(documentId)!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.name).toBe('Committed once');
    expect(after.activity.filter((entry) => entry.label === 'Exactly once ambiguous mutation')).toHaveLength(1);
    expect((runtime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it('terminates a provisional engine session when initialization response parsing fails', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-provisional-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-provisional-test' });
    runtimes.push(runtime);
    await runtime.start();
    let initializeDispatches = 0;
    const messages: JSONRPCMessage[] = [];
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : undefined;
        const response = await fetch(input, init);
        if (body?.method === 'initialize') {
          initializeDispatches += 1;
          return responseFailureAfterCommit(response, 'Injected initialization response parse failure.');
        }
        return response;
      },
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'provisional-client', version: '1.0.0' } },
    }));
    expect(initializeDispatches).toBe(1);
    expect(responseFor(messages, 1)).toMatchObject({ error: { code: -32_001, data: { retryable: true } } });
    expect((runtime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it('bounds a real provisional host session when the whole initialize response is lost and cleanup cannot arrive', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-whole-response-loss-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({
      userDataPath,
      appVersion: 'bridge-whole-response-loss-test',
      mcpProvisionalSessionTtlMs: 100,
    });
    runtimes.push(runtime);
    await runtime.start();
    const hostInternals = runtime.mcpHost as unknown as {
      sessions: Map<string, unknown>;
      provisionalSessions: Map<string, unknown>;
    };
    let initializeDispatches = 0;
    let cleanupAttempts = 0;
    let retainedAfterResponseConsumption = 0;
    const messages: JSONRPCMessage[] = [];
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        if (init?.method === 'DELETE' && headers.has(MCP_BRIDGE_PROVISIONAL_HEADER) && !headers.has('mcp-session-id')) {
          cleanupAttempts += 1;
          return new Response('{"error":"injected_cleanup_unavailable"}', { status: 503, headers: { 'content-type': 'application/json' } });
        }
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : undefined;
        const response = await fetch(input, init);
        if (body?.method === 'initialize') {
          initializeDispatches += 1;
          return wholeResponseLossAfterCommit(response, 'Injected whole initialization response loss.', () => {
            retainedAfterResponseConsumption = hostInternals.sessions.size;
          });
        }
        return response;
      },
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'whole-response-loss-client', version: '1.0.0' } },
    }));
    expect(initializeDispatches).toBe(1);
    expect(retainedAfterResponseConsumption).toBe(1);
    expect(cleanupAttempts).toBe(2);
    expect(responseFor(messages, 1)).toMatchObject({ error: { code: -32_001, data: { retryable: true } } });
    await expect.poll(() => hostInternals.sessions.size, { timeout: 2_000 }).toBe(0);
    expect(hostInternals.provisionalSessions.size).toBe(0);
  });

  it('retains known-session cleanup through two transient DELETE failures and recovers on the third real-host attempt', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-delete-retry-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-delete-retry-test' });
    runtimes.push(runtime);
    await runtime.start();
    const hostInternals = runtime.mcpHost as unknown as { sessions: Map<string, unknown> };
    let deleteAttempts = 0;
    let recoveryStatus: number | undefined;
    const messages: JSONRPCMessage[] = [];
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        if (init?.method === 'DELETE' && headers.has('mcp-session-id')) {
          deleteAttempts += 1;
          if (deleteAttempts <= 2) {
            return new Response('{"error":"injected_delete_failure"}', { status: 503, headers: { 'content-type': 'application/json' } });
          }
        }
        const response = await fetch(input, init);
        if (init?.method === 'DELETE' && headers.has('mcp-session-id')) recoveryStatus = response.status;
        return response;
      },
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'delete-retry-client', version: '1.0.0' } },
    }));
    expect(responseFor(messages, 1)).toHaveProperty('result');
    expect(hostInternals.sessions.size).toBe(1);

    await bridge.close();

    expect(deleteAttempts).toBe(3);
    expect([204, 404]).toContain(recoveryStatus);
    expect(hostInternals.sessions.size).toBe(0);
    expect((bridge as unknown as { pendingSessionRetirements: Map<string, unknown> }).pendingSessionRetirements.size).toBe(0);
  });

  it('retires a confirmed real-host session after bridge exit even when every known DELETE fails', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-delete-persistent-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({
      userDataPath,
      appVersion: 'bridge-delete-persistent-test',
      mcpProvisionalSessionTtlMs: 100,
    });
    runtimes.push(runtime);
    await runtime.start();
    const hostInternals = runtime.mcpHost as unknown as {
      sessions: Map<string, { bridgeCorrelationId?: string; bridgeLifetimeResponse?: unknown }>;
      provisionalSessions: Map<string, unknown>;
    };
    let deleteAttempts = 0;
    const reportedErrors: Error[] = [];
    const messages: JSONRPCMessage[] = [];
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        if (init?.method === 'DELETE' && headers.has('mcp-session-id')) {
          deleteAttempts += 1;
          return new Response('{"error":"injected_persistent_delete_failure"}', { status: 503, headers: { 'content-type': 'application/json' } });
        }
        return fetch(input, init);
      },
      emit: (message) => { messages.push(message); },
      reportError: (error) => { reportedErrors.push(error); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'persistent-delete-client', version: '1.0.0' } },
    }));
    expect(responseFor(messages, 1)).toHaveProperty('result');
    expect(hostInternals.sessions.size).toBe(1);
    expect(hostInternals.provisionalSessions.size).toBe(0);
    expect([...hostInternals.sessions.values()][0]).toMatchObject({
      bridgeCorrelationId: expect.any(String),
      bridgeLifetimeResponse: expect.any(Object),
    });

    await bridge.close();

    expect(deleteAttempts).toBe(3);
    expect((bridge as unknown as { pendingSessionRetirements: Map<string, unknown> }).pendingSessionRetirements.size).toBe(0);
    expect(reportedErrors.map((error) => error.message)).toContain('AIDraw MCP bridge could not confirm retirement of every internal session before stdio closed.');
    await expect.poll(() => hostInternals.sessions.size, { timeout: 2_000 }).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(hostInternals.sessions.size).toBe(0);
  });

  it('blocks ordinary traffic after a failed external initialize handshake', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-failed-handshake-'));
    temporaryPaths.push(userDataPath);
    const messages: JSONRPCMessage[] = [];
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 30,
      pollIntervalMs: 5,
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 'failed-init', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'failed-handshake-client', version: '1.0.0' } },
    }));
    expect(responseFor(messages, 'failed-init')).toMatchObject({ error: { code: -32_001 } });

    const runtime = new EngineRuntime({ userDataPath, appVersion: 'failed-handshake-test' });
    runtimes.push(runtime);
    await runtime.start();
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 'must-not-advance', method: 'tools/list', params: {} }));
    expect(responseFor(messages, 'must-not-advance')).toMatchObject({ error: { code: -32_001 } });
    expect((runtime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    expect((bridge as unknown as { externalInitializeSucceeded: boolean; initializeRequest?: unknown })).toMatchObject({
      externalInitializeSucceeded: false,
      initializeRequest: undefined,
    });
  });

  it('preserves initialized intent after ambiguous first delivery and re-establishes it before replacement traffic', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-ambiguous-initialized-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'ambiguous-initialized-test' });
    runtimes.push(runtime);
    await runtime.start();
    const messages: JSONRPCMessage[] = [];
    let initializedDispatches = 0;
    let loseFirstInitialized = true;
    let toolDispatches = 0;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { id?: unknown; method?: string } : undefined;
        const response = await fetch(input, init);
        if (body?.method === 'notifications/initialized') {
          initializedDispatches += 1;
          if (loseFirstInitialized) {
            loseFirstInitialized = false;
            await response.text();
            throw new Error('Injected ambiguous initialized delivery.');
          }
        }
        if (body?.id === 'after-ambiguous-initialized') toolDispatches += 1;
        return response;
      },
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 'ambiguous-init', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ambiguous-initialized-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect((bridge as unknown as { initializedIntent: boolean }).initializedIntent).toBe(true);
    expect((runtime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);

    await bridge.accept(rpc({ jsonrpc: '2.0', id: 'after-ambiguous-initialized', method: 'tools/list', params: {} }));
    expect(responseFor(messages, 'after-ambiguous-initialized')).toHaveProperty('result');
    expect(initializedDispatches).toBe(2);
    expect(toolDispatches).toBe(1);
  });

  it('delivers active cancellation immediately and suppresses queued cancellation across recovery', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-cancellation-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-cancellation-test' });
    runtimes.push(runtime);
    await runtime.start();
    const documentId = runtime.service.getActiveDocumentId()!;
    const resourceUri = `aidraw://documents/${documentId}/snapshot`;
    const hostSessions = (runtime.mcpHost as unknown as {
      sessions: Map<string, { bridgeLifetimeResponse?: ServerResponse }>;
    }).sessions;
    const messages: JSONRPCMessage[] = [];
    const order: string[] = [];
    const held = deferred();
    const release = deferred();
    let aDispatches = 0;
    let bDispatches = 0;
    let cDispatches = 0;
    let cancellationDispatches = 0;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      recoveryStabilityMs: 20,
      fetch: async (input, init) => {
        const body = typeof init?.body === 'string'
          ? JSON.parse(init.body) as { id?: unknown; method?: string; params?: { requestId?: unknown } }
          : undefined;
        if (body?.method === 'notifications/cancelled') {
          cancellationDispatches += 1;
          order.push(`cancel ${String(body.params?.requestId)} dispatched`);
        }
        if (body?.id === 'cancel-a') {
          aDispatches += 1;
          order.push('A dispatched');
          const response = await fetch(input, init);
          held.resolve();
          await release.promise;
          return response;
        }
        if (body?.id === 'cancel-b') bDispatches += 1;
        if (body?.id === 'cancel-c') {
          cDispatches += 1;
          order.push('C dispatched');
        }
        return fetch(input, init);
      },
      emit: (message) => {
        messages.push(message);
        if ('id' in message && message.id === 'cancel-a') order.push('A settled');
      },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'cancellation-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'session_manage', arguments: { action: 'join', name: 'Cancellation artist', documentId } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 3, method: 'resources/subscribe', params: { uri: resourceUri } }));
    const initial = [...hostSessions.values()][0]!;

    const a = bridge.accept(rpc({ jsonrpc: '2.0', id: 'cancel-a', method: 'tools/list', params: {} }));
    await held.promise;
    const b = bridge.accept(rpc({ jsonrpc: '2.0', id: 'cancel-b', method: 'tools/list', params: {} }));
    const c = bridge.accept(rpc({ jsonrpc: '2.0', id: 'cancel-c', method: 'tools/list', params: {} }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-b', reason: 'no longer needed' } }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-a', reason: 'stop active work' } }));
    expect(bDispatches).toBe(0);
    expect(cancellationDispatches).toBe(1);
    expect(order).toContain('cancel cancel-a dispatched');
    expect(responseFor(messages, 'cancel-b')).toMatchObject({ error: { code: -32_800, data: { dispatched: false } } });

    initial.bridgeLifetimeResponse!.end();
    await expect.poll(() => Boolean((bridge as unknown as { serverEventRecovery?: unknown }).serverEventRecovery)).toBe(true);
    release.resolve();
    await Promise.all([a, b, c]);

    expect(aDispatches).toBe(1);
    expect(bDispatches).toBe(0);
    expect(cDispatches).toBe(1);
    expect(responseFor(messages, 'cancel-a')).toHaveProperty('result');
    expect(responseFor(messages, 'cancel-c')).toHaveProperty('result');
    expect(order.indexOf('A settled')).toBeLessThan(order.indexOf('C dispatched'));
    expect(hostSessions.size).toBe(1);
  });

  it('cancels a preparing request during replacement discovery without dispatching it or closing the bridge', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-preparing-cancellation-'));
    temporaryPaths.push(userDataPath);
    const firstRuntime = new EngineRuntime({ userDataPath, appVersion: 'preparing-cancellation-first' });
    runtimes.push(firstRuntime);
    await firstRuntime.start();
    const messages: JSONRPCMessage[] = [];
    const blocked = deferred();
    const release = deferred();
    let blockReplacementIdentity = false;
    let replacementInitializes = 0;
    let targetDispatches = 0;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const url = new URL(input.toString());
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { id?: unknown; method?: string } : undefined;
        if (blockReplacementIdentity && url.pathname === '/mcp/identity') {
          blocked.resolve();
          await release.promise;
        }
        if (blockReplacementIdentity && init?.method === 'POST' && body?.method === 'initialize') replacementInitializes += 1;
        if (body?.id === 'cancel-preparing') targetDispatches += 1;
        return fetch(input, init);
      },
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'preparing-cancellation-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await firstRuntime.stop();
    const secondRuntime = new EngineRuntime({ userDataPath, appVersion: 'preparing-cancellation-second' });
    runtimes.push(secondRuntime);
    await secondRuntime.start();
    blockReplacementIdentity = true;

    const preparing = bridge.accept(rpc({ jsonrpc: '2.0', id: 'cancel-preparing', method: 'tools/list', params: {} }));
    await blocked.promise;
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-preparing' } }));
    release.resolve();
    await preparing;
    expect(responseFor(messages, 'cancel-preparing')).toMatchObject({ error: { code: -32_800 } });
    expect(messages.filter((message) => 'id' in message && message.id === 'cancel-preparing')).toHaveLength(1);
    expect(replacementInitializes).toBe(0);
    expect(targetDispatches).toBe(0);

    blockReplacementIdentity = false;
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 'after-preparing-cancel', method: 'tools/list', params: {} }));
    expect(responseFor(messages, 'after-preparing-cancel')).toHaveProperty('result');
    expect((secondRuntime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(1);
  });

  it('does not retry a dispatched request after cancellation when the first response proves non-delivery', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-cancel-safe-retry-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'cancel-safe-retry-test' });
    runtimes.push(runtime);
    await runtime.start();
    const messages: JSONRPCMessage[] = [];
    const dispatched = deferred();
    const release = deferred();
    let targetDispatches = 0;
    let cancellationDispatches = 0;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { id?: unknown; method?: string } : undefined;
        if (body?.id === 'cancel-before-safe-retry') {
          targetDispatches += 1;
          dispatched.resolve();
          await release.promise;
          return new Response('{"error":"injected_proven_non_delivery"}', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (body?.method === 'notifications/cancelled') cancellationDispatches += 1;
        return fetch(input, init);
      },
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'cancel-safe-retry-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    const target = bridge.accept(rpc({ jsonrpc: '2.0', id: 'cancel-before-safe-retry', method: 'tools/list', params: {} }));
    await dispatched.promise;
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-before-safe-retry' } }));
    release.resolve();
    await target;
    expect(targetDispatches).toBe(1);
    expect(cancellationDispatches).toBe(1);
    expect(responseFor(messages, 'cancel-before-safe-retry')).toMatchObject({ error: { code: -32_800 } });
    expect(messages.filter((message) => 'id' in message && message.id === 'cancel-before-safe-retry')).toHaveLength(1);
  });

  it('bounds repeated immediate lifetime failures and later admits a stable on-demand replacement', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-recovery-budget-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-recovery-budget-test' });
    runtimes.push(runtime);
    await runtime.start();
    const hostSessions = (runtime.mcpHost as unknown as {
      sessions: Map<string, { bridgeLifetimeResponse?: ServerResponse }>;
    }).sessions;
    const messages: JSONRPCMessage[] = [];
    const reportedErrors: Error[] = [];
    let initializeDispatches = 0;
    let lifetimeDispatches = 0;
    let failLifetimes = false;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      recoveryStabilityMs: 25,
      recoveryWindowMs: 500,
      recoveryLimit: 3,
      fetch: async (input, init) => {
        const url = new URL(input.toString());
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : undefined;
        if (init?.method === 'POST' && body?.method === 'initialize') initializeDispatches += 1;
        if (init?.method === 'GET' && url.pathname === '/mcp' && headers.has('mcp-session-id')) {
          lifetimeDispatches += 1;
          const response = await fetch(input, init);
          if (failLifetimes) {
            await response.body?.cancel().catch(() => undefined);
            return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          }
          return response;
        }
        return fetch(input, init);
      },
      emit: (message) => { messages.push(message); },
      reportError: (error) => { reportedErrors.push(error); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'recovery-budget-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    const initial = [...hostSessions.values()][0]!;
    failLifetimes = true;
    initial.bridgeLifetimeResponse!.end();
    await expect.poll(() => reportedErrors.some((error) => error.message.includes('could not recover its interrupted lifetime stream')), { timeout: 2_000 }).toBe(true);
    const boundedInitializes = initializeDispatches;
    const boundedLifetimes = lifetimeDispatches;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(initializeDispatches).toBe(boundedInitializes);
    expect(lifetimeDispatches).toBe(boundedLifetimes);
    expect(initializeDispatches).toBeLessThanOrEqual(3);
    expect(lifetimeDispatches).toBeLessThanOrEqual(3);

    await bridge.accept(rpc({ jsonrpc: '2.0', id: 'recovery-failure-observed', method: 'tools/list', params: {} }));
    expect(responseFor(messages, 'recovery-failure-observed')).toMatchObject({ error: { code: -32_001 } });
    failLifetimes = false;
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 'stable-after-budget', method: 'tools/list', params: {} }));
    expect(responseFor(messages, 'stable-after-budget')).toHaveProperty('result');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hostSessions.size).toBe(1);
  });

  it('returns one recovery failure to every request already queued behind that barrier', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-recovery-failure-cohort-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'recovery-failure-cohort-test' });
    runtimes.push(runtime);
    await runtime.start();
    const hostSessions = (runtime.mcpHost as unknown as {
      sessions: Map<string, { bridgeLifetimeResponse?: ServerResponse }>;
    }).sessions;
    const messages: JSONRPCMessage[] = [];
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    let failRecovery = false;
    let recoveryInitializeAttempts = 0;
    let queuedDispatches = 0;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      recoveryStabilityMs: 20,
      fetch: async (input, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { id?: unknown; method?: string } : undefined;
        if (failRecovery && init?.method === 'POST' && body?.method === 'initialize') {
          recoveryInitializeAttempts += 1;
          recoveryStarted.resolve();
          await releaseRecovery.promise;
          return new Response('{"error":"injected_recovery_failure"}', {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (body?.id === 'recovery-cohort-b' || body?.id === 'recovery-cohort-c') queuedDispatches += 1;
        return fetch(input, init);
      },
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'recovery-failure-cohort-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    failRecovery = true;
    [...hostSessions.values()][0]!.bridgeLifetimeResponse!.end();
    await recoveryStarted.promise;
    const b = bridge.accept(rpc({ jsonrpc: '2.0', id: 'recovery-cohort-b', method: 'tools/list', params: {} }));
    const c = bridge.accept(rpc({ jsonrpc: '2.0', id: 'recovery-cohort-c', method: 'tools/list', params: {} }));
    releaseRecovery.resolve();
    await Promise.all([b, c]);
    expect(recoveryInitializeAttempts).toBe(2);
    expect(queuedDispatches).toBe(0);
    expect(responseFor(messages, 'recovery-cohort-b')).toMatchObject({ error: { code: -32_001 } });
    expect(responseFor(messages, 'recovery-cohort-c')).toMatchObject({ error: { code: -32_001 } });

    failRecovery = false;
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 'after-recovery-cohort', method: 'tools/list', params: {} }));
    expect(responseFor(messages, 'after-recovery-cohort')).toHaveProperty('result');
  });

  it.each(['malformed', 'oversized'] as const)(
    'treats a $s lifetime event as one failed candidate and settles on the next stable generation',
    async (failure) => {
      const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-event-failure-'));
      temporaryPaths.push(userDataPath);
      const runtime = new EngineRuntime({ userDataPath, appVersion: `bridge-event-${failure}-test` });
      runtimes.push(runtime);
      await runtime.start();
      const hostSessions = (runtime.mcpHost as unknown as {
        sessions: Map<string, { bridgeLifetimeResponse?: ServerResponse }>;
      }).sessions;
      const messages: JSONRPCMessage[] = [];
      const reportedErrors: Error[] = [];
      let injectFailure = false;
      let injected = false;
      let initializeDispatches = 0;
      let lifetimeDispatches = 0;
      const bridge = new McpBridgeSession({
        userDataPath,
        readyTimeoutMs: 2_000,
        pollIntervalMs: 10,
        recoveryStabilityMs: 20,
        fetch: async (input, init) => {
          const url = new URL(input.toString());
          const headers = new Headers(init?.headers);
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : undefined;
          if (init?.method === 'POST' && body?.method === 'initialize') initializeDispatches += 1;
          if (init?.method === 'GET' && url.pathname === '/mcp' && headers.has('mcp-session-id')) {
            lifetimeDispatches += 1;
            const response = await fetch(input, init);
            if (injectFailure && !injected) {
              injected = true;
              const payload = failure === 'malformed'
                ? 'data: {not-json}\n\n'
                : `data: ${'x'.repeat(2 * 1024 * 1024 + 32)}\n\n`;
              return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(payload));
                  controller.close();
                },
              }), { status: response.status, statusText: response.statusText, headers: response.headers });
            }
            return response;
          }
          return fetch(input, init);
        },
        emit: (message) => { messages.push(message); },
        reportError: (error) => { reportedErrors.push(error); },
      });
      bridges.push(bridge);
      await bridge.accept(rpc({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: `event-${failure}-client`, version: '1.0.0' } },
      }));
      await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      const initial = [...hostSessions.values()][0]!;
      injectFailure = true;
      initial.bridgeLifetimeResponse!.end();
      await expect.poll(() => hostSessions.size === 1 && initializeDispatches === 3 && lifetimeDispatches === 3, { timeout: 3_000 }).toBe(true);
      expect(reportedErrors.some((error) => failure === 'malformed'
        ? error.message.includes('JSON') || error.message.includes('position')
        : error.message.includes('oversized server event'))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(initializeDispatches).toBe(3);
      expect(lifetimeDispatches).toBe(3);
      await bridge.accept(rpc({ jsonrpc: '2.0', id: `after-${failure}`, method: 'tools/list', params: {} }));
      expect(responseFor(messages, `after-${failure}`)).toHaveProperty('result');
    },
  );

  it('collapses duplicate recovery publications to one generation replacement', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-duplicate-recovery-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-duplicate-recovery-test' });
    runtimes.push(runtime);
    await runtime.start();
    const messages: JSONRPCMessage[] = [];
    let initializeDispatches = 0;
    let lifetimeDispatches = 0;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      recoveryStabilityMs: 20,
      fetch: async (input, init) => {
        const url = new URL(input.toString());
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : undefined;
        if (init?.method === 'POST' && body?.method === 'initialize') initializeDispatches += 1;
        if (init?.method === 'GET' && url.pathname === '/mcp' && headers.has('mcp-session-id')) lifetimeDispatches += 1;
        return fetch(input, init);
      },
      emit: (message) => { messages.push(message); },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'duplicate-recovery-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    const internals = bridge as unknown as {
      active: unknown;
      scheduleServerEventRecovery(active: unknown, interruption: Error): void;
    };
    const active = internals.active;
    internals.scheduleServerEventRecovery(active, new Error('first interruption signal'));
    internals.scheduleServerEventRecovery(active, new Error('duplicate interruption signal'));
    await bridge.accept(rpc({ jsonrpc: '2.0', id: 'after-duplicate-recovery', method: 'tools/list', params: {} }));
    expect(responseFor(messages, 'after-duplicate-recovery')).toHaveProperty('result');
    expect(initializeDispatches).toBe(2);
    expect(lifetimeDispatches).toBe(2);
  });

  it('drops buffered notifications from a retired generation and emits the current generation exactly once', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-event-generation-'));
    temporaryPaths.push(userDataPath);
    const firstRuntime = new EngineRuntime({ userDataPath, appVersion: 'bridge-event-generation-one' });
    runtimes.push(firstRuntime);
    await firstRuntime.start();
    let currentState = (await readCurrentMcpEngineRunState(userDataPath))!;
    const eventStreams = [controlledServerEvents(), controlledServerEvents()];
    const messages: JSONRPCMessage[] = [];
    const oldOutputRelease = deferred();
    const oldOutputStarted = deferred();
    let initializeCount = 0;
    let lifetimeCount = 0;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const url = new URL(input.toString());
        const headers = new Headers(init?.headers);
        const request = typeof init?.body === 'string'
          ? JSON.parse(init.body) as { id?: string | number; method?: string }
          : undefined;
        if (url.pathname === '/mcp/identity') {
          return Response.json({ version: 1, instanceId: currentState.instanceId, pid: currentState.pid });
        }
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        if (init?.method === 'GET' && url.pathname === '/mcp' && headers.has('mcp-session-id')) {
          const stream = eventStreams[lifetimeCount++];
          if (!stream) throw new Error('Unexpected extra lifetime stream.');
          return new Response(stream.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (init?.method === 'POST' && request?.method === 'initialize') {
          initializeCount += 1;
          return Response.json({
            jsonrpc: '2.0', id: request.id,
            result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'event-generation-host', version: '1.0.0' } },
          }, { headers: { 'mcp-session-id': `event-generation-${initializeCount}` } });
        }
        if (init?.method === 'POST' && request?.id !== undefined) {
          return Response.json({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
        }
        return new Response(null, { status: 202 });
      },
      emit: async (message) => {
        messages.push(message);
        if ('method' in message && message.method === 'notifications/resources/updated'
          && message.params && typeof message.params === 'object' && 'uri' in message.params
          && message.params.uri === 'aidraw://old-output-blocker') {
          oldOutputStarted.resolve();
          await oldOutputRelease.promise;
        }
      },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 'event-generation-init', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'event-generation-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    const blocker = rpc({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'aidraw://old-output-blocker' } });
    const retired = rpc({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'aidraw://retired-generation' } });
    eventStreams[0]!.enqueue(blocker);
    await oldOutputStarted.promise;
    eventStreams[0]!.enqueue(retired);

    await firstRuntime.stop();
    const secondRuntime = new EngineRuntime({ userDataPath, appVersion: 'bridge-event-generation-two' });
    runtimes.push(secondRuntime);
    await secondRuntime.start();
    currentState = (await readCurrentMcpEngineRunState(userDataPath))!;
    const reconnecting = bridge.accept(rpc({ jsonrpc: '2.0', id: 'event-generation-reconnect', method: 'tools/list', params: {} }));
    await expect.poll(() => initializeCount).toBe(2);
    await expect.poll(() => lifetimeCount).toBe(2);
    oldOutputRelease.resolve();
    await reconnecting;
    expect(responseFor(messages, 'event-generation-reconnect')).toHaveProperty('result');
    expect(initializeCount).toBe(2);
    expect(lifetimeCount).toBe(2);

    const current = rpc({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'aidraw://current-generation' } });
    eventStreams[1]!.enqueue(current);
    await expect.poll(() => messages.some((message) => 'method' in message
      && message.method === 'notifications/resources/updated'
      && message.params && typeof message.params === 'object' && 'uri' in message.params
      && message.params.uri === 'aidraw://current-generation')).toBe(true);
    const notifications = messages.filter((message) => 'method' in message
      && message.method === 'notifications/resources/updated');
    expect(notifications).toEqual([blocker, current]);
    eventStreams[0]!.close();
    eventStreams[1]!.close();
  });

  it('does not invoke output for a lifetime event once close has been published', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-event-close-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-event-close-test' });
    runtimes.push(runtime);
    await runtime.start();
    const state = (await readCurrentMcpEngineRunState(userDataPath))!;
    const events = controlledServerEvents();
    const messages: JSONRPCMessage[] = [];
    const outputRelease = deferred();
    const outputStarted = deferred();
    let initializeCount = 0;
    const bridge = new McpBridgeSession({
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      fetch: async (input, init) => {
        const url = new URL(input.toString());
        const headers = new Headers(init?.headers);
        const request = typeof init?.body === 'string'
          ? JSON.parse(init.body) as { id?: string | number; method?: string }
          : undefined;
        if (url.pathname === '/mcp/identity') {
          return Response.json({ version: 1, instanceId: state.instanceId, pid: state.pid });
        }
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        if (init?.method === 'GET' && url.pathname === '/mcp' && headers.has('mcp-session-id')) {
          return new Response(events.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (init?.method === 'POST' && request?.method === 'initialize') {
          initializeCount += 1;
          return Response.json({
            jsonrpc: '2.0', id: request.id,
            result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'event-close-host', version: '1.0.0' } },
          }, { headers: { 'mcp-session-id': `event-close-${initializeCount}` } });
        }
        return new Response(null, { status: 202 });
      },
      emit: async (message) => {
        messages.push(message);
        if ('method' in message && message.method === 'notifications/resources/updated'
          && message.params && typeof message.params === 'object' && 'uri' in message.params
          && message.params.uri === 'aidraw://blocking-output') {
          outputStarted.resolve();
          await outputRelease.promise;
        }
      },
    });
    bridges.push(bridge);
    await bridge.accept(rpc({
      jsonrpc: '2.0', id: 'event-close-init', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'event-close-client', version: '1.0.0' } },
    }));
    await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    const blocking = rpc({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'aidraw://blocking-output' } });
    const afterClose = rpc({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'aidraw://after-close' } });
    events.enqueue(blocking);
    await outputStarted.promise;
    events.enqueue(afterClose);
    const closing = bridge.close();
    outputRelease.resolve();
    events.close();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages.filter((message) => 'method' in message && message.method === 'notifications/resources/updated'
      && message.params && typeof message.params === 'object' && 'uri' in message.params
      && message.params.uri === 'aidraw://blocking-output')).toHaveLength(1);
    expect(messages).not.toContainEqual(afterClose);
  });

  it.each(['stdin-end', 'stdin-close', 'transport-error', 'process-exit'] as const)(
    'cancels blocked discovery without replacement work on $s',
    async (source) => {
      const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-stdio-close-source-'));
      temporaryPaths.push(userDataPath);
      const runtime = new EngineRuntime({ userDataPath, appVersion: `bridge-${source}-test` });
      runtimes.push(runtime);
      await runtime.start();
      const input = new PassThrough();
      const output = new PassThrough();
      const termination = new AbortController();
      const blocked = deferred();
      const release = deferred();
      let initializeDispatches = 0;
      let lifetimeDispatches = 0;
      const running = runMcpStdioBridge({
        input,
        output,
        userDataPath,
        readyTimeoutMs: 2_000,
        pollIntervalMs: 10,
        terminalCloseTimeoutMs: 40,
        terminationSignal: termination.signal,
        fetch: async (request, init) => {
          const url = new URL(request.toString());
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : undefined;
          if (url.pathname === '/mcp/identity') {
            blocked.resolve();
            await release.promise;
          }
          if (init?.method === 'POST' && body?.method === 'initialize') initializeDispatches += 1;
          if (init?.method === 'GET' && url.pathname === '/mcp') lifetimeDispatches += 1;
          return fetch(request, init);
        },
      });
      input.write(`${JSON.stringify({
        jsonrpc: '2.0', id: source, method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: source, version: '1.0.0' } },
      })}\n`);
      await blocked.promise;
      if (source === 'stdin-end') input.end();
      else if (source === 'stdin-close') input.destroy();
      else if (source === 'transport-error') input.emit('error', new Error('Injected stdio transport error.'));
      else termination.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
      release.resolve();
      await running;
      expect(initializeDispatches).toBe(0);
      expect(lifetimeDispatches).toBe(0);
      expect((runtime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    },
  );

  it.each(['identity', 'initialize-transport', 'initialize-body', 'lifetime-admission'] as const)(
    'bounds explicit close during initial $s without publishing a handshake',
    async (phase) => {
      const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-initialize-close-'));
      temporaryPaths.push(userDataPath);
      const runtime = new EngineRuntime({ userDataPath, appVersion: `bridge-initialize-close-${phase}` });
      runtimes.push(runtime);
      await runtime.start();
      const messages: JSONRPCMessage[] = [];
      const held = deferred();
      const release = deferred();
      let initializeDispatches = 0;
      let lifetimeDispatches = 0;
      let phaseHeld = false;
      const bridge = new McpBridgeSession({
        userDataPath,
        readyTimeoutMs: 2_000,
        pollIntervalMs: 10,
        terminalCloseTimeoutMs: 35,
        fetch: async (input, init) => {
          const url = new URL(input.toString());
          const headers = new Headers(init?.headers);
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : undefined;
          if (phase === 'identity' && url.pathname === '/mcp/identity' && !phaseHeld) {
            phaseHeld = true;
            held.resolve();
            await release.promise;
          }
          const response = await fetch(input, init);
          if (init?.method === 'POST' && body?.method === 'initialize') {
            initializeDispatches += 1;
            if (phase === 'initialize-transport' && !phaseHeld) {
              phaseHeld = true;
              held.resolve();
              await release.promise;
            }
            if (phase === 'initialize-body' && !phaseHeld) {
              phaseHeld = true;
              const text = await response.text();
              return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                  held.resolve();
                  void release.promise.then(() => {
                    controller.enqueue(new TextEncoder().encode(text));
                    controller.close();
                  });
                },
              }), { status: response.status, statusText: response.statusText, headers: response.headers });
            }
          }
          if (init?.method === 'GET' && url.pathname === '/mcp' && headers.has('mcp-session-id')) {
            lifetimeDispatches += 1;
            if (phase === 'lifetime-admission' && !phaseHeld) {
              phaseHeld = true;
              held.resolve();
              await release.promise;
            }
          }
          return response;
        },
        emit: (message) => { messages.push(message); },
      });
      bridges.push(bridge);
      const initialization = bridge.accept(rpc({
        jsonrpc: '2.0', id: `close-${phase}`, method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: `close-${phase}`, version: '1.0.0' } },
      }));
      await held.promise;
      const startedClosingAt = Date.now();
      await bridge.close();
      expect(Date.now() - startedClosingAt).toBeLessThan(250);
      release.resolve();
      await initialization;
      expect(messages.some((message) => 'id' in message && message.id === `close-${phase}`)).toBe(false);
      expect(initializeDispatches).toBe(phase === 'identity' ? 0 : 1);
      expect(lifetimeDispatches).toBe(phase === 'lifetime-admission' ? 1 : 0);
      await expect.poll(() => (runtime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    },
  );

  it.each(['initialized', 'joined-attribution', 'resource-subscription'] as const)(
    'cancels normal replacement during $s and suppresses later restoration plus queued dispatch',
    async (phase) => {
      const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-normal-reconnect-close-'));
      temporaryPaths.push(userDataPath);
      const firstRuntime = new EngineRuntime({ userDataPath, appVersion: `normal-reconnect-${phase}-first` });
      runtimes.push(firstRuntime);
      await firstRuntime.start();
      const documentId = firstRuntime.service.getActiveDocumentId()!;
      const resourceUri = `aidraw://documents/${documentId}/snapshot`;
      const messages: JSONRPCMessage[] = [];
      const held = deferred();
      const release = deferred();
      let replacement = false;
      let phaseHeld = false;
      let initializedDispatches = 0;
      let restoredJoins = 0;
      let restoredSubscriptions = 0;
      let queuedDispatches = 0;
      const bridge = new McpBridgeSession({
        userDataPath,
        readyTimeoutMs: 2_000,
        pollIntervalMs: 10,
        terminalCloseTimeoutMs: 35,
        fetch: async (input, init) => {
          const body = typeof init?.body === 'string'
            ? JSON.parse(init.body) as { id?: unknown; method?: string; params?: { name?: string } }
            : undefined;
          const internal = typeof body?.id === 'string' && body.id.startsWith('aidraw-bridge-');
          const initialized = replacement && body?.method === 'notifications/initialized';
          const join = replacement && internal && body?.method === 'tools/call' && body.params?.name === 'session_manage';
          const subscription = replacement && internal && body?.method === 'resources/subscribe';
          if (initialized) initializedDispatches += 1;
          if (join) restoredJoins += 1;
          if (subscription) restoredSubscriptions += 1;
          if (body?.id === `queued-after-${phase}`) queuedDispatches += 1;
          const response = await fetch(input, init);
          const target = phase === 'initialized' && initialized
            || phase === 'joined-attribution' && join
            || phase === 'resource-subscription' && subscription;
          if (target && !phaseHeld) {
            phaseHeld = true;
            held.resolve();
            await release.promise;
          }
          return response;
        },
        emit: (message) => { messages.push(message); },
      });
      bridges.push(bridge);
      await bridge.accept(rpc({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: `normal-reconnect-${phase}`, version: '1.0.0' } },
      }));
      await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      await bridge.accept(rpc({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'session_manage', arguments: { action: 'join', name: 'Normal reconnect artist', documentId } },
      }));
      await bridge.accept(rpc({ jsonrpc: '2.0', id: 3, method: 'resources/subscribe', params: { uri: resourceUri } }));
      await firstRuntime.stop();
      const secondRuntime = new EngineRuntime({ userDataPath, appVersion: `normal-reconnect-${phase}-second` });
      runtimes.push(secondRuntime);
      await secondRuntime.start();
      replacement = true;

      const queued = bridge.accept(rpc({ jsonrpc: '2.0', id: `queued-after-${phase}`, method: 'tools/list', params: {} }));
      await held.promise;
      const startedClosingAt = Date.now();
      await bridge.close();
      expect(Date.now() - startedClosingAt).toBeLessThan(250);
      const countsAtClose = [initializedDispatches, restoredJoins, restoredSubscriptions, queuedDispatches];
      release.resolve();
      await queued;
      expect([initializedDispatches, restoredJoins, restoredSubscriptions, queuedDispatches]).toEqual(countsAtClose);
      expect(initializedDispatches).toBe(1);
      expect(restoredJoins).toBe(phase === 'initialized' ? 0 : 1);
      expect(restoredSubscriptions).toBe(phase === 'resource-subscription' ? 1 : 0);
      expect(queuedDispatches).toBe(0);
      expect(messages.some((message) => 'id' in message && message.id === `queued-after-${phase}`)).toBe(false);
      await expect.poll(() => (secondRuntime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    },
  );

  it.each(['response', 'response-body', 'emit'] as const)(
    'terminates within a bound when dispatched external work stalls at $s without replay',
    async (phase) => {
      const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-bridge-terminal-bound-'));
      temporaryPaths.push(userDataPath);
      const runtime = new EngineRuntime({ userDataPath, appVersion: `terminal-bound-${phase}` });
      runtimes.push(runtime);
      await runtime.start();
      const messages: JSONRPCMessage[] = [];
      const held = deferred();
      const release = deferred();
      let block = false;
      let dispatches = 0;
      const bridge = new McpBridgeSession({
        userDataPath,
        readyTimeoutMs: 2_000,
        pollIntervalMs: 10,
        terminalCloseTimeoutMs: 35,
        fetch: async (input, init) => {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { id?: unknown } : undefined;
          const target = block && body?.id === `terminal-${phase}`;
          if (target) dispatches += 1;
          const response = await fetch(input, init);
          if (target) {
            if (phase === 'response') {
              held.resolve();
              await release.promise;
              return response;
            }
            if (phase === 'response-body') {
              const text = await response.text();
              return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                  held.resolve();
                  void release.promise.then(() => {
                    controller.enqueue(new TextEncoder().encode(text));
                    controller.close();
                  });
                },
              }), { status: response.status, statusText: response.statusText, headers: response.headers });
            }
          }
          return response;
        },
        emit: async (message) => {
          if (block && phase === 'emit' && 'id' in message && message.id === `terminal-${phase}`) {
            held.resolve();
            await release.promise;
          }
          messages.push(message);
        },
      });
      bridges.push(bridge);
      await bridge.accept(rpc({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: `terminal-${phase}`, version: '1.0.0' } },
      }));
      await bridge.accept(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      block = true;
      const external = bridge.accept(rpc({ jsonrpc: '2.0', id: `terminal-${phase}`, method: 'tools/list', params: {} }));
      await held.promise;
      const startedClosingAt = Date.now();
      await bridge.close();
      expect(Date.now() - startedClosingAt).toBeLessThan(250);
      release.resolve();
      await external;
      expect(dispatches).toBe(1);
      await expect.poll(() => (runtime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    },
  );

  it('bounds real stdio shutdown when the external output writer never drains', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-stdio-output-bound-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'stdio-output-bound-test' });
    runtimes.push(runtime);
    await runtime.start();
    const input = new PassThrough();
    const messages: JSONRPCMessage[] = [];
    const blocked = deferred();
    let blockTarget = false;
    let pending = '';
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        pending += chunk.toString('utf8');
        for (;;) {
          const boundary = pending.indexOf('\n');
          if (boundary < 0) break;
          const line = pending.slice(0, boundary).trim();
          pending = pending.slice(boundary + 1);
          if (!line) continue;
          const message = rpc(JSON.parse(line) as unknown);
          messages.push(message);
          if (blockTarget && 'id' in message && message.id === 'blocked-output') {
            blocked.resolve();
            return;
          }
        }
        callback();
      },
    });
    const running = runMcpStdioBridge({
      input,
      output,
      userDataPath,
      readyTimeoutMs: 2_000,
      pollIntervalMs: 10,
      terminalCloseTimeoutMs: 35,
    });
    input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 'output-init', method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'output-bound-client', version: '1.0.0' } },
    })}\n`);
    expect(await waitForMessage(messages, 'output-init')).toHaveProperty('result');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    blockTarget = true;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'blocked-output', method: 'tools/list', params: {} })}\n`);
    await blocked.promise;
    const startedClosingAt = Date.now();
    input.end();
    await running;
    expect(Date.now() - startedClosingAt).toBeLessThan(350);
    await expect.poll(() => (runtime.mcpHost as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('fails closed when a run-state file becomes group-readable', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-mcp-state-mode-'));
    temporaryPaths.push(userDataPath);
    const runtime = new EngineRuntime({ userDataPath, appVersion: 'bridge-state-mode-test' });
    runtimes.push(runtime);
    await runtime.start();
    const state = await readCurrentMcpEngineRunState(userDataPath);
    expect(state).toBeTruthy();
    await chmod(mcpRunStatePaths(userDataPath).instance(state!.instanceId), 0o640);
    expect(await readCurrentMcpEngineRunState(userDataPath)).toBeUndefined();
  });
});
