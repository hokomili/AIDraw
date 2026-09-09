import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineRuntime } from '@main/engine-runtime';
import {
  createEphemeralMcpAuthority,
  createMcpBridgeProvisionalId,
  MCP_AUTHORITY_BYTES,
  MCP_AUTHORITY_PATTERN,
  MCP_BRIDGE_PROVISIONAL_ID_PATTERN,
} from '@main/mcp-authority';

const temporaryPaths: string[] = [];
const runtimes: EngineRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function parseMcp(text: string): { result?: Record<string, unknown>; error?: unknown } {
  const data = text.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim() ?? text;
  return JSON.parse(data) as { result?: Record<string, unknown>; error?: unknown };
}

async function initializeClient(url: string, token: string, name: string): Promise<{ sessionId: string; headers: Record<string, string> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name, version: '1.0.0' } },
    }),
  });
  const message = parseMcp(await response.text());
  expect(response.status).toBe(200);
  expect(message.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  const protocolVersion = message.result?.protocolVersion;
  if (typeof protocolVersion !== 'string') throw new Error('MCP negotiated protocol version missing');
  const sessionId = response.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-session-id': sessionId!,
    'mcp-protocol-version': protocolVersion,
  };
  const initialized = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  await initialized.text();
  expect(initialized.status).toBeLessThan(300);
  return { sessionId: sessionId!, headers };
}

describe('ephemeral MCP authority', () => {
  it('mints canonical process-memory bearer values', () => {
    const first = createEphemeralMcpAuthority();
    const second = createEphemeralMcpAuthority();
    expect(first).toMatch(MCP_AUTHORITY_PATTERN);
    expect(second).toMatch(MCP_AUTHORITY_PATTERN);
    expect(second).not.toBe(first);
    expect(Buffer.from(first, 'base64url')).toHaveLength(MCP_AUTHORITY_BYTES);
  });

  it('rejects an injected random source with the wrong byte length', () => {
    expect(() => createEphemeralMcpAuthority(() => Buffer.alloc(MCP_AUTHORITY_BYTES - 1))).toThrow('invalid value');
  });

  it('mints a non-authority provisional identity and rejects malformed injected values', () => {
    const provisionalId = createMcpBridgeProvisionalId();
    expect(provisionalId).toMatch(MCP_BRIDGE_PROVISIONAL_ID_PATTERN);
    expect(provisionalId).not.toMatch(MCP_AUTHORITY_PATTERN);
    expect(() => createMcpBridgeProvisionalId(() => 'not-a-provisional-id')).toThrow('invalid value');
  });

  it('invalidates a real authenticated headless session across stop and restart', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-engine-authority-'));
    temporaryPaths.push(userDataPath);

    const firstRuntime = new EngineRuntime({ userDataPath, appVersion: 'authority-test' });
    runtimes.push(firstRuntime);
    await firstRuntime.start();
    expect(firstRuntime.service.getMcpInfo()).toMatchObject({ running: true, authority: 'ephemeral' });
    const firstConnection = firstRuntime.mcpHost.connection();
    expect(firstConnection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(firstConnection.token).toMatch(MCP_AUTHORITY_PATTERN);

    const firstClient = await initializeClient(firstConnection.url!, firstConnection.token, 'first-engine-client');
    const authenticated = await fetch(firstConnection.url!, {
      method: 'POST',
      headers: firstClient.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(authenticated.status).toBe(200);
    expect(parseMcp(await authenticated.text()).result?.tools).toBeTruthy();

    await firstRuntime.stop();
    expect(firstRuntime.mcpHost.connection()).toEqual({ url: undefined, token: '' });

    const secondRuntime = new EngineRuntime({ userDataPath, appVersion: 'authority-test' });
    runtimes.push(secondRuntime);
    await secondRuntime.start();
    const secondConnection = secondRuntime.mcpHost.connection();
    expect(secondConnection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(secondConnection.token).toMatch(MCP_AUTHORITY_PATTERN);
    expect(secondConnection.token).not.toBe(firstConnection.token);

    const staleAuthority = await fetch(secondConnection.url!, {
      method: 'POST',
      headers: firstClient.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(staleAuthority.status).toBe(401);
    await expect(staleAuthority.json()).resolves.toMatchObject({ error: 'invalid_token' });

    const staleSession = await fetch(secondConnection.url!, {
      method: 'POST',
      headers: { ...firstClient.headers, authorization: `Bearer ${secondConnection.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    expect(staleSession.status).toBe(404);
    await expect(staleSession.json()).resolves.toMatchObject({ error: 'unknown_session' });

    const secondClient = await initializeClient(secondConnection.url!, secondConnection.token, 'second-engine-client');
    expect(secondClient.sessionId).not.toBe(firstClient.sessionId);
  });
});
