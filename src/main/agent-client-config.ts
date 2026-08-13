import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { agentClientDescriptor, type AgentClientId, type AgentClientSetupResult } from '../common/agent-clients';
import { replacePrivateFile, replacePrivateTextFile, type PrivateFileReplacer } from './private-json-file';

export interface McpConnectionDetails {
  url: string;
  token: string;
}

export interface AgentClientConfigOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: Date;
  replaceFile?: PrivateFileReplacer;
}

interface ConfigWriteResult {
  configPath: string;
  backupPath?: string;
}

interface ExistingConfig {
  bytes: Buffer;
  text: string;
}

let configurationQueue: Promise<void> = Promise.resolve();

function exclusiveConfiguration<T>(operation: () => Promise<T>): Promise<T> {
  const result = configurationQueue.then(operation, operation);
  configurationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
}

export function updateCodexToml(existing: string, connection: McpConnectionDetails): string {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  const retained: string[] = [];
  let skip = false;
  for (const line of lines) {
    const table = line.trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
    if (table) skip = table === 'mcp_servers.aidraw' || table.startsWith('mcp_servers.aidraw.');
    if (!skip) retained.push(line);
  }
  while (retained.length && !retained.at(-1)?.trim()) retained.pop();
  const table = [
    '[mcp_servers.aidraw]',
    `url = "${escapeToml(connection.url)}"`,
    `http_headers = { Authorization = "Bearer ${escapeToml(connection.token)}" }`,
  ];
  return `${retained.join(eol)}${retained.length ? `${eol}${eol}` : ''}${table.join(eol)}${eol}`;
}

function assertJsonObject(text: string, configPath: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length) {
    throw new Error(`${configPath} contains invalid JSON/JSONC (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}).`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${configPath} must contain a JSON object.`);
  return value as Record<string, unknown>;
}

function setJsonValue(text: string, path: (string | number)[], value: unknown): string {
  const source = text.trim() ? text : '{}\n';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return applyEdits(source, modify(source, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  }));
}

export function updateAgentJson(clientId: Exclude<AgentClientId, 'codex' | 'generic'>, existing: string, configPath: string, connection: McpConnectionDetails): string {
  const document = assertJsonObject(existing, configPath);
  const authorization = `Bearer ${connection.token}`;
  if (clientId === 'claude-code') {
    return setJsonValue(existing, ['mcpServers', 'aidraw'], {
      type: 'http',
      url: connection.url,
      headers: { Authorization: authorization },
    });
  }
  if (clientId === 'opencode') {
    let updated = existing;
    if (!updated.trim()) updated = setJsonValue(updated, ['$schema'], 'https://opencode.ai/config.json');
    const mcp = document.mcp && typeof document.mcp === 'object' && !Array.isArray(document.mcp)
      ? document.mcp as Record<string, unknown>
      : undefined;
    const obsoleteServers = mcp?.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers)
      ? mcp.servers as Record<string, unknown>
      : undefined;
    if (obsoleteServers && Object.hasOwn(obsoleteServers, 'aidraw')) {
      const siblings = Object.keys(obsoleteServers).filter((name) => name !== 'aidraw');
      if (siblings.length) {
        throw new Error(`${configPath} contains non-AIDraw entries under the obsolete mcp.servers wrapper; AIDraw will not migrate unrelated OpenCode settings automatically.`);
      }
      updated = setJsonValue(updated, ['mcp', 'servers'], undefined);
    }
    return setJsonValue(updated, ['mcp', 'aidraw'], {
      type: 'remote',
      url: connection.url,
      enabled: true,
      oauth: false,
      headers: { Authorization: authorization },
    });
  }
  return setJsonValue(existing, ['mcpServers', 'aidraw'], {
    serverUrl: connection.url,
    headers: { Authorization: authorization },
  });
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then((entry) => entry.isFile(), () => false);
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function readExistingConfig(configPath: string): Promise<ExistingConfig | undefined> {
  try {
    const bytes = await readFile(configPath);
    return { bytes, text: bytes.toString('utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function resolveConfigPath(clientId: Exclude<AgentClientId, 'generic'>, options: AgentClientConfigOptions): Promise<string> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  if (clientId === 'codex') return join(environment.CODEX_HOME || join(home, '.codex'), 'config.toml');
  if (clientId === 'claude-code') return environment.AIDRAW_CLAUDE_CONFIG_PATH || join(home, '.claude.json');
  if (clientId === 'antigravity') return environment.AIDRAW_ANTIGRAVITY_CONFIG_PATH || join(home, '.gemini', 'config', 'mcp_config.json');
  if (environment.AIDRAW_OPENCODE_CONFIG_PATH) return environment.AIDRAW_OPENCODE_CONFIG_PATH;
  const root = environment.XDG_CONFIG_HOME || join(home, '.config');
  const jsonPath = join(root, 'opencode', 'opencode.json');
  const jsoncPath = join(root, 'opencode', 'opencode.jsonc');
  return await exists(jsonPath) || !await exists(jsoncPath) ? jsonPath : jsoncPath;
}

function sameExistingConfig(actual: ExistingConfig | undefined, expected: ExistingConfig | undefined): boolean {
  return actual === undefined ? expected === undefined : expected !== undefined && actual.bytes.equals(expected.bytes);
}

async function nextBackupPath(configPath: string, now: Date): Promise<string> {
  const base = `${configPath}.aidraw-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
  if (!await pathExists(base)) return base;
  for (let suffix = 2; suffix <= 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!await pathExists(candidate)) return candidate;
  }
  throw new Error(`${configPath} has too many backups for the same timestamp; retry setup with a later time.`);
}

