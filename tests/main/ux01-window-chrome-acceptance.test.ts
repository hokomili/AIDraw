import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EDITOR_DENSITY, MACOS_EDITOR_WINDOW_CHROME } from '../../src/common/editor-layout';
import {
  assertUx01WindowBoundsMatchRenderer,
  assertUx01WindowInsideWorkArea,
  assertUx01WindowChromeSafeReporterEnvironment,
  buildUx01WindowChromeChildEnvironment,
  deriveUx01TrafficLightCenters,
  parseUx01WindowDriverAction,
  parseUx01WindowDriverInspection,
  parseUx01WindowDriverPreflight,
  resolveUx01WindowChromeAcceptance,
  UX01_WINDOW_CHROME_ASAR_HASH_ENV,
  UX01_WINDOW_CHROME_DISCOVERY_ENV,
  UX01_WINDOW_CHROME_EXE_HASH_ENV,
  UX01_WINDOW_CHROME_FAILURE_PREFIX,
  UX01_WINDOW_CHROME_FAILURE_ROOT_ENV,
  UX01_WINDOW_CHROME_PACKAGE_PREFIX,
  UX01_WINDOW_CHROME_PROFILE_ENV,
  UX01_WINDOW_CHROME_PROFILE_PREFIX,
  UX01_WINDOW_CHROME_SCENARIO,
  UX01_WINDOW_CHROME_UNSAFE_REPORT_ENVIRONMENTS,
} from '../../scripts/ux01-window-chrome-acceptance.mjs';
import { parseFeatureTracker } from '../../scripts/check-rc-readiness.mjs';

const execute = promisify(execFile);
const digest = 'A'.repeat(64);

function environment(workspace: string, runId: string): NodeJS.ProcessEnv {
  return {
    AIDRAW_E2E_OUT_DIR: join(workspace, 'test-results', 'prepared-packages', `${UX01_WINDOW_CHROME_PACKAGE_PREFIX}${runId}`),
    [UX01_WINDOW_CHROME_PROFILE_ENV]: join(workspace, 'test-results', 'retained', `${UX01_WINDOW_CHROME_PROFILE_PREFIX}${runId}`),
    [UX01_WINDOW_CHROME_FAILURE_ROOT_ENV]: join(workspace, 'test-results', 'retained-failures', `${UX01_WINDOW_CHROME_FAILURE_PREFIX}${runId}`),
    [UX01_WINDOW_CHROME_EXE_HASH_ENV]: digest,
    [UX01_WINDOW_CHROME_ASAR_HASH_ENV]: digest.toLowerCase(),
  };
}

function inspection(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    pid: 100,
    postEventAccess: true,
    windows: [{ windowId: 200, onScreen: true, bounds: { x: 30, y: 40, width: 1_520, height: 940 } }],
    buttonMetrics: {
      close: { width: 14, height: 14 },
      minimize: { offsetX: 20, width: 14, height: 14 },
      zoom: { offsetX: 40, width: 14, height: 14 },
    },
    ...overrides,
  };
}

