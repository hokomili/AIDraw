import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentClientSetupSnippet,
  prepareAgentClientSetup,
  productMcpBridgeClientLaunch,
  productMcpBridgeLauncherContents,
  productMcpBridgeLauncherPath,
  publishProductMcpBridgeLauncher,
} from '@main/agent-client-config';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const launch = {
  command: '/bin/sh',
  args: ['/Users/artist/Library/Application Support/AIDraw/mcp/bridge-launcher.sh'],
} as const;

describe('stable agent-client setup', () => {
  it('returns a one-time no-secret Codex stdio snippet without claiming to edit configuration', async () => {
    const result = await prepareAgentClientSetup('codex', launch);
    expect(result).toMatchObject({ status: 'manual', clientId: 'codex', restartRequired: false });
    expect(result).not.toHaveProperty('configPath');
    expect(result).not.toHaveProperty('backupPath');
    expect(result.message).toContain('no-secret stdio bridge once');
    expect(result.message).toContain('without changing client configuration');
    expect(result.setupSnippet).toBe(agentClientSetupSnippet('codex', launch));
    expect(result.setupSnippet).toContain('[mcp_servers.aidraw]');
    expect(result.setupSnippet).toContain('command = "/bin/sh"');
    expect(result.setupSnippet).toContain('bridge-launcher.sh');
    expect(result.setupSnippet).not.toMatch(/Bearer|Authorization|127\.0\.0\.1|token|password/iu);
  });

  it.each([
    ['claude-code', 'mcpServers'],
    ['opencode', 'mcp'],
    ['antigravity', 'mcpServers'],
    ['generic', 'transport'],
  ] as const)('returns parseable persistent %s stdio settings', async (clientId, rootKey) => {
    const result = await prepareAgentClientSetup(clientId, launch);
    const snippet = JSON.parse(result.setupSnippet!) as Record<string, unknown>;
    expect(snippet).toHaveProperty(rootKey);
    expect(result.message).toContain('reconnects after later AIDraw restarts');
    expect(result.setupSnippet).not.toMatch(/Bearer|Authorization|127\.0\.0\.1|token|password/iu);
  });

  it('escapes quotes and backslashes and rejects the complete control range from generated TOML', () => {
    const snippet = agentClientSetupSnippet('codex', {
      command: 'C:\\Program Files\\AIDraw "Preview"\\AIDraw.exe',
      args: ['C:\\AIDraw Profile\\bridge.cmd'],
    });
    expect(snippet).toContain('C:\\\\Program Files');
    expect(snippet).toContain('\\"Preview\\"');
    for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 0x7f]) {
      expect(() => agentClientSetupSnippet('codex', {
        command: `/Applications/AIDraw${String.fromCodePoint(codePoint)}ignored`,
        args: ['bridge'],
      }), `U+${codePoint.toString(16).padStart(4, '0')}`).toThrow('control characters');
    }
  });

  it('keeps the macOS/Linux client command stable while ordinary launch refreshes relocation and AppImage targets', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-stable-launcher-'));
    temporaryDirectories.push(userDataPath);
    const base = { appPath: '/Applications/AIDraw.app/Contents/Resources/app.asar', packaged: true, platform: 'darwin' as const, userDataPath };
    const first = await publishProductMcpBridgeLauncher({
      ...base,
      executable: '/Applications/AIDraw.app/Contents/MacOS/AIDraw',
    });
    const launcherPath = productMcpBridgeLauncherPath(userDataPath, 'darwin');
    expect(first).toEqual({ command: '/bin/sh', args: [launcherPath] });
    expect(await readFile(launcherPath, 'utf8')).toContain("exec '/Applications/AIDraw.app/Contents/MacOS/AIDraw' '--mcp-bridge'");

    const relocated = await publishProductMcpBridgeLauncher({
      ...base,
      executable: '/Volumes/Tools/AIDraw.app/Contents/MacOS/AIDraw',
      appPath: '/Volumes/Tools/AIDraw.app/Contents/Resources/app.asar',
    });
    expect(relocated).toEqual(first);
    const relocatedSource = await readFile(launcherPath, 'utf8');
    expect(relocatedSource).toContain("'/Volumes/Tools/AIDraw.app/Contents/MacOS/AIDraw'");
    expect(relocatedSource).not.toContain("'/Applications/AIDraw.app/Contents/MacOS/AIDraw'");
    if (process.platform !== 'win32') expect((await stat(launcherPath)).mode & 0o077).toBe(0);

    await publishProductMcpBridgeLauncher({
      executable: '/tmp/.mount_AIDraw/AIDraw',
      appPath: '/tmp/.mount_AIDraw/resources/app.asar',
      packaged: true,
      platform: 'linux',
      appImagePath: '/home/artist/Applications/AIDraw.AppImage',
      userDataPath,
    });
    expect(await readFile(productMcpBridgeLauncherPath(userDataPath, 'linux'), 'utf8')).toContain("'/home/artist/Applications/AIDraw.AppImage' '--mcp-bridge'");
  });

  it('uses one update-stable Windows command/wrapper location while the wrapper follows Squirrel versions', () => {
    const userDataPath = 'C:\\Users\\Artist\\AppData\\Roaming\\AIDraw';
    const first = productMcpBridgeClientLaunch(userDataPath, 'win32', { SystemRoot: 'C:\\Windows' });
    const second = productMcpBridgeClientLaunch(userDataPath, 'win32', { SystemRoot: 'C:\\Windows' });
    expect(second).toEqual(first);
    expect(first).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', 'C:\\Users\\Artist\\AppData\\Roaming\\AIDraw\\mcp\\bridge-launcher.cmd'],
    });
    const oldVersion = productMcpBridgeLauncherContents({ command: 'C:\\Users\\Artist\\AppData\\Local\\AIDraw\\app-1.0.0\\AIDraw.exe', args: ['--mcp-bridge'] }, 'win32');
    const newVersion = productMcpBridgeLauncherContents({ command: 'C:\\Users\\Artist\\AppData\\Local\\AIDraw\\app-1.1.0\\AIDraw.exe', args: ['--mcp-bridge'] }, 'win32');
    expect(oldVersion).not.toBe(newVersion);
    expect(newVersion).toContain('app-1.1.0');
    expect(newVersion).toContain('"--mcp-bridge"');
  });

  it('keeps development source/profile arguments inside the refreshed wrapper, not client configuration', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'aidraw-development-launcher-'));
    temporaryDirectories.push(userDataPath);
    const clientLaunch = await publishProductMcpBridgeLauncher({
      executable: '/tools/electron',
      appPath: '/work/AIDraw',
      packaged: false,
      platform: 'linux',
      explicitUserDataPath: '/tmp/aidraw-profile',
      userDataPath,
    });
    expect(clientLaunch).toEqual({ command: '/bin/sh', args: [productMcpBridgeLauncherPath(userDataPath, 'linux')] });
    expect(await readFile(clientLaunch.args[0], 'utf8')).toContain("'/tools/electron' '/work/AIDraw' '--user-data-dir=/tmp/aidraw-profile' '--mcp-bridge'");
  });
});
