import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertPackagedE2eProfile,
  inspectPackagedMcpCredential,
  packagedE2ePrimaryModifier,
  packagedE2ePrimaryShortcut,
  packagedE2eSpawnOptions,
  PACKAGED_E2E_RETAINED_CASES,
  PACKAGED_E2E_RETAINED_TITLE_PATTERN,
  PACKAGED_E2E_SELF_CONTAINED_CASES,
  resolvePackagedE2eArtifact,
  resolvePackagedE2eSelection,
} from '../../scripts/packaged-e2e-runtime.mjs';

describe('packaged Level 2 platform routing', () => {
  it('accepts only the current active v2 encrypted credential envelope without leaking either value', () => {
    const liveToken = 'synthetic-live-token-that-must-not-reach-reporters';
    const encryptedValue = 'synthetic-encrypted-value-that-must-not-reach-reporters';
    expect(inspectPackagedMcpCredential({
      version: 2,
      status: 'active',
      encryption: 'electron-safe-storage',
      value: encryptedValue,
    }, liveToken)).toEqual({
      version: 2,
      status: 'active',
      encryption: 'electron-safe-storage',
      encryptedValuePresent: true,
    });

    for (const invalid of [
      { version: 1, encryption: 'electron-safe-storage', value: encryptedValue },
      { version: 2, status: 'revoked' },
      { version: 2, status: 'active', encryption: 'electron-safe-storage', value: '' },
      { version: 2, status: 'active', encryption: 'electron-safe-storage', value: liveToken },
      { version: 2, status: 'active', encryption: 'electron-safe-storage', value: encryptedValue, extra: true },
    ]) {
      let message = '';
      try {
        inspectPackagedMcpCredential(invalid, liveToken);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe('The packaged MCP credential is not the expected encrypted safe-storage record.');
      expect(message).not.toContain(liveToken);
      expect(message).not.toContain(encryptedValue);
    }
  });

  it('routes every current-package credential consumer through the shared v2 inspector', async () => {
    const consumers = [
      ['tests/e2e/security.spec.ts', 1],
      ['tests/e2e/mcp-discovery.spec.ts', 1],
      ['tests/e2e/utility-containment.spec.ts', 7],
      ['tests/e2e/editor.spec.ts', 1],
      ['tests/e2e/stale-renderer-recovery.spec.ts', 2],
      ['scripts/ux01-packaged-acceptance.mjs', 1],
      ['scripts/fnd05-packaged-acceptance.mjs', 1],
    ] as const;
    for (const [path, expectedCalls] of consumers) {
      const source = await readFile(resolve(path), 'utf8');
      expect(source.match(/inspectPackagedMcpCredential\(/g)).toHaveLength(expectedCalls);
      expect(source).not.toContain("['encryption', 'value', 'version']");
      expect(source).not.toContain("keys.join(',') !== 'encryption,value,version'");
    }
  });

  it('resolves the native Windows and macOS package layouts without changing the output override contract', () => {
    const workspacePath = resolve('synthetic-workspace');
    const windows = resolvePackagedE2eArtifact({ workspacePath, environment: { AIDRAW_E2E_OUT_DIR: 'out-windows' }, platform: 'win32', arch: 'x64' });
    expect(windows.executable).toBe(join(workspacePath, 'out-windows', 'AIDraw-win32-x64', 'AIDraw.exe'));
    expect(windows.asar).toBe(join(workspacePath, 'out-windows', 'AIDraw-win32-x64', 'resources', 'app.asar'));

    const mac = resolvePackagedE2eArtifact({ workspacePath, environment: { AIDRAW_E2E_OUT_DIR: 'out-macos' }, platform: 'darwin', arch: 'arm64' });
    expect(mac.executable).toBe(join(workspacePath, 'out-macos', 'AIDraw-darwin-arm64', 'AIDraw.app', 'Contents', 'MacOS', 'AIDraw'));
    expect(mac.asar).toBe(join(workspacePath, 'out-macos', 'AIDraw-darwin-arm64', 'AIDraw.app', 'Contents', 'Resources', 'app.asar'));

    const sharedGeneration = resolvePackagedE2eArtifact({ workspacePath, environment: { AIDRAW_FORGE_OUT_DIR: 'out-generation-3' }, platform: 'linux', arch: 'x64' });
    expect(sharedGeneration.outRoot).toBe(join(workspacePath, 'out-generation-3'));
    const explicitE2e = resolvePackagedE2eArtifact({ workspacePath, environment: { AIDRAW_FORGE_OUT_DIR: 'out-generation-3', AIDRAW_E2E_OUT_DIR: 'reviewed-package' }, platform: 'linux', arch: 'x64' });
    expect(explicitE2e.outRoot).toBe(join(workspacePath, 'reviewed-package'));
  });

  it('accepts an explicit macOS app or launcher while still deriving the matching ASAR', () => {
    const workspacePath = resolve('synthetic-workspace');
    const fromApp = resolvePackagedE2eArtifact({ workspacePath, environment: { AIDRAW_E2E_EXECUTABLE: 'candidate/AIDraw.app' }, platform: 'darwin', arch: 'arm64' });
    expect(fromApp.executable).toBe(join(workspacePath, 'candidate', 'AIDraw.app', 'Contents', 'MacOS', 'AIDraw'));
    expect(fromApp.asar).toBe(join(workspacePath, 'candidate', 'AIDraw.app', 'Contents', 'Resources', 'app.asar'));
  });

  it('keeps the clean Level 2 default self-contained and routes explicit retained work without skipping its guards', () => {
    const ordinary = resolvePackagedE2eSelection({}, []);
    expect(ordinary.suite).toBe('self-contained');
    expect(ordinary.grepInvert?.test('FND-09-UTILITY-CONTAINMENT exact package')).toBe(true);
    expect(PACKAGED_E2E_RETAINED_TITLE_PATTERN.test('opens the configurable New Document dialog')).toBe(false);
    expect(ordinary.grep).toBeUndefined();

    const retained = resolvePackagedE2eSelection({ AIDRAW_E2E_SUITE: 'retained' }, []);
    expect(retained.suite).toBe('retained');
    expect(retained.grep?.test('MCP-COLD-DISCOVERY exact package')).toBe(true);
    expect(retained.grep?.test('FND-05-STALE-RENDERER exact package')).toBe(true);
    expect(retained.grep?.test('FND-05-UNRESPONSIVE-RENDERER exact package')).toBe(true);
    expect(retained.grep?.test('UX-01-DENSITY exact package')).toBe(true);
    expect(retained.grep?.test('UX-01-WINDOW-CHROME exact package')).toBe(true);
    expect(retained.grepInvert).toBeUndefined();

    const historicalWindowsInvocation = resolvePackagedE2eSelection({ AIDRAW_E2E_FND09_UTILITY_PROFILE: 'E:\\AIDraw\\test-results\\retained\\aidraw-e2e-fnd09-utility-run' }, ['--grep=FND-09-UTILITY-CONTAINMENT']);
    expect(historicalWindowsInvocation.suite).toBe('retained');
    expect(historicalWindowsInvocation.configuredRetainedProfiles).toEqual(['AIDRAW_E2E_FND09_UTILITY_PROFILE']);
    expect(() => resolvePackagedE2eSelection({ AIDRAW_E2E_SUITE: 'self-contained', AIDRAW_E2E_FND09_UTILITY_PROFILE: 'configured' }, [])).toThrow(/cannot be combined/);
  });

  it('freezes the reviewed split at 27 clean-package cases plus 14 explicit retained cases', () => {
    expect(PACKAGED_E2E_SELF_CONTAINED_CASES).toBe(27);
    expect(PACKAGED_E2E_RETAINED_CASES).toBe(14);
    expect(PACKAGED_E2E_SELF_CONTAINED_CASES + PACKAGED_E2E_RETAINED_CASES).toBe(41);
  });

  it('keeps spawn behavior and primary shortcuts native on both desktop platforms', () => {
    expect(packagedE2eSpawnOptions({ stdio: 'ignore' }, 'win32').windowsHide).toBe(true);
    expect(packagedE2eSpawnOptions({ stdio: 'ignore' }, 'darwin').windowsHide).toBe(false);
    expect(packagedE2ePrimaryShortcut('N', 'win32')).toBe('Control+N');
    expect(packagedE2ePrimaryShortcut('N', 'darwin')).toBe('Meta+N');
    expect(packagedE2ePrimaryModifier('win32')).toBe('Control');
    expect(packagedE2ePrimaryModifier('darwin')).toBe('Meta');
  });

  it('allows only explicitly isolated aidraw-e2e profiles below test-results or the system temporary root', () => {
    const workspacePath = process.cwd();
    expect(assertPackagedE2eProfile(join(workspacePath, 'test-results', 'playwright-profiles', 'aidraw-e2e-case-123'), workspacePath)).toBe(resolve(workspacePath, 'test-results', 'playwright-profiles', 'aidraw-e2e-case-123'));
    expect(() => assertPackagedE2eProfile(join(workspacePath, 'user-profile'), workspacePath)).toThrow(/aidraw-e2e/);
    expect(() => assertPackagedE2eProfile(join(workspacePath, 'aidraw-e2e-global'), workspacePath)).toThrow(/outside test-results/);
  });
});
