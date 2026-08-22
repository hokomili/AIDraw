import { isAbsolute, resolve, win32 } from 'node:path';
import { MCP_AUTHORITY_PATTERN } from './mcp-authority';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';

export interface McpConnectionHandoff {
  version: 2;
  url: string;
  token: string;
  authority: 'engine-process';
  activeDocumentId?: string;
  pid: number;
  trustedFolders: readonly string[];
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function validLoopbackMcpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && Number.isInteger(port) && port > 0 && port <= 65_535 && url.pathname === '/mcp'
      && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch {
    return false;
  }
}

function absoluteHandoffPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096
    && (isAbsolute(value) || win32.isAbsolute(value));
}

/** Strictly parse the caller-owned version-two QA/automation handoff. */
export function parseMcpConnectionHandoff(value: unknown): McpConnectionHandoff | undefined {
  const required = ['version', 'url', 'token', 'authority', 'pid', 'trustedFolders'] as const;
  if (!plainRecord(value) || !exactKeys(value, required, ['activeDocumentId'])
    || value.version !== 2 || value.authority !== 'engine-process'
    || !validLoopbackMcpUrl(value.url) || typeof value.token !== 'string' || !MCP_AUTHORITY_PATTERN.test(value.token)
    || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || (value.activeDocumentId !== undefined && (typeof value.activeDocumentId !== 'string' || value.activeDocumentId.length < 1 || value.activeDocumentId.length > 256))
    || !Array.isArray(value.trustedFolders) || value.trustedFolders.some((folder) => !absoluteHandoffPath(folder))) return undefined;
  const trustedFolders = value.trustedFolders as string[];
  if (new Set(trustedFolders).size !== trustedFolders.length) return undefined;
  return {
    version: 2,
    url: value.url,
    token: value.token,
    authority: 'engine-process',
    ...(value.activeDocumentId === undefined ? {} : { activeDocumentId: value.activeDocumentId }),
    pid: Number(value.pid),
    trustedFolders: [...trustedFolders],
  };
}

/** Publish one complete private handoff for the explicitly named engine process. */
export function writeMcpConnectionHandoff(
  filePath: string,
  handoff: McpConnectionHandoff,
  replaceFile?: PrivateJsonFileReplacer,
): Promise<void> {
  const parsed = parseMcpConnectionHandoff(handoff);
  if (!parsed) throw new Error('AIDraw refused to write an invalid version-two MCP connection handoff.');
  return replacePrivateJsonFile(filePath, parsed, replaceFile);
}

export function resolveMcpConnectionHandoffPath(input: string): string {
  if (!input || !isAbsolute(input)) throw new Error('--write-mcp-connection requires a non-empty absolute path.');
  return resolve(input);
}
