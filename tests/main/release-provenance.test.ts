import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureReleaseProvenance, compareReleaseProvenance, type ReleaseProvenance } from '../../scripts/release-provenance.mjs';

const temporaryRoots: string[] = [];
const commit = 'b'.repeat(40);
const execute = promisify(execFile);

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

async function releaseWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'aidraw-release-provenance-'));
  temporaryRoots.push(root);
  const artifactPath = join(root, 'out', 'make', 'zip', 'AIDraw.zip');
  await mkdir(join(root, 'out', 'make', 'zip'), { recursive: true });
  const artifact = 'deterministic archive bytes\n';
  await writeFile(artifactPath, artifact, 'utf8');
  await writeFile(join(root, 'out', 'SHA256SUMS-windows-x64.txt'), `${sha256(artifact)}  make/zip/AIDraw.zip\n`, 'utf8');
  await writeFile(join(root, 'out', 'THIRD_PARTY_LICENSES.json'), '[]\n', 'utf8');
  await writeFile(join(root, 'out', 'THIRD_PARTY_LICENSES.md'), '# Licenses\n', 'utf8');
  const packageJson = {
    name: 'aidraw',
    version: '0.1.0-alpha.1',
    engines: { node: '>=24 <25' },
    dependencies: { '@napi-rs/canvas': '1.0.3', canvas: '3.2.0-aidraw.1' },
    devDependencies: { electron: '43.2.0', '@electron-forge/cli': '7.11.2', vite: '7.3.6', typescript: '5.9.3' },
  };
  const packageLock = { name: 'aidraw', version: packageJson.version, lockfileVersion: 3, packages: { '': { version: packageJson.version } } };
  await writeFile(join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`, 'utf8');
  await writeFile(join(root, '.nvmrc'), '24\n', 'utf8');
  return root;
}

async function capture(root: string) {
  return captureReleaseProvenance({
    cwd: root,
    repository: { commit, status: '' },
    runtime: { nodeVersion: 'v24.14.0', npmVersion: '11.7.0', platform: 'win32', architecture: 'x64', osRelease: 'test-os-a' },
    capturedAt: '2026-08-11T00:00:00.000Z',
  });
}

function copyManifest(manifest: ReleaseProvenance): ReleaseProvenance { return JSON.parse(JSON.stringify(manifest)) as ReleaseProvenance; }

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release provenance and reproducibility', () => {
  it('captures a clean exact source, toolchain, checksum, license, and artifact inventory', async () => {
    const root = await releaseWorkspace();
    const { manifest, outputPath } = await capture(root);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      platform: { label: 'windows-x64', nodePlatform: 'win32', architecture: 'x64' },
      candidate: { version: '0.1.0-alpha.1', commit },
      source: { clean: true, lockfileVersion: 3 },
      runtime: { node: 'v24.14.0', npm: '11.7.0', nvmrc: '24', nodeEngine: '>=24 <25' },
      toolchain: { electron: '43.2.0', '@electron-forge/cli': '7.11.2' },
    });
    expect(manifest.artifacts).toEqual([{ path: 'make/zip/AIDraw.zip', bytes: 28, sha256: sha256('deterministic archive bytes\n') }]);
    expect(manifest.licenseReports.map((entry) => entry.path)).toEqual(['THIRD_PARTY_LICENSES.json', 'THIRD_PARTY_LICENSES.md']);
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(manifest);
  });

  it('rejects a dirty source before writing provenance', async () => {
    const root = await releaseWorkspace();
    await expect(captureReleaseProvenance({
      cwd: root,
      repository: { commit, status: ' M src/main.ts' },
      runtime: { nodeVersion: 'v24.14.0', npmVersion: '11.7.0', platform: 'win32', architecture: 'x64' },
    })).rejects.toThrow('requires a clean checkout');
  });

  it('rejects a checksum that does not match maker output', async () => {
    const root = await releaseWorkspace();
    await writeFile(join(root, 'out', 'SHA256SUMS-windows-x64.txt'), `${'0'.repeat(64)}  make/zip/AIDraw.zip\n`, 'utf8');
    await expect(capture(root)).rejects.toThrow('Checksum manifest hash mismatch');
  });

  it('passes exact artifact reproducibility while retaining environment differences as diagnostics', async () => {
    const root = await releaseWorkspace();
    const { manifest } = await capture(root);
    const rerun = copyManifest(manifest);
    rerun.capturedAt = '2026-08-12T00:00:00.000Z';
    rerun.runtime.osRelease = 'test-os-b';
    const report = compareReleaseProvenance(manifest, rerun, { comparedAt: '2026-08-13T00:00:00.000Z' });
    expect(report).toMatchObject({ result: 'PASS', platform: 'windows-x64', sourceIdentityEqual: true, toolchainIdentityEqual: true, artifactInventoryEqual: true, artifactCount: 1, differences: [] });
    expect(report.environmentDifferences.map((entry) => entry.field)).toEqual(['capturedAt', 'runtime.osRelease']);
  });

  it('fails on any source or artifact identity difference with exact field diagnostics', async () => {
    const root = await releaseWorkspace();
    const { manifest } = await capture(root);
    const rerun = copyManifest(manifest);
    rerun.candidate.commit = 'c'.repeat(40);
    rerun.artifacts[0].sha256 = 'd'.repeat(64);
    const report = compareReleaseProvenance(manifest, rerun, { comparedAt: '2026-08-13T00:00:00.000Z' });
    expect(report.result).toBe('FAIL');
    expect(report.sourceIdentityEqual).toBe(false);
    expect(report.artifactInventoryEqual).toBe(false);
    expect(report.differences.map((entry) => entry.field)).toEqual(['artifacts.make/zip/AIDraw.zip', 'candidate.commit']);
  });

  it('writes a hashed comparison report once and refuses to overwrite it', async () => {
    const root = await releaseWorkspace();
    const { manifest, outputPath: leftPath } = await capture(root);
    const rightPath = join(root, 'out', 'independent-provenance.json');
    const reportPath = join(root, 'out', 'comparison.json');
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(rightPath, serialized, 'utf8');
    const script = resolve('scripts/release-provenance.mjs');
    const result = await execute(process.execPath, [script, 'compare', `--left=${leftPath}`, `--right=${rightPath}`, `--output=${reportPath}`], { cwd: root, encoding: 'utf8', windowsHide: true });
    expect(result.stdout).toContain('AIDraw release reproducibility: PASS for windows-x64 (1 artifacts)');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { result: string; leftManifest: { sha256: string }; rightManifest: { sha256: string } };
    expect(report).toMatchObject({ result: 'PASS', leftManifest: { sha256: sha256(serialized) }, rightManifest: { sha256: sha256(serialized) } });
    await expect(execute(process.execPath, [script, 'compare', `--left=${leftPath}`, `--right=${rightPath}`, `--output=${reportPath}`], { cwd: root, encoding: 'utf8', windowsHide: true })).rejects.toMatchObject({ stderr: expect.stringContaining('EEXIST') });
  });

  it('wires provenance into native release production and artifact retention', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    const workflow = await readFile(resolve('.github/workflows/release.yml'), 'utf8');
    expect(packageJson.scripts.provenance).toBe('node scripts/release-provenance.mjs capture');
    expect(packageJson.scripts['reproducibility:compare']).toBe('node scripts/release-provenance.mjs compare');
    expect(packageJson.scripts['release:current']).toMatch(/npm run licenses && npm run provenance$/u);
    expect(workflow).toContain('AIDRAW_RELEASE_PLATFORM: ${{ matrix.platform }}');
    expect(workflow).toContain('out/RELEASE_PROVENANCE-${{ matrix.platform }}.json');
  });
});
