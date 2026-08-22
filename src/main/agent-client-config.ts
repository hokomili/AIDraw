import { agentClientDescriptor, type AgentClientId, type AgentClientSetupResult } from '../common/agent-clients';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { replacePrivateTextFile, type PrivateFileReplacer } from './private-json-file';
import { ensureWindowsPrivateDirectory } from './windows-private-directory';

export interface McpBridgeLaunch {
  command: string;
  args: readonly string[];
}

export interface ProductMcpBridgeLaunchOptions {
  executable: string;
  appPath: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  appImagePath?: string;
  explicitUserDataPath?: string;
  userDataPath: string;
  environment?: NodeJS.ProcessEnv;
  replaceFile?: PrivateFileReplacer;
  ensureWindowsDirectory?: (directory: string) => Promise<void>;
}

function safeLaunchText(value: string, label: string): string {
  if (!value || [...value].some((character) => character.codePointAt(0)! <= 0x1f || character.codePointAt(0) === 0x7f)) {
    throw new Error(`AIDraw ${label} contains invalid control characters.`);
  }
  return value;
}

function productMcpBridgeTarget(options: ProductMcpBridgeLaunchOptions): McpBridgeLaunch {
  const appImage = options.platform === 'linux' && options.packaged && options.appImagePath
    && isAbsolute(options.appImagePath) ? options.appImagePath : undefined;
  const command = safeLaunchText(appImage ?? options.executable, 'bridge command');
  const args = [
    ...(!options.packaged ? [safeLaunchText(options.appPath, 'development application path')] : []),
    ...(options.explicitUserDataPath ? [`--user-data-dir=${safeLaunchText(options.explicitUserDataPath, 'profile path')}`] : []),
    '--mcp-bridge',
  ];
  return { command, args };
}

function posixQuote(value: string): string {
  return `'${safeLaunchText(value, 'bridge target').replace(/'/gu, `'"'"'`)}'`;
}

function windowsBatchQuote(value: string): string {
  const safe = safeLaunchText(value, 'bridge target');
  if (safe.includes('"')) throw new Error('AIDraw Windows bridge targets cannot contain a double quote.');
  return `"${safe.replace(/%/gu, '%%')}"`;
}

export function productMcpBridgeLauncherPath(userDataPath: string, platform: NodeJS.Platform): string {
  const root = safeLaunchText(userDataPath, 'profile path');
  if (!isAbsolute(root) && !win32.isAbsolute(root)) throw new Error('AIDraw bridge profile path must be absolute.');
  return platform === 'win32'
    ? win32.join(root, 'mcp', 'bridge-launcher.cmd')
    : join(root, 'mcp', 'bridge-launcher.sh');
}

export function productMcpBridgeLauncherContents(target: McpBridgeLaunch, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `@echo off\r\n@${[target.command, ...target.args].map(windowsBatchQuote).join(' ')}\r\n@exit /b %errorlevel%\r\n`;
  }
  return `#!/bin/sh\nexec ${[target.command, ...target.args].map(posixQuote).join(' ')}\n`;
}

export function productMcpBridgeClientLaunch(
  userDataPath: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
): McpBridgeLaunch {
  const launcherPath = productMcpBridgeLauncherPath(userDataPath, platform);
  if (platform === 'win32') {
    const systemRoot = environment.SystemRoot ?? environment.windir;
    if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('AIDraw could not resolve the stable Windows system command launcher.');
    return {
      command: win32.join(systemRoot, 'System32', 'cmd.exe'),
      args: ['/d', '/v:off', '/s', '/c', launcherPath],
    };
  }
  return { command: '/bin/sh', args: [launcherPath] };
}

/**
 * Atomically refresh the stable per-profile stdio wrapper to the current app
 * location and return the static no-secret command stored by MCP clients.
 * Normal GUI/headless launch performs this refresh after updates/relocation.
 */
export async function publishProductMcpBridgeLauncher(options: ProductMcpBridgeLaunchOptions): Promise<McpBridgeLaunch> {
  const target = productMcpBridgeTarget(options);
  const launcherPath = productMcpBridgeLauncherPath(options.userDataPath, options.platform);
  const launcherDirectory = dirname(launcherPath);
  await mkdir(launcherDirectory, { recursive: true, mode: 0o700 });
  const details = await lstat(launcherDirectory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('AIDraw MCP bridge launcher root must be a plain private directory.');
  if (options.platform === 'win32') {
    await (options.ensureWindowsDirectory ?? ((directory) => ensureWindowsPrivateDirectory(directory, {
      environment: options.environment,
    })))(launcherDirectory);
  } else {
    await chmod(launcherDirectory, 0o700);
  }
  await replacePrivateTextFile(launcherPath, productMcpBridgeLauncherContents(target, options.platform), options.replaceFile);
  return productMcpBridgeClientLaunch(options.userDataPath, options.platform, options.environment);
}

function jsonSnippet(clientId: Exclude<AgentClientId, 'codex' | 'generic'>, launch: McpBridgeLaunch): string {
  const command = safeLaunchText(launch.command, 'bridge command');
  const args = launch.args.map((argument) => safeLaunchText(argument, 'bridge argument'));
  if (clientId === 'claude-code') {
    return JSON.stringify({
      mcpServers: { aidraw: { type: 'stdio', command, args } },
    }, null, 2);
  }
  if (clientId === 'opencode') {
    return JSON.stringify({
      mcp: { aidraw: { type: 'local', command: [command, ...args], enabled: true } },
    }, null, 2);
  }
  return JSON.stringify({
    mcpServers: { aidraw: { command, args } },
  }, null, 2);
}

function tomlString(value: string): string {
  return `"${safeLaunchText(value, 'bridge setting').replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function codexSnippet(launch: McpBridgeLaunch): string {
  return `[mcp_servers.aidraw]\ncommand = ${tomlString(launch.command)}\nargs = [${launch.args.map(tomlString).join(', ')}]\n`;
}

export function agentClientSetupSnippet(clientId: AgentClientId, launch: McpBridgeLaunch): string {
  if (clientId === 'generic') {
    return JSON.stringify({
      transport: 'stdio',
      command: safeLaunchText(launch.command, 'bridge command'),
      args: launch.args.map((argument) => safeLaunchText(argument, 'bridge argument')),
    }, null, 2);
  }
  return clientId === 'codex' ? codexSnippet(launch) : jsonSnippet(clientId, launch);
}

/**
 * Return one-time stdio bridge settings without modifying a client
 * configuration file. No engine URL, bearer, or per-launch value is exposed.
 */
export async function prepareAgentClientSetup(
  clientId: AgentClientId,
  launch: McpBridgeLaunch,
): Promise<AgentClientSetupResult> {
  const descriptor = agentClientDescriptor(clientId);
  return {
    status: 'manual',
    clientId,
    clientName: descriptor.name,
    message: 'Add this no-secret stdio bridge once. It waits safely for AIDraw, discovers only the current private engine run, and reconnects after later AIDraw restarts without changing client configuration.',
    restartRequired: false,
    restartInstruction: descriptor.restartInstruction,
    documentationUrl: descriptor.documentationUrl,
    setupSnippet: agentClientSetupSnippet(clientId, launch),
  };
}
