import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { UX01_UNSAFE_REPORT_ENVIRONMENTS } from './ux01-packaged-acceptance.mjs';

export const UX01_WINDOW_CHROME_SCENARIO = 'UX-01-WINDOW-CHROME exact package preserves native traffic lights and drag/no-drag routing';
export const UX01_WINDOW_CHROME_PROFILE_ENV = 'AIDRAW_E2E_UX01_WINDOW_CHROME_PROFILE';
export const UX01_WINDOW_CHROME_FAILURE_ROOT_ENV = 'AIDRAW_E2E_UX01_WINDOW_CHROME_FAILURE_ROOT';
export const UX01_WINDOW_CHROME_EXE_HASH_ENV = 'AIDRAW_E2E_UX01_WINDOW_CHROME_EXE_SHA256';
export const UX01_WINDOW_CHROME_ASAR_HASH_ENV = 'AIDRAW_E2E_UX01_WINDOW_CHROME_ASAR_SHA256';
export const UX01_WINDOW_CHROME_DISCOVERY_ENV = 'AIDRAW_E2E_UX01_WINDOW_CHROME_DISCOVERY_ONLY';
export const UX01_WINDOW_CHROME_PACKAGE_PREFIX = 'ux01-window-chrome-';
export const UX01_WINDOW_CHROME_PROFILE_PREFIX = 'aidraw-e2e-ux01-window-chrome-';
export const UX01_WINDOW_CHROME_FAILURE_PREFIX = 'ux01-window-chrome-native-';
export const UX01_WINDOW_CHROME_DRIVER_FILE = 'macos-window-chrome-driver';
export const UX01_WINDOW_COORDINATE_SPACES = Object.freeze({
  native: 'quartz-main-display-upper-left',
  renderer: 'blink-root-window-css-pixels',
});
export const UX01_WINDOW_CHROME_UNSAFE_REPORT_ENVIRONMENTS = UX01_UNSAFE_REPORT_ENVIRONMENTS;
export const UX01_WINDOW_CHROME_FILES = Object.freeze({
  evidence: 'ux01-window-chrome-evidence.json',
  failure: 'ux01-window-chrome-failure.json',
  cleanup: 'ux01-window-chrome-cleanup.json',
  forbiddenNetwork: 'ux01-window-chrome-forbidden-network.json',
  providerCredentials: join('credentials', 'generation.json'),
});
const UX01_WINDOW_CHROME_CHILD_ENVIRONMENTS = Object.freeze([
  'HOME', 'LOGNAME', 'USER', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING',
  'DEVELOPER_DIR', 'SDKROOT',
  'AIDRAW_E2E_LAUNCH_CONTEXT', 'AIDRAW_E2E_OUT_DIR', 'AIDRAW_E2E_PLATFORM', 'AIDRAW_E2E_ARCH',
  'AIDRAW_E2E_EXECUTABLE', 'AIDRAW_E2E_ASAR',
  UX01_WINDOW_CHROME_PROFILE_ENV, UX01_WINDOW_CHROME_FAILURE_ROOT_ENV,
  UX01_WINDOW_CHROME_EXE_HASH_ENV, UX01_WINDOW_CHROME_ASAR_HASH_ENV,
]);

