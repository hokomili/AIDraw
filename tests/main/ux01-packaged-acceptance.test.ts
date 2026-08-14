import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertUx01ContentSizeRequest,
  assertUx01EvidenceRedacted,
  assertUx01SafeReporterEnvironment,
  inspectUx01EncryptedToken,
  parseUx01WindowMeasurement,
  parseUx01OwnedProcesses,
  redactUx01FailureText,
  resolveUx01PackagedAcceptance,
  UX01_PACKAGED_ASAR_HASH_ENV,
  UX01_PACKAGED_EXE_HASH_ENV,
  UX01_PACKAGED_FAILURE_ROOT_ENV,
  UX01_PACKAGED_FAILURE_PREFIX,
  UX01_PACKAGED_FILES,
  UX01_PACKAGED_PROFILE_ENV,
  UX01_PACKAGED_SCREENSHOTS,
} from '../../scripts/ux01-packaged-acceptance.mjs';
import { parseFeatureTracker } from '../../scripts/check-rc-readiness.mjs';

const digest = 'A'.repeat(64);

function environment(profile: string): NodeJS.ProcessEnv {
  const workspace = resolve('synthetic-workspace');
  const runId = profile.slice(profile.lastIndexOf('aidraw-e2e-ux01-density-') + 'aidraw-e2e-ux01-density-'.length);
  return {
    [UX01_PACKAGED_PROFILE_ENV]: profile,
    [UX01_PACKAGED_FAILURE_ROOT_ENV]: join(workspace, 'test-results', 'retained-failures', `${UX01_PACKAGED_FAILURE_PREFIX}${runId}`),
    [UX01_PACKAGED_EXE_HASH_ENV]: digest,
    [UX01_PACKAGED_ASAR_HASH_ENV]: digest.toLowerCase(),
  };
}