describe('UX-01 exact-package native window-chrome preparation', () => {
  it('correlates one fresh prepared package, profile, failure root, selector, and exact hashes', () => {
    const workspace = resolve('synthetic-workspace');
    const runId = '20260814t120000z-10b5379-r1';
    const configured = resolveUx01WindowChromeAcceptance({ workspacePath: workspace, environment: environment(workspace, runId) });
    expect(configured).toMatchObject({
      workspace,
      runId,
      packageRoot: join(workspace, 'test-results', 'prepared-packages', `${UX01_WINDOW_CHROME_PACKAGE_PREFIX}${runId}`),
      profile: join(workspace, 'test-results', 'retained', `${UX01_WINDOW_CHROME_PROFILE_PREFIX}${runId}`),
      failureRoot: join(workspace, 'test-results', 'retained-failures', `${UX01_WINDOW_CHROME_FAILURE_PREFIX}${runId}`),
      executableSha256: digest,
      asarSha256: digest,
    });
    expect(configured.driverSource).toBe(join(workspace, 'scripts', 'macos-window-chrome-driver.m'));
    expect(configured.driverExecutable).toBe(join(configured.failureRoot, 'macos-window-chrome-driver'));
    expect(configured.playwrightOutput).toBe(join(configured.failureRoot, 'playwright'));
    expect(UX01_WINDOW_CHROME_SCENARIO).toContain('native traffic lights and drag/no-drag routing');
  });

  it('fails closed on uncorrelated or nested roots, reused-looking IDs, and wrong hashes', () => {
    const workspace = resolve('synthetic-workspace');
    const runId = '20260814t120000z-10b5379-r1';
    const valid = environment(workspace, runId);
    expect(() => resolveUx01WindowChromeAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [UX01_WINDOW_CHROME_PROFILE_ENV]: join(String(valid[UX01_WINDOW_CHROME_PROFILE_ENV]), 'nested') },
    })).toThrow(/direct child/);
    expect(() => resolveUx01WindowChromeAcceptance({
      workspacePath: workspace,
      environment: { ...valid, AIDRAW_E2E_OUT_DIR: join(workspace, 'test-results', 'prepared-packages', `${UX01_WINDOW_CHROME_PACKAGE_PREFIX}different-run`) },
    })).toThrow(/matching fresh/);
    expect(() => resolveUx01WindowChromeAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [UX01_WINDOW_CHROME_FAILURE_ROOT_ENV]: join(workspace, 'test-results', 'retained-failures', `${UX01_WINDOW_CHROME_FAILURE_PREFIX}different-run`) },
    })).toThrow(/matching fresh/);
    expect(() => resolveUx01WindowChromeAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [UX01_WINDOW_CHROME_PROFILE_ENV]: join(workspace, 'test-results', 'retained', `${UX01_WINDOW_CHROME_PROFILE_PREFIX}short`) },
    })).toThrow(/8-80/);
    expect(() => resolveUx01WindowChromeAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [UX01_WINDOW_CHROME_ASAR_HASH_ENV]: 'abc' },
    })).toThrow(/SHA-256/);
    expect(() => resolveUx01WindowChromeAcceptance({ workspacePath: workspace, environment: {} })).toThrow(/is required/);
  });

  it('parses one exact-owner Quartz window and derives bounded standard traffic-light centers', () => {
    expect(parseUx01WindowDriverPreflight({ version: 1, postEventAccess: true })).toEqual({ version: 1, postEventAccess: true });
    const parsed = parseUx01WindowDriverInspection(inspection());
    expect(parsed).toEqual(inspection());
    expect(MACOS_EDITOR_WINDOW_CHROME.trafficLightPosition).toEqual({ x: 12, y: 11 });
    const centers = deriveUx01TrafficLightCenters(parsed.buttonMetrics, {
      trafficLightPosition: MACOS_EDITOR_WINDOW_CHROME.trafficLightPosition,
      trafficLightReservedWidth: MACOS_EDITOR_WINDOW_CHROME.trafficLightReservedWidth,
      topbarHeight: EDITOR_DENSITY.topbarHeight,
    });
    expect(centers).toEqual({
      close: { x: 19, y: 18 },
      minimize: { x: 39, y: 18 },
      zoom: { x: 59, y: 18 },
    });
    expect(assertUx01WindowBoundsMatchRenderer(parsed.windows[0], { x: 30, y: 40, width: 1_520, height: 940 })).toBe(true);
    expect(assertUx01WindowInsideWorkArea({
      outer: { x: 30, y: 40, width: 1_520, height: 940 },
      screen: { availLeft: 0, availTop: 0, availWidth: 1_920, availHeight: 1_080 },
    })).toBe(true);
    expect(parseUx01WindowDriverAction({ version: 1, action: 'drag', posted: true, pid: 100, windowId: 200 })).toEqual({
      version: 1, action: 'drag', posted: true, pid: 100, windowId: 200,
    });
    expect(parseUx01WindowDriverAction({ version: 1, action: 'option-click', posted: true, pid: 100, windowId: 200 })).toEqual({
      version: 1, action: 'option-click', posted: true, pid: 100, windowId: 200,
    });
  });

  it('rejects ambiguous windows, malformed metrics/actions, and renderer/native identity drift', () => {
    expect(() => parseUx01WindowDriverPreflight({ version: 1, postEventAccess: 'yes' })).toThrow(/preflight contract/);
    expect(() => parseUx01WindowDriverInspection(inspection({ windows: [inspection().windows[0], { ...inspection().windows[0], windowId: 201 }] }))).toThrow(/ambiguous/);
    expect(() => parseUx01WindowDriverInspection(inspection({ buttonMetrics: { ...inspection().buttonMetrics, zoom: { offsetX: 100, width: 14, height: 14 } } }))).toThrow(/zoom button offset/);
    expect(() => deriveUx01TrafficLightCenters(inspection().buttonMetrics, {
      trafficLightPosition: { x: 60, y: 13 }, trafficLightReservedWidth: 84, topbarHeight: 56,
    })).toThrow(/do not fit/);
    expect(() => parseUx01WindowDriverAction({ version: 1, action: 'click', posted: false, pid: 100, windowId: 200 })).toThrow(/did not confirm/);
    expect(() => parseUx01WindowDriverAction({ version: 1, action: 'fullscreen-click', posted: true, pid: 100, windowId: 200 })).toThrow(/did not confirm/);
    const parsed = parseUx01WindowDriverInspection(inspection());
    expect(() => assertUx01WindowBoundsMatchRenderer(parsed.windows[0], { x: 35, y: 40, width: 1_520, height: 940 })).toThrow(/native x/);
    expect(() => assertUx01WindowBoundsMatchRenderer(parsed.windows[0], { x: 30, y: 40, width: 1_520, height: 940 }, 20)).toThrow(/tolerance/);
    expect(() => assertUx01WindowInsideWorkArea({
      outer: { x: 30, y: 40, width: 1_900, height: 1_050 },
      screen: { availLeft: 0, availTop: 0, availWidth: 1_920, availHeight: 1_080 },
    })).toThrow(/outside the renderer-reported work area/);
  });

  it('rejects ambient reporter outputs that could retain local credentials', () => {
    expect(assertUx01WindowChromeSafeReporterEnvironment({})).toBe(true);
    for (const name of ['PLAYWRIGHT_HTML_OUTPUT_DIR', 'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JUNIT_OUTPUT_FILE', 'PLAYWRIGHT_BLOB_OUTPUT_DIR']) {
      expect(() => assertUx01WindowChromeSafeReporterEnvironment({ [name]: '/tmp/unsafe' })).toThrow(new RegExp(name));
    }
  });

  it('passes only explicit system and run identity values to compiler, controller, and package children', () => {
    const child = buildUx01WindowChromeChildEnvironment({
      HOME: '/Users/example',
      PATH: '/usr/bin:/bin',
      AIDRAW_E2E_OUT_DIR: '/workspace/test-results/prepared-packages/ux01-window-chrome-run-id',
      [UX01_WINDOW_CHROME_PROFILE_ENV]: '/workspace/test-results/retained/aidraw-e2e-ux01-window-chrome-run-id',
      [UX01_WINDOW_CHROME_FAILURE_ROOT_ENV]: '/workspace/test-results/retained-failures/ux01-window-chrome-native-run-id',
      [UX01_WINDOW_CHROME_EXE_HASH_ENV]: digest,
      [UX01_WINDOW_CHROME_ASAR_HASH_ENV]: digest,
      OPENAI_API_KEY: 'must-not-pass',
      ANTHROPIC_API_KEY: 'must-not-pass',
      SSH_AUTH_SOCK: '/must/not/pass',
      NODE_OPTIONS: '--inspect',
      PLAYWRIGHT_JSON_OUTPUT_FILE: '/must/not/pass',
    });
    expect(child).toMatchObject({
      HOME: '/Users/example',
      PATH: '/usr/bin:/bin',
      AIDRAW_E2E_UX01_WINDOW_CHROME_WRAPPER: '1',
      PLAYWRIGHT_NO_COPY_PROMPT: '1',
    });
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'PLAYWRIGHT_JSON_OUTPUT_FILE']) {
      expect(child).not.toHaveProperty(name);
    }
  });

  it('uses only public exact-PID macOS input/window APIs and no production testing backdoor', async () => {
    const [driver, wrapper, config, spec, main, preload, styles, electronTypes] = await Promise.all([
      readFile(resolve('scripts/macos-window-chrome-driver.m'), 'utf8'),
      readFile(resolve('scripts/run-ux01-window-chrome-acceptance.mjs'), 'utf8'),
      readFile(resolve('playwright.ux01-window-chrome.config.ts'), 'utf8'),
      readFile(resolve('tests/e2e/editor-window-chrome.spec.ts'), 'utf8'),
      readFile(resolve('src/main/main.ts'), 'utf8'),
      readFile(resolve('src/preload/preload.ts'), 'utf8'),
      readFile(resolve('src/renderer/styles.css'), 'utf8'),
      readFile(resolve('node_modules/electron/electron.d.ts'), 'utf8'),
    ]);
    for (const marker of [
      'CGWindowListCopyWindowInfo', 'kCGWindowOwnerPID', 'kCGWindowNumber', 'CGPreflightPostEventAccess',
      'CGEventCreateMouseEvent', 'CGEventSetFlags', 'kCGEventFlagMaskAlternate', 'CGEventPostToPid',
      'standardWindowButton:NSWindowCloseButton',
      'standardWindowButton:NSWindowMiniaturizeButton', 'standardWindowButton:NSWindowZoomButton',
    ]) expect(driver).toContain(marker);
    expect(driver.match(/CGPreflightPostEventAccess/g)?.length).toBeGreaterThanOrEqual(3);
    expect(driver.indexOf('[command isEqualToString:@"preflight"]')).toBeLessThan(driver.indexOf('ParseInteger(argv[2], @"owner PID"'));
    expect(driver).not.toContain('CGRequestPostEventAccess');
    expect(driver).not.toContain('AXUIElement');
    expect(driver).not.toContain('CGEventPost(');
    expect(driver).not.toMatch(/\bkill\s*\(/);
    expect(driver).not.toMatch(/\bsignal\s*\(/);

    expect(wrapper).toContain("spawn('/usr/bin/xcrun'");
    expect(wrapper).toContain("'ApplicationServices'");
    expect(wrapper).toContain('process.umask(0o077)');
    expect(wrapper).toContain('inspectPackagedSecurity');
    expect(wrapper).toContain("mode: 0o700");
    expect(wrapper).toContain("'--config=playwright.ux01-window-chrome.config.ts'");
    expect(wrapper).toContain('assertUx01WindowChromeSafeReporterEnvironment()');
    expect(wrapper).toContain('buildUx01WindowChromeChildEnvironment()');
    expect(wrapper).toContain("execute(configured.driverExecutable, ['preflight']");
    expect(wrapper).toContain('parseUx01WindowDriverPreflight(rawPreflight)');
    expect(wrapper).toContain('if (!preflight.postEventAccess)');
    expect(wrapper).toContain('the exact package and profile were not launched or created');
    expect(wrapper).toContain('env: childEnvironment');
    expect(wrapper).not.toMatch(/\.kill\s*\(/);
    expect(wrapper).not.toMatch(/\brm\s*\(/);
    expect(wrapper).toContain('shell: false');
    expect(wrapper).not.toContain('mkdir(configured.profile');
    const permissionPreflight = wrapper.indexOf("execute(configured.driverExecutable, ['preflight']");
    const playwrightLaunch = wrapper.indexOf("const child = spawn(process.execPath");
    expect(permissionPreflight).toBeGreaterThan(-1);
    expect(playwrightLaunch).toBeGreaterThan(permissionPreflight);
    expect(wrapper).not.toContain('CGRequestPostEventAccess');

    expect(config).toContain("reporter: [['list']]");
    expect(config).toContain("trace: 'off'");
    expect(config).toContain("screenshot: 'off'");
    expect(config).toContain("video: 'off'");
    expect(config).toContain("AIDRAW_E2E_UX01_WINDOW_CHROME_WRAPPER !== '1'");
    expect(config).not.toContain("['html'");

    const orderedMarkers = [
      "stage: 'interactive-no-drag-click'",
      "stage: 'interactive-no-drag-gesture'",
      "stage: 'intended-app-region-drag'",
      "stage: 'native-option-zoom-toggle'",
      "stage: 'native-minimize-and-show'",
      "stage: 'native-close-and-show'",
    ].map((marker) => spec.indexOf(marker));
    expect(orderedMarkers.every((index) => index >= 0)).toBe(true);
    expect(orderedMarkers).toEqual([...orderedMarkers].sort((left, right) => left - right));
    expect(spec).toContain("signalOwner(configured.profile, '--show')");
    expect(spec).toContain("signalOwner(profile, '--quit-engine')");
    expect(spec).toContain("getPropertyValue('-webkit-app-region')");
    expect(spec).toContain("expect(targets.topbarRegion).toBe('drag')");
    expect(spec).toContain("expect(targets.buttonRegion).toBe('no-drag')");
    expect(spec).toContain('initialInspection.postEventAccess');
    expect(spec).toContain("'option-click'");
    expect(spec).toContain('assertUx01WindowInsideWorkArea(zoomedMeasurement)');
    expect(spec).toContain("action: 'native green-button Option-click'");
    expect(spec).not.toContain("stage: 'native-zoom-toggle'");
    expect(spec).toContain('assertUx01WindowBoundsMatchRenderer');
    expect(spec).not.toContain('newCDPSession');
    expect(spec).not.toContain('Browser.getWindowForTarget');
    expect(spec).not.toContain('Browser.setWindowBounds');
    expect(spec).not.toContain('--write-mcp-connection');
    expect(spec).not.toContain('inspectUx01EncryptedToken');
    expect(spec).not.toMatch(/\._(?:channel|connection|transport)\b/);
    expect(spec).not.toContain('AXUIElement');
    expect(spec).not.toMatch(/\.kill\s*\(/);
    expect(spec).not.toMatch(/\brm\s*\(/);

    expect(main).toContain('trafficLightPosition: MACOS_EDITOR_WINDOW_CHROME.trafficLightPosition');
    expect(main).not.toContain('UX01_WINDOW_CHROME_SCENARIO');
    expect(preload).not.toContain('UX01_WINDOW_CHROME_SCENARIO');
    expect(styles).toContain('html[data-native-titlebar="hidden-inset"] .topbar { -webkit-app-region: drag; }');
    expect(styles).toContain('-webkit-app-region: no-drag;');
    expect(electronTypes).toContain('trafficLightPosition?: Point;');
    expect(electronTypes).toContain('Set a custom position for the traffic light buttons');
  });

  it('discovers exactly the dedicated window-chrome selector without creating any run root', async () => {
    const workspace = process.cwd();
    const runId = 'source-list-discovery-fixture';
    const configuredEnvironment = environment(workspace, runId);
    const roots = [
      configuredEnvironment.AIDRAW_E2E_OUT_DIR!,
      configuredEnvironment[UX01_WINDOW_CHROME_PROFILE_ENV]!,
      configuredEnvironment[UX01_WINDOW_CHROME_FAILURE_ROOT_ENV]!,
    ];
    for (const path of roots) expect(await access(path).then(() => true, () => false), `${path} must start absent`).toBe(false);
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      ...configuredEnvironment,
      [UX01_WINDOW_CHROME_DISCOVERY_ENV]: '1',
      PLAYWRIGHT_NO_COPY_PROMPT: '1',
    };
    delete childEnvironment.AIDRAW_E2E_LAUNCH_CONTEXT;
    for (const name of UX01_WINDOW_CHROME_UNSAFE_REPORT_ENVIRONMENTS) delete childEnvironment[name];
    const playwrightCli = resolve('node_modules', '@playwright', 'test', 'cli.js');
    const { stdout, stderr } = await execute(process.execPath, [
      playwrightCli,
      'test',
      '--config=playwright.ux01-window-chrome.config.ts',
      '--list',
      '--grep',
      UX01_WINDOW_CHROME_SCENARIO,
    ], { cwd: workspace, env: childEnvironment, maxBuffer: 4 * 1024 * 1024 });
    const listing = `${stdout}\n${stderr}`;
    expect(listing.split(UX01_WINDOW_CHROME_SCENARIO)).toHaveLength(2);
    expect(listing).toContain('Total: 1 test in 1 file');
    for (const path of roots) expect(await access(path).then(() => true, () => false), `${path} must remain absent`).toBe(false);
  });

  it('keeps UX-01 Working/P0 and records preparation without promoting an unexecuted native claim', async () => {
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
      'native traffic-light/top-bar route is prepared but has not been packaged or executed',
      'exact-PID action',
      'no Accessibility API',
      'separate native authority',
    ]) expect(truth).toContain(claim);
    expect(truth).toContain('Secure r5');
    expect(truth).toContain('passed **1/1 in 5.5 seconds**');
    expect(truth).not.toContain('native traffic-light/top-bar PASS');

    const section = testing.slice(testing.indexOf('### UX-01 native window-chrome acceptance preparation'));
    expect(section).toContain(UX01_WINDOW_CHROME_SCENARIO);
    expect(section).toContain('source/headless preparation only');
    expect(section).toContain('has not been packaged or executed');
    expect(section).toContain('before the test can create its profile');
    expect(section).toContain('fails closed unless it returns true');
    expect(section).toContain('rechecks that permission immediately before every exact-PID action');
    expect(section).toContain('12×11 px');
    expect(section).toContain('without moving the user-visible controls');
    expect(section).toContain('Option-click');
    expect(section).toContain('instead of entering fullscreen');
    expect(section).toContain('no Accessibility API');
    expect(changelog).toContain('Prepare a separate one-shot UX-01 native window-chrome acceptance');
    expect(changelog).toContain('before the packaged app launches or its profile is created');
    expect(changelog).toContain('does not itself earn a native PASS');
  });
});
