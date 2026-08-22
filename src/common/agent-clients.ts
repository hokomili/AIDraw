export type AgentClientId = 'codex' | 'claude-code' | 'opencode' | 'antigravity' | 'generic';

export interface AgentClientDescriptor {
  id: AgentClientId;
  name: string;
  configuration: 'toml' | 'json' | 'jsonc' | 'manual';
  configurationDescription: string;
  restartInstruction: string;
  documentationUrl: string;
}

export const AGENT_CLIENTS: readonly AgentClientDescriptor[] = [
  {
    id: 'codex',
    name: 'Codex',
    configuration: 'toml',
    configurationDescription: 'a Codex TOML snippet',
    restartInstruction: 'Reload Codex once after adding the AIDraw bridge. Later AIDraw restarts need no client change.',
    documentationUrl: 'https://developers.openai.com/codex/mcp/',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    configuration: 'json',
    configurationDescription: 'a Claude Code JSON snippet',
    restartInstruction: 'Reload Claude Code once after adding the AIDraw bridge. Later AIDraw restarts need no client change.',
    documentationUrl: 'https://code.claude.com/docs/en/mcp',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    configuration: 'jsonc',
    configurationDescription: 'an OpenCode JSON snippet',
    restartInstruction: 'Reload OpenCode once after adding the AIDraw bridge. Later AIDraw restarts need no client change.',
    documentationUrl: 'https://opencode.ai/docs/mcp-servers/',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    configuration: 'json',
    configurationDescription: 'an Antigravity JSON snippet',
    restartInstruction: 'Reload Antigravity once after adding the AIDraw bridge. Later AIDraw restarts need no client change.',
    documentationUrl: 'https://www.antigravity.google/docs/mcp',
  },
  {
    id: 'generic',
    name: 'Other MCP client',
    configuration: 'manual',
    configurationDescription: 'your client’s stdio MCP settings',
    restartInstruction: 'Reload the client once after adding the AIDraw bridge. Later AIDraw restarts need no client change.',
    documentationUrl: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports',
  },
] as const;

export function agentClientDescriptor(id: AgentClientId): AgentClientDescriptor {
  const descriptor = AGENT_CLIENTS.find((candidate) => candidate.id === id);
  if (!descriptor) throw new Error(`Unsupported agent client: ${id as string}`);
  return descriptor;
}

export function isAgentClientId(value: unknown): value is AgentClientId {
  return typeof value === 'string' && AGENT_CLIENTS.some((client) => client.id === value);
}

export interface AgentClientSetupResult {
  status: 'manual';
  clientId: AgentClientId;
  clientName: string;
  message: string;
  restartRequired: false;
  restartInstruction: string;
  documentationUrl: string;
  setupSnippet?: string;
}