function required(environment, name) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required for the retained UX-01 window-chrome acceptance.`);
  return value;
}

function declaredSha256(environment, name) {
  const value = required(environment, name).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(value)) throw new Error(`${name} must be one exact SHA-256 digest.`);
  return value;
}

function directChildWithPrefix(root, candidate, prefix, environmentName) {
  const nested = relative(root, candidate);
  const leaf = basename(candidate);
  if (!nested || nested.startsWith('..') || isAbsolute(nested) || dirname(candidate) !== root || !leaf.startsWith(prefix)) {
    throw new Error(`${environmentName} must be a fresh ${prefix}* direct child of ${relative(process.cwd(), root) || root}.`);
  }
  return leaf.slice(prefix.length);
}

export function resolveUx01WindowChromeAcceptance({ workspacePath = process.cwd(), environment = process.env } = {}) {
  const workspace = resolve(workspacePath);
  const preparedRoot = resolve(workspace, 'test-results', 'prepared-packages');
  const retainedRoot = resolve(workspace, 'test-results', 'retained');
  const retainedFailureRoot = resolve(workspace, 'test-results', 'retained-failures');
  const packageRoot = resolve(workspace, required(environment, 'AIDRAW_E2E_OUT_DIR'));
  const profile = resolve(required(environment, UX01_WINDOW_CHROME_PROFILE_ENV));
  const failureRoot = resolve(required(environment, UX01_WINDOW_CHROME_FAILURE_ROOT_ENV));
  const runId = directChildWithPrefix(retainedRoot, profile, UX01_WINDOW_CHROME_PROFILE_PREFIX, UX01_WINDOW_CHROME_PROFILE_ENV);
  if (!/^[a-z0-9](?:[a-z0-9-]{6,78}[a-z0-9])$/.test(runId)) {
    throw new Error(`${UX01_WINDOW_CHROME_PROFILE_ENV} must end in an 8-80 character lowercase run identifier.`);
  }
  if (directChildWithPrefix(preparedRoot, packageRoot, UX01_WINDOW_CHROME_PACKAGE_PREFIX, 'AIDRAW_E2E_OUT_DIR') !== runId) {
    throw new Error(`AIDRAW_E2E_OUT_DIR must be the matching fresh ${UX01_WINDOW_CHROME_PACKAGE_PREFIX}${runId} direct child of test-results/prepared-packages.`);
  }
  if (directChildWithPrefix(retainedFailureRoot, failureRoot, UX01_WINDOW_CHROME_FAILURE_PREFIX, UX01_WINDOW_CHROME_FAILURE_ROOT_ENV) !== runId) {
    throw new Error(`${UX01_WINDOW_CHROME_FAILURE_ROOT_ENV} must be the matching fresh ${UX01_WINDOW_CHROME_FAILURE_PREFIX}${runId} direct child of test-results/retained-failures.`);
  }
  const paths = Object.fromEntries(Object.entries(UX01_WINDOW_CHROME_FILES).map(([key, file]) => [key, join(profile, file)]));
  return {
    workspace,
    preparedRoot,
    retainedRoot,
    retainedFailureRoot,
    packageRoot,
    profile,
    runId,
    failureRoot,
    playwrightOutput: join(failureRoot, 'playwright'),
    driverSource: join(workspace, 'scripts', 'macos-window-chrome-driver.m'),
    driverExecutable: join(failureRoot, UX01_WINDOW_CHROME_DRIVER_FILE),
    executableSha256: declaredSha256(environment, UX01_WINDOW_CHROME_EXE_HASH_ENV),
    asarSha256: declaredSha256(environment, UX01_WINDOW_CHROME_ASAR_HASH_ENV),
    paths,
  };
}

export function assertUx01WindowChromeSafeReporterEnvironment(environment = process.env) {
  const configured = UX01_WINDOW_CHROME_UNSAFE_REPORT_ENVIRONMENTS.filter((name) => String(environment[name] ?? '').trim());
  if (configured.length) {
    throw new Error(`UX-01 window-chrome acceptance rejects credential-capable Playwright report configuration: ${configured.join(', ')}.`);
  }
  return true;
}

export function buildUx01WindowChromeChildEnvironment(environment = process.env) {
  const childEnvironment = {};
  for (const name of UX01_WINDOW_CHROME_CHILD_ENVIRONMENTS) {
    const value = environment[name];
    if (typeof value === 'string' && value) childEnvironment[name] = value;
  }
  childEnvironment.AIDRAW_E2E_UX01_WINDOW_CHROME_WRAPPER = '1';
  childEnvironment.PLAYWRIGHT_NO_COPY_PROMPT = '1';
  return childEnvironment;
}

function boundedNumber(value, label, { integer = false, minimum = -32_768, maximum = 32_768 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < minimum || number > maximum) {
    throw new Error(`The macOS window driver returned invalid ${label}.`);
  }
  return number;
}

function parsedBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The macOS window driver returned invalid window bounds.');
  const bounds = {
    x: boundedNumber(value.x, 'window x'),
    y: boundedNumber(value.y, 'window y'),
    width: boundedNumber(value.width, 'window width', { minimum: 1, maximum: 32_768 }),
    height: boundedNumber(value.height, 'window height', { minimum: 1, maximum: 32_768 }),
  };
  return bounds;
}

function parsedButton(value, label, offsetRequired) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The macOS window driver returned invalid ${label} button metrics.`);
  const button = {
    width: boundedNumber(value.width, `${label} button width`, { minimum: 6, maximum: 64 }),
    height: boundedNumber(value.height, `${label} button height`, { minimum: 6, maximum: 64 }),
    ...(offsetRequired ? { offsetX: boundedNumber(value.offsetX, `${label} button offset`, { minimum: 1, maximum: 80 }) } : {}),
  };
  return button;
}

