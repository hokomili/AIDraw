import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MCP_AUTHORITY_PATTERN } from './mcp-authority';
import { replacePrivateJsonFile } from './private-json-file';
import { ensureWindowsPrivateDirectory, validateWindowsPrivateDirectory } from './windows-private-directory';

const MAX_RUN_STATE_BYTES = 4_096;
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface McpRunStatePointer {
  version: 1;
  instanceId: string;
  pid: number;
}

/**
 * Product-owned discovery state for one live engine. This is not durable MCP
 * authority: the instance file is private, is removed on an orderly stop, and
 * its bearer is rejected as soon as that engine host stops.
 */
export interface McpEngineRunState extends McpRunStatePointer {
  authority: 'engine-run';
  url: string;
  token: string;
  startedAt: string;
}

export interface McpRunStatePaths {
  directory: string;
  current: string;
  instance(instanceId: string): string;
}

export interface McpRunStateSecurity {
  platform?: NodeJS.Platform;
  ensureWindowsDirectory?: (directory: string) => Promise<void>;
  validateWindowsDirectory?: (directory: string) => Promise<void>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validLoopbackMcpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
      && Number.isInteger(port) && port >= 1 && port <= 65_535
      && parsed.pathname === '/mcp' && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash && parsed.href === value;
  } catch {
    return false;
  }
}

function validStartedAt(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function parseMcpRunStatePointer(value: unknown): McpRunStatePointer | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['version', 'instanceId', 'pid'])
    || value.version !== 1 || typeof value.instanceId !== 'string'
    || !INSTANCE_ID_PATTERN.test(value.instanceId) || !validPid(value.pid)) return undefined;
  return { version: 1, instanceId: value.instanceId, pid: value.pid };
}

export function parseMcpEngineRunState(value: unknown): McpEngineRunState | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['version', 'instanceId', 'pid', 'authority', 'url', 'token', 'startedAt'])
    || value.version !== 1 || value.authority !== 'engine-run'
    || typeof value.instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(value.instanceId)
    || !validPid(value.pid) || !validLoopbackMcpUrl(value.url)
    || typeof value.token !== 'string' || !MCP_AUTHORITY_PATTERN.test(value.token)
    || !validStartedAt(value.startedAt)) return undefined;
  return {
    version: 1,
    instanceId: value.instanceId,
    pid: value.pid,
    authority: 'engine-run',
    url: value.url,
    token: value.token,
    startedAt: value.startedAt,
  };
}

export function mcpRunStatePaths(userDataPath: string): McpRunStatePaths {
  const directory = join(userDataPath, 'runtime');
  return {
    directory,
    current: join(directory, 'mcp-current.json'),
    instance: (instanceId) => join(directory, `mcp-engine-${instanceId}.json`),
  };
}

function runStatePlatform(security: McpRunStateSecurity): NodeJS.Platform {
  return security.platform ?? process.platform;
}

async function validateRunStateDirectory(directory: string, security: McpRunStateSecurity): Promise<void> {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('AIDraw MCP runtime state root is not a plain directory.');
  if (runStatePlatform(security) === 'win32') {
    await (security.validateWindowsDirectory ?? ((path) => validateWindowsPrivateDirectory(path)))(directory);
  } else if ((details.mode & 0o077) !== 0) {
    throw new Error('AIDraw MCP runtime state root is not private to the current OS user.');
  }
}

async function assertPlainRunStateDirectory(directory: string): Promise<void> {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('AIDraw MCP runtime state root is not a plain directory.');
}

async function readPrivateJson(filePath: string, platform: NodeJS.Platform): Promise<unknown> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || !Number.isSafeInteger(details.size) || details.size < 2 || details.size > MAX_RUN_STATE_BYTES) {
      throw new Error('AIDraw MCP run state is not a bounded regular file.');
    }
    if (platform !== 'win32' && (details.mode & 0o077) !== 0) {
      throw new Error('AIDraw MCP run state is not private to the current OS user.');
    }
    const bytes = Buffer.allocUnsafe(details.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== details.size) throw new Error('AIDraw MCP run state changed while it was read.');
    return JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

async function readPointer(filePath: string, security: McpRunStateSecurity): Promise<McpRunStatePointer | undefined> {
  try {
    return parseMcpRunStatePointer(await readPrivateJson(filePath, runStatePlatform(security)));
  } catch {
    return undefined;
  }
}

export async function publishMcpEngineRunState(
  userDataPath: string,
  state: McpEngineRunState,
  security: McpRunStateSecurity = {},
): Promise<void> {
  const parsed = parseMcpEngineRunState(state);
  if (!parsed) throw new Error('AIDraw refused to publish invalid MCP engine run state.');
  const paths = mcpRunStatePaths(userDataPath);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await assertPlainRunStateDirectory(paths.directory);
  if (runStatePlatform(security) === 'win32') {
    await (security.ensureWindowsDirectory ?? ((path) => ensureWindowsPrivateDirectory(path)))(paths.directory);
  } else {
    await chmod(paths.directory, 0o700);
  }
  await validateRunStateDirectory(paths.directory, security);
  const prior = await readPointer(paths.current, security);
  const instancePath = paths.instance(parsed.instanceId);
  try {
    await replacePrivateJsonFile(instancePath, parsed);
    await replacePrivateJsonFile(paths.current, {
      version: 1,
      instanceId: parsed.instanceId,
      pid: parsed.pid,
    } satisfies McpRunStatePointer);
  } catch (error) {
    await unlink(instancePath).catch(() => undefined);
    throw error;
  }
  if (prior && prior.instanceId !== parsed.instanceId) {
    await unlink(paths.instance(prior.instanceId)).catch(() => undefined);
  }
}

/**
 * Double-read the non-secret pointer around the private instance file so a
 * replacement during discovery fails closed instead of mixing two launches.
 */
export async function readCurrentMcpEngineRunState(
  userDataPath: string,
  security: McpRunStateSecurity = {},
): Promise<McpEngineRunState | undefined> {
  const paths = mcpRunStatePaths(userDataPath);
  try { await validateRunStateDirectory(paths.directory, security); }
  catch { return undefined; }
  const before = await readPointer(paths.current, security);
  if (!before) return undefined;
  let state: McpEngineRunState | undefined;
  try {
    state = parseMcpEngineRunState(await readPrivateJson(paths.instance(before.instanceId), runStatePlatform(security)));
  } catch {
    return undefined;
  }
  const after = await readPointer(paths.current, security);
  try { await validateRunStateDirectory(paths.directory, security); }
  catch { return undefined; }
  if (!state || !after || before.instanceId !== after.instanceId || before.pid !== after.pid
    || state.instanceId !== before.instanceId || state.pid !== before.pid) return undefined;
  return state;
}

/** Remove only this engine's unguessable authority file. The stale pointer is
 * intentionally harmless and avoids a stop/start race deleting a successor's
 * discovery pointer.
 */
export async function retireMcpEngineRunState(
  userDataPath: string,
  instanceId: string,
  security: McpRunStateSecurity = {},
): Promise<void> {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) return;
  try { await validateRunStateDirectory(mcpRunStatePaths(userDataPath).directory, security); }
  catch { return; }
  await unlink(mcpRunStatePaths(userDataPath).instance(instanceId)).catch(() => undefined);
}
