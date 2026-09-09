import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createPackageWithOptions } from '@electron/asar';
import { reservePackageGeneration } from '../../scripts/package-output-policy.mjs';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const packagedUtilityWorkerSource = [
  'containment-probe',
  'utility-cancel',
  'The utility containment probe is unavailable outside isolated packaged QA.',
  'process.crash',
].join('\n');

async function reserveSyntheticPackage(workspace: string, platform: string, architecture: string) {
  await writeFile(join(workspace, 'package.json'), '{"name":"aidraw","version":"0.1.0-alpha.1"}', 'utf8');
  await reservePackageGeneration({ workspace, outputDirectory: join(workspace, 'out'), platform, architecture });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('desktop release artifact preflight', () => {
  it('supports an explicitly selected local Electron ZIP directory for offline package checkpoints', async () => {
    const forge = await readFile(resolve('forge.config.ts'), 'utf8');
    expect(forge).toContain("process.env.AIDRAW_ELECTRON_ZIP_DIR");
    expect(forge).toContain('electronZipDir: resolve(localElectronZipDirectory)');
  });

  it('leaves a fresh first-generation output available without creating it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-release-'));
    temporaryDirectories.push(workspace);
    await writeFile(join(workspace, 'package.json'), '{"name":"aidraw","version":"0.1.0-alpha.1"}', 'utf8');

    const script = resolve('scripts/prepare-make-output.mjs');
    const result = await execute(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, AIDRAW_FORGE_OUT_DIR: join(workspace, 'out') },
    });

    expect(result.stdout).toContain('release preflight: fresh package-generation root out');
    await expect(readFile(join(workspace, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an existing generation without deleting package or maker bytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-release-existing-'));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, 'out', 'make', 'zip'), { recursive: true });
    await mkdir(join(workspace, 'out', 'AIDraw-win32-x64'), { recursive: true });
    await writeFile(join(workspace, 'package.json'), '{"name":"aidraw","version":"0.1.0-alpha.1"}', 'utf8');
    await writeFile(join(workspace, 'out', 'make', 'zip', 'AIDraw-win32-x64-1.0.0.zip'), 'stale', 'utf8');
    await writeFile(join(workspace, 'out', 'SHA256SUMS.txt'), 'stale', 'utf8');
    await writeFile(join(workspace, 'out', 'AIDraw-win32-x64', 'keep.txt'), 'current package', 'utf8');

    const script = resolve('scripts/prepare-make-output.mjs');
    await expect(execute(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, AIDRAW_FORGE_OUT_DIR: join(workspace, 'out') },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Refusing to replace package-generation root out'),
    });

    await expect(readFile(join(workspace, 'out', 'make', 'zip', 'AIDraw-win32-x64-1.0.0.zip'), 'utf8')).resolves.toBe('stale');
    await expect(readFile(join(workspace, 'out', 'SHA256SUMS.txt'), 'utf8')).resolves.toBe('stale');
    await expect(readFile(join(workspace, 'out', 'AIDraw-win32-x64', 'keep.txt'), 'utf8')).resolves.toBe('current package');
  });

  it.each([
    ['darwin', 'arm64', 'AIDraw-darwin-arm64'],
    ['linux', 'x64', 'AIDraw-linux-x64'],
  ])('resolves the %s package layout instead of a Windows hard-coded path', async (platform, architecture, expectedDirectory) => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-package-layout-'));
    temporaryDirectories.push(workspace);
    await reserveSyntheticPackage(workspace, platform, architecture);
    const script = resolve('scripts/verify-package.mjs');
    await expect(execute(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, AIDRAW_FORGE_OUT_DIR: join(workspace, 'out'), AIDRAW_PACKAGE_PLATFORM: platform, AIDRAW_PACKAGE_ARCH: architecture },
    })).rejects.toMatchObject({ stderr: expect.stringContaining(expectedDirectory) });
  });

  it('rejects build-only advisory dependencies in the packaged runtime archive', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-package-build-only-audit-'));
    temporaryDirectories.push(workspace);
    const source = join(workspace, 'asar-source');
    const packageDirectory = join(workspace, 'out', 'AIDraw-win32-x64');
    const archive = join(packageDirectory, 'resources', 'app.asar');
    await reserveSyntheticPackage(workspace, 'win32', 'x64');
    await mkdir(join(source, 'node_modules', 'tar'), { recursive: true });
    await mkdir(join(packageDirectory, 'resources'), { recursive: true });
    await writeFile(join(packageDirectory, 'AIDraw.exe'), Buffer.alloc(1_000_001, 1));
    await writeFile(join(source, 'node_modules', 'tar', 'index.js'), Buffer.alloc(4_096, 1));
    await createPackageWithOptions(source, archive, {});

    const script = resolve('scripts/verify-package.mjs');
    await expect(execute(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, AIDRAW_FORGE_OUT_DIR: join(workspace, 'out'), AIDRAW_PACKAGE_PLATFORM: 'win32', AIDRAW_PACKAGE_ARCH: 'x64' },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('Build-only audit dependencies leaked into the runtime archive') });
  });

  it('rejects a packaged utility importer that still depends on Electron nativeImage', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-package-importer-'));
    temporaryDirectories.push(workspace);
    const source = join(workspace, 'asar-source');
    const packageDirectory = join(workspace, 'out', 'AIDraw-win32-x64');
    const archive = join(packageDirectory, 'resources', 'app.asar');
    await reserveSyntheticPackage(workspace, 'win32', 'x64');
    await mkdir(join(source, '.vite', 'build'), { recursive: true });
    await mkdir(join(packageDirectory, 'resources'), { recursive: true });
    await writeFile(join(packageDirectory, 'AIDraw.exe'), Buffer.alloc(1_000_001, 1));
    await writeFile(join(source, '.vite', 'build', 'utility-worker.js'), 'import("./import-document-test.js");\n', 'utf8');
    await writeFile(join(source, '.vite', 'build', 'utility-worker-test.js'), packagedUtilityWorkerSource, 'utf8');
    await writeFile(join(source, '.vite', 'build', 'import-document-test.js'), `const nativeImage = {};\n/*${'x'.repeat(4_096)}*/\n`, 'utf8');
    await createPackageWithOptions(source, archive, {});

    const script = resolve('scripts/verify-package.mjs');
    await expect(execute(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, AIDRAW_FORGE_OUT_DIR: join(workspace, 'out'), AIDRAW_PACKAGE_PLATFORM: 'win32', AIDRAW_PACKAGE_ARCH: 'x64' },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('must not depend on Electron nativeImage') });
  });

  it('rejects a package whose main bundle lacks the current MCP self-documentation surface', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-package-mcp-discovery-'));
    temporaryDirectories.push(workspace);
    const source = join(workspace, 'asar-source');
    const packageDirectory = join(workspace, 'out', 'AIDraw-win32-x64');
    const archive = join(packageDirectory, 'resources', 'app.asar');
    await reserveSyntheticPackage(workspace, 'win32', 'x64');
    await mkdir(join(source, '.vite', 'build'), { recursive: true });
    await mkdir(join(packageDirectory, 'resources'), { recursive: true });
    await writeFile(join(packageDirectory, 'AIDraw.exe'), Buffer.alloc(1_000_001, 1));
    await writeFile(join(source, '.vite', 'build', 'utility-worker.js'), 'import("./import-document-test.js");\n', 'utf8');
    await writeFile(join(source, '.vite', 'build', 'utility-worker-test.js'), packagedUtilityWorkerSource, 'utf8');
    await writeFile(join(source, '.vite', 'build', 'import-document-test.js'), `const decoder = {};\n/*${'x'.repeat(4_096)}*/\n`, 'utf8');
    await writeFile(join(source, '.vite', 'build', 'main.js'), 'const oldMcpSurface = true;\n', 'utf8');
    await createPackageWithOptions(source, archive, {});

    const script = resolve('scripts/verify-package.mjs');
    await expect(execute(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, AIDRAW_FORGE_OUT_DIR: join(workspace, 'out'), AIDRAW_PACKAGE_PLATFORM: 'win32', AIDRAW_PACKAGE_ARCH: 'x64' },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('missing current MCP discovery markers') });
  });

  it('rejects a retained pre-policy package root before inspecting or mutating package bytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-unreserved-package-'));
    temporaryDirectories.push(workspace);
    await writeFile(join(workspace, 'package.json'), '{"name":"aidraw","version":"0.1.0-alpha.1"}', 'utf8');
    const retainedBytePath = join(workspace, 'out', 'AIDraw-win32-x64', 'AIDraw.exe');
    await mkdir(join(workspace, 'out', 'AIDraw-win32-x64'), { recursive: true });
    await writeFile(retainedBytePath, 'retained pre-policy package bytes\n', 'utf8');

    const script = resolve('scripts/verify-package.mjs');
    await expect(execute(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, AIDRAW_FORGE_OUT_DIR: join(workspace, 'out'), AIDRAW_PACKAGE_PLATFORM: 'win32', AIDRAW_PACKAGE_ARCH: 'x64' },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('Package generation marker is missing or invalid') });
    await expect(readFile(retainedBytePath, 'utf8')).resolves.toBe('retained pre-policy package bytes\n');
  });
});
