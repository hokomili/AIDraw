import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('desktop release artifact preflight', () => {
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
});
