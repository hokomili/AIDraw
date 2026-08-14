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
  native: 'quartz-visible-window-main-display-upper-left',
  renderer: 'blink-root-window-css-pixels-from-electron-nswindow-frame',
});
export const UX01_WINDOW_ACTION_MAPPING_UNCERTAINTY = 2;
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
      sharedBasis: 'electron-43-primary-screen-top-left-at-dpr-1',
      directBoundsEquality: false,
      dynamicDecoratedFrameRelationRequired: true,
    },
    native: nativeInspection,
    renderer: { ...rendererMeasurement, outer: parsedBounds(rendererMeasurement.outer) },
  };
}

function parsedRendererFrameMeasurement(measurement) {
  if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement)) {
    throw new Error('The UX-01 decorated-frame relation requires one trusted renderer measurement.');
  }
  const outer = parsedBounds(measurement.outer);
  const content = measurement.content;
  const screen = measurement.screen;
  const layout = measurement.layout;
  if (!content || typeof content !== 'object' || Array.isArray(content)
    || !screen || typeof screen !== 'object' || Array.isArray(screen)
    || !layout || typeof layout !== 'object' || Array.isArray(layout)) {
    throw new Error('The UX-01 decorated-frame relation requires renderer content, screen, and layout evidence.');
  }
  const parsedContent = {
    width: boundedNumber(content.width, 'renderer content width', { integer: true, minimum: 1, maximum: 32_768 }),
    height: boundedNumber(content.height, 'renderer content height', { integer: true, minimum: 1, maximum: 32_768 }),
    devicePixelRatio: boundedNumber(content.devicePixelRatio, 'renderer device-pixel ratio', { minimum: 0.25, maximum: 8 }),
  };
  const parsedScreen = {
    width: boundedNumber(screen.width, 'renderer screen width', { integer: true, minimum: 1, maximum: 32_768 }),
    height: boundedNumber(screen.height, 'renderer screen height', { integer: true, minimum: 1, maximum: 32_768 }),
    availLeft: boundedNumber(screen.availLeft, 'renderer available-screen left', { integer: true }),
    availTop: boundedNumber(screen.availTop, 'renderer available-screen top', { integer: true }),
    availWidth: boundedNumber(screen.availWidth, 'renderer available-screen width', { integer: true, minimum: 1, maximum: 32_768 }),
    availHeight: boundedNumber(screen.availHeight, 'renderer available-screen height', { integer: true, minimum: 1, maximum: 32_768 }),
  };
  const parseLayoutBox = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`The UX-01 decorated-frame relation requires ${label} layout evidence.`);
    }
    return {
      clientWidth: boundedNumber(value.clientWidth, `${label} client width`, { integer: true, minimum: 1, maximum: 32_768 }),
      clientHeight: boundedNumber(value.clientHeight, `${label} client height`, { integer: true, minimum: 1, maximum: 32_768 }),
      scrollWidth: boundedNumber(value.scrollWidth, `${label} scroll width`, { integer: true, minimum: 1, maximum: 32_768 }),
      scrollHeight: boundedNumber(value.scrollHeight, `${label} scroll height`, { integer: true, minimum: 1, maximum: 32_768 }),
    };
  };
  return {
    outer,
    content: parsedContent,
    screen: parsedScreen,
    layout: {
      root: parseLayoutBox(layout.root, 'renderer root'),
      body: parseLayoutBox(layout.body, 'renderer body'),
    },
  };
}

function assertRectInside(inside, outside, label) {
  if (inside.x < outside.x || inside.y < outside.y
    || inside.x + inside.width > outside.x + outside.width
    || inside.y + inside.height > outside.y + outside.height) {
    throw new Error(`The UX-01 ${label} rectangle is not contained by its declared coordinate-space boundary.`);
  }
}

