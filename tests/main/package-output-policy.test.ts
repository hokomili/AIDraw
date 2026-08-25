import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PACKAGE_GENERATION_MARKER,
  PACKAGE_GENERATION_POLICY,
  assertPackageOutputAvailable,
  readPackageGeneration,
  reservePackageGeneration,
  resolvePackageOutputRoot,
} from '../../scripts/package-output-policy.mjs';
import {
  PACKAGE_BUILD_INPUT_MANIFEST,
  capturePackageBuildInput,
  readPackageBuildInput,
} from '../../scripts/package-build-input.mjs';

const temporaryDirectories: string[] = [];

async function createWorkspace(prefix: string) {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(workspace);
  await writeFile(join(workspace, 'package.json'), '{"name":"aidraw","version":"0.1.0-alpha.1"}', 'utf8');
  return workspace;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('immutable package-output generations', () => {
  it('reserves one normal first generation and refuses to replace its package bytes', async () => {
    const workspace = await createWorkspace('aidraw-package-generation-');
    const canonicalWorkspace = await realpath(workspace);
    await expect(assertPackageOutputAvailable({ workspace, environment: {} })).resolves.toMatchObject({
      outputDirectory: join(canonicalWorkspace, 'out'),
      relativeOutputDirectory: 'out',
    });

    const reserved = await reservePackageGeneration({
      workspace,
      environment: {},
      platform: 'darwin',
      architecture: 'arm64',
    });
    expect(reserved.generation).toEqual({
      schemaVersion: 1,
      policy: PACKAGE_GENERATION_POLICY,
      package: { name: 'aidraw', version: '0.1.0-alpha.1' },
      target: { platform: 'darwin', architecture: 'arm64' },
      outputDirectory: 'out',
    });
    expect(JSON.parse(await readFile(join(workspace, 'out', PACKAGE_GENERATION_MARKER), 'utf8'))).toEqual(reserved.generation);

    const packageSentinel = join(workspace, 'out', 'AIDraw-darwin-arm64', 'AIDraw.app', 'sentinel');
    await mkdir(dirname(packageSentinel), { recursive: true });
    await writeFile(packageSentinel, 'mapped generation', 'utf8');
    await expect(reservePackageGeneration({
      workspace,
      environment: {},
      platform: 'darwin',
      architecture: 'arm64',
    })).rejects.toThrow('Refusing to replace package-generation root out');
    await expect(readFile(packageSentinel, 'utf8')).resolves.toBe('mapped generation');
  });

  it('admits only one concurrent reservation for an absent root', async () => {
    const workspace = await createWorkspace('aidraw-package-generation-race-');
    const options = { workspace, environment: {}, platform: 'linux', architecture: 'x64' };
    const results = await Promise.allSettled([
      reservePackageGeneration(options),
      reservePackageGeneration(options),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(readPackageGeneration(options)).resolves.toMatchObject({
      generation: { target: { platform: 'linux', architecture: 'x64' } },
    });
  });

  it('captures exact package source inputs, ignores documentation, and fails closed on post-capture source drift', async () => {
    const workspace = await createWorkspace('aidraw-package-build-input-');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await mkdir(join(workspace, 'docs'), { recursive: true });
    await writeFile(join(workspace, 'src', 'main.ts'), 'export const subject = 1;\n', 'utf8');
    await writeFile(join(workspace, 'docs', 'TESTING.md'), 'pre-build documentation\n', 'utf8');
    await reservePackageGeneration({ workspace, environment: {}, platform: 'darwin', architecture: 'arm64' });
    const captured = await capturePackageBuildInput({
      workspace,
      outputDirectory: join(workspace, 'out'),
      inputPaths: ['package.json', 'src'],
    });
    expect(captured.manifest.summary).toMatchObject({ files: 2, bytes: expect.any(Number), recordsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(JSON.parse(await readFile(join(workspace, 'out', PACKAGE_BUILD_INPUT_MANIFEST), 'utf8'))).toEqual(captured.manifest);
    await writeFile(join(workspace, 'docs', 'TESTING.md'), 'changed after build\n', 'utf8');
    await expect(readPackageBuildInput({
      workspace,
      outputDirectory: join(workspace, 'out'),
      inputPaths: ['package.json', 'src'],
    })).resolves.toMatchObject({ fileSha256: captured.fileSha256 });
    await writeFile(join(workspace, 'src', 'main.ts'), 'export const subject = 2;\n', 'utf8');
    await expect(readPackageBuildInput({
      workspace,
      outputDirectory: join(workspace, 'out'),
      inputPaths: ['package.json', 'src'],
    })).rejects.toThrow('source inputs changed after the package build began');
  });

  it('fails closed on malformed, duplicate, reordered, or forged build-input records', async () => {
    const workspace = await createWorkspace('aidraw-package-build-input-invalid-');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'main.ts'), 'export const subject = 1;\n', 'utf8');
    await reservePackageGeneration({ workspace, environment: {}, platform: 'darwin', architecture: 'arm64' });
    await capturePackageBuildInput({
      workspace,
      outputDirectory: join(workspace, 'out'),
      inputPaths: ['package.json', 'src'],
    });
    const manifestPath = join(workspace, 'out', PACKAGE_BUILD_INPUT_MANIFEST);
    const original = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      records: Array<{ path: string; bytes: number; sha256: string }>;
    };

    for (const records of [
      [{ ...original.records[0], path: '../package.json' }, ...original.records.slice(1)],
      [{ ...original.records[0], bytes: -1 }, ...original.records.slice(1)],
      [{ ...original.records[0], sha256: 'not-a-digest' }, ...original.records.slice(1)],
      [...original.records].reverse(),
      [original.records[0], original.records[0], ...original.records.slice(1)],
    ]) {
      const malformed = { ...original, records };
      await writeFile(manifestPath, `${JSON.stringify(malformed)}\n`, 'utf8');
      await expect(readPackageBuildInput({
        workspace,
        outputDirectory: join(workspace, 'out'),
        inputPaths: ['package.json', 'src'],
      })).rejects.toThrow(/invalid file record|summary does not match/u);
    }
  });

  it('keeps explicit run-owned prepared-package roots distinct', async () => {
    const workspace = await createWorkspace('aidraw-prepared-generations-');
    const canonicalWorkspace = await realpath(workspace);
    const preparedParent = join(workspace, 'test-results', 'prepared-packages');
    await mkdir(preparedParent, { recursive: true });
    const first = join(preparedParent, 'fnd05-run-one');
    const second = join(preparedParent, 'ux01-run-two');

    const [firstReservation, secondReservation] = await Promise.all([
      reservePackageGeneration({ workspace, outputDirectory: first, platform: 'darwin', architecture: 'arm64' }),
      reservePackageGeneration({ workspace, outputDirectory: second, platform: 'darwin', architecture: 'arm64' }),
    ]);

    expect(firstReservation.outputDirectory).toBe(join(canonicalWorkspace, 'test-results', 'prepared-packages', 'fnd05-run-one'));
    expect(secondReservation.outputDirectory).toBe(join(canonicalWorkspace, 'test-results', 'prepared-packages', 'ux01-run-two'));
    expect(firstReservation.generation.outputDirectory).toBe('test-results/prepared-packages/fnd05-run-one');
    expect(secondReservation.generation.outputDirectory).toBe('test-results/prepared-packages/ux01-run-two');
    expect(firstReservation.markerPath).not.toBe(secondReservation.markerPath);
  });

  it('rejects blank, workspace-root, outside-workspace, unsupported-target, and mismatched-marker inputs', async () => {
    const workspace = await createWorkspace('aidraw-package-generation-invalid-');
    expect(() => resolvePackageOutputRoot({ workspace, environment: { AIDRAW_FORGE_OUT_DIR: '   ' } })).toThrow('must name a nonempty');
    expect(() => resolvePackageOutputRoot({ workspace, outputDirectory: workspace })).toThrow('strict children');
    expect(() => resolvePackageOutputRoot({ workspace, outputDirectory: resolve(workspace, '..', 'outside') })).toThrow('strict children');
    await expect(reservePackageGeneration({ workspace, environment: {}, platform: 'darwin', architecture: 'ia32' })).rejects.toThrow('Unsupported AIDraw package architecture');

    await reservePackageGeneration({ workspace, environment: {}, platform: 'win32', architecture: 'x64' });
    const marker = join(workspace, 'out', PACKAGE_GENERATION_MARKER);
    const parsed = JSON.parse(await readFile(marker, 'utf8')) as { target: { architecture: string } };
    parsed.target.architecture = 'arm64';
    await writeFile(marker, `${JSON.stringify(parsed)}\n`, 'utf8');
    await expect(readPackageGeneration({ workspace, environment: {}, platform: 'win32', architecture: 'x64' })).rejects.toThrow('does not match');
  });

  it.skipIf(process.platform === 'win32')('does not follow a package-generation root symlink', async () => {
    const workspace = await createWorkspace('aidraw-package-generation-symlink-');
    const otherDirectory = join(workspace, 'other-generation');
    await mkdir(otherDirectory);
    await symlink(otherDirectory, join(workspace, 'out'));

    await expect(readPackageGeneration({
      workspace,
      environment: {},
      platform: 'darwin',
      architecture: 'arm64',
    })).rejects.toThrow('must be a real directory');
  });

  it('guards Forge before Packager overwrite and introduces no process or deletion authority', async () => {
    const [policy, forge, forgePackage, packager, verifier, prepare, checksums, licenses, provenance, packagedE2e, changelog, tracker, testing] = await Promise.all([
      readFile(resolve('scripts/package-output-policy.mjs'), 'utf8'),
      readFile(resolve('forge.config.ts'), 'utf8'),
      readFile(resolve('node_modules/@electron-forge/core/src/api/package.ts'), 'utf8'),
      readFile(resolve('node_modules/@electron/packager/dist/packager.js'), 'utf8'),
      readFile(resolve('scripts/verify-package.mjs'), 'utf8'),
      readFile(resolve('scripts/prepare-make-output.mjs'), 'utf8'),
      readFile(resolve('scripts/checksums.mjs'), 'utf8'),
      readFile(resolve('scripts/license-report.mjs'), 'utf8'),
      readFile(resolve('scripts/release-provenance.mjs'), 'utf8'),
      readFile(resolve('scripts/packaged-e2e-runtime.mjs'), 'utf8'),
      readFile(resolve('CHANGELOG.md'), 'utf8'),
      readFile(resolve('docs/FEATURE_TRACKER.md'), 'utf8'),
      readFile(resolve('docs/TESTING.md'), 'utf8'),
    ]);

    expect(policy).not.toMatch(/node:child_process|\b(?:execFile|spawn|kill|rm|rename|unlink)\s*\(/u);
    expect(policy).toContain("from 'node:fs/promises'");
    expect(policy).toContain("from 'node:path'");
    expect(forge).toContain('prePackage: async');
    expect(forge).toContain('await reservePackageGeneration');
    expect(forge).toContain('await capturePackageBuildInput');
    expect(forgePackage.indexOf("'prePackage'" )).toBeLessThan(forgePackage.indexOf('packager(packageOpts)'));
    expect(packager).toContain('await fs_extra_1.default.remove(outDir)');
    expect(verifier).toContain('await readPackageGeneration');
    expect(verifier.indexOf('await readPackageGeneration')).toBeLessThan(verifier.indexOf('let executable'));
    expect(verifier).toContain('await readPackageBuildInput');
    expect(prepare).not.toMatch(/\b(?:rm|rename|unlink)\s*\(/u);
    expect(prepare).toContain('await assertPackageOutputAvailable');
    expect(checksums).toContain('resolvePackageOutputRoot');
    expect(checksums).toContain('readPackageGeneration');
    expect(licenses).toContain('resolvePackageOutputRoot');
    expect(provenance).toContain('packageGeneration');
    expect(packagedE2e).toContain('environment.AIDRAW_E2E_OUT_DIR) ?? nonEmpty(environment.AIDRAW_FORGE_OUT_DIR)');
    expect(changelog).toContain('supported Forge package output a single-use generation');
    expect(tracker).toContain('window-chrome preparation/correction checkpoints are synchronized through base `0f42b227e6fe88c27e7bd1cdaccf3f4456f62984`');
    expect(tracker).toContain('supported package path separately refuses a same-root replacement');
    expect(testing).toContain('### Single-use package-generation roots');
  });
});
