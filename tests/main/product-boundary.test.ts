import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_BUILD_INPUT_PATHS } from '../../scripts/package-build-input.mjs';
import { IPC } from '../../src/common/contracts';

const removedRuntimePaths = [
  'src/common/generation.ts',
  'src/common/generation-capabilities.ts',
  'src/main/credentials.ts',
  'src/main/secure-storage.ts',
  'src/main/provider-credentials.ts',
  'src/main/generation-manager.ts',
  'src/main/generation-provider-runner.ts',
  'src/main/generation-e2e.ts',
  'src/main/pixel-generation-e2e.ts',
] as const;

async function source(path: string): Promise<string> {
  return readFile(resolve(path), 'utf8');
}

interface VitestCommand {
  surface: string;
  command: string;
  cacheDisabled: boolean;
}

function normalizedCommand(command: string): string {
  return command.replace(/\\\r?\n/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function containsVitestRun(command: string): boolean {
  return /(?:^|[\s;&|])(?:[^\s;&|]*[\\/])?vitest(?:\.mjs)?\s+run(?:\s|$)/iu.test(
    normalizedCommand(command).replace(/["']/gu, ''),
  );
}

function commandLike(value: string): boolean {
  return /^(?:[$>]\s*|PS>\s*|&\s*)?(?:node|npx|npm|pnpm|yarn|bun|deno|vitest)(?:\s|$)/iu.test(value.trim());
}

function command(surface: string, value: string): VitestCommand {
  const normalized = normalizedCommand(value);
  return { surface, command: normalized, cacheDisabled: /(?:^|\s)--cache=false(?:\s|$)/u.test(normalized) };
}

function markdownVitestCommands(surface: string, markdown: string): VitestCommand[] {
  const commands: VitestCommand[] = [];
  const fences = /^```([^\r\n]*)\r?\n([\s\S]*?)^```[^\S\r\n]*$/gmu;
  for (const match of markdown.matchAll(fences)) {
    const language = match[1]!.trim().toLowerCase();
    if (language && !/^(?:bash|sh|shell|zsh|powershell|pwsh|ps1|cmd|console)$/u.test(language)) continue;
    for (const rawLine of match[2]!.split(/\r?\n/u)) {
      const line = rawLine.trim().replace(/^(?:[$>]\s*|PS>\s*)/u, '');
      if (commandLike(line) && containsVitestRun(line)) commands.push(command(surface, line));
    }
  }
  const withoutFences = markdown.replace(fences, '');
  for (const match of withoutFences.matchAll(/`([^`\r\n]+)`/gu)) {
    const inline = match[1]!.trim();
    if (commandLike(inline) && containsVitestRun(inline)) commands.push(command(surface, inline));
  }
  return commands;
}

function shellVitestCommands(surface: string, script: string): VitestCommand[] {
  const commands: VitestCommand[] = [];
  for (const rawLine of script.split(/\r?\n/u)) {
    if (/^\s*(?:#|\/\/|REM(?:\s|$)|::)/iu.test(rawLine)) continue;
    const line = rawLine.trim()
      .replace(/^run:\s*/u, '')
      .replace(/^(?:exec|call)\s+/iu, '')
      .replace(/^env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)+\s+/u, '');
    if (commandLike(line) && containsVitestRun(line)) commands.push(command(surface, line));
  }
  return commands;
}

interface SourceLiteral { value: string; start: number; end: number }

function sourceLiterals(sourceText: string): SourceLiteral[] {
  const literals: SourceLiteral[] = [];
  for (let index = 0; index < sourceText.length;) {
    if (sourceText[index] === '/' && sourceText[index + 1] === '/') {
      index = sourceText.indexOf('\n', index + 2); if (index < 0) break; continue;
    }
    if (sourceText[index] === '/' && sourceText[index + 1] === '*') {
      const end = sourceText.indexOf('*/', index + 2); index = end < 0 ? sourceText.length : end + 2; continue;
    }
    const quote = sourceText[index];
    if (quote !== "'" && quote !== '"' && quote !== '`') { index += 1; continue; }
    const start = index;
    let value = '';
    index += 1;
    while (index < sourceText.length) {
      const character = sourceText[index]!;
      if (character === '\\') {
        if (index + 1 < sourceText.length) value += sourceText[index + 1];
        index += 2;
        continue;
      }
      if (character === quote) { index += 1; break; }
      value += character;
      index += 1;
    }
    literals.push({ value, start, end: index });
  }
  return literals;
}

function executableVitestCommands(surface: string, sourceText: string): VitestCommand[] {
  const literals = sourceLiterals(sourceText);
  const commands: VitestCommand[] = [];
  for (const literal of literals) {
    if (commandLike(literal.value) && containsVitestRun(literal.value)) commands.push(command(surface, literal.value));
  }
  for (let index = 0; index < literals.length; index += 1) {
    const entry = literals[index]!;
    const lower = entry.value.toLowerCase();
    const next = literals[index + 1];
    const isLauncher = /(?:^|[\\/])vitest\.mjs$/u.test(lower) || (lower === 'vitest' && next?.value === 'run');
    if (!isLauncher) continue;
    const arrayEnd = sourceText.indexOf(']', entry.end);
    if (arrayEnd < 0 || arrayEnd - entry.end > 1_500) continue;
    const nextArrayLiteral = literals.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.start > arrayEnd);
    const argumentsInArray = literals.slice(index, nextArrayLiteral < 0 ? literals.length : nextArrayLiteral);
    if (!argumentsInArray.some((candidate) => candidate.value === 'run')) continue;
    commands.push(command(surface, argumentsInArray.map((candidate) => candidate.value).join(' ')));
  }
  return [...new Map(commands.map((candidate) => [`${candidate.surface}\0${candidate.command}`, candidate])).values()];
}

async function filesBelow(directory: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path, pattern));
    else if (entry.isFile() && pattern.test(entry.name)) files.push(path);
  }
  return files;
}

