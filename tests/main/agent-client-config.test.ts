import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeAgentClientSetup, configureAgentClientFile, genericSetupSnippet, updateCodexToml } from '@main/agent-client-config';

const temporaryDirectories: string[] = [];
const connection = { url: 'http://127.0.0.1:49152/mcp', token: 'private-test-token' };
const now = new Date('2026-08-04T01:02:03.456Z');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-agent-client-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('cross-agent MCP configuration', () => {
  it('replaces only the Codex AIDraw table and its subtables', () => {
    const existing = '[features]\nweb_search = true\n\n[mcp_servers.aidraw]\nurl = "old"\n\n[mcp_servers.aidraw.env]\nOLD = "secret"\n\n[mcp_servers.keep]\nurl = "https://example.test"\n';
    const updated = updateCodexToml(existing, connection);
    expect(updated).toContain('[features]\nweb_search = true');
    expect(updated).toContain('[mcp_servers.keep]\nurl = "https://example.test"');
    expect(updated).not.toContain('OLD =');
    expect(updated.match(/\[mcp_servers\.aidraw\]/g)).toHaveLength(1);
    expect(updated).toContain('http_headers = { Authorization = "Bearer private-test-token" }');
  });

  it('backs up and safely updates Codex user configuration', async () => {
    const home = await temporaryHome();
    const configPath = join(home, '.codex', 'config.toml');
    const original = '[model]\nname = "keep-me"\n';
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(configPath, original, 'utf8');
    const result = await configureAgentClientFile('codex', connection, { homeDirectory: home, environment: {}, now });
    expect(result).toMatchObject({ status: 'configured', clientId: 'codex', configPath, restartRequired: true });
    expect(await readFile(result.backupPath!, 'utf8')).toBe(original);
    expect(await readFile(configPath, 'utf8')).toContain('[model]\nname = "keep-me"');
  });

  it('serializes automatic updates and preserves each same-timestamp config version in a private backup', async () => {
    const home = await temporaryHome();
    const configDirectory = join(home, '.codex');
    const configPath = join(configDirectory, 'config.toml');
    const original = '[model]\nname = "keep-me"\n';
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, original, 'utf8');

    let releaseFirstReplacement!: () => void;
    const firstReplacementRelease = new Promise<void>((resolve) => { releaseFirstReplacement = resolve; });
    let markFirstReplacementStarted!: () => void;
    const firstReplacementStarted = new Promise<void>((resolve) => { markFirstReplacementStarted = resolve; });
    const replacements: Array<{ source: string; destination: string }> = [];
    const replaceFile = async (source: string, destination: string): Promise<void> => {
      replacements.push({ source, destination });
      if (replacements.length === 1) {
        markFirstReplacementStarted();
        await firstReplacementRelease;
      }
      await rename(source, destination);
    };

    const first = configureAgentClientFile('codex', { ...connection, token: 'first-token' }, {
      homeDirectory: home, environment: {}, now, replaceFile,
    });
    await firstReplacementStarted;
    const second = configureAgentClientFile('codex', { ...connection, token: 'second-token' }, {
      homeDirectory: home, environment: {}, now, replaceFile,
    });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(replacements).toHaveLength(1);
    releaseFirstReplacement();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.backupPath).toBeTruthy();
    expect(secondResult.backupPath).toBeTruthy();
    expect(secondResult.backupPath).not.toBe(firstResult.backupPath);
    await expect(readFile(firstResult.backupPath!, 'utf8')).resolves.toBe(original);
    await expect(readFile(secondResult.backupPath!, 'utf8')).resolves.toContain('first-token');
    const final = await readFile(configPath, 'utf8');
    expect(final).toContain('second-token');
    expect(final).not.toContain('first-token');
    if (process.platform !== 'win32') {
      for (const filePath of [configPath, firstResult.backupPath!, secondResult.backupPath!]) {
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      }
    }
    expect((await readdir(configDirectory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves prior bytes after replacement failure and does not poison the update queue', async () => {
    const home = await temporaryHome();
    const configDirectory = join(home, '.codex');
    const configPath = join(configDirectory, 'config.toml');
    const original = '[model]\nname = "keep-me"\n';
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, original, 'utf8');
    let replacements = 0;
    const replaceFile = async (source: string, destination: string): Promise<void> => {
      replacements += 1;
      if (replacements === 1) throw new Error('simulated replacement failure');
      await rename(source, destination);
    };

    await expect(configureAgentClientFile('codex', { ...connection, token: 'failed-token' }, {
      homeDirectory: home, environment: {}, now, replaceFile,
    })).rejects.toThrow('simulated replacement failure');
    await expect(readFile(configPath, 'utf8')).resolves.toBe(original);
    expect((await readdir(configDirectory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);

    const recovered = await configureAgentClientFile('codex', { ...connection, token: 'recovery-token' }, {
      homeDirectory: home, environment: {}, now, replaceFile,
    });
    expect(replacements).toBe(2);
    await expect(readFile(configPath, 'utf8')).resolves.toContain('recovery-token');
    expect(recovered.backupPath).toBeTruthy();
    if (process.platform !== 'win32') expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(configDirectory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves unrelated Claude Code user settings', async () => {
    const home = await temporaryHome();
    const configPath = join(home, '.claude.json');
    await writeFile(configPath, JSON.stringify({ theme: 'dark', mcpServers: { keep: { type: 'http', url: 'https://keep.test' }, aidraw: { url: 'old' } } }, null, 2), 'utf8');
    await configureAgentClientFile('claude-code', connection, { homeDirectory: home, environment: {}, now });
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown> & { mcpServers: Record<string, unknown> };
    expect(config.theme).toBe('dark');
    expect(config.mcpServers.keep).toEqual({ type: 'http', url: 'https://keep.test' });
    expect(config.mcpServers.aidraw).toEqual({ type: 'http', url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } });
  });

  it('updates OpenCode JSONC without discarding comments or sibling servers', async () => {
    const home = await temporaryHome();
    const configRoot = join(home, 'xdg');
    const configPath = join(configRoot, 'opencode', 'opencode.jsonc');
    await mkdir(join(configRoot, 'opencode'), { recursive: true });
    await writeFile(configPath, '{\n  // keep this explanation\n  "mcp": { "keep": { "type": "remote", "url": "https://keep.test", "enabled": true }, },\n}\n', 'utf8');
    await configureAgentClientFile('opencode', connection, { homeDirectory: home, environment: { XDG_CONFIG_HOME: configRoot }, now });
    const text = await readFile(configPath, 'utf8');
    const config = parse(text) as { mcp: Record<string, unknown> };
    expect(text).toContain('// keep this explanation');
    expect(config.mcp.keep).toMatchObject({ url: 'https://keep.test', enabled: true });
    expect(config.mcp.aidraw).toEqual({ type: 'remote', url: connection.url, enabled: true, oauth: false, headers: { Authorization: `Bearer ${connection.token}` } });
    expect(config.mcp).not.toHaveProperty('servers');
  });

  it('migrates AIDraw\'s obsolete OpenCode V2 wrapper when it contains no unrelated servers', async () => {
    const home = await temporaryHome();
    const configRoot = join(home, 'xdg');
    const configPath = join(configRoot, 'opencode', 'opencode.json');
    await mkdir(join(configRoot, 'opencode'), { recursive: true });
    await writeFile(configPath, JSON.stringify({ theme: 'keep', mcp: { servers: { aidraw: { type: 'remote', url: 'http://127.0.0.1:1/mcp', oauth: false, codemode: false, headers: { Authorization: 'Bearer stale-test-value' } } } } }, null, 2), 'utf8');
    await configureAgentClientFile('opencode', connection, { homeDirectory: home, environment: { XDG_CONFIG_HOME: configRoot }, now });
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { theme: string; mcp: Record<string, unknown> };
    expect(config.theme).toBe('keep');
    expect(config.mcp).not.toHaveProperty('servers');
    expect(config.mcp.aidraw).toEqual({ type: 'remote', url: connection.url, enabled: true, oauth: false, headers: { Authorization: `Bearer ${connection.token}` } });
  });

  it('does not migrate unrelated entries from the obsolete OpenCode V2 wrapper', async () => {
    const home = await temporaryHome();
    const configRoot = join(home, 'xdg');
    const configPath = join(configRoot, 'opencode', 'opencode.json');
    await mkdir(join(configRoot, 'opencode'), { recursive: true });
    const original = JSON.stringify({ mcp: { servers: { aidraw: { type: 'remote', url: 'old' }, keep: { type: 'remote', url: 'https://keep.test' } } } }, null, 2);
    await writeFile(configPath, original, 'utf8');
    await expect(configureAgentClientFile('opencode', connection, { homeDirectory: home, environment: { XDG_CONFIG_HOME: configRoot }, now })).rejects.toThrow('will not migrate unrelated OpenCode settings');
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('writes the documented Antigravity remote-server schema', async () => {
    const home = await temporaryHome();
    const configPath = join(home, '.gemini', 'config', 'mcp_config.json');
    const result = await configureAgentClientFile('antigravity', connection, { homeDirectory: home, environment: {}, now });
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(result.configPath).toBe(configPath);
    expect(config.mcpServers.aidraw).toEqual({ serverUrl: connection.url, headers: { Authorization: `Bearer ${connection.token}` } });
  });

  it('returns explicit generic Streamable HTTP settings without writing a file', async () => {
    const result = await configureAgentClientFile('generic', connection);
    expect(result).toMatchObject({ status: 'manual', clientId: 'generic', restartRequired: false, setupSnippet: genericSetupSnippet(connection) });
    expect(JSON.parse(result.setupSnippet!)).toEqual({ transport: 'streamable-http', url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } });
  });

  it('refuses to overwrite malformed client configuration', async () => {
    const home = await temporaryHome();
    const configPath = join(home, '.claude.json');
    await writeFile(configPath, '{ invalid', 'utf8');
    await expect(configureAgentClientFile('claude-code', connection, { homeDirectory: home, environment: {}, now })).rejects.toThrow(/invalid JSON/);
    await expect(readFile(configPath, 'utf8')).resolves.toBe('{ invalid');
  });

  it('reports a saved client configuration truthfully when start-at-login enablement fails', async () => {
    const configured = {
      status: 'configured' as const,
      clientId: 'codex' as const,
      clientName: 'Codex',
      message: 'AIDraw saved the client configuration.',
      restartRequired: true,
      restartInstruction: 'Restart Codex.',
      documentationUrl: 'https://example.test/codex',
      configPath: '/private/config.toml',
      backupPath: '/private/config.toml.backup',
    };
    const enableStartAtLogin = vi.fn(async () => { throw new Error('simulated login-item failure'); });
    const result = await completeAgentClientSetup(configured, {
      isolated: false,
      platformLabel: 'macOS',
      enableStartAtLogin,
    });
    expect(result).toMatchObject({
      status: 'configured',
      restartRequired: true,
      configPath: configured.configPath,
      backupPath: configured.backupPath,
    });
    expect(result.message).toContain('client configuration was saved');
    expect(result.message).toContain('simulated login-item failure');
    expect(result.message).toContain('Start AIDraw manually');
    expect(enableStartAtLogin).toHaveBeenCalledOnce();
  });

  it('keeps isolated packaged validation from changing start-at-login', async () => {
    const enableStartAtLogin = vi.fn(async () => ({ startsAtLogin: true }));
    const result = await completeAgentClientSetup({
      status: 'configured', clientId: 'opencode', clientName: 'OpenCode', message: 'Configured.',
      restartRequired: true, restartInstruction: 'Restart OpenCode.',
      documentationUrl: 'https://example.test/opencode',
    }, {
      isolated: true,
      platformLabel: 'macOS',
      enableStartAtLogin,
    });
    expect(result.message).toBe('Configured. Start-at-login was intentionally unchanged by this isolated packaged validation.');
    expect(enableStartAtLogin).not.toHaveBeenCalled();
  });
});