export function parseUx01WindowDriverPreflight(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || typeof value.postEventAccess !== 'boolean') {
    throw new Error('The macOS window driver did not return its version-one event-posting preflight contract.');
  }
  return { version: 1, postEventAccess: value.postEventAccess };
}

export function parseUx01WindowDriverInspection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new Error('The macOS window driver did not return its version-one inspection contract.');
  }
  const pid = boundedNumber(value.pid, 'owner PID', { integer: true, minimum: 1, maximum: 2_147_483_647 });
  if (typeof value.postEventAccess !== 'boolean' || !Array.isArray(value.windows) || value.windows.length > 1) {
    throw new Error('The macOS window driver returned an ambiguous owner/window or event-access result.');
  }
  const windows = value.windows.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.onScreen !== 'boolean') {
      throw new Error('The macOS window driver returned an invalid exact-owner window.');
    }
    return {
      windowId: boundedNumber(entry.windowId, 'window ID', { integer: true, minimum: 1, maximum: 4_294_967_295 }),
      onScreen: entry.onScreen,
      bounds: parsedBounds(entry.bounds),
    };
  });
  const metrics = value.buttonMetrics;
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error('The macOS window driver returned no native standard-button metrics.');
  }
  return {
    version: 1,
    pid,
    postEventAccess: value.postEventAccess,
    windows,
    buttonMetrics: {
      close: parsedButton(metrics.close, 'close', false),
      minimize: parsedButton(metrics.minimize, 'minimize', true),
      zoom: parsedButton(metrics.zoom, 'zoom', true),
    },
  };
}

export function parseUx01WindowDriverAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !['click', 'option-click', 'drag'].includes(value.action) || value.posted !== true) {
    throw new Error('The macOS window driver did not confirm one bounded exact-owner action.');
  }
  return {
    version: 1,
    action: value.action,
    posted: true,
    pid: boundedNumber(value.pid, 'action owner PID', { integer: true, minimum: 1, maximum: 2_147_483_647 }),
    windowId: boundedNumber(value.windowId, 'action window ID', { integer: true, minimum: 1, maximum: 4_294_967_295 }),
  };
}