async function existingOptionalPath(
  path: string,
  pathAccess: (candidate: string) => Promise<unknown> = access,
): Promise<string[]> {
  try {
    await pathAccess(path);
    return [path];
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function accessError(code: 'ENOENT' | 'EACCES' | 'EIO'): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}

async function maintainedVitestCommands(): Promise<VitestCommand[]> {
  const root = resolve('.');
  const manifest = JSON.parse(await source('package.json')) as { scripts?: Record<string, string> };
  const commands = Object.entries(manifest.scripts ?? {})
    .filter(([, value]) => containsVitestRun(value))
    .map(([name, value]) => command(`package.json#scripts.${name}`, value));
  const markdownPaths = [
    ...['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'].map((path) => resolve(root, path)),
    ...await filesBelow(resolve(root, 'docs'), /\.md$/u),
    ...await existingOptionalPath(resolve(root, '.codex', 'SECRETARY_HANDOFF.md')),
  ];
  for (const path of markdownPaths) {
    commands.push(...markdownVitestCommands(relative(root, path), await readFile(path, 'utf8')));
  }
  for (const path of await filesBelow(resolve(root, 'scripts'), /\.(?:mjs|cjs|js|mts|ts|ps1|sh|cmd)$/u)) {
    const script = await readFile(path, 'utf8');
    commands.push(.../\.(?:ps1|sh|cmd)$/u.test(path)
      ? shellVitestCommands(relative(root, path), script)
      : executableVitestCommands(relative(root, path), script));
  }
  for (const path of await filesBelow(resolve(root, '.github'), /\.(?:yml|yaml)$/u)) {
    commands.push(...shellVitestCommands(relative(root, path), await readFile(path, 'utf8')));
  }
  return commands;
}

describe('native drawing product boundary', () => {
  it('routes trusted renderer transactions through the same main-owned canonical service policy', async () => {
    const main = await source('src/main/main.ts');
    const service = await source('src/main/document-service.ts');
    const journal = await source('src/main/journal.ts');
    expect(main).toContain('handle(IPC.applyTransaction');
    expect(main).toContain('return service.apply({ ...transaction, actor: HUMAN_ACTOR });');
    expect(service).toContain('assertStrictNativeEditableTransaction(transaction);');
    expect(journal.match(/assertStrictNativeEditableTransaction\(/gu)).toHaveLength(2);
  });

  it('publishes a byte-exact reproducible source-subject manifest generator', () => {
    const script = resolve('scripts/source-subject-manifest.mjs');
    const manifest = execFileSync(process.execPath, [script, 'manifest'], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });
    const repeated = execFileSync(process.execPath, [script, 'manifest'], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });
    const summary = JSON.parse(execFileSync(process.execPath, [script, 'summary'], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as {
      version: number; encoding: string; ordering: string; recordFormat: string; finalNewline: boolean; entries: number; bytes: number; sha256: string;
    };
    expect(repeated.equals(manifest)).toBe(true);
    expect(manifest.at(-1)).toBe(0x0a);
    expect(summary).toMatchObject({
      version: 1,
      encoding: 'UTF-8',
      ordering: 'ascending raw UTF-8 path bytes',
      finalNewline: true,
      bytes: manifest.byteLength,
      sha256: createHash('sha256').update(manifest).digest('hex'),
    });
    expect(summary.recordFormat).toBe('<XY>\\t<file|symlink|deleted>\\t<byteLength>\\t<sha256>\\t<path>\\n');
    const lines = manifest.toString('utf8').trimEnd().split('\n');
    expect(summary.entries).toBe(lines.length);
    const paths = lines.map((line) => {
      const fields = line.split('\t');
      expect(fields).toHaveLength(5);
      expect(fields[0]).toHaveLength(2);
      expect(['file', 'symlink', 'deleted']).toContain(fields[1]);
      expect(Number.isSafeInteger(Number(fields[2]))).toBe(true);
      expect(fields[3]).toMatch(/^[0-9a-f]{64}$/u);
      return fields[4];
    });
    expect(paths).toContain('scripts/source-subject-manifest.mjs');
    expect(paths).toEqual([...paths].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))));
  });

  it('binds packages to exact runtime build inputs without conflating later documentation bytes', async () => {
    expect(PACKAGE_BUILD_INPUT_PATHS).toContain('src');
    expect(PACKAGE_BUILD_INPUT_PATHS).toContain('packages');
    expect(PACKAGE_BUILD_INPUT_PATHS).toContain('index.html');
    expect(PACKAGE_BUILD_INPUT_PATHS).not.toContain('docs');
    expect(PACKAGE_BUILD_INPUT_PATHS).not.toContain('README.md');

    const [forge, verifier, testing, release] = await Promise.all([
      source('forge.config.ts'),
      source('scripts/verify-package.mjs'),
      source('docs/TESTING.md'),
      source('docs/RELEASE_CHECKLIST.md'),
    ]);
    expect(forge.indexOf('await reservePackageGeneration')).toBeLessThan(forge.indexOf('await capturePackageBuildInput'));
    expect(verifier).toContain('const sourceBuildInput = await readPackageBuildInput');
    expect(verifier).toContain('sourceBuildInput: {');
    expect(verifier).toContain("'pixel.tilemap.region'");
    expect(verifier).toContain("'Automatic MCP connection grants no file authority'");
    expect(testing).toContain('Package source-input manifest');
    expect(testing).toContain('Final worktree manifest');
    expect(release).toContain('exact first-party package source-input manifest');
    expect(release).toContain('later documentation bytes are not package source inputs');
  });

  it('scans the ignored local handoff when present without requiring it in a clean clone', async () => {
    const handoff = resolve('.codex', 'SECRETARY_HANDOFF.md');
    await expect(existingOptionalPath(handoff, async () => undefined)).resolves.toEqual([handoff]);
    await expect(existingOptionalPath(handoff, async () => { throw accessError('ENOENT'); })).resolves.toEqual([]);
  });

  it.each(['EACCES', 'EIO'] as const)('fails closed when optional-handoff discovery returns %s', async (code) => {
    const handoff = resolve('.codex', 'SECRETARY_HANDOFF.md');
    await expect(existingOptionalPath(handoff, async () => { throw accessError(code); })).rejects.toMatchObject({ code });
  });

  it('extracts maintained commands without mistaking ordinary prose for an executable route', () => {
    const prose = 'Historical prose: the prior vitest run was recorded before cache-disabled acceptance became policy.';
    expect(markdownVitestCommands('docs/HISTORY.md', prose)).toEqual([]);

    const unflagged = markdownVitestCommands('docs/FUTURE_ACCEPTANCE.md', [
      '```sh',
      'node scripts/npm-node24.mjs exec -- vitest run tests/main/future.test.ts',
      '```',
    ].join('\n'));
    expect(unflagged).toEqual([expect.objectContaining({ surface: 'docs/FUTURE_ACCEPTANCE.md', cacheDisabled: false })]);

    const flagged = markdownVitestCommands(
      'docs/FUTURE_ACCEPTANCE.md',
      'Run `vitest run --cache=false tests/main/future.test.ts` after the source check.',
    );
    expect(flagged).toEqual([expect.objectContaining({ cacheDisabled: true })]);

    const futureScript = "spawnSync(process.execPath, [resolve(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', config]);";
    expect(executableVitestCommands('scripts/future-gate.mjs', futureScript)).toEqual([
      expect.objectContaining({ surface: 'scripts/future-gate.mjs', cacheDisabled: false }),
    ]);
    expect(executableVitestCommands('scripts/future-gate.mjs', futureScript.replace("'run'", "'run', '--cache=false'"))).toEqual([
      expect.objectContaining({ cacheDisabled: true }),
    ]);
    expect(shellVitestCommands('scripts/future-gate.sh', [
      '# Historical prose: the prior vitest run was recorded here.',
      'node node_modules/vitest/vitest.mjs run tests/main/future.test.ts',
    ].join('\n'))).toEqual([expect.objectContaining({ surface: 'scripts/future-gate.sh', cacheDisabled: false })]);
    expect(shellVitestCommands(
      '.github/workflows/future.yml',
      'run: npx vitest run --cache=false tests/main/future.test.ts',
    )).toEqual([expect.objectContaining({ surface: '.github/workflows/future.yml', cacheDisabled: true })]);
  });

  it('keeps every maintained package, executable, and documented Vitest acceptance route cache-disabled', async () => {
    const manifest = JSON.parse(await source('package.json')) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.verify).toContain('npm run test');
    expect(manifest.scripts?.['release:current']).toContain('npm run verify');
    expect(manifest.scripts?.['release:current']).toContain('npm run test:performance');
    const commands = await maintainedVitestCommands();
    expect(commands.map((candidate) => candidate.surface)).toEqual(expect.arrayContaining([
      'package.json#scripts.test',
      'package.json#scripts.test:performance',
      'docs/TESTING.md',
      'scripts/qa08-tiled-cell-budget-gate.mjs',
      'scripts/qa08-tiled-cell-budget-gate-v2.mjs',
    ]));
    expect(commands.filter((candidate) => !candidate.cacheDisabled)).toEqual([]);
  });

  it('ships no content-provider SDK or provider/protected-storage runtime', async () => {
    const manifest = JSON.parse(await source('package.json')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(manifest[field] ?? {}).not.toHaveProperty('openai');
    }
    await Promise.all(removedRuntimePaths.map(async (path) => {
      await expect(access(resolve(path))).rejects.toMatchObject({ code: 'ENOENT' });
    }));

    const runtime = await Promise.all([
      source('src/main/main.ts'),
      source('src/main/engine-runtime.ts'),
      source('src/main/mcp-host.ts'),
      source('src/preload/preload.ts'),
      source('src/renderer/App.tsx'),
    ]).then((parts) => parts.join('\n'));
    expect(runtime).not.toMatch(/safeStorage|GenerationManager|GenerationProvider|ProviderCredentials|OPENAI_API_KEY|STABILITY_API_KEY|COMFYUI/i);
  });

  it('exposes a stable no-secret MCP bridge and no provider or credential lifecycle IPC', async () => {
    const channels = Object.values(IPC);
    expect(channels.filter((channel) => /provider|generation|credential|rotate|revoke|secure-storage/i.test(channel))).toEqual([]);
    expect(IPC).toMatchObject({ mcpConnection: 'aidraw:mcp:connection', agentClientSetup: 'aidraw:mcp:agent-client-setup' });

    const authority = await source('src/main/mcp-authority.ts');
    const engine = await source('src/main/engine-runtime.ts');
    const runState = await source('src/main/mcp-run-state.ts');
    const bridge = await source('src/main/mcp-stdio-bridge.ts');
    const setup = await source('src/main/agent-client-config.ts');
    const main = await source('src/main/main.ts');
    const renderer = await source('src/renderer/App.tsx');
    expect(authority).toContain('never a durable client setting');
    expect(engine).toContain('const token = createEphemeralMcpAuthority()');
    expect(engine).toContain('await publishMcpEngineRunState');
    expect(runState).toContain("authority: 'engine-run'");
    expect(runState).toContain('Double-read the non-secret pointer');
    expect(runState).toContain('validateWindowsPrivateDirectory');
    expect(bridge).toContain("url.pathname = '/mcp/identity'");
    expect(bridge).toContain('this.active.state.instanceId !== state.instanceId');
    expect(main).toContain("const bridgeInvocation = process.argv.includes('--mcp-bridge')");
    expect(main).toContain('const hasSingleInstanceLock = bridgeInvocation || cliInvocation');
    expect(main).toContain('await runMcpStdioBridge({');
    expect(main).toContain("process.once('SIGINT', requestTermination)");
    expect(main).toContain("process.once('SIGTERM', requestTermination)");
    expect(main).toContain('terminationSignal: termination.signal');
    expect(main).toContain("process.removeListener('SIGTERM', requestTermination)");
    expect(main).toContain('await publishProductMcpBridgeLauncher(productMcpBridgeLauncherOptions())');
    expect(setup).toContain("'bridge-launcher.cmd'");
    expect(setup).toContain("'bridge-launcher.sh'");
    expect(setup).toContain("command: '/bin/sh'");
    expect(setup).toContain("args: ['/d', '/v:off', '/s', '/c', launcherPath]");
    expect(setup).toContain('No engine URL, bearer, or per-launch value is exposed.');
    expect(setup).not.toMatch(/homedir|safeStorage/);
    expect(setup).not.toMatch(/Authorization|127\.0\.0\.1|http_headers/u);
    expect(renderer).not.toContain('Authorization header');
    expect(renderer).not.toContain('await window.aidraw.getMcpConnection()');
  });

  it('suppresses macOS bridge activation before any app-ready or editor route', async () => {
    const main = await source('src/main/main.ts');
    const bridgeGuard = main.indexOf("if (bridgeInvocation && process.platform === 'darwin')");
    const activationPolicy = main.indexOf("app.setActivationPolicy('accessory')", bridgeGuard);
    const dockHide = main.indexOf('app.dock?.hide()', bridgeGuard);
    const startupWindow = main.indexOf("app.commandLine.appendSwitch('no-startup-window')", bridgeGuard);
    const firstReady = main.indexOf('app.whenReady()');
    expect(bridgeGuard).toBeGreaterThan(0);
    expect(startupWindow).toBeGreaterThan(bridgeGuard);
    expect(activationPolicy).toBeGreaterThan(bridgeGuard);
    expect(dockHide).toBeGreaterThan(bridgeGuard);
    expect(Math.max(startupWindow, activationPolicy, dockHide)).toBeLessThan(firstReady);
  });

  it('keeps old provenance readable only as passive document compatibility', async () => {
    const schema = await source('packages/core/src/schemas.ts');
    const model = await source('packages/core/src/model.ts');
    const transactionPolicy = await source('src/main/transaction-policy.ts');
    const mcpHost = await source('src/main/mcp-host.ts');
    expect(schema).toContain("z.enum(['openai', 'stability', 'comfyui', 'external'])");
    expect(model).toContain('AIDraw no longer creates provider provenance');
    expect(transactionPolicy).toContain('Historical provider provenance is read-only compatibility metadata.');
    expect(mcpHost).not.toContain("registerTool('generation_start'");
  });
});
