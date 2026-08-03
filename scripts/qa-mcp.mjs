import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const HELP = `AIDraw QA MCP client

Usage:
  node scripts/qa-mcp.mjs init --connection <json> --state <json> --actor-name <name> --actor-color <css-color>
  node scripts/qa-mcp.mjs tool --state <json> --name <tool> [--args-file <json> | --args-json <json>]
  node scripts/qa-mcp.mjs resource --state <json> --uri <aidraw://...>
  node scripts/qa-mcp.mjs close --state <json>

The state file contains a localhost bearer token. Keep it below ignored
test-results/ and never paste it into a report.
`;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf('=');
    const key = separator >= 0 ? argument.slice(2, separator) : argument.slice(2);
    const value = separator >= 0 ? argument.slice(separator + 1) : rest[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    values.set(key, value);
  }
  return { command, values };
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

function parseRpcPayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const events = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (!events.length) throw new Error(`MCP returned an unrecognized response: ${trimmed.slice(0, 240)}`);
  return JSON.parse(events.at(-1));
}

async function request(url, headers, body) {
  const response = await globalThis.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: globalThis.AbortSignal.timeout(30_000),
  });
  const payload = parseRpcPayload(await response.text());
  if (!response.ok || payload.error) throw new Error(JSON.stringify(payload.error ?? payload));
  return { response, payload };
}

function baseHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
}

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function loadState(values) {
  const statePath = resolve(required(values, 'state'));
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (state.version !== 1 || !state.url || !state.token || !state.sessionId || !Number.isInteger(state.nextRequestId)) {
    throw new Error(`Invalid or closed QA MCP state: ${statePath}`);
  }
  return { statePath, state };
}

async function rpc(statePath, state, method, params = {}) {
  const id = state.nextRequestId;
  const headers = { ...baseHeaders(state.token), 'mcp-session-id': state.sessionId };
  const result = await request(state.url, headers, { jsonrpc: '2.0', id, method, params });
  state.nextRequestId += 1;
  state.lastRequestAt = new Date().toISOString();
  await writeState(statePath, state);
  return result.payload.result;
}

function structuredToolResult(result, name) {
  if (result?.isError) throw new Error(`${name} returned an MCP tool error: ${JSON.stringify(result)}`);
  const textEntry = result?.content?.find((entry) => entry.type === 'text' && typeof entry.text === 'string');
  if (!textEntry) return result;
  try { return JSON.parse(textEntry.text); } catch { return { text: textEntry.text, raw: result }; }
}

async function init(values) {
  const connectionPath = resolve(required(values, 'connection'));
  const statePath = resolve(required(values, 'state'));
  const actorName = required(values, 'actor-name');
  const actorColor = required(values, 'actor-color');
  const connection = JSON.parse(await readFile(connectionPath, 'utf8'));
  if (!connection.url || !connection.token || !connection.pid) throw new Error('The QA connection file is incomplete.');
  const initialized = await request(connection.url, baseHeaders(connection.token), {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2026-07-28',
      capabilities: { resources: { subscribe: true } },
      clientInfo: { name: 'AIDraw isolated Luna QA', version: '1.0' },
    },
  });
  const sessionId = initialized.response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('AIDraw did not return an MCP session ID.');
  const state = {
    version: 1,
    url: connection.url,
    token: connection.token,
    sessionId,
    nextRequestId: 2,
    connectionPath,
    connectionPid: connection.pid,
    actorName,
    actorColor,
    initializedAt: new Date().toISOString(),
  };
  await globalThis.fetch(state.url, {
    method: 'POST',
    headers: { ...baseHeaders(state.token), 'mcp-session-id': state.sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  await writeState(statePath, state);
  const joined = structuredToolResult(await rpc(statePath, state, 'tools/call', {
    name: 'session_manage',
    arguments: { action: 'join', name: actorName, color: actorColor },
  }), 'session_manage');
  process.stdout.write(`${JSON.stringify({ statePath, url: state.url, connectionPid: state.connectionPid, actorName, joined }, null, 2)}\n`);
}

async function tool(values) {
  const { statePath, state } = await loadState(values);
  const name = required(values, 'name');
  const argsFile = values.get('args-file');
  const argsJson = values.get('args-json');
  if (argsFile && argsJson) throw new Error('Use only one of --args-file or --args-json.');
  const args = argsFile
    ? JSON.parse(await readFile(resolve(argsFile), 'utf8'))
    : argsJson
      ? JSON.parse(argsJson)
      : {};
  const result = structuredToolResult(await rpc(statePath, state, 'tools/call', { name, arguments: args }), name);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function resource(values) {
  const { statePath, state } = await loadState(values);
  const uri = required(values, 'uri');
  const result = await rpc(statePath, state, 'resources/read', { uri });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function close(values) {
  const { statePath, state } = await loadState(values);
  let leave;
  try {
    leave = structuredToolResult(await rpc(statePath, state, 'tools/call', {
      name: 'session_manage',
      arguments: { action: 'leave' },
    }), 'session_manage');
  } finally {
    const headers = { ...baseHeaders(state.token), 'mcp-session-id': state.sessionId };
    await globalThis.fetch(state.url, { method: 'DELETE', headers, signal: globalThis.AbortSignal.timeout(10_000) }).catch(() => undefined);
    const closed = {
      version: 1,
      url: state.url,
      connectionPath: state.connectionPath,
      connectionPid: state.connectionPid,
      actorName: state.actorName,
      actorColor: state.actorColor,
      initializedAt: state.initializedAt,
      closedAt: new Date().toISOString(),
      credentialsRedacted: true,
    };
    await writeState(statePath, closed);
  }
  process.stdout.write(`${JSON.stringify({ statePath, left: true, result: leave }, null, 2)}\n`);
}

const { command, values } = parseArguments(process.argv.slice(2));
if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(HELP);
} else if (command === 'init') {
  await init(values);
} else if (command === 'tool') {
  await tool(values);
} else if (command === 'resource') {
  await resource(values);
} else if (command === 'close') {
  await close(values);
} else {
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