async function writeConfig(
  configPath: string,
  contents: string,
  expectedExisting: ExistingConfig | undefined,
  now: Date,
  replaceFile?: PrivateFileReplacer,
): Promise<ConfigWriteResult> {
  if (!sameExistingConfig(await readExistingConfig(configPath), expectedExisting)) {
    throw new Error(`${configPath} changed while AIDraw was preparing the update; retry setup.`);
  }
  let backupPath: string | undefined;
  if (expectedExisting) {
    backupPath = await nextBackupPath(configPath, now);
    await replacePrivateFile(backupPath, expectedExisting.bytes);
  }
  if (!sameExistingConfig(await readExistingConfig(configPath), expectedExisting)) {
    throw new Error(`${configPath} changed while AIDraw was preparing the update; retry setup.`);
  }
  await replacePrivateTextFile(configPath, contents, replaceFile);
  return { configPath, backupPath };
}

export function genericSetupSnippet(connection: McpConnectionDetails): string {
  return JSON.stringify({
    transport: 'streamable-http',
    url: connection.url,
    headers: { Authorization: `Bearer ${connection.token}` },
  }, null, 2);
}

export async function completeAgentClientSetup(
  result: AgentClientSetupResult,
  options: {
    isolated: boolean;
    platformLabel: string;
    enableStartAtLogin: () => Promise<{ startsAtLogin: boolean }>;
  },
): Promise<AgentClientSetupResult> {
  if (options.isolated) {
    return { ...result, message: `${result.message} Start-at-login was intentionally unchanged by this isolated packaged validation.` };
  }
  try {
    const status = await options.enableStartAtLogin();
    return {
      ...result,
      message: `${result.message}${status.startsAtLogin
        ? ` The headless engine will start at ${options.platformLabel} sign-in.`
        : ' Start-at-login becomes available in a packaged desktop build.'}`,
    };
  } catch (error) {
    return {
      ...result,
      message: `${result.message} The client configuration was saved, but AIDraw could not enable headless start at ${options.platformLabel} sign-in: ${error instanceof Error ? error.message : String(error)} Start AIDraw manually before the client reconnects.`,
    };
  }
}

export async function configureAgentClientFile(clientId: AgentClientId, connection: McpConnectionDetails, options: AgentClientConfigOptions = {}): Promise<AgentClientSetupResult> {
  const descriptor = agentClientDescriptor(clientId);
  if (clientId === 'generic') {
    return {
      status: 'manual', clientId, clientName: descriptor.name,
      message: 'Copy these authenticated Streamable HTTP settings into the client. Keep the bearer token private.',
      restartRequired: false, restartInstruction: descriptor.restartInstruction,
      documentationUrl: descriptor.documentationUrl, setupSnippet: genericSetupSnippet(connection),
    };
  }
  return exclusiveConfiguration(async () => {
    const configPath = await resolveConfigPath(clientId, options);
    const existing = await readExistingConfig(configPath);
    const source = existing?.text ?? '';
    const contents = clientId === 'codex'
      ? updateCodexToml(source, connection)
      : updateAgentJson(clientId, source, configPath, connection);
    const written = await writeConfig(configPath, contents, existing, options.now ?? new Date(), options.replaceFile);
    return {
      status: 'configured', clientId, clientName: descriptor.name,
      message: `AIDraw replaced only the aidraw MCP entry in ${configPath}${written.backupPath ? ' and saved a timestamped backup' : ''}.`,
      restartRequired: true, restartInstruction: descriptor.restartInstruction,
      documentationUrl: descriptor.documentationUrl, ...written,
    };
  });
}