// Pinned source contract: Electron 43.4.0 NativeWindowMac::GetBounds reads
// NSWindow.frame and flips it against the primary screen; Chromium 150 exposes
// that root-window rect through screenX/screenY/outerWidth/outerHeight. Apple
// documents kCGWindowBounds in upper-left-main-display screen space but does
// not promise that its visible window-server rectangle equals NSWindow.frame.
export function deriveUx01DecoratedFrameRelation(windowRecord, rendererMeasurement) {
  const nativeWindow = parsedWindowRecord(windowRecord, 'current');
  if (!nativeWindow.onScreen) throw new Error('The UX-01 decorated-frame relation requires one on-screen native window.');
  const renderer = parsedRendererFrameMeasurement(rendererMeasurement);
  if (renderer.content.devicePixelRatio !== 1) {
    throw new Error('The UX-01 decorated-frame relation is limited to the declared DPR-1 acceptance host.');
  }
  if (renderer.screen.availLeft !== 0 || renderer.screen.availTop < 0
    || renderer.screen.availWidth > renderer.screen.width
    || renderer.screen.availTop + renderer.screen.availHeight > renderer.screen.height) {
    throw new Error('The UX-01 decorated-frame relation is limited to the declared main-display screen basis.');
  }
  for (const key of ['width', 'height']) {
    if (renderer.content[key] !== renderer.outer[key]) {
      throw new Error('The UX-01 renderer viewport does not cover the nominal root-window frame.');
    }
  }
  for (const box of Object.values(renderer.layout)) {
    if (box.clientWidth !== renderer.content.width || box.scrollWidth !== renderer.content.width
      || box.clientHeight !== renderer.content.height || box.scrollHeight !== renderer.content.height) {
      throw new Error('The UX-01 renderer root/body geometry cannot safely anchor a frame-local input target.');
    }
  }
  const mainDisplay = { x: 0, y: 0, width: renderer.screen.width, height: renderer.screen.height };
  assertRectInside(renderer.outer, mainDisplay, 'renderer nominal-frame');
  assertRectInside(nativeWindow.bounds, mainDisplay, 'Quartz visible-window');
  assertRectInside(nativeWindow.bounds, renderer.outer, 'Quartz-visible-inside-nominal-frame');
  const insets = {
    left: nativeWindow.bounds.x - renderer.outer.x,
    top: nativeWindow.bounds.y - renderer.outer.y,
    right: (renderer.outer.x + renderer.outer.width) - (nativeWindow.bounds.x + nativeWindow.bounds.width),
    bottom: (renderer.outer.y + renderer.outer.height) - (nativeWindow.bounds.y + nativeWindow.bounds.height),
  };
  if (Object.values(insets).some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error('The UX-01 decorated-frame relation has a fractional or negative visible-frame inset.');
  }
  return {
    model: 'dynamic-contained-quartz-visible-frame',
    windowId: nativeWindow.windowId,
    nativeBounds: nativeWindow.bounds,
    rendererOuter: renderer.outer,
    rendererContent: renderer.content,
    mainDisplay,
    insets,
    mappingUncertainty: {
      x: UX01_WINDOW_ACTION_MAPPING_UNCERTAINTY,
      y: UX01_WINDOW_ACTION_MAPPING_UNCERTAINTY,
      source: 'exact-driver-current-bounds-reinspection',
    },
  };
}

