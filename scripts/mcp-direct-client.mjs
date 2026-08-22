import { readFile } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

export const AIDRAW_MCP_PROTOCOL_VERSION = '2026-07-28';
const AUTHORITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function validLoopbackMcpUrl(value) {
  if (typeof value !== 'string' || value.length > 128) return false;
  try {
    const url = new globalThis.URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && Number.isInteger(port) && port > 0 && port <= 65_535 && url.pathname === '/mcp'
      && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch {
    return false;
  }
}

function absoluteHandoffPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096
    && (isAbsolute(value) || win32.isAbsolute(value));
}

/** One strict parser shared by maintained QA scripts and packaged E2E clients. */
export function parseMcpConnectionHandoff(value) {
  const required = ['version', 'url', 'token', 'authority', 'pid', 'trustedFolders'];
  if (!plainRecord(value) || !exactKeys(value, required, ['activeDocumentId'])
    || value.version !== 2 || value.authority !== 'engine-process'
    || !validLoopbackMcpUrl(value.url) || typeof value.token !== 'string' || !AUTHORITY_PATTERN.test(value.token)
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || (value.activeDocumentId !== undefined && (typeof value.activeDocumentId !== 'string' || value.activeDocumentId.length < 1 || value.activeDocumentId.length > 256))
    || !Array.isArray(value.trustedFolders) || value.trustedFolders.some((folder) => !absoluteHandoffPath(folder))) return undefined;
  if (new Set(value.trustedFolders).size !== value.trustedFolders.length) return undefined;
  return {
    version: 2,
    url: value.url,
    token: value.token,
    authority: 'engine-process',
    ...(value.activeDocumentId === undefined ? {} : { activeDocumentId: value.activeDocumentId }),
    pid: value.pid,
    trustedFolders: [...value.trustedFolders],
  };
}

export async function readMcpConnectionHandoff(filePath) {
  const parsed = parseMcpConnectionHandoff(JSON.parse(await readFile(filePath, 'utf8')));
  if (!parsed) throw new Error(`Invalid AIDraw version-two MCP connection handoff: ${filePath}`);
  return parsed;
}

export function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (!data.length) throw new Error(`AIDraw MCP returned an unrecognized response: ${trimmed.slice(0, 240)}`);
  return JSON.parse(data.at(-1));
}

export function directMcpHeaders(connection, sessionId, protocolVersion) {
  if (!protocolVersion || typeof protocolVersion !== 'string' || protocolVersion.length > 64) {
    throw new Error('AIDraw MCP negotiated an invalid protocol version.');
  }
  return {
    authorization: `Bearer ${connection.token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': protocolVersion,
  };
}

export async function initializeDirectMcp(connection, options = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const requestId = options.requestId ?? 1;
  const response = await fetchImplementation(connection.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connection.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'initialize',
      params: {
        protocolVersion: options.protocolVersion ?? AIDRAW_MCP_PROTOCOL_VERSION,
        capabilities: options.capabilities ?? {},
        clientInfo: options.clientInfo ?? { name: 'AIDraw direct QA client', version: '1.0.0' },
      },
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const initialized = parseMcpResponse(await response.text());
  const sessionId = response.headers.get('mcp-session-id');
  const protocolVersion = initialized?.result?.protocolVersion;
  if (!response.ok || initialized?.error || !sessionId || !protocolVersion) {
    throw new Error(`AIDraw MCP initialize failed: ${JSON.stringify(initialized?.error ?? initialized)}`);
  }
  const headers = directMcpHeaders(connection, sessionId, protocolVersion);
  const notification = await fetchImplementation(connection.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await notification.text();
  if (!notification.ok) throw new Error(`AIDraw MCP initialized notification failed with HTTP ${notification.status}.`);
  return { initialize: initialized.result, sessionId, protocolVersion, headers };
}
