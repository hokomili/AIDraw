import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EDITOR_DENSITY, MACOS_EDITOR_WINDOW_CHROME } from '../../src/common/editor-layout';
import {
  assertUx01DecoratedFrameRelationStable,
  assertUx01WindowInsideWorkArea,
  assertUx01WindowMovedWithinCoordinateSpaces,
  assertUx01WindowStationaryWithinCoordinateSpaces,
  assertUx01WindowChromeSafeReporterEnvironment,
  buildUx01WindowChromeChildEnvironment,
  createUx01WindowGeometryDiagnostics,
  deriveUx01DecoratedFrameRelation,
  deriveUx01TrafficLightCenters,
  mapUx01FramePointToQuartzLocal,
  mapUx01RendererHitTargetToQuartzLocal,
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
  UX01_WINDOW_COORDINATE_SPACES,
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
    windows: [{ windowId: 200, onScreen: true, bounds: { x: 203, y: 32, width: 1_514, height: 936 } }],
    buttonMetrics: {
      close: { width: 14, height: 14 },
      minimize: { offsetX: 20, width: 14, height: 14 },
      zoom: { offsetX: 40, width: 14, height: 14 },
    },
    ...overrides,
  };
}

function rendererMeasurement(overrides: Record<string, unknown> = {}) {
  return {
    location: 'aidraw://app/index.html',
    content: { width: 1_520, height: 940, devicePixelRatio: 1 },
    outer: { x: 200, y: 30, width: 1_520, height: 940 },
    screen: { width: 1_920, height: 1_080, availLeft: 0, availTop: 30, availWidth: 1_920, availHeight: 960 },
    layout: {
      root: { clientWidth: 1_520, clientHeight: 940, scrollWidth: 1_520, scrollHeight: 940 },
      body: { clientWidth: 1_520, clientHeight: 940, scrollWidth: 1_520, scrollHeight: 940 },
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

  it('parses one exact-owner Quartz window and maps native-frame controls through the observed decorated-frame relation', () => {
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
    const relation = deriveUx01DecoratedFrameRelation(parsed.windows[0], rendererMeasurement());
    expect(relation).toMatchObject({
      model: 'dynamic-contained-quartz-visible-frame',
      windowId: 200,
      nativeBounds: { x: 203, y: 32, width: 1_514, height: 936 },
      rendererOuter: { x: 200, y: 30, width: 1_520, height: 940 },
      insets: { left: 3, top: 2, right: 3, bottom: 2 },
      mappingUncertainty: { x: 2, y: 2, source: 'exact-driver-current-bounds-reinspection' },
    });
    expect(mapUx01FramePointToQuartzLocal(relation, centers.close)).toEqual({ x: 16, y: 16 });
    expect(mapUx01RendererHitTargetToQuartzLocal(relation, {
      region: 'no-drag',
      point: { x: 1_400, y: 28 },
      safeRect: { x: 1_396, y: 24, width: 8, height: 8 },
    })).toMatchObject({
      region: 'no-drag',
      point: { x: 1_397, y: 26 },
      rendererPoint: { x: 1_400, y: 28 },
    });
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

  it('rejects ambiguous windows, malformed metrics/actions, and unsafe decorated-frame mappings', () => {
    expect(() => parseUx01WindowDriverPreflight({ version: 1, postEventAccess: 'yes' })).toThrow(/preflight contract/);
    expect(() => parseUx01WindowDriverInspection(inspection({ windows: [inspection().windows[0], { ...inspection().windows[0], windowId: 201 }] }))).toThrow(/ambiguous/);
    expect(() => parseUx01WindowDriverInspection(inspection({ buttonMetrics: { ...inspection().buttonMetrics, zoom: { offsetX: 100, width: 14, height: 14 } } }))).toThrow(/zoom button offset/);
    expect(() => deriveUx01TrafficLightCenters(inspection().buttonMetrics, {
      trafficLightPosition: { x: 60, y: 13 }, trafficLightReservedWidth: 84, topbarHeight: 56,
    })).toThrow(/do not fit/);
    expect(() => parseUx01WindowDriverAction({ version: 1, action: 'click', posted: false, pid: 100, windowId: 200 })).toThrow(/did not confirm/);
    expect(() => parseUx01WindowDriverAction({ version: 1, action: 'fullscreen-click', posted: true, pid: 100, windowId: 200 })).toThrow(/did not confirm/);
    const parsed = parseUx01WindowDriverInspection(inspection());
    expect(() => deriveUx01DecoratedFrameRelation(parsed.windows[0], rendererMeasurement({
      content: { width: 1_520, height: 940, devicePixelRatio: 2 },
    }))).toThrow(/DPR-1/);
    expect(() => deriveUx01DecoratedFrameRelation(parsed.windows[0], rendererMeasurement({
      screen: { width: 1_920, height: 1_080, availLeft: 1_920, availTop: 30, availWidth: 1_920, availHeight: 960 },
    }))).toThrow(/main-display/);
    expect(() => deriveUx01DecoratedFrameRelation(parsed.windows[0], rendererMeasurement({
      content: { width: 1_519, height: 940, devicePixelRatio: 1 },
    }))).toThrow(/viewport does not cover/);
    expect(() => deriveUx01DecoratedFrameRelation(parsed.windows[0], rendererMeasurement({
      layout: {
        root: { clientWidth: 1_520, clientHeight: 940, scrollWidth: 1_521, scrollHeight: 940 },
        body: { clientWidth: 1_520, clientHeight: 940, scrollWidth: 1_520, scrollHeight: 940 },
      },
    }))).toThrow(/cannot safely anchor/);
    expect(() => deriveUx01DecoratedFrameRelation(
      { ...parsed.windows[0], bounds: { x: 196, y: 30, width: 1_514, height: 936 } },
      rendererMeasurement(),
    )).toThrow(/not contained/);
    const relation = deriveUx01DecoratedFrameRelation(parsed.windows[0], rendererMeasurement());
    expect(() => mapUx01RendererHitTargetToQuartzLocal(relation, {
      region: 'drag', point: { x: 100, y: 28 }, safeRect: { x: 99, y: 27, width: 2, height: 2 },
    })).toThrow(/hit-target neighborhood/);
    expect(() => mapUx01FramePointToQuartzLocal(relation, { x: 3, y: 2 })).toThrow(/mapped-action-neighborhood/);
    expect(() => mapUx01FramePointToQuartzLocal({
      ...relation,
      insets: { ...relation.insets, left: 4 },
    }, { x: 100, y: 28 })).toThrow(/internally inconsistent/);
    expect(() => assertUx01WindowInsideWorkArea({
      outer: { x: 30, y: 40, width: 1_900, height: 1_050 },
      screen: { availLeft: 0, availTop: 0, availWidth: 1_920, availHeight: 1_080 },
    })).toThrow(/outside the renderer-reported work area/);
  });

  it('keeps raw Quartz/Blink measurements while deriving a contained visible-frame relation instead of equality', () => {
    const parsed = parseUx01WindowDriverInspection(inspection());
    const renderer = rendererMeasurement();
    const diagnostics = createUx01WindowGeometryDiagnostics(parsed, renderer);
    expect(diagnostics).toEqual({
      coordinateModel: {
        native: UX01_WINDOW_COORDINATE_SPACES.native,
        renderer: UX01_WINDOW_COORDINATE_SPACES.renderer,
        sharedBasis: 'electron-43-primary-screen-top-left-at-dpr-1',
        directBoundsEquality: false,
        dynamicDecoratedFrameRelationRequired: true,
      },
      native: parsed,
      renderer,
    });
    expect(diagnostics.native.windows[0].bounds).toEqual({ x: 203, y: 32, width: 1_514, height: 936 });
    expect(diagnostics.renderer.outer).toEqual({ x: 200, y: 30, width: 1_520, height: 940 });
    expect(deriveUx01DecoratedFrameRelation(diagnostics.native.windows[0], renderer).insets)
      .toEqual({ left: 3, top: 2, right: 3, bottom: 2 });
  });

  it('proves no-drag and drag movement independently in Quartz and Blink coordinate spaces', () => {
    const nativeBefore = inspection().windows[0];
    const rendererBefore = { x: 200, y: 30, width: 1_520, height: 940 };
    expect(assertUx01WindowStationaryWithinCoordinateSpaces({
      nativeBefore,
      nativeAfter: { ...nativeBefore, bounds: { x: 203, y: 32, width: 1_514, height: 936 } },
      rendererBefore,
      rendererAfter: { x: 200, y: 30, width: 1_520, height: 940 },
    })).toEqual({
      native: { x: 0, y: 0, width: 0, height: 0 },
      renderer: { x: 0, y: 0, width: 0, height: 0 },
    });

    expect(assertUx01WindowMovedWithinCoordinateSpaces({
      nativeBefore,
      nativeAfter: { ...nativeBefore, bounds: { x: 283, y: 32, width: 1_514, height: 936 } },
      rendererBefore,
      rendererAfter: { x: 280, y: 30, width: 1_520, height: 940 },
      requestedDelta: { x: 80, y: 0 },
    })).toEqual({
      native: { x: 80, y: 0, width: 0, height: 0 },
      renderer: { x: 80, y: 0, width: 0, height: 0 },
    });

    expect(() => assertUx01WindowMovedWithinCoordinateSpaces({
      nativeBefore,
      nativeAfter: { ...nativeBefore, bounds: { x: 203, y: 32, width: 1_514, height: 936 } },
      rendererBefore,
      rendererAfter: { x: 280, y: 30, width: 1_520, height: 940 },
      requestedDelta: { x: 80, y: 0 },
    })).toThrow(/native coordinate space/);
    expect(() => assertUx01WindowMovedWithinCoordinateSpaces({
      nativeBefore,
      nativeAfter: { ...nativeBefore, bounds: { x: 283, y: 32, width: 1_514, height: 936 } },
      rendererBefore,
      rendererAfter: { x: 120, y: 30, width: 1_520, height: 940 },
      requestedDelta: { x: 80, y: 0 },
    })).toThrow(/renderer coordinate space/);
    expect(() => assertUx01WindowMovedWithinCoordinateSpaces({
      nativeBefore,
      nativeAfter: { ...nativeBefore, bounds: { x: 288, y: 32, width: 1_514, height: 936 } },
      rendererBefore,
      rendererAfter: { x: 285, y: 30, width: 1_520, height: 940 },
      requestedDelta: { x: 80, y: 0 },
    })).toThrow(/native coordinate space/);
    expect(() => assertUx01WindowMovedWithinCoordinateSpaces({
      nativeBefore,
      nativeAfter: { ...nativeBefore, bounds: { x: 283, y: 32, width: 1_519, height: 936 } },
      rendererBefore,
      rendererAfter: { x: 280, y: 30, width: 1_520, height: 940 },
      requestedDelta: { x: 80, y: 0 },
    })).toThrow(/resized the window in native coordinate space/);
    expect(() => assertUx01WindowStationaryWithinCoordinateSpaces({
      nativeBefore,
      nativeAfter: { ...nativeBefore, windowId: 201 },
      rendererBefore,
      rendererAfter: rendererBefore,
    })).toThrow(/window identity changed/);

    const beforeRelation = deriveUx01DecoratedFrameRelation(nativeBefore, rendererMeasurement());
    const afterRelation = deriveUx01DecoratedFrameRelation(
      { ...nativeBefore, bounds: { x: 283, y: 32, width: 1_514, height: 936 } },
      rendererMeasurement({ outer: { x: 280, y: 30, width: 1_520, height: 940 } }),
    );
    expect(assertUx01DecoratedFrameRelationStable(beforeRelation, afterRelation)).toEqual({
      left: 0, top: 0, right: 0, bottom: 0,
    });
    const driftedRelation = deriveUx01DecoratedFrameRelation(
      { ...nativeBefore, bounds: { x: 286, y: 32, width: 1_514, height: 936 } },
      rendererMeasurement({ outer: { x: 280, y: 30, width: 1_520, height: 940 } }),
    );
    expect(() => assertUx01DecoratedFrameRelationStable(beforeRelation, driftedRelation)).toThrow(/left inset changed/);
  });

  it('rejects a stale pre-target snapshot even when the moved window still has a valid decorated-frame relation', () => {
    const nativeBefore = inspection().windows[0];
    const nativeAfter = { ...nativeBefore, bounds: { ...nativeBefore.bounds, x: nativeBefore.bounds.x + 8 } };
    const rendererBefore = rendererMeasurement();
    const rendererAfter = rendererMeasurement({
      outer: { ...rendererBefore.outer, x: rendererBefore.outer.x + 8 },
    });
    const relationBefore = deriveUx01DecoratedFrameRelation(nativeBefore, rendererBefore);
    const relationAfter = deriveUx01DecoratedFrameRelation(nativeAfter, rendererAfter);
    expect(assertUx01DecoratedFrameRelationStable(relationBefore, relationAfter))
      .toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(() => assertUx01WindowStationaryWithinCoordinateSpaces({
      nativeBefore,
      nativeAfter,
      rendererBefore: rendererBefore.outer,
      rendererAfter: rendererAfter.outer,
    })).toThrow(/moved in native coordinate space/);
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
    expect(driver).toContain('const double tolerance = 2.0;');
    expect(driver).toContain('The exact owner/window bounds changed before input admission: expected %.3f,%.3f %.3fx%.3f; actual %.3f,%.3f %.3fx%.3f.');

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
    expect(spec).toContain("expect(initialTargets.topbarRegion).toBe('drag')");
    expect(spec).toContain("expect(initialTargets.buttonRegion).toBe('no-drag')");
    expect(spec).toContain('verifyRect(interactiveSafeRect');
    expect(spec).toContain("verifyRect(safeRect");
    expect(spec).toContain('const step = 0.5');
    expect(spec).toContain('if (!inspection.postEventAccess)');
    expect(spec).toContain("'option-click'");
    expect(spec).toContain('assertUx01WindowInsideWorkArea(zoomedMeasurement)');
    expect(spec).toContain("action: 'native green-button Option-click'");
    expect(spec).not.toContain("stage: 'native-zoom-toggle'");
    expect(spec).toContain('deriveUx01DecoratedFrameRelation');
    expect(spec).toContain('mapUx01FramePointToQuartzLocal');
    expect(spec).toContain('mapUx01RendererHitTargetToQuartzLocal');
    expect(spec).toContain('assertUx01DecoratedFrameRelationStable');
    expect(spec).not.toContain('assertUx01WindowSizeMatchesRenderer');
    expect(spec).toContain('assertUx01WindowMovedWithinCoordinateSpaces');
    expect(spec).toContain('assertUx01WindowStationaryWithinCoordinateSpaces');
    expect(spec).toContain('createUx01WindowGeometryDiagnostics');
    expect(spec).not.toContain('assertUx01WindowBoundsMatchRenderer');
    expect(spec).toContain('const WINDOW_STABILITY_OBSERVATIONS = 3;');
    expect(spec).toContain('const WINDOW_STABILITY_INTERVAL_MS = 100;');
    expect(spec).toContain('const WINDOW_STABILITY_TIMEOUT_MS = 5_000;');
    expect(spec).toContain('waitForStableWindowGeometry(page, configured.driverExecutable, ownerPid)');
    expect(spec.match(/await captureActionReadySnapshot\(/g)).toHaveLength(7);
    const initialTargetObservation = spec.indexOf('const initialTargets = await chromeHitTargets(page);');
    const initialActionAdmission = spec.indexOf('const initialClickAdmission = await captureActionReadySnapshot(');
    const initialTargetMapping = spec.indexOf('const initialInteractiveClick = mapUx01RendererHitTargetToQuartzLocal(');
    const initialNativePost = spec.indexOf('configured.driverExecutable, ownerPid, initialClickAdmission.snapshot.window');
    expect([initialTargetObservation, initialActionAdmission, initialTargetMapping, initialNativePost].every((index) => index >= 0)).toBe(true);
    expect([initialTargetObservation, initialActionAdmission, initialTargetMapping, initialNativePost])
      .toEqual([...new Set([initialTargetObservation, initialActionAdmission, initialTargetMapping, initialNativePost])].sort((left, right) => left - right));
    for (const admission of [
      'initialClickAdmission', 'noDragAdmission', 'dragAdmission', 'zoomAdmission',
      'zoomRestoreAdmission', 'minimizeAdmission', 'closeAdmission',
    ]) expect(spec).toContain(`${admission}.snapshot.window`);
    expect(spec).toContain('before=${JSON.stringify(baseline.geometry)}; current=${JSON.stringify(snapshot.geometry)}.');
    expect(spec).not.toContain('postClick(configured.driverExecutable, ownerPid, shownInspection.windows[0], closePoint)');
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

  it('keeps UX-01 Working/P0 and records consumed r1/r2/r3 without promoting a native claim', async () => {
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
      'Fresh r2 `20260814t102354z-f7e6d0c-r2`',
      'failed **1/1 in 2.6 seconds** before input',
      'Quartz `203,32 1514×936`',
      'Blink `200,30 1520×940`',
      'Fresh r3 `20260814t112230z-ff44905-r3`',
      'controller TOCTOU/evidence failure',
      'three bounded paired stability observations',
      'fresh paired action-ready snapshot',
      'dynamic decorated-frame containment relation',
      'exact-PID/window/current-native-bounds reinspection',
      'Accessibility API',
      'separate native authority',
    ]) expect(truth).toContain(claim);
    expect(truth).toContain('Secure r5');
    expect(truth).toContain('passed **1/1 in 5.5 seconds**');
    expect(truth).not.toContain('native traffic-light/top-bar PASS');

    const section = testing.slice(testing.indexOf('### UX-01 native window-chrome preparation, consumed r1/r2/r3 controller failures, and corrected source model'));
    expect(section).toContain(UX01_WINDOW_CHROME_SCENARIO);
    expect(section).toContain('R1 `20260814t092808z-7ff773c-r1`');
    expect(section).toContain('Fresh r2 `20260814t102354z-f7e6d0c-r2`');
    expect(section).toContain('Fresh r3 `20260814t112230z-ff44905-r3`');
    expect(section).toContain('owner PID 22702');
    expect(section).toContain('window ID 7030');
    expect(section).toContain('controller TOCTOU/evidence defect');
    expect(section).toContain('cannot distinguish first-show settling from another native move');
    expect(section).toContain('Quartz reported `203,32 1514×936`');
    expect(section).toContain('trusted Blink reported `200,30 1520×940`');
    expect(section).toContain('No CoreGraphics input was posted');
    expect(section).toContain('not product traffic-light/drag behavior, privacy completion');
    expect(section).toContain('Apple documents `kCGWindowBounds` in Quartz screen space');
    expect(section).toContain('`NativeWindowMac::GetBounds` reads `NSWindow.frame`');
    expect(section).toContain("returns the embedder's `RootWindowRect`");
    expect(section).toContain('invalidate both direct origin and size equality');
    expect(section).toContain('dynamically requires the on-screen Quartz visible rectangle');
    expect(section).toContain('complete 0.5-CSS-px hit-test neighborhood');
    expect(section).toContain('three consecutive paired native/renderer observations');
    expect(section).toContain('fresh paired action-ready snapshot');
    expect(section).toContain('expected and actual bounds');
    expect(section).toContain('stationary independently in Quartz and Blink');
    expect(section).toContain('Raw native and renderer records are retained before every assertion');
    expect(section).toContain('before the test can create its profile');
    expect(section).toContain('fails closed unless it returns true');
    expect(section).toContain('rechecks that permission immediately before every exact-PID action');
    expect(section).toContain('12×11 px');
    expect(section).toContain('without moving the user-visible controls');
    expect(section).toContain('Option-click');
    expect(section).toContain('instead of entering fullscreen');
    expect(section).toContain('no Accessibility API');
    expect(changelog).toContain('Prepare a separate one-shot UX-01 native window-chrome acceptance');
    expect(changelog).toContain('R2 then failed **1/1 in 2.6 seconds**');
    expect(changelog).toContain('Fresh r3 `20260814t112230z-ff44905-r3`');
    expect(changelog).toContain('controller time-of-check/time-of-use and evidence gap');
    expect(changelog).toContain('three bounded paired native/renderer stability observations');
    expect(changelog).toContain('fresh paired action-ready snapshot');
    expect(changelog).toContain('1514×936');
    expect(changelog).toContain("dynamically requires Quartz's visible window-server rectangle");
    expect(changelog).toContain('All three runs cleaned up gracefully with zero survivors and are immutable, non-reusable controller failures');
    expect(changelog).toContain('before the packaged app launches or its profile is created');
    expect(changelog).not.toContain('This checkpoint is source/headless preparation only: it has not been packaged or executed');
    expect(truth).not.toContain('prepared but has not been packaged or executed');
  });
});
