import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import {
  COMPLETE_AUDIT_COMMAND,
  EXPECTED_ELECTRON_VERSION,
  assertPackagedElectronVersion,
  inspectDependencySecurityPolicy,
} from '../../scripts/dependency-security.mjs';
import { planSafeDmg } from '../../scripts/safe-dmg-maker.mjs';

const execute = promisify(execFile);

async function currentPolicyInputs() {
  return {
    packageJson: JSON.parse(await readFile(resolve('package.json'), 'utf8')) as Record<string, unknown>,
    lockJson: JSON.parse(await readFile(resolve('package-lock.json'), 'utf8')) as Record<string, unknown>,
  };
}

describe('dependency and packaged-runtime security policy', () => {
  it('pins the reviewed Electron and patched build graph in both manifest and lock', async () => {
    const result = inspectDependencySecurityPolicy(await currentPolicyInputs());
    expect(result).toMatchObject({
      electron: '43.4.0',
      forge: '7.11.2',
      packager: '18.4.4',
      extractor: '@electron-internal/extract-zip@1.0.5',
      externalRegistryPackages: 701,
      repositoryWorkspaces: ['packages/canvas', 'packages/core'],
      overrides: {
        '@electron/rebuild': '4.2.0',
        'extract-zip': 'npm:@electron-internal/extract-zip@1.0.5',
        tar: '7.5.22',
        tmp: '0.2.7',
      },
    });
  });

  it('requires registry tarballs and SHA-512 integrity across every external non-link lock entry', async () => {
    const inputs = await currentPolicyInputs();
    expect(() => inspectDependencySecurityPolicy(inputs)).not.toThrow();

    const externalSource = structuredClone(inputs);
    ((externalSource.lockJson.packages as Record<string, unknown>)['node_modules/zod'] as Record<string, unknown>).resolved = 'git+https://example.invalid/zod.git';
    expect(() => inspectDependencySecurityPolicy(externalSource)).toThrow(/node_modules\/zod must resolve to an exact HTTPS registry\.npmjs\.org tarball/);

    const missingIntegrity = structuredClone(inputs);
    delete ((missingIntegrity.lockJson.packages as Record<string, unknown>)['node_modules/zod'] as Record<string, unknown>).integrity;
    expect(() => inspectDependencySecurityPolicy(missingIntegrity)).toThrow(/node_modules\/zod must retain a registry SHA-512 integrity value/);

    const malformedIntegrity = structuredClone(inputs);
    ((malformedIntegrity.lockJson.packages as Record<string, unknown>)['node_modules/zod'] as Record<string, unknown>).integrity = 'sha512-AAAA';
    expect(() => inspectDependencySecurityPolicy(malformedIntegrity)).toThrow(/node_modules\/zod must retain a registry SHA-512 integrity value/);

    const undeclaredWorkspace = structuredClone(inputs);
    (undeclaredWorkspace.lockJson.packages as Record<string, unknown>)['node_modules/undeclared-workspace'] = {
      resolved: 'packages/undeclared-workspace',
      link: true,
    };
    (undeclaredWorkspace.lockJson.packages as Record<string, unknown>)['packages/undeclared-workspace'] = { version: '1.0.0' };
    expect(() => inspectDependencySecurityPolicy(undeclaredWorkspace)).toThrow(/explicitly allowed repository workspace/);

    const disguisedWorkspace = structuredClone(inputs);
    ((disguisedWorkspace.lockJson.packages as Record<string, unknown>)['packages/core'] as Record<string, unknown>).resolved = 'https://registry.npmjs.org/@aidraw/core/-/core-0.1.0-alpha.1.tgz';
    ((disguisedWorkspace.lockJson.packages as Record<string, unknown>)['packages/core'] as Record<string, unknown>).integrity = 'sha512-AAAA';
    expect(() => inspectDependencySecurityPolicy(disguisedWorkspace)).toThrow(/must remain a repository workspace record/);
  });

  it('fails closed on an Electron downgrade, missing override, or forbidden build package', async () => {
    const inputs = await currentPolicyInputs();
    const downgraded = structuredClone(inputs);
    (downgraded.packageJson.devDependencies as Record<string, string>).electron = '43.2.0';
    expect(() => inspectDependencySecurityPolicy(downgraded)).toThrow(/Electron version must be exactly 43\.4\.0/);

    const missingOverride = structuredClone(inputs);
    delete (missingOverride.packageJson.overrides as Record<string, string>)['@electron/rebuild'];
    expect(() => inspectDependencySecurityPolicy(missingOverride)).toThrow(/override @electron\/rebuild must be exactly 4\.2\.0/);

    const forbidden = structuredClone(inputs);
    (forbidden.lockJson.packages as Record<string, unknown>)['node_modules/appdmg'] = { version: '0.6.6' };
    expect(() => inspectDependencySecurityPolicy(forbidden)).toThrow(/appdmg/);
  });

  it('keeps Forge 7 on its positional-hook Packager and substitutes only the extractor API', async () => {
    const packagerPackage = JSON.parse(await readFile(resolve('node_modules/@electron/packager/package.json'), 'utf8')) as { version: string };
    const extractorPackage = JSON.parse(
      await readFile(resolve('node_modules/extract-zip/package.json'), 'utf8'),
    ) as { name: string; version: string; description: string };
    expect(packagerPackage.version).toBe('18.4.4');
    expect(extractorPackage).toMatchObject({
      name: '@electron-internal/extract-zip',
      version: '1.0.5',
      description: expect.stringContaining('Drop-in replacement for extract-zip'),
    });

    const forgePackageSource = await readFile(resolve('node_modules/@electron-forge/core/dist/api/package.js'), 'utf8');
    const packagerHookSource = await readFile(resolve('node_modules/@electron/packager/dist/hooks.js'), 'utf8');
    const packagerUnzipSource = await readFile(resolve('node_modules/@electron/packager/dist/unzip.js'), 'utf8');
    expect(forgePackageSource).toContain('hidePromiseFromPromisify(async (buildPath, electronVersion, pPlatform, pArch, done)');
    expect(forgePackageSource).toContain('afterCopy: sequentialHooks(afterCopyHooks)');
    expect(packagerHookSource).toContain('promisify)(hookFn).apply(promisifyHooks, args)');
    expect(packagerUnzipSource).toContain('const extract_zip_1 = __importDefault(require("extract-zip"));');
    expect(packagerUnzipSource).toContain('(0, extract_zip_1.default)(zipPath, { dir: targetDir })');
  });

  it('requires the packaged Electron version file to match the locked runtime exactly', () => {
    expect(EXPECTED_ELECTRON_VERSION).toBe('43.4.0');
    expect(assertPackagedElectronVersion(EXPECTED_ELECTRON_VERSION, '43.4.0\n')).toBe('43.4.0');
    expect(() => assertPackagedElectronVersion(EXPECTED_ELECTRON_VERSION, '43.2.0')).toThrow(/expected 43\.4\.0/);
  });

  it('uses a path-safe native macOS DMG plan without the unpatched appdmg chain', async () => {
    const plan = planSafeDmg({ dir: '/tmp/package', makeDir: '/tmp/out/make', appName: 'AIDraw', configuredName: 'AIDraw' });
    expect(plan).toEqual({
      appPath: resolve('/tmp/package/AIDraw.app'),
      outputPath: resolve('/tmp/out/make/AIDraw.dmg'),
      volumeName: 'AIDraw',
    });
    expect(() => planSafeDmg({ dir: '/tmp/package', makeDir: '/tmp/out/make', appName: 'AIDraw', configuredName: '../escape' })).toThrow(/safe DMG artifact leaf/);
    const source = await readFile(resolve('scripts/safe-dmg-maker.mjs'), 'utf8');
    expect(source).toContain("execute('/usr/bin/ditto'");
    expect(source).toContain("execute('/usr/bin/hdiutil'");
    expect(source).not.toMatch(/appdmg|electron-installer-dmg|\bexec\(/);
  });

  it('gates CI and release on runtime, complete-tree, and registry-signature checks', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['security:verify']).toContain('security:audit:runtime');
    expect(packageJson.scripts['security:verify']).toContain('security:audit:complete');
    expect(packageJson.scripts['security:verify']).toContain('security:audit:signatures');
    expect(packageJson.scripts['security:audit:complete']).toBe(COMPLETE_AUDIT_COMMAND);
    for (const dependencyType of ['prod', 'dev', 'optional', 'peer']) {
      expect(packageJson.scripts['security:audit:complete']).toContain(`--include=${dependencyType}`);
    }
    expect(packageJson.scripts['security:audit:complete']).not.toContain('--omit=');
    expect(packageJson.scripts['release:current']).toContain('npm run security:verify');
    expect(packageJson.scripts['release:current']).not.toContain('audit --omit=dev');

    for (const workflow of ['ci.yml', 'release.yml']) {
      const source = await readFile(join(resolve('.github/workflows'), workflow), 'utf8');
      expect(source).toContain('npm run security:verify');
      expect(source).not.toContain('npm audit --omit=dev');
    }
  });

  it('keeps every dependency type included under ambient npm omit configuration', async () => {
    const npmExecPath = process.env.npm_execpath;
    if (!npmExecPath) throw new Error('npm_execpath is required to test the pinned npm audit configuration.');
    const includeArguments = ['prod', 'dev', 'optional', 'peer'].map((dependencyType) => `--include=${dependencyType}`);
    for (const ambientOmit of ['dev', 'optional', 'peer']) {
      const { stdout } = await execute(process.execPath, [npmExecPath, 'config', 'list', '--json', ...includeArguments], {
        env: { ...process.env, npm_config_omit: ambientOmit },
      });
      const config = JSON.parse(stdout) as { include?: string[]; omit?: string[] };
      expect(config.include).toEqual(['prod', 'dev', 'optional', 'peer']);
      expect(config.omit).toEqual([]);
    }
  });
});
