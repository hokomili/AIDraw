import { isAbsolute, resolve } from 'node:path';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';

export interface McpConnectionHandoff {
  version: 1;
  url: string;
  token: string;
  activeDocumentId?: string;
  pid: number;
  trustedFolders: readonly string[];
}

/** Publish one complete private plaintext MCP bootstrap artifact. */
export function writeMcpConnectionHandoff(
  filePath: string,
  handoff: McpConnectionHandoff,
  replaceFile?: PrivateJsonFileReplacer,
): Promise<void> {
  return replacePrivateJsonFile(filePath, handoff, replaceFile);
}

export function resolveMcpConnectionHandoffPath(input: string): string {
  if (!input || !isAbsolute(input)) throw new Error('--write-mcp-connection requires a non-empty absolute path.');
  return resolve(input);
}
