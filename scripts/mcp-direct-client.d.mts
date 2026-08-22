export const AIDRAW_MCP_PROTOCOL_VERSION: string;

export interface DirectMcpConnection {
  version?: number;
  url?: string;
  token: string;
  authority?: string;
  activeDocumentId?: string;
  pid?: number;
  trustedFolders?: string[];
}

export interface McpConnectionHandoff extends DirectMcpConnection {
  version: 2;
  url: string;
  authority: 'engine-process';
  pid: number;
  trustedFolders: string[];
}

export function parseMcpConnectionHandoff(value: unknown): McpConnectionHandoff | undefined;
export function readMcpConnectionHandoff(filePath: string): Promise<McpConnectionHandoff>;
export function parseMcpResponse(text: string): Record<string, unknown>;
export function directMcpHeaders(connection: DirectMcpConnection, sessionId: string, protocolVersion: string): Record<string, string>;
export function initializeDirectMcp(connection: DirectMcpConnection, options?: {
  fetch?: typeof globalThis.fetch;
  requestId?: string | number;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
  signal?: AbortSignal;
}): Promise<{
  initialize: Record<string, unknown>;
  sessionId: string;
  protocolVersion: string;
  headers: Record<string, string>;
}>;
