import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { updateAgentJson } from '@main/agent-client-config';
import { prepareIsolatedOpenCodeDiscovery, redactIsolatedOpenCodeDiscovery } from '../../scripts/opencode-discovery-config.mjs';
import {
  buildOpenCodeChildEnvironment,
  buildOpenCodeConfig,
  buildOpenCodeDiscoveryPlan,
  inspectOpenCodeConfig,
  redactOpenCodeConfig,
  assertOpenCodeDiscoveryLaunchBoundary,
  type OpenCodeDiscoveryPlanInput,
} from '../../scripts/opencode-discovery-safety.mjs';

const token = 'test-only-high-entropy-bearer';
const connection = { url: 'http://127.0.0.1:49152/mcp', token };
const baseline: OpenCodeDiscoveryPlanInput = {
  workspacePath: 'E:\\AIDraw',
  runRoot: 'E:\\AIDraw\\test-results\\retained\\aidraw-agt14-opencode-discovery-20260806T040000',
  aidrawExecutable: 'E:\\AIDraw\\out-mcp-discovery-20260805T190410\\AIDraw-win32-x64\\AIDraw.exe',
  aidrawExecutableBytes: 225_614_336,
  aidrawExecutableSha256: '3824676578BB15E1AA94D79D333DAA2D65B71FEC8111CC2D27F9956F8B40E0CB',
  aidrawAsar: 'E:\\AIDraw\\out-mcp-discovery-20260805T190410\\AIDraw-win32-x64\\resources\\app.asar',
  aidrawAsarBytes: 47_276_568,
  aidrawAsarSha256: 'C7C43234CB18322A221492AA44F3C4F60DDB2B20F60D9FE621DA28DE20F8349E',
  clientProductVersion: '1.18.13',
  clientExecutable: 'C:\\Users\\hokom\\AppData\\Local\\Programs\\opencode\\opencode.exe',
  clientExecutableBytes: 231_549_320,
  clientExecutableSha256: 'F82E4188C34E06E12A781FEE78198F2B5E102E5D345B1CF62A46D21531A19204',
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('isolated installed OpenCode discovery safety', () => {
  it('derives every mutable client artifact below one fresh retained run root', () => {
    const plan = buildOpenCodeDiscoveryPlan(baseline, 'win32');
    expect(plan).toMatchObject({
      version: 1,
      kind: 'aidraw-opencode-installed-discovery',
      runRoot: baseline.runRoot,
      aidraw: {
        executableSha256: baseline.aidrawExecutableSha256,
        profile: `${baseline.runRoot}\\aidraw-profile`,
        connectionPath: `${baseline.runRoot}\\aidraw-profile\\mcp-connection.json`,
      },
      client: {
        id: 'opencode',
        executableSha256: baseline.clientExecutableSha256,
        configRoot: `${baseline.runRoot}\\aidraw-profile\\opencode-xdg`,
        configPath: `${baseline.runRoot}\\aidraw-profile\\opencode-xdg\\opencode\\opencode.jsonc`,
        userData: `${baseline.runRoot}\\opencode-user-data`,
      },
      networkBoundary: { requiresIndependentOfflineEnforcement: true },
    });
    expect(plan.client.arguments).toContain(`--user-data-dir=${plan.client.userData}`);
    for (const serialized of [JSON.stringify(plan), plan.client.arguments.join('\n')]) expect(serialized).not.toContain(token);
  });

  it('refuses a broad, nested, or incorrectly named retained run root', () => {
    for (const runRoot of [
      'E:\\AIDraw\\test-results\\retained',
      'E:\\AIDraw\\test-results\\retained\\nested\\aidraw-agt14-opencode-discovery-run',
      'E:\\AIDraw\\test-results\\retained\\opencode-run',
      'E:\\AIDraw\\other\\aidraw-agt14-opencode-discovery-run',
    ]) expect(() => buildOpenCodeDiscoveryPlan({ ...baseline, runRoot }, 'win32')).toThrow(/fresh aidraw-agt14-opencode-discovery-/);
  });

  it('creates the exact product OpenCode shape and redacts it without leaking the bearer', () => {
    const config = buildOpenCodeConfig(connection);
    const productConfig = updateAgentJson('opencode', '', 'opencode.jsonc', connection);
    expect(parse(config)).toEqual(parse(productConfig));
    expect(inspectOpenCodeConfig(config, connection.url)).toEqual({
      schema: 'https://opencode.ai/config.json',
      configured: true,
      urlMatches: true,
      authorizationState: 'bearer',
      obsoleteWrapperAbsent: true,
    });

    const redacted = redactOpenCodeConfig(config);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain('Bearer ');
    expect(inspectOpenCodeConfig(redacted, connection.url)).toMatchObject({ configured: true, urlMatches: true, authorizationState: 'redacted' });
    expect(redactOpenCodeConfig(redacted)).toBe(redacted);
  });

  it('passes only an allowlisted system environment plus disposable client roots and loopback-denying proxies', () => {
    const plan = buildOpenCodeDiscoveryPlan(baseline, 'win32');
    const environment = buildOpenCodeChildEnvironment({
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\System32',
      HOME: 'C:\\Users\\real',
      CODEX_HOME: 'C:\\Users\\real\\.codex',
      OPENAI_API_KEY: 'must-not-cross',
      ANTHROPIC_API_KEY: 'must-not-cross',
      UNRELATED_SECRET: 'must-not-cross',
    }, plan);
    expect(environment).toMatchObject({
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\System32',
      USERPROFILE: plan.client.home,
      APPDATA: plan.client.roamingAppData,
      LOCALAPPDATA: plan.client.localAppData,
      XDG_CONFIG_HOME: plan.client.configRoot,
      TEMP: plan.client.temp,
      TMP: plan.client.temp,
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost,::1,[::1]',
    });
    for (const key of ['HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'UNRELATED_SECRET']) expect(environment).not.toHaveProperty(key);
  });

  it('refuses non-loopback, wrong-path, or missing-secret MCP configuration', () => {
    expect(() => buildOpenCodeConfig({ url: 'https://example.test/mcp', token })).toThrow(/loopback/);
    expect(() => buildOpenCodeConfig({ url: 'http://127.0.0.1:49152/other', token })).toThrow(/loopback/);
    expect(() => buildOpenCodeConfig({ url: connection.url, token: '' })).toThrow(/bearer token/);
  });

  it('requires both the explicit native launch declaration and independent offline enforcement', () => {
    expect(() => assertOpenCodeDiscoveryLaunchBoundary({}, 'win32')).toThrow(/execution boundary/);
    expect(() => assertOpenCodeDiscoveryLaunchBoundary({ launchContext: 'unsandboxed-gui' }, 'win32')).toThrow(/offline boundary/);
    expect(assertOpenCodeDiscoveryLaunchBoundary({
      launchContext: 'unsandboxed-gui',
      offlineBoundary: 'coordinator-enforced-offline',
    }, 'win32')).toEqual({ launchContext: 'unsandboxed-gui', offlineBoundary: 'coordinator-enforced-offline' });
  });

  it('prepares only the isolated config and secret-free manifest, then redacts in place after declared shutdown', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'aidraw-opencode-discovery-'));
    temporaryDirectories.push(workspacePath);
    const runRoot = join(workspacePath, 'test-results', 'retained', 'aidraw-agt14-opencode-discovery-fixture');
    const aidrawExecutable = join(workspacePath, 'AIDraw.exe');
    const aidrawAsar = join(workspacePath, 'app.asar');
    const clientExecutable = join(workspacePath, 'OpenCode.exe');
    const identities = [
      [aidrawExecutable, 'aidraw-executable'],
      [aidrawAsar, 'aidraw-asar'],
      [clientExecutable, 'opencode-executable'],
    ] as const;
    await mkdir(join(runRoot, 'aidraw-profile'), { recursive: true });
    for (const [path, contents] of identities) await writeFile(path, contents, 'utf8');
    const digest = (contents: string) => createHash('sha256').update(contents).digest('hex').toUpperCase();
    const input: OpenCodeDiscoveryPlanInput = {
      workspacePath,
      runRoot,
      aidrawExecutable,
      aidrawExecutableBytes: identities[0][1].length,
      aidrawExecutableSha256: digest(identities[0][1]),
      aidrawAsar,
      aidrawAsarBytes: identities[1][1].length,
      aidrawAsarSha256: digest(identities[1][1]),
      clientProductVersion: '1.18.13',
      clientExecutable,
      clientExecutableBytes: identities[2][1].length,
      clientExecutableSha256: digest(identities[2][1]),
    };
    const plan = buildOpenCodeDiscoveryPlan(input);
    await writeFile(plan.aidraw.connectionPath, JSON.stringify({ ...connection, pid: 42 }), 'utf8');

    const manifest = await prepareIsolatedOpenCodeDiscovery(input, new Date('2026-08-06T04:00:00.000Z'));
    const config = await readFile(plan.client.configPath, 'utf8');
    const manifestText = await readFile(plan.manifestPath, 'utf8');
    expect(inspectOpenCodeConfig(config, connection.url)).toMatchObject({ configured: true, authorizationState: 'bearer' });
    expect(manifest).toMatchObject({ credentialStatus: 'live-in-isolated-config', configSummary: { authorizationState: 'bearer' } });
    expect(manifestText).not.toContain(token);
    expect(manifestText).not.toContain('Bearer ');
    expect(manifest.clientEnvironment).not.toHaveProperty('OPENAI_API_KEY');
    await expect(prepareIsolatedOpenCodeDiscovery(input)).rejects.toThrow(/fresh OpenCode discovery path already exists/);

    const cleanup = await redactIsolatedOpenCodeDiscovery(plan.manifestPath, new Date('2026-08-06T04:01:00.000Z'));
    expect(cleanup).toMatchObject({ authorizationState: 'redacted', credentialStatus: 'redacted-after-graceful-stop' });
    const redacted = await readFile(plan.client.configPath, 'utf8');
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain('Bearer ');
    expect(await readFile(plan.cleanupAuditPath, 'utf8')).not.toContain(token);
  });
});