describe('UX-01 retained exact-package acceptance boundary', () => {
  it('records density r5 and separate window-chrome r1 without widening Working/P0', async () => {
    const [changelog, tracker, testing] = await Promise.all([
      readFile(resolve('CHANGELOG.md'), 'utf8'),
      readFile(resolve('docs/FEATURE_TRACKER.md'), 'utf8'),
      readFile(resolve('docs/TESTING.md'), 'utf8'),
    ]);
    const parsed = parseFeatureTracker(tracker);
    expect(parsed.errors).toEqual([]);
    const ux01 = parsed.items.find((item) => item.id === 'UX-01');
    expect(ux01).toMatchObject({ status: '🟢 Working', priority: 'P0' });
    const truth = ux01?.truth ?? '';
    for (const claim of [
      'exactly one wrapper invocation',
      '1/1 in 5.5 seconds',
      '1,520×940',
      '980×640',
      '860×550',
      '62/632/286',
      '12 pointer and 12 keyboard workflows',
      '11 sampled control floors',
      '138 px timeline',
      'revision 9→10',
      'four distinct screenshots',
      'zero external renderer requests',
      'must never be reused',
    ]) expect(truth).toContain(claim);
    for (const claim of [
      'window-chrome r1 `20260814t092808z-7ff773c-r1`',
      'failed **1/1 in 3.2 seconds** before native input',
      'incorrectly compared Quartz absolute `x` with Blink `screenX`',
      'immutable controller evidence',
      'wholly fresh package and separate native authority remain required',
    ]) expect(truth).toContain(claim);
    expect(truth).not.toContain('prepared but has not been packaged or executed');
    const lowercaseTruth = truth.toLowerCase();
    for (const nonclaim of [
      'native window-chrome pass',
      'customizable workspace persistence',
      'progressive-disclosure completion',
      '200% text',
      'assistive technology',
      'tablet/touchpad',
      'high-DPI/mixed-display',
      'smaller work areas',
      'broad polish',
      'rc',
      'stable-v1',
    ].map((value) => value.toLowerCase())) expect(lowercaseTruth).toContain(nonclaim);

    const changelogEntry = changelog.split(/\r?\n/u).find((line) => line.startsWith('- Complete one isolated retained UX-01 exact-package acceptance')) ?? '';
    expect(changelogEntry).toContain('R4 was consumed before output');
    expect(changelogEntry).toContain('r5 package from synchronized `c726d27` then ran exactly once and passed **1/1 in 5.5 seconds**');
    expect(changelogEntry).toContain('UX-01 remains Working/P0');
    expect(changelogEntry).toContain('not RC or stable-v1 evidence');

    const sectionStart = testing.indexOf('### UX-01 exact-package acceptance: immutable r1/r2/r3 failures, consumed r4, and narrow r5 PASS');
    const sectionEnd = testing.indexOf('\n## ', sectionStart + 1);
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    const acceptance = testing.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd);
    expect(acceptance).toContain('exactly **one** wrapper invocation');
    expect(acceptance).toContain('Evidence SHA-256 is `6ac62913c5028d56f3f705f331c1b597264d62eae40a77b429cb75a96fde1f09`');
    expect(acceptance).toContain('UX-01 therefore remains **Working/P0**');
    expect(acceptance).toContain('Never rerun, reuse, relaunch, rewrite, or delete r5');

    expect(changelog).not.toContain('A fresh secure package/profile/output is required for complete native acceptance');
    expect(truth).not.toContain('Still required before Verified: a fresh exact-package run');
    expect(acceptance).not.toContain('Any later run requires a freshly built secure package');
  });

  it('requires one immutable direct-child retained profile and exact package hashes', () => {
    const workspace = resolve('synthetic-workspace');
    const profile = join(workspace, 'test-results', 'retained', 'aidraw-e2e-ux01-density-20260814t120000z');
    const resolved = resolveUx01PackagedAcceptance({ workspacePath: workspace, environment: environment(profile) });
    expect(resolved).toMatchObject({ workspace, profile, runId: '20260814t120000z', executableSha256: digest, asarSha256: digest });
    expect(resolved.failureRoot).toBe(join(workspace, 'test-results', 'retained-failures', 'ux01-density-native-20260814t120000z'));
    expect(resolved.playwrightOutput).toBe(join(resolved.failureRoot, 'playwright'));
    expect(resolved.paths.ownerConnection).toBe(join(profile, UX01_PACKAGED_FILES.ownerConnection));
    expect(resolved.screenshots).toEqual(UX01_PACKAGED_SCREENSHOTS.map((file) => join(profile, file)));
    expect(new Set(resolved.screenshots).size).toBe(4);
  });

  it('fails closed for a default, nested, reused-looking, or underdeclared profile/hash contract', () => {
    const workspace = resolve('synthetic-workspace');
    const valid = join(workspace, 'test-results', 'retained', 'aidraw-e2e-ux01-density-20260814t120000z');
    expect(() => resolveUx01PackagedAcceptance({ workspacePath: workspace, environment: environment(join(workspace, 'Default')) })).toThrow(/direct child/);
    expect(() => resolveUx01PackagedAcceptance({ workspacePath: workspace, environment: environment(join(valid, 'nested')) })).toThrow(/direct child/);
    expect(() => resolveUx01PackagedAcceptance({ workspacePath: workspace, environment: environment(join(workspace, 'test-results', 'retained', 'aidraw-e2e-ux01-density-short')) })).toThrow(/8-80/);
    expect(() => resolveUx01PackagedAcceptance({ workspacePath: workspace, environment: { ...environment(valid), [UX01_PACKAGED_ASAR_HASH_ENV]: 'abc' } })).toThrow(/SHA-256/);
    expect(() => resolveUx01PackagedAcceptance({
      workspacePath: workspace,
      environment: { ...environment(valid), [UX01_PACKAGED_FAILURE_ROOT_ENV]: join(workspace, 'test-results', 'retained-failures', 'ux01-density-native-other-run') },
    })).toThrow(/matching fresh/);
    expect(() => resolveUx01PackagedAcceptance({ workspacePath: workspace, environment: {} })).toThrow(/is required/);
  });

  it('finds only processes carrying the exact run-owned profile', () => {
    const profile = resolve('test-results/retained/aidraw-e2e-ux01-density-20260814t120000z');
    const table = [
      ` 100 1 /candidate/AIDraw --user-data-dir=${profile}`,
      ` 101 100 /candidate/AIDraw Helper --type=renderer --user-data-dir=${profile}`,
      ` 102 100 /candidate/AIDraw Helper --type=gpu-process --user-data-dir=${profile}`,
      ` 103 100 /candidate/AIDraw Helper --type=renderer --user-data-dir=${profile}-sibling`,
      ' 999 1 /candidate/AIDraw --user-data-dir=/Users/example/Library/Application Support/AIDraw',
    ].join('\n');
    expect(parseUx01OwnedProcesses(table, profile)).toEqual([
      { pid: 100, ppid: 1, type: 'browser' },
      { pid: 101, ppid: 100, type: 'renderer' },
      { pid: 102, ppid: 100, type: 'gpu-process' },
    ]);
  });

  it('redacts live values and rejects credential-shaped retained evidence', () => {
    const secret = 'ux01-private-token-value';
    const failure = redactUx01FailureText(`Authorization: Bearer ${secret}; token=${secret}`, [secret]);
    expect(failure).not.toContain(secret);
    expect(assertUx01EvidenceRedacted(JSON.stringify({ status: 'failed', failure }), [secret])).toBe(true);
    expect(() => assertUx01EvidenceRedacted(JSON.stringify({ token: secret }), [secret])).toThrow(/credential-shaped/);
    expect(() => assertUx01EvidenceRedacted(JSON.stringify({ detail: `Bearer ${secret}` }), [secret])).toThrow(/credential-shaped/);
  });

  it('checks encrypted token shape without returning or reporting either token value', () => {
    const liveToken = 'synthetic-live-token-that-must-not-reach-playwright';
    expect(inspectUx01EncryptedToken({ version: 1, encryption: 'electron-safe-storage', value: 'encrypted-ciphertext' }, liveToken)).toEqual({
      version: 1,
      encryption: 'electron-safe-storage',
      encryptedValuePresent: true,
    });
    let message = '';
    try {
      inspectUx01EncryptedToken({ version: 1, encryption: 'electron-safe-storage', value: liveToken }, liveToken);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/expected encrypted safe-storage record/);
    expect(message).not.toContain(liveToken);
  });

  it('parses only trusted bounded renderer window geometry and bounded content requests', () => {
    const measurement = {
      location: 'aidraw://app/index.html',
      content: { width: 980, height: 640, devicePixelRatio: 2 },
      outer: { x: 50, y: 80, width: 996, height: 679 },
      screen: { width: 1_728, height: 1_117, availLeft: 0, availTop: 39, availWidth: 1_728, availHeight: 1_078 },
      layout: {
        root: { clientWidth: 980, clientHeight: 640, scrollWidth: 980, scrollHeight: 640 },
        body: { clientWidth: 980, clientHeight: 640, scrollWidth: 980, scrollHeight: 640 },
      },
    };
    expect(parseUx01WindowMeasurement(measurement)).toEqual(measurement);
    expect(() => parseUx01WindowMeasurement({ ...measurement, location: 'https://example.test/' })).toThrow(/exact trusted/);
    expect(() => parseUx01WindowMeasurement({ ...measurement, outer: { x: 50, y: 80, width: 979, height: 639 } })).toThrow(/invalid native/);
    expect(() => parseUx01WindowMeasurement({
      ...measurement,
      layout: { ...measurement.layout, root: { ...measurement.layout.root, scrollHeight: 639 } },
    })).toThrow(/invalid native/);
    expect(() => parseUx01WindowMeasurement({
      ...measurement,
      screen: { ...measurement.screen, availHeight: 1_118 },
    })).toThrow(/invalid native/);
    expect(assertUx01ContentSizeRequest(980, 640)).toEqual({ width: 980, height: 640 });
    expect(() => assertUx01ContentSizeRequest(979.5, 640)).toThrow(/bounded integer/);
    expect(() => assertUx01ContentSizeRequest(100, 100)).toThrow(/bounded integer/);
  });

  it('rejects ambient reporter outputs that can retain live credential-bearing diagnostics', () => {
    expect(assertUx01SafeReporterEnvironment({})).toBe(true);
    for (const name of ['PLAYWRIGHT_HTML_OUTPUT_DIR', 'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JUNIT_OUTPUT_FILE', 'PLAYWRIGHT_BLOB_OUTPUT_DIR']) {
      expect(() => assertUx01SafeReporterEnvironment({ [name]: '/tmp/unsafe' })).toThrow(new RegExp(name));
    }
  });

  it('uses Electron-supported renderer content resizing with four bounded screenshots and graceful-only cleanup', async () => {
    const [source, mainSource, styles, electronTypes] = await Promise.all([
      readFile(resolve('tests/e2e/editor-density.spec.ts'), 'utf8'),
      readFile(resolve('src/main/main.ts'), 'utf8'),
      readFile(resolve('src/renderer/styles.css'), 'utf8'),
      readFile(resolve('node_modules/electron/electron.d.ts'), 'utf8'),
    ]);
    expect(source).toContain("'--remote-debugging-address=127.0.0.1'");
    expect(electronTypes).toContain('Emitted when the page calls `window.moveTo`, `window.resizeTo` or related APIs.');
    expect(electronTypes).toContain('By default, this will move the window.');
    expect(electronTypes).toContain('requested new content bounds');
    expect(electronTypes).toContain("titleBarStyle?: ('default' | 'hidden' | 'hiddenInset' | 'customButtonsOnHover')");
    expect(mainSource).toContain('titleBarStyle: MACOS_EDITOR_WINDOW_CHROME.titleBarStyle');
    expect(mainSource).not.toContain('enableLargerThanScreen: true');
    expect(styles).toContain('html[data-native-titlebar="hidden-inset"] .topbar { -webkit-app-region: drag; }');
    expect(styles).toContain('--macos-traffic-light-inset: 84px;');
    expect(styles).toContain('-webkit-app-region: no-drag;');
    expect(source).toContain('window.resizeTo(size.width, size.height)');
    expect(source).toContain('width: window.outerWidth, height: window.outerHeight');
    expect(source).toContain('availHeight: browserScreen.availHeight');
    expect(source).toContain('x: window.screenX, y: window.screenY');
    expect(source).toContain('scrollHeight: document.documentElement.scrollHeight');
    expect(source).toContain('expectNoRootViewportOverflow(defaultWindow)');
    expect(source).toContain('expectOuterInsideWorkArea(defaultWindow)');
    expect(source).toContain('diagnostics: failureDiagnostics');
    expect(source).toContain("stage: 'long-document-menu-pointer-navigation'");
    expect(source).toContain("stage: 'long-document-menu-keyboard-navigation'");
    const openingFocusWait = source.indexOf('await expect(mapMenuItem).toBeFocused()');
    const homeKey = source.indexOf("await page.keyboard.press('Home')");
    const homeFocusWait = source.indexOf('await expect(firstMenuItem).toBeFocused()');
    const arrowDownKey = source.indexOf("await page.keyboard.press('ArrowDown')");
    const targetFocusWait = source.indexOf('await expect(illustrationMenuItem).toBeFocused()');
    expect([openingFocusWait, homeKey, homeFocusWait, arrowDownKey, targetFocusWait].every((index) => index >= 0)).toBe(true);
    expect([openingFocusWait, homeKey, homeFocusWait, arrowDownKey, targetFocusWait])
      .toEqual([...[openingFocusWait, homeKey, homeFocusWait, arrowDownKey, targetFocusWait]].sort((left, right) => left - right));
    expect(source).toContain('parseUx01WindowMeasurement');
    expect(source).not.toContain('Browser.getWindowForTarget');
    expect(source).not.toContain('Browser.setWindowBounds');
    expect(source).not.toContain('newCDPSession');
    expect(source).toContain("toMatchObject({ width: 1_520, height: 940 })");
    expect(source.match(/waitForContentSize\(page, 980, 640\)/g)).toHaveLength(2);
    expect(source).toContain("expect(compactState.columns).toBe('62px 632px 286px')");
    expect(source).toContain('expect(timelineBoundary.timeline.height).toBe(138)');
    expect(source).toContain("pointerActions.push('pixel draw inside canvas and inert click below 138px boundary')");
    expect(source).toContain("keyboardActions.push('inspector Add paint layer by Enter')");
    expect(source).toContain("pointerActions.push('map asset add and last tile-grid cell')");
    expect(source).toContain("signalOwner(profile, '--quit-engine')");
    expect(source).toContain('inspectUx01EncryptedToken(tokenFile, connection.token)');
    expect(source).not.toMatch(/expect\([^\n]*connection\.token/);
    expect(source.match(/screenshotRecord\(page, configured\.screenshots\[\d\]\)/g)).toHaveLength(4);
    expect(source).not.toContain('injectRendererRecoveryTestEvent');
    expect(source).not.toContain('Page.crash');
    expect(source).not.toMatch(/\.kill\s*\(/);
    expect(source).not.toMatch(/\brm\s*\(/);
  });

  it('runs only through the credential-safe user-only wrapper and dedicated list reporter', async () => {
    const [wrapper, config, playwrightArtifacts] = await Promise.all([
      readFile(resolve('scripts/run-ux01-density-acceptance.mjs'), 'utf8'),
      readFile(resolve('playwright.ux01.config.ts'), 'utf8'),
      readFile(resolve('node_modules/playwright/lib/index.js'), 'utf8'),
    ]);
    expect(wrapper).toContain('process.umask(0o077)');
    expect(wrapper).toContain("mode: 0o700");
    expect(wrapper).toContain("PLAYWRIGHT_NO_COPY_PROMPT: '1'");
    expect(wrapper).toContain("'--config=playwright.ux01.config.ts'");
    expect(wrapper).toContain('assertUx01SafeReporterEnvironment()');
    expect(wrapper).not.toMatch(/\.kill\s*\(/);
    expect(wrapper).not.toMatch(/\brm\s*\(/);
    expect(config).toContain("reporter: [['list']]");
    expect(config).toContain("trace: 'off'");
    expect(config).toContain("screenshot: 'off'");
    expect(config).toContain("video: 'off'");
    expect(config).toContain("process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1'");
    expect(config).not.toContain("['html'");
    expect(playwrightArtifacts).toMatch(/if \(process\.env\.PLAYWRIGHT_NO_COPY_PROMPT\)\s+return;/);
    expect(playwrightArtifacts).toContain('await page.ariaSnapshot({ mode: "ai"');
  });
});