export function deriveUx01TrafficLightCenters(buttonMetrics, contract) {
  const origin = contract?.trafficLightPosition;
  const reservedWidth = boundedNumber(contract?.trafficLightReservedWidth, 'traffic-light reserved width', { minimum: 60, maximum: 160 });
  const topbarHeight = boundedNumber(contract?.topbarHeight, 'top-bar height', { minimum: 32, maximum: 96 });
  const originX = boundedNumber(origin?.x, 'traffic-light origin x', { minimum: 0, maximum: reservedWidth });
  const originY = boundedNumber(origin?.y, 'traffic-light origin y', { minimum: 0, maximum: topbarHeight });
  const close = parsedButton(buttonMetrics?.close, 'close', false);
  const minimize = parsedButton(buttonMetrics?.minimize, 'minimize', true);
  const zoom = parsedButton(buttonMetrics?.zoom, 'zoom', true);
  const centers = {
    close: { x: originX + close.width / 2, y: originY + close.height / 2 },
    minimize: { x: originX + minimize.offsetX + minimize.width / 2, y: originY + minimize.height / 2 },
    zoom: { x: originX + zoom.offsetX + zoom.width / 2, y: originY + zoom.height / 2 },
  };
  if (!(centers.close.x < centers.minimize.x && centers.minimize.x < centers.zoom.x)
    || centers.zoom.x >= reservedWidth
    || Object.values(centers).some((point) => point.y >= topbarHeight)) {
    throw new Error('The native standard-button metrics do not fit AIDraw\'s declared traffic-light reserve.');
  }
  return centers;
}

function boundedWindowTolerance(tolerance) {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 4) throw new Error('The UX-01 native-window tolerance must remain bounded.');
  return tolerance;
}

function parsedWindowRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The UX-01 ${label} native window is missing.`);
  if (typeof value.onScreen !== 'boolean') throw new Error(`The UX-01 ${label} native window has no on-screen state.`);
  return {
    windowId: boundedNumber(value.windowId, `${label} window ID`, { integer: true, minimum: 1, maximum: 4_294_967_295 }),
    onScreen: value.onScreen,
    bounds: parsedBounds(value.bounds),
  };
}

function sameWindowIdentity(before, after) {
  if (before.windowId !== after.windowId) throw new Error('The exact-owner native window identity changed across one bounded action.');
  if (!before.onScreen || !after.onScreen) throw new Error('The exact-owner native window left the on-screen set during one bounded action.');
}

function boundsDelta(before, after) {
  return {
    x: after.x - before.x,
    y: after.y - before.y,
    width: after.width - before.width,
    height: after.height - before.height,
  };
}

export function createUx01WindowGeometryDiagnostics(nativeInspection, rendererMeasurement) {
  if (!nativeInspection || typeof nativeInspection !== 'object' || Array.isArray(nativeInspection)
    || !Array.isArray(nativeInspection.windows)) {
    throw new Error('The UX-01 native geometry diagnostics require one parsed exact-owner inspection.');
  }
  if (!rendererMeasurement || typeof rendererMeasurement !== 'object' || Array.isArray(rendererMeasurement)) {
    throw new Error('The UX-01 renderer geometry diagnostics require one trusted root-window measurement.');
  }
  return {
    coordinateModel: {
      native: UX01_WINDOW_COORDINATE_SPACES.native,
      renderer: UX01_WINDOW_COORDINATE_SPACES.renderer,
      crossSourceComparable: ['width', 'height'],
      absoluteOriginsComparable: false,
    },
    native: nativeInspection,
    renderer: { ...rendererMeasurement, outer: parsedBounds(rendererMeasurement.outer) },
  };
}

export function assertUx01WindowSizeMatchesRenderer(windowRecord, rendererOuter, tolerance = 2) {
  const boundedTolerance = boundedWindowTolerance(tolerance);
  const nativeBounds = parsedWindowRecord(windowRecord, 'current').bounds;
  const rendererBounds = parsedBounds(rendererOuter);
  for (const key of ['width', 'height']) {
    if (Math.abs(nativeBounds[key] - rendererBounds[key]) > boundedTolerance) {
      throw new Error(`The exact-owner native ${key} does not match the trusted renderer outer size.`);
    }
  }
  return true;
}

export function assertUx01WindowStationaryWithinCoordinateSpaces(samples, tolerance = 2) {
  const boundedTolerance = boundedWindowTolerance(tolerance);
  const nativeBefore = parsedWindowRecord(samples?.nativeBefore, 'previous');
  const nativeAfter = parsedWindowRecord(samples?.nativeAfter, 'current');
  const rendererBefore = parsedBounds(samples?.rendererBefore);
  const rendererAfter = parsedBounds(samples?.rendererAfter);
  sameWindowIdentity(nativeBefore, nativeAfter);
  const deltas = {
    native: boundsDelta(nativeBefore.bounds, nativeAfter.bounds),
    renderer: boundsDelta(rendererBefore, rendererAfter),
  };
  for (const [coordinateSpace, delta] of Object.entries(deltas)) {
    for (const key of ['x', 'y', 'width', 'height']) {
      if (Math.abs(delta[key]) > boundedTolerance) {
        throw new Error(`The exact window moved in ${coordinateSpace} coordinate space during a no-drag action.`);
      }
    }
  }
  return deltas;
}

export function assertUx01WindowMovedWithinCoordinateSpaces(samples, options = {}) {
  const tolerance = boundedWindowTolerance(options.tolerance ?? 2);
  const minimumDistance = boundedNumber(options.minimumDistance ?? 40, 'minimum independent drag distance', { minimum: 1, maximum: 512 });
  const requestedDelta = {
    x: boundedNumber(samples?.requestedDelta?.x, 'requested drag x', { minimum: -512, maximum: 512 }),
    y: boundedNumber(samples?.requestedDelta?.y, 'requested drag y', { minimum: -512, maximum: 512 }),
  };
  if (requestedDelta.x === 0 || requestedDelta.y !== 0) throw new Error('The UX-01 independent movement contract requires one bounded horizontal drag.');
  if (Math.abs(requestedDelta.x) < minimumDistance) throw new Error('The UX-01 requested drag is shorter than its independent movement floor.');
  const nativeBefore = parsedWindowRecord(samples?.nativeBefore, 'previous');
  const nativeAfter = parsedWindowRecord(samples?.nativeAfter, 'current');
  const rendererBefore = parsedBounds(samples?.rendererBefore);
  const rendererAfter = parsedBounds(samples?.rendererAfter);
  sameWindowIdentity(nativeBefore, nativeAfter);
  const deltas = {
    native: boundsDelta(nativeBefore.bounds, nativeAfter.bounds),
    renderer: boundsDelta(rendererBefore, rendererAfter),
  };
  const direction = Math.sign(requestedDelta.x);
  for (const [coordinateSpace, delta] of Object.entries(deltas)) {
    if (Math.sign(delta.x) !== direction
      || Math.abs(delta.x) < minimumDistance
      || Math.abs(delta.x) > Math.abs(requestedDelta.x) + tolerance
      || Math.abs(delta.y) > tolerance) {
      throw new Error(`The intended app-region drag did not move independently in ${coordinateSpace} coordinate space.`);
    }
    if (Math.abs(delta.width) > tolerance || Math.abs(delta.height) > tolerance) {
      throw new Error(`The intended app-region drag resized the window in ${coordinateSpace} coordinate space.`);
    }
  }
  return deltas;
}

export function assertUx01WindowInsideWorkArea(measurement, tolerance = 2) {
  const boundedTolerance = boundedWindowTolerance(tolerance);
  const outer = parsedBounds(measurement?.outer);
  const screen = measurement?.screen;
  if (!screen || typeof screen !== 'object' || Array.isArray(screen)) {
    throw new Error('The UX-01 renderer returned no native work-area contract.');
  }
  const workArea = {
    x: boundedNumber(screen.availLeft, 'work-area x'),
    y: boundedNumber(screen.availTop, 'work-area y'),
    width: boundedNumber(screen.availWidth, 'work-area width', { minimum: 1, maximum: 32_768 }),
    height: boundedNumber(screen.availHeight, 'work-area height', { minimum: 1, maximum: 32_768 }),
  };
  if (outer.x < workArea.x - boundedTolerance
    || outer.y < workArea.y - boundedTolerance
    || outer.x + outer.width > workArea.x + workArea.width + boundedTolerance
    || outer.y + outer.height > workArea.y + workArea.height + boundedTolerance) {
    throw new Error('The native standard-zoom result moved required window chrome outside the renderer-reported work area.');
  }
  return true;
}
