import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createPackageWithOptions } from '@electron/asar';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const packagedUtilityWorkerSource = [
  'containment-probe',
  'utility-cancel',
  'The utility containment probe is unavailable outside isolated packaged QA.',
  'process.crash',
].join('\n');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('desktop release artifact preflight', () => {
  it('supports an explicitly selected local Electron ZIP directory for offline package checkpoints', async () => {
    const forge = await readFile(resolve('forge.config.ts'), 'utf8');
    expect(forge).toContain("process.env.AIDRAW_ELECTRON_ZIP_DIR");
    expect(forge).toContain('electronZipDir: resolve(localElectronZipDirectory)');
  });

  it('removes only stale maker output and generated manifests', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-release-'));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, 'out', 'make', 'zip'), { recursive: true });
    await mkdir(join(workspace, 'out', 'AIDraw-win32-x64'), { recursive: true });
    await writeFile(join(workspace, 'package.json'), '{"name":"aidraw"}', 'utf8');
    await writeFile(join(workspace, 'out', 'make', 'zip', 'AIDraw-win32-x64-1.0.0.zip'), 'stale', 'utf8');
    await writeFile(join(workspace, 'out', 'SHA256SUMS.txt'), 'stale', 'utf8');
    await writeFile(join(workspace, 'out', 'SHA256SUMS-linux-x64.txt'), 'stale', 'utf8');
    await writeFile(join(workspace, 'out', 'THIRD_PARTY_LICENSES.json'), 'stale', 'utf8');
    await writeFile(join(workspace, 'out', 'AIDraw-win32-x64', 'keep.txt'), 'current package', 'utf8');

    const script = resolve('scripts/prepare-make-output.mjs');
    const result = await execute(process.execPath, [script], { cwd: workspace });

    expect(result.stdout).toContain('release preflight: cleared');
    await expect(readFile(join(workspace, 'out', 'make', 'zip', 'AIDraw-win32-x64-1.0.0.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspace, 'out', 'SHA256SUMS.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspace, 'out', 'SHA256SUMS-linux-x64.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspace, 'out', 'THIRD_PARTY_LICENSES.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspace, 'out', 'AIDraw-win32-x64', 'keep.txt'), 'utf8')).resolves.toBe('current package');
  });

  it.each([
    ['darwin', 'arm64', 'AIDraw-darwin-arm64'],
    ['linux', 'x64', 'AIDraw-linux-x64'],
  ])('resolves the %s package layout instead of a Windows hard-coded path', async (platform, architecture, expectedDirectory) => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-package-layout-'));
    temporaryDirectories.push(workspace);
    const script = resolve('scripts/verify-package.mjs');
    await expect(execute(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, AIDRAW_FORGE_OUT_DIR: join(workspace, 'out'), AIDRAW_PACKAGE_PLATFORM: platform, AIDRAW_PACKAGE_ARCH: architecture },
    })).rejects.toMatchObject({ stderr: expect.stringContaining(expectedDirectory) });
  });

  it('rejects a packaged utility importer that still depends on Electron nativeImage', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aidraw-package-importer-'));
    temporaryDirectories.push(workspace);
    const source = join(workspace, 'asar-source');
    const packageDirectory = join(workspace, 'out', 'AIDraw-win32-x64');
    const archive = join(packageDirectory, 'resources', 'app.asar');
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
});