function parsedFrameRelation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.model !== 'dynamic-contained-quartz-visible-frame') {
    throw new Error('The UX-01 action has no validated decorated-frame relation.');
  }
  const relation = {
    ...value,
    windowId: boundedNumber(value.windowId, 'relation window ID', { integer: true, minimum: 1, maximum: 4_294_967_295 }),
    nativeBounds: parsedBounds(value.nativeBounds),
    rendererOuter: parsedBounds(value.rendererOuter),
    insets: {
      left: boundedNumber(value.insets?.left, 'left visible-frame inset', { integer: true, minimum: 0, maximum: 32_768 }),
      top: boundedNumber(value.insets?.top, 'top visible-frame inset', { integer: true, minimum: 0, maximum: 32_768 }),
      right: boundedNumber(value.insets?.right, 'right visible-frame inset', { integer: true, minimum: 0, maximum: 32_768 }),
      bottom: boundedNumber(value.insets?.bottom, 'bottom visible-frame inset', { integer: true, minimum: 0, maximum: 32_768 }),
    },
    mappingUncertainty: {
      x: boundedWindowTolerance(value.mappingUncertainty?.x),
      y: boundedWindowTolerance(value.mappingUncertainty?.y),
    },
  };
  const expectedInsets = {
    left: relation.nativeBounds.x - relation.rendererOuter.x,
    top: relation.nativeBounds.y - relation.rendererOuter.y,
    right: (relation.rendererOuter.x + relation.rendererOuter.width)
      - (relation.nativeBounds.x + relation.nativeBounds.width),
    bottom: (relation.rendererOuter.y + relation.rendererOuter.height)
      - (relation.nativeBounds.y + relation.nativeBounds.height),
  };
  for (const key of ['left', 'top', 'right', 'bottom']) {
    if (relation.insets[key] !== expectedInsets[key]) {
      throw new Error('The UX-01 decorated-frame relation is internally inconsistent.');
    }
  }
  return relation;
}

function parsedPoint(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The UX-01 ${label} point is missing.`);
  return {
    x: boundedNumber(value.x, `${label} x`),
    y: boundedNumber(value.y, `${label} y`),
  };
}

function parsedSafeRect(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The UX-01 renderer target has no complete safe hit-test rectangle.');
  }
  return parsedBounds(value);
}

export function mapUx01FramePointToQuartzLocal(relationValue, pointValue) {
  const relation = parsedFrameRelation(relationValue);
  const point = parsedPoint(pointValue, 'nominal-frame');
  const mapped = { x: point.x - relation.insets.left, y: point.y - relation.insets.top };
  const uncertaintyRect = {
    x: mapped.x - relation.mappingUncertainty.x,
    y: mapped.y - relation.mappingUncertainty.y,
    width: relation.mappingUncertainty.x * 2,
    height: relation.mappingUncertainty.y * 2,
  };
  assertRectInside(uncertaintyRect, { x: 0, y: 0, width: relation.nativeBounds.width, height: relation.nativeBounds.height }, 'mapped-action-neighborhood');
  return mapped;
}

export function mapUx01RendererHitTargetToQuartzLocal(relationValue, targetValue) {
  const relation = parsedFrameRelation(relationValue);
  if (!targetValue || typeof targetValue !== 'object' || Array.isArray(targetValue)
    || !['drag', 'no-drag'].includes(targetValue.region)) {
    throw new Error('The UX-01 renderer target has no exact drag/no-drag region contract.');
  }
  const point = parsedPoint(targetValue.point, 'renderer hit-target');
  const safeRect = parsedSafeRect(targetValue.safeRect);
  const requiredNeighborhood = {
    x: point.x - relation.mappingUncertainty.x,
    y: point.y - relation.mappingUncertainty.y,
    width: relation.mappingUncertainty.x * 2,
    height: relation.mappingUncertainty.y * 2,
  };
  assertRectInside(requiredNeighborhood, safeRect, 'renderer hit-target neighborhood');
  const mapped = mapUx01FramePointToQuartzLocal(relation, point);
  return {
    region: targetValue.region,
    point: mapped,
    rendererPoint: point,
    safeRect,
    mappingUncertainty: relation.mappingUncertainty,
  };
}

export function assertUx01DecoratedFrameRelationStable(beforeValue, afterValue, tolerance = 2) {
  const boundedTolerance = boundedWindowTolerance(tolerance);
  const before = parsedFrameRelation(beforeValue);
  const after = parsedFrameRelation(afterValue);
  if (before.windowId !== after.windowId) throw new Error('The decorated-frame relation changed native window identity.');
  const delta = {};
  for (const key of ['left', 'top', 'right', 'bottom']) {
    delta[key] = after.insets[key] - before.insets[key];
    if (Math.abs(delta[key]) > boundedTolerance) {
      throw new Error(`The decorated-frame ${key} inset changed outside the bounded action relation.`);
    }
  }
  return delta;
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
