import { expect, test } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { EDITOR_DENSITY, MACOS_EDITOR_WINDOW_CHROME } from '../../src/common/editor-layout';
import {
  assertUx01EvidenceRedacted,
  parseUx01OwnedProcesses,
  parseUx01WindowMeasurement,
  redactUx01FailureText,
} from '../../scripts/ux01-packaged-acceptance.mjs';
import {
  assertUx01DecoratedFrameRelationStable,
  assertUx01WindowInsideWorkArea,
  assertUx01WindowMovedWithinCoordinateSpaces,
  assertUx01WindowStationaryWithinCoordinateSpaces,
  createUx01WindowGeometryDiagnostics,
  deriveUx01DecoratedFrameRelation,
  deriveUx01TrafficLightCenters,
  mapUx01FramePointToQuartzLocal,
  mapUx01RendererHitTargetToQuartzLocal,
  parseUx01WindowDriverAction,
  parseUx01WindowDriverInspection,
  resolveUx01WindowChromeAcceptance,
  UX01_WINDOW_ACTION_MAPPING_UNCERTAINTY,
  UX01_WINDOW_CHROME_SCENARIO,
} from '../../scripts/ux01-window-chrome-acceptance.mjs';
import {
  resolvePackagedE2eArtifact,
  spawnPackagedE2e,
  waitForPackagedE2eReady,
} from '../../scripts/packaged-e2e-runtime.mjs';

const execute = promisify(execFile);
const artifact = resolvePackagedE2eArtifact();
const executable = artifact.executable;
const asar = artifact.asar;
const networkDisabledArguments = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--no-pings',
];

interface OwnedProcess {
  pid: number;
  ppid: number;
  type: string;
}

interface NativeMeasurement {
  location: string;
  content: { width: number; height: number; devicePixelRatio: number };
  outer: { x: number; y: number; width: number; height: number };
  screen: { width: number; height: number; availLeft: number; availTop: number; availWidth: number; availHeight: number };
  layout: {
    root: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number };
    body: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number };
  };
}

type NativeInspection = ReturnType<typeof parseUx01WindowDriverInspection>;
type NativeWindowRecord = NativeInspection['windows'][number];

interface WindowGeometrySnapshot {
  measurement: NativeMeasurement;
  inspection: NativeInspection;
  geometry: ReturnType<typeof createUx01WindowGeometryDiagnostics>;
  window: NativeWindowRecord;
  relation: ReturnType<typeof deriveUx01DecoratedFrameRelation>;
}

const WINDOW_STABILITY_OBSERVATIONS = 3;
const WINDOW_STABILITY_INTERVAL_MS = 100;
const WINDOW_STABILITY_TIMEOUT_MS = 5_000;

interface CleanupRecord {
  ownerPid?: number;
  ownerExitCode?: number | null;
  signalPid?: number;
  signalExitCode?: number | null;
  controllerCredentials: 'not-created-or-accessed';
  ownedSurvivors: OwnedProcess[];
  graceful: boolean;
  error?: string;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve the isolated UX-01 window-chrome DevTools port.');
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForExit(child: ChildProcess, label: string, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise<number | null>((resolveExit, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveExit(code);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${label} could not run: ${error.message}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${label} did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function isPermittedRendererUrl(value: string): boolean {
  if (/^(?:aidraw|data|blob|devtools):/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

async function waitForSingleRendererPage(context: BrowserContext): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pages = context.pages().filter((candidate) => !candidate.isClosed() && candidate.url().startsWith('aidraw://app/'));
    if (pages.length === 1) {
      await pages[0].waitForLoadState('domcontentloaded');
      await expect(pages[0].locator('.app-shell')).toBeVisible();
      return pages[0];
    }
    if (pages.length > 1) throw new Error(`The retained UX-01 owner admitted ${pages.length} renderer pages; expected exactly one.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('The retained UX-01 owner did not expose exactly one trusted renderer page.');
}

async function processRows(profile: string): Promise<OwnedProcess[]> {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return parseUx01OwnedProcesses(stdout, profile);
}

async function waitForProcessShape(profile: string, expectedOwnerPid: number): Promise<OwnedProcess[]> {
  const deadline = Date.now() + 20_000;
  let last: OwnedProcess[] = [];
  while (Date.now() < deadline) {
    last = await processRows(profile);
    if (last.some((entry) => entry.pid === expectedOwnerPid && entry.type === 'browser')
      && last.filter((entry) => entry.type === 'renderer').length === 1) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`The retained UX-01 process shape never reached one owner and one renderer: ${JSON.stringify(last)}.`);
}

async function waitForNoOwnedProcesses(profile: string): Promise<OwnedProcess[]> {
  const deadline = Date.now() + 15_000;
  let rows = await processRows(profile);
  while (rows.length && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    rows = await processRows(profile);
  }
  return rows;
}

async function signalOwner(profile: string, argument: '--show' | '--quit-engine') {
  const signal = spawnPackagedE2e(executable, [`--user-data-dir=${profile}`, argument], { stdio: 'ignore' });
  const exitCode = await waitForExit(signal, `The retained UX-01 ${argument} signal`, 10_000);
  if (exitCode !== 0) throw new Error(`The retained UX-01 ${argument} signal exited with ${String(exitCode)}.`);
  return { pid: signal.pid, exitCode };
}

async function writePrivateRecord(path: string, text: string): Promise<void> {
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error(`The retained UX-01 record is not mode 0600: ${path}.`);
}

async function stopOwner(
  child: ChildProcess | undefined,
  browser: Browser | undefined,
  profile: string,
): Promise<CleanupRecord> {
  const ownerPid = child?.pid;
  let signalPid: number | undefined;
  let signalExitCode: number | null | undefined;
  let cleanupError: Error | undefined;
  if (child?.exitCode === null) {
    try {
      const signal = await signalOwner(profile, '--quit-engine');
      signalPid = signal.pid;
      signalExitCode = signal.exitCode;
      await waitForExit(child, 'The retained UX-01 window-chrome owner', 15_000);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const ownerStopped = Boolean(child && child.exitCode !== null);
  if (ownerStopped && browser?.isConnected()) await browser.close().catch(() => undefined);
  let ownedSurvivors: OwnedProcess[] = [];
  try {
    ownedSurvivors = await waitForNoOwnedProcesses(profile);
  } catch (error) {
    cleanupError ??= error instanceof Error ? error : new Error('The retained UX-01 process survivors could not be inspected.');
  }
  const graceful = Boolean(child && child.exitCode === 0 && signalExitCode === 0
    && ownedSurvivors.length === 0 && !cleanupError);
  return {
    ownerPid,
    ownerExitCode: child?.exitCode,
    signalPid,
    signalExitCode,
    controllerCredentials: 'not-created-or-accessed',
    ownedSurvivors,
    graceful,
    ...(cleanupError ? { error: cleanupError.message } : {}),
  };
}

async function nativeMeasurement(page: Page): Promise<NativeMeasurement> {
  return parseUx01WindowMeasurement(await page.evaluate(() => {
    const browserScreen = window.screen as Screen & { availLeft: number; availTop: number };
    return {
      location: window.location.href,
      content: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      outer: { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight },
      screen: {
        width: browserScreen.width,
        height: browserScreen.height,
        availLeft: browserScreen.availLeft,
        availTop: browserScreen.availTop,
        availWidth: browserScreen.availWidth,
        availHeight: browserScreen.availHeight,
      },
      layout: {
        root: {
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        },
        body: {
          clientWidth: document.body.clientWidth,
          clientHeight: document.body.clientHeight,
          scrollWidth: document.body.scrollWidth,
          scrollHeight: document.body.scrollHeight,
        },
      },
    };
  }));
}

function sameBounds(left: NativeMeasurement['outer'], right: NativeMeasurement['outer'], tolerance = 2): boolean {
  return (['x', 'y', 'width', 'height'] as const).every((key) => Math.abs(left[key] - right[key]) <= tolerance);
}

async function waitForMeasurement(page: Page, predicate: (value: NativeMeasurement) => boolean, label: string): Promise<NativeMeasurement> {
  const deadline = Date.now() + 15_000;
  let last = await nativeMeasurement(page);
  while (Date.now() < deadline) {
    last = await nativeMeasurement(page);
    if (predicate(last)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(last.outer)}.`);
}

async function runDriver(driver: string, arguments_: string[]): Promise<unknown> {
  const { stdout } = await execute(driver, arguments_, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  try { return JSON.parse(stdout); }
  catch { throw new Error('The exact macOS window driver returned malformed JSON.'); }
}

async function inspectOwner(driver: string, pid: number) {
  return parseUx01WindowDriverInspection(await runDriver(driver, ['inspect', String(pid)]));
}

function windowGeometrySnapshot(
  inspection: NativeInspection,
  measurement: NativeMeasurement,
  expectedWindowId?: number,
): WindowGeometrySnapshot {
  const geometry = createUx01WindowGeometryDiagnostics(inspection, measurement);
  if (!inspection.postEventAccess) {
    throw new Error('CoreGraphics exact-PID event posting is not pre-authorized; the driver did not request access.');
  }
  if (inspection.windows.length !== 1 || !inspection.windows[0].onScreen) {
    throw new Error('The exact UX-01 owner does not expose one on-screen native editor window.');
  }
  const window = inspection.windows[0];
  if (expectedWindowId !== undefined && window.windowId !== expectedWindowId) {
    throw new Error(`The exact UX-01 native window identity changed from ${expectedWindowId} to ${window.windowId}.`);
  }
  return {
    measurement,
    inspection,
    geometry,
    window,
    relation: deriveUx01DecoratedFrameRelation(window, measurement),
  };
}

async function captureWindowGeometrySnapshot(
  page: Page,
  driver: string,
  pid: number,
  expectedWindowId?: number,
): Promise<WindowGeometrySnapshot> {
  const measurement = await nativeMeasurement(page);
  const inspection = await inspectOwner(driver, pid);
  return windowGeometrySnapshot(inspection, measurement, expectedWindowId);
}

function stationarySnapshotDeltas(before: WindowGeometrySnapshot, after: WindowGeometrySnapshot) {
  return {
    coordinateSpaces: assertUx01WindowStationaryWithinCoordinateSpaces({
      nativeBefore: before.window,
      nativeAfter: after.window,
      rendererBefore: before.measurement.outer,
      rendererAfter: after.measurement.outer,
    }),
    decoratedFrame: assertUx01DecoratedFrameRelationStable(before.relation, after.relation),
  };
}

async function waitForStableWindowGeometry(
  page: Page,
  driver: string,
  pid: number,
): Promise<{
  first: WindowGeometrySnapshot;
  snapshot: WindowGeometrySnapshot;
  observations: number;
  deltas: ReturnType<typeof stationarySnapshotDeltas>;
}> {
  const deadline = Date.now() + WINDOW_STABILITY_TIMEOUT_MS;
  const first = await captureWindowGeometrySnapshot(page, driver, pid);
  let anchor = first;
  let stableObservations = 1;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, WINDOW_STABILITY_INTERVAL_MS));
    const current = await captureWindowGeometrySnapshot(page, driver, pid, first.window.windowId);
    try {
      const deltas = stationarySnapshotDeltas(anchor, current);
      stableObservations += 1;
      if (stableObservations >= WINDOW_STABILITY_OBSERVATIONS) {
        return { first, snapshot: current, observations: stableObservations, deltas };
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      anchor = current;
      stableObservations = 1;
    }
  }
  throw new Error(
    `The exact UX-01 native/renderer window did not reach ${WINDOW_STABILITY_OBSERVATIONS} bounded stable observations: ${lastError?.message ?? 'no stable observation'}.`,
  );
}

async function captureActionReadySnapshot(
  page: Page,
  driver: string,
  pid: number,
  baseline: WindowGeometrySnapshot,
  label: string,
): Promise<{ snapshot: WindowGeometrySnapshot; deltas: ReturnType<typeof stationarySnapshotDeltas> }> {
  const snapshot = await captureWindowGeometrySnapshot(page, driver, pid, baseline.window.windowId);
  try {
    return { snapshot, deltas: stationarySnapshotDeltas(baseline, snapshot) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The exact UX-01 ${label} action-ready snapshot changed after target observation: ${message}; `
        + `before=${JSON.stringify(baseline.geometry)}; current=${JSON.stringify(snapshot.geometry)}.`,
    );
  }
}

function boundsArguments(windowRecord: { bounds: { x: number; y: number; width: number; height: number } }): string[] {
  return [windowRecord.bounds.x, windowRecord.bounds.y, windowRecord.bounds.width, windowRecord.bounds.height].map(String);
}

async function postClick(
  driver: string,
  pid: number,
  windowRecord: { windowId: number; bounds: { x: number; y: number; width: number; height: number } },
  point: { x: number; y: number },
) {
  const result = parseUx01WindowDriverAction(await runDriver(driver, [
    'click', String(pid), String(windowRecord.windowId), ...boundsArguments(windowRecord), String(point.x), String(point.y),
  ]));
  if (result.pid !== pid || result.windowId !== windowRecord.windowId || result.action !== 'click') {
    throw new Error('The macOS driver did not bind its click to the exact owner/window.');
  }
  return result;
}

async function postOptionClick(
  driver: string,
  pid: number,
  windowRecord: { windowId: number; bounds: { x: number; y: number; width: number; height: number } },
  point: { x: number; y: number },
) {
  const result = parseUx01WindowDriverAction(await runDriver(driver, [
    'option-click', String(pid), String(windowRecord.windowId), ...boundsArguments(windowRecord), String(point.x), String(point.y),
  ]));
  if (result.pid !== pid || result.windowId !== windowRecord.windowId || result.action !== 'option-click') {
    throw new Error('The macOS driver did not bind its Option-click to the exact owner/window.');
  }
  return result;
}

async function postDrag(
  driver: string,
  pid: number,
  windowRecord: { windowId: number; bounds: { x: number; y: number; width: number; height: number } },
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const result = parseUx01WindowDriverAction(await runDriver(driver, [
    'drag', String(pid), String(windowRecord.windowId), ...boundsArguments(windowRecord),
    String(start.x), String(start.y), String(end.x), String(end.y),
  ]));
  if (result.pid !== pid || result.windowId !== windowRecord.windowId || result.action !== 'drag') {
    throw new Error('The macOS driver did not bind its drag to the exact owner/window.');
  }
  return result;
}

async function waitForWindowInspection(
  driver: string,
  pid: number,
  predicate: (inspection: ReturnType<typeof parseUx01WindowDriverInspection>) => boolean,
  label: string,
) {
  const deadline = Date.now() + 15_000;
  let inspection = await inspectOwner(driver, pid);
  while (Date.now() < deadline) {
    inspection = await inspectOwner(driver, pid);
    if (predicate(inspection)) return inspection;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(inspection.windows)}.`);
}

async function chromeHitTargets(page: Page): Promise<{
  topbarRegion: string;
  buttonRegion: string;
  verificationStep: number;
  drag: { region: 'drag'; point: { x: number; y: number }; safeRect: { x: number; y: number; width: number; height: number } };
  interactiveClick: { region: 'no-drag'; point: { x: number; y: number }; safeRect: { x: number; y: number; width: number; height: number } };
  interactiveGesture: {
    start: { region: 'no-drag'; point: { x: number; y: number }; safeRect: { x: number; y: number; width: number; height: number } };
    end: { region: 'no-drag'; point: { x: number; y: number }; safeRect: { x: number; y: number; width: number; height: number } };
  };
}> {
  return page.evaluate(({ reservedWidth, uncertainty }) => {
    const topbar = document.querySelector<HTMLElement>('.topbar');
    const brand = document.querySelector<HTMLElement>('.brand');
    const button = document.querySelector<HTMLElement>('button[aria-label="All open documents"]');
    if (!topbar || !brand || !button) throw new Error('The exact renderer is missing its top-bar acceptance targets.');
    const topbarRect = topbar.getBoundingClientRect();
    const brandRect = brand.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const topbarRegion = getComputedStyle(topbar).getPropertyValue('-webkit-app-region').trim();
    const buttonRegion = getComputedStyle(button).getPropertyValue('-webkit-app-region').trim();
    if (topbarRegion !== 'drag' || buttonRegion !== 'no-drag') {
      throw new Error('The exact renderer does not expose the declared drag/no-drag region contract.');
    }
    const step = 0.5;
    const interactiveSelector = 'button,input,select,textarea,a,[role="menu"],[role="dialog"]';
    const verifyRect = (
      rect: { x: number; y: number; width: number; height: number },
      predicate: (hit: Element) => boolean,
      label: string,
    ) => {
      if (rect.width <= 0 || rect.height <= 0) throw new Error(`The exact renderer returned an empty ${label} hit-test rectangle.`);
      for (let y = rect.y; y <= rect.y + rect.height; y += step) {
        for (let x = rect.x; x <= rect.x + rect.width; x += step) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || !predicate(hit)) throw new Error(`The complete ${label} hit-test neighborhood is not safe.`);
        }
      }
    };
    const pointRect = (left: number, right: number, y: number) => ({
      x: left - uncertainty,
      y: y - uncertainty,
      width: (right - left) + uncertainty * 2,
      height: uncertainty * 2,
    });
    const y = topbarRect.top + topbarRect.height / 2;
    let dragPoint: { x: number; y: number } | undefined;
    for (let x = Math.max(brandRect.left + reservedWidth + 4, topbarRect.left + reservedWidth + 4); x < brandRect.right - 4; x += 2) {
      const safeRect = pointRect(x, x, y);
      try {
        verifyRect(safeRect, (hit) => topbar.contains(hit) && !hit.closest(interactiveSelector), 'app-region drag');
        dragPoint = { x, y };
        break;
      } catch { /* keep searching for a complete non-interactive neighborhood */ }
    }
    if (!dragPoint) throw new Error('The exact renderer has no non-interactive point in its intended drag region.');
    const interactiveCenter = { x: buttonRect.left + buttonRect.width / 2, y: buttonRect.top + buttonRect.height / 2 };
    const gestureDistance = Math.min(4, Math.floor((buttonRect.width - (uncertainty * 2) - 4) / 4));
    if (gestureDistance < 2) throw new Error('The exact no-drag control has no bounded in-control gesture corridor.');
    const gestureStart = { x: interactiveCenter.x - gestureDistance, y: interactiveCenter.y };
    const gestureEnd = { x: interactiveCenter.x + gestureDistance, y: interactiveCenter.y };
    const interactiveSafeRect = pointRect(gestureStart.x, gestureEnd.x, interactiveCenter.y);
    if (interactiveSafeRect.x < buttonRect.left || interactiveSafeRect.y < buttonRect.top
      || interactiveSafeRect.x + interactiveSafeRect.width > buttonRect.right
      || interactiveSafeRect.y + interactiveSafeRect.height > buttonRect.bottom) {
      throw new Error('The no-drag action neighborhood does not fit inside its named control.');
    }
    verifyRect(interactiveSafeRect, (hit) => hit === button || hit.closest('button') === button, 'interactive no-drag');
    const dragSafeRect = pointRect(dragPoint.x, dragPoint.x, dragPoint.y);
    return {
      topbarRegion,
      buttonRegion,
      verificationStep: step,
      drag: { region: 'drag', point: dragPoint, safeRect: dragSafeRect },
      interactiveClick: { region: 'no-drag', point: interactiveCenter, safeRect: interactiveSafeRect },
      interactiveGesture: {
        start: { region: 'no-drag', point: gestureStart, safeRect: interactiveSafeRect },
        end: { region: 'no-drag', point: gestureEnd, safeRect: interactiveSafeRect },
      },
    };
  }, {
    reservedWidth: MACOS_EDITOR_WINDOW_CHROME.trafficLightReservedWidth,
    uncertainty: UX01_WINDOW_ACTION_MAPPING_UNCERTAINTY,
  });
}

function dragDelta(measurement: NativeMeasurement): { x: number; y: number } {
  const candidates = [{ x: 80, y: 0 }, { x: -80, y: 0 }];
  const chosen = candidates.find((delta) => {
    const nextX = measurement.outer.x + delta.x;
    return nextX >= measurement.screen.availLeft
      && nextX + measurement.outer.width <= measurement.screen.availLeft + measurement.screen.availWidth;
  });
  if (!chosen) throw new Error('The exact renderer work area has no bounded horizontal drag route.');
  return chosen;
}

test(UX01_WINDOW_CHROME_SCENARIO, async ({ browserName }, testInfo) => {
  test.skip(process.platform !== 'darwin' || process.arch !== 'arm64', 'This prepared checkpoint is the exact current macOS/arm64 acceptance only.');
  test.setTimeout(150_000);
  if (browserName !== 'chromium') throw new Error('UX-01 window-chrome acceptance requires Playwright Chromium protocol support.');
  if (testInfo.project.metadata.suite !== 'retained-ux01-window-chrome'
    || process.env.AIDRAW_E2E_UX01_WINDOW_CHROME_WRAPPER !== '1') {
    throw new Error('UX-01 window-chrome acceptance was not admitted by its dedicated private wrapper.');
  }
  const configured = resolveUx01WindowChromeAcceptance();
  expect(artifact.platform).toBe('darwin');
  expect(artifact.arch).toBe('arm64');
  expect(await sha256(executable)).toBe(configured.executableSha256);
  expect(await sha256(asar)).toBe(configured.asarSha256);
  expect(await access(configured.profile).then(() => true, () => false), 'The retained UX-01 profile must not exist before launch.').toBe(false);
  await mkdir(configured.profile, { recursive: false, mode: 0o700 });
  if (((await stat(configured.profile)).mode & 0o777) !== 0o700) throw new Error('The retained UX-01 profile is not mode 0700.');
  for (const path of Object.values(configured.paths)) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const port = await reservePort();
  const stderr: Buffer[] = [];
  const externalRendererRequests: string[] = [];
  const child = spawnPackagedE2e(executable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    ...networkDisabledArguments,
    `--user-data-dir=${configured.profile}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ownerPid = child.pid;
  if (!ownerPid) throw new Error('The exact UX-01 package launch returned no owner PID.');
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

  let browser: Browser | undefined;
  let acceptanceFailure: Error | undefined;
  let evidence: Record<string, unknown> | undefined;
  let cleanup: CleanupRecord | undefined;
  let failureDiagnostics: Record<string, unknown> = { stage: 'launch' };
  try {
    browser = await waitForPackagedE2eReady({
      child,
      label: 'The retained UX-01 window-chrome DevTools endpoint',
      stderr: () => Buffer.concat(stderr).toString('utf8'),
      attempt: async () => {
        try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
        catch { return undefined; }
      },
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error('The retained UX-01 owner has no default browser context.');
    context.on('request', (request) => {
      if (!isPermittedRendererUrl(request.url())) externalRendererRequests.push(request.url());
    });
    let page = await waitForSingleRendererPage(context);
    const processShapeBefore = await waitForProcessShape(configured.profile, ownerPid);
    const originalRendererPid = processShapeBefore.find((entry) => entry.type === 'renderer')?.pid;
    if (!originalRendererPid) throw new Error('The exact UX-01 owner has no original renderer PID.');

    failureDiagnostics = { stage: 'native-window-stability', ownerPid, processShapeBefore };
    const initialStability = await waitForStableWindowGeometry(page, configured.driverExecutable, ownerPid);
    const initialSnapshot = initialStability.snapshot;
    const initialMeasurement = initialSnapshot.measurement;
    const initialInspection = initialSnapshot.inspection;
    const initialGeometry = initialSnapshot.geometry;
    const initialWindow = initialSnapshot.window;
    const initialRelation = initialSnapshot.relation;
    failureDiagnostics = {
      stage: 'native-window-stability', ownerPid, processShapeBefore,
      first: initialStability.first.geometry, stable: initialGeometry,
      observations: initialStability.observations, deltas: initialStability.deltas,
      relation: initialRelation,
    };
    const nominalTrafficLights = deriveUx01TrafficLightCenters(initialInspection.buttonMetrics, {
      trafficLightPosition: MACOS_EDITOR_WINDOW_CHROME.trafficLightPosition,
      trafficLightReservedWidth: MACOS_EDITOR_WINDOW_CHROME.trafficLightReservedWidth,
      topbarHeight: EDITOR_DENSITY.topbarHeight,
    });
    const initialTargets = await chromeHitTargets(page);
    expect(initialTargets.topbarRegion).toBe('drag');
    expect(initialTargets.buttonRegion).toBe('no-drag');
    expect(initialTargets.verificationStep).toBe(0.5);
    const initialClickAdmission = await captureActionReadySnapshot(
      page, configured.driverExecutable, ownerPid, initialSnapshot, 'interactive no-drag click',
    );
    const initialInteractiveClick = mapUx01RendererHitTargetToQuartzLocal(
      initialClickAdmission.snapshot.relation, initialTargets.interactiveClick,
    );

    failureDiagnostics = {
      stage: 'interactive-no-drag-click', ownerPid, processShapeBefore,
      stable: initialGeometry, before: initialClickAdmission.snapshot.geometry,
      relation: initialClickAdmission.snapshot.relation,
      admissionDeltas: initialClickAdmission.deltas, target: initialInteractiveClick,
    };
    await postClick(
      configured.driverExecutable, ownerPid, initialClickAdmission.snapshot.window, initialInteractiveClick.point,
    );
    await expect(page.getByRole('menu', { name: 'All open documents' })).toBeVisible();
    const afterInteractiveClick = await inspectOwner(configured.driverExecutable, ownerPid);
    const afterInteractiveClickMeasurement = await nativeMeasurement(page);
    const afterInteractiveClickGeometry = createUx01WindowGeometryDiagnostics(afterInteractiveClick, afterInteractiveClickMeasurement);
    failureDiagnostics = { ...failureDiagnostics, after: afterInteractiveClickGeometry };
    if (afterInteractiveClick.windows.length !== 1) throw new Error('The no-drag click changed the exact native window count.');
    const afterInteractiveClickRelation = deriveUx01DecoratedFrameRelation(afterInteractiveClick.windows[0], afterInteractiveClickMeasurement);
    const afterInteractiveClickSnapshot = windowGeometrySnapshot(
      afterInteractiveClick, afterInteractiveClickMeasurement, initialWindow.windowId,
    );
    failureDiagnostics = { ...failureDiagnostics, afterRelation: afterInteractiveClickRelation };
    const noDragClickDeltas = assertUx01WindowStationaryWithinCoordinateSpaces({
      nativeBefore: initialClickAdmission.snapshot.window,
      nativeAfter: afterInteractiveClick.windows[0],
      rendererBefore: initialClickAdmission.snapshot.measurement.outer,
      rendererAfter: afterInteractiveClickMeasurement.outer,
    });
    const noDragClickRelationDeltas = assertUx01DecoratedFrameRelationStable(
      initialClickAdmission.snapshot.relation, afterInteractiveClickRelation,
    );
    await page.keyboard.press('Escape');

    const noDragTargets = await chromeHitTargets(page);
    const noDragAdmission = await captureActionReadySnapshot(
      page, configured.driverExecutable, ownerPid, afterInteractiveClickSnapshot, 'interactive no-drag gesture',
    );
    const noDragStart = mapUx01RendererHitTargetToQuartzLocal(
      noDragAdmission.snapshot.relation, noDragTargets.interactiveGesture.start,
    );
    const noDragEnd = mapUx01RendererHitTargetToQuartzLocal(
      noDragAdmission.snapshot.relation, noDragTargets.interactiveGesture.end,
    );
    failureDiagnostics = {
      stage: 'interactive-no-drag-gesture', ownerPid, processShapeBefore,
      stable: afterInteractiveClickGeometry, before: noDragAdmission.snapshot.geometry,
      relation: noDragAdmission.snapshot.relation, admissionDeltas: noDragAdmission.deltas,
      targets: { start: noDragStart, end: noDragEnd },
    };
    await postDrag(
      configured.driverExecutable, ownerPid, noDragAdmission.snapshot.window, noDragStart.point, noDragEnd.point,
    );
    const afterNoDrag = await inspectOwner(configured.driverExecutable, ownerPid);
    const afterNoDragMeasurement = await nativeMeasurement(page);
    const afterNoDragGeometry = createUx01WindowGeometryDiagnostics(afterNoDrag, afterNoDragMeasurement);
    failureDiagnostics = { ...failureDiagnostics, after: afterNoDragGeometry };
    if (afterNoDrag.windows.length !== 1) throw new Error('The no-drag gesture changed the exact native window count.');
    const afterNoDragRelation = deriveUx01DecoratedFrameRelation(afterNoDrag.windows[0], afterNoDragMeasurement);
    const afterNoDragSnapshot = windowGeometrySnapshot(afterNoDrag, afterNoDragMeasurement, initialWindow.windowId);
    failureDiagnostics = { ...failureDiagnostics, afterRelation: afterNoDragRelation };
    const noDragGestureDeltas = assertUx01WindowStationaryWithinCoordinateSpaces({
      nativeBefore: noDragAdmission.snapshot.window,
      nativeAfter: afterNoDrag.windows[0],
      rendererBefore: noDragAdmission.snapshot.measurement.outer,
      rendererAfter: afterNoDragMeasurement.outer,
    });
    const noDragGestureRelationDeltas = assertUx01DecoratedFrameRelationStable(
      noDragAdmission.snapshot.relation, afterNoDragRelation,
    );
    const allDocuments = page.getByRole('button', { name: 'All open documents' });
    const documentsMenu = page.getByRole('menu', { name: 'All open documents' });
    if (await documentsMenu.isVisible()) await page.keyboard.press('Escape');
    await allDocuments.focus();
    await page.keyboard.press('Enter');
    await expect(documentsMenu).toBeVisible();
    await page.keyboard.press('Escape');

    const dragTargets = await chromeHitTargets(page);
    const dragAdmission = await captureActionReadySnapshot(
      page, configured.driverExecutable, ownerPid, afterNoDragSnapshot, 'intended app-region drag',
    );
    const dragStart = mapUx01RendererHitTargetToQuartzLocal(dragAdmission.snapshot.relation, dragTargets.drag);
    const delta = dragDelta(dragAdmission.snapshot.measurement);
    const dragEnd = mapUx01FramePointToQuartzLocal(dragAdmission.snapshot.relation, {
      x: dragTargets.drag.point.x + delta.x,
      y: dragTargets.drag.point.y + delta.y,
    });
    failureDiagnostics = {
      stage: 'intended-app-region-drag', ownerPid, processShapeBefore,
      stable: afterNoDragGeometry, before: dragAdmission.snapshot.geometry,
      relation: dragAdmission.snapshot.relation, admissionDeltas: dragAdmission.deltas,
      targets: { start: dragStart, end: dragEnd }, requestedDelta: delta,
    };
    await postDrag(configured.driverExecutable, ownerPid, dragAdmission.snapshot.window, dragStart.point, dragEnd);
    const draggedMeasurement = await waitForMeasurement(
      page,
      (value) => Math.abs(value.outer.x - dragAdmission.snapshot.measurement.outer.x) >= 40
        && Math.abs(value.outer.y - dragAdmission.snapshot.measurement.outer.y) <= 2,
      'The intended app-region drag did not move only the exact run-owned window',
    );
    const draggedInspection = await waitForWindowInspection(
      configured.driverExecutable,
      ownerPid,
      (value) => value.windows.length === 1
        && value.windows[0].windowId === initialWindow.windowId
        && value.windows[0].onScreen
        && Math.abs(value.windows[0].bounds.x - dragAdmission.snapshot.window.bounds.x) >= 40
        && Math.abs(value.windows[0].bounds.y - dragAdmission.snapshot.window.bounds.y) <= 2,
      'The intended app-region drag did not move the exact native window independently',
    );
    const draggedGeometry = createUx01WindowGeometryDiagnostics(draggedInspection, draggedMeasurement);
    failureDiagnostics = { ...failureDiagnostics, after: draggedGeometry, requestedDelta: delta };
    const draggedRelation = deriveUx01DecoratedFrameRelation(draggedInspection.windows[0], draggedMeasurement);
    const draggedSnapshot = windowGeometrySnapshot(draggedInspection, draggedMeasurement, initialWindow.windowId);
    failureDiagnostics = { ...failureDiagnostics, afterRelation: draggedRelation };
    const dragDeltas = assertUx01WindowMovedWithinCoordinateSpaces({
      nativeBefore: dragAdmission.snapshot.window,
      nativeAfter: draggedInspection.windows[0],
      rendererBefore: dragAdmission.snapshot.measurement.outer,
      rendererAfter: draggedMeasurement.outer,
      requestedDelta: delta,
    });
    const dragRelationDeltas = assertUx01DecoratedFrameRelationStable(dragAdmission.snapshot.relation, draggedRelation);
    expect(draggedMeasurement.content).toEqual(initialMeasurement.content);

    const zoomAdmission = await captureActionReadySnapshot(
      page, configured.driverExecutable, ownerPid, draggedSnapshot, 'native Option-click standard zoom',
    );
    const draggedZoomPoint = mapUx01FramePointToQuartzLocal(zoomAdmission.snapshot.relation, nominalTrafficLights.zoom);
    failureDiagnostics = {
      stage: 'native-option-zoom-toggle', ownerPid, processShapeBefore,
      stable: draggedGeometry, before: zoomAdmission.snapshot.geometry,
      relation: zoomAdmission.snapshot.relation, admissionDeltas: zoomAdmission.deltas,
      nativeTarget: draggedZoomPoint,
    };
    await postOptionClick(
      configured.driverExecutable, ownerPid, zoomAdmission.snapshot.window, draggedZoomPoint,
    );
    const zoomedMeasurement = await waitForMeasurement(
      page,
      (value) => !sameBounds(value.outer, zoomAdmission.snapshot.measurement.outer),
      'The native green-button Option-click did not produce a distinct standard-zoom geometry state',
    );
    const zoomedInspection = await waitForWindowInspection(
      configured.driverExecutable,
      ownerPid,
      (value) => value.windows.length === 1 && value.windows[0].windowId === initialWindow.windowId && value.windows[0].onScreen,
      'The native green-button Option-click changed exact window identity',
    );
    const zoomedGeometry = createUx01WindowGeometryDiagnostics(zoomedInspection, zoomedMeasurement);
    failureDiagnostics = { ...failureDiagnostics, zoomed: zoomedGeometry };
    const zoomedRelation = deriveUx01DecoratedFrameRelation(zoomedInspection.windows[0], zoomedMeasurement);
    const zoomedSnapshot = windowGeometrySnapshot(zoomedInspection, zoomedMeasurement, initialWindow.windowId);
    failureDiagnostics = { ...failureDiagnostics, zoomedRelation };
    assertUx01WindowInsideWorkArea(zoomedMeasurement);
    expect(child.exitCode).toBeNull();
    expect(browser.isConnected()).toBe(true);
    const zoomRestoreAdmission = await captureActionReadySnapshot(
      page, configured.driverExecutable, ownerPid, zoomedSnapshot, 'native Option-click standard-zoom restore',
    );
    const zoomedZoomPoint = mapUx01FramePointToQuartzLocal(
      zoomRestoreAdmission.snapshot.relation, nominalTrafficLights.zoom,
    );
    failureDiagnostics = {
      ...failureDiagnostics, restoreBefore: zoomRestoreAdmission.snapshot.geometry,
      restoreRelation: zoomRestoreAdmission.snapshot.relation,
      restoreAdmissionDeltas: zoomRestoreAdmission.deltas,
    };
    await postOptionClick(
      configured.driverExecutable, ownerPid, zoomRestoreAdmission.snapshot.window, zoomedZoomPoint,
    );
    const restoredAfterZoom = await waitForMeasurement(
      page,
      (value) => sameBounds(value.outer, zoomAdmission.snapshot.measurement.outer),
      'The second native green-button Option-click did not restore the prior standard-zoom geometry',
    );
    const restoredAfterZoomInspection = await waitForWindowInspection(
      configured.driverExecutable,
      ownerPid,
      (value) => value.windows.length === 1 && value.windows[0].windowId === initialWindow.windowId && value.windows[0].onScreen,
      'The second native green-button Option-click changed exact window identity',
    );
    const restoredAfterZoomGeometry = createUx01WindowGeometryDiagnostics(restoredAfterZoomInspection, restoredAfterZoom);
    failureDiagnostics = { ...failureDiagnostics, restored: restoredAfterZoomGeometry };
    const restoredAfterZoomRelation = deriveUx01DecoratedFrameRelation(restoredAfterZoomInspection.windows[0], restoredAfterZoom);
    const restoredAfterZoomSnapshot = windowGeometrySnapshot(
      restoredAfterZoomInspection, restoredAfterZoom, initialWindow.windowId,
    );
    failureDiagnostics = { ...failureDiagnostics, restoredRelation: restoredAfterZoomRelation };
    const zoomRestoreDeltas = assertUx01WindowStationaryWithinCoordinateSpaces({
      nativeBefore: zoomAdmission.snapshot.window,
      nativeAfter: restoredAfterZoomInspection.windows[0],
      rendererBefore: zoomAdmission.snapshot.measurement.outer,
      rendererAfter: restoredAfterZoom.outer,
    });
    const zoomRestoreRelationDeltas = assertUx01DecoratedFrameRelationStable(
      zoomAdmission.snapshot.relation, restoredAfterZoomRelation,
    );

    const minimizeAdmission = await captureActionReadySnapshot(
      page, configured.driverExecutable, ownerPid, restoredAfterZoomSnapshot, 'native minimize',
    );
    const beforeMinimizeGeometry = minimizeAdmission.snapshot.geometry;
    const beforeMinimizeRelation = minimizeAdmission.snapshot.relation;
    const minimizePoint = mapUx01FramePointToQuartzLocal(beforeMinimizeRelation, nominalTrafficLights.minimize);
    failureDiagnostics = {
      stage: 'native-minimize-and-show', ownerPid, processShapeBefore,
      stable: restoredAfterZoomGeometry, before: beforeMinimizeGeometry,
      relation: beforeMinimizeRelation, admissionDeltas: minimizeAdmission.deltas,
      nativeTarget: minimizePoint,
    };
    await postClick(configured.driverExecutable, ownerPid, minimizeAdmission.snapshot.window, minimizePoint);
    const minimizedInspection = await waitForWindowInspection(
      configured.driverExecutable,
      ownerPid,
      (value) => value.windows.length === 1 && value.windows[0].windowId === initialWindow.windowId && !value.windows[0].onScreen,
      'The native minimize traffic light did not move the exact window off screen',
    );
    const minimizedMeasurement = await nativeMeasurement(page);
    const minimizedGeometry = createUx01WindowGeometryDiagnostics(minimizedInspection, minimizedMeasurement);
    failureDiagnostics = { ...failureDiagnostics, minimized: minimizedGeometry };
    expect(child.exitCode).toBeNull();
    const minimizeShow = await signalOwner(configured.profile, '--show');
    const shownInspection = await waitForWindowInspection(
      configured.driverExecutable,
      ownerPid,
      (value) => value.windows.length === 1 && value.windows[0].windowId === initialWindow.windowId && value.windows[0].onScreen,
      'The exact same-profile show did not restore the minimized window',
    );
    const shownMeasurement = await waitForMeasurement(page, (value) => sameBounds(value.outer, restoredAfterZoom.outer), 'The restored minimized window changed geometry');
    const shownGeometry = createUx01WindowGeometryDiagnostics(shownInspection, shownMeasurement);
    failureDiagnostics = { ...failureDiagnostics, restored: shownGeometry };
    const shownRelation = deriveUx01DecoratedFrameRelation(shownInspection.windows[0], shownMeasurement);
    failureDiagnostics = { ...failureDiagnostics, restoredRelation: shownRelation };
    const minimizeRestoreDeltas = assertUx01WindowStationaryWithinCoordinateSpaces({
      nativeBefore: minimizeAdmission.snapshot.window,
      nativeAfter: shownInspection.windows[0],
      rendererBefore: minimizeAdmission.snapshot.measurement.outer,
      rendererAfter: shownMeasurement.outer,
    });
    const minimizeRestoreRelationDeltas = assertUx01DecoratedFrameRelationStable(beforeMinimizeRelation, shownRelation);

    const shownSnapshot = windowGeometrySnapshot(shownInspection, shownMeasurement, initialWindow.windowId);
    const closeAdmission = await captureActionReadySnapshot(
      page, configured.driverExecutable, ownerPid, shownSnapshot, 'native close',
    );
    const closePoint = mapUx01FramePointToQuartzLocal(closeAdmission.snapshot.relation, nominalTrafficLights.close);
    failureDiagnostics = {
      stage: 'native-close-and-show', ownerPid, processShapeBefore,
      stable: shownGeometry, before: closeAdmission.snapshot.geometry,
      relation: closeAdmission.snapshot.relation, admissionDeltas: closeAdmission.deltas,
      nativeTarget: closePoint,
    };
    const closeEvent = page.waitForEvent('close');
    await postClick(configured.driverExecutable, ownerPid, closeAdmission.snapshot.window, closePoint);
    await closeEvent;
    const closedInspection = await waitForWindowInspection(
      configured.driverExecutable,
      ownerPid,
      (value) => value.windows.length === 0,
      'The native close traffic light did not retire the exact editor window',
    );
    expect(child.exitCode).toBeNull();
    expect(browser.isConnected()).toBe(true);
    const closeShow = await signalOwner(configured.profile, '--show');
    page = await waitForSingleRendererPage(context);
    const processShapeAfter = await waitForProcessShape(configured.profile, ownerPid);
    const replacementRendererPid = processShapeAfter.find((entry) => entry.type === 'renderer')?.pid;
    if (!replacementRendererPid || replacementRendererPid === originalRendererPid) {
      throw new Error('The native close/show route did not admit exactly one replacement renderer.');
    }
    const reopenedInspection = await waitForWindowInspection(
      configured.driverExecutable,
      ownerPid,
      (value) => value.windows.length === 1 && value.windows[0].onScreen && value.windows[0].windowId !== initialWindow.windowId,
      'The exact same-profile show did not create one distinct native editor window',
    );
    const reopenedMeasurement = await nativeMeasurement(page);
    const reopenedGeometry = createUx01WindowGeometryDiagnostics(reopenedInspection, reopenedMeasurement);
    failureDiagnostics = { ...failureDiagnostics, reopened: reopenedGeometry, processShapeAfter };
    const reopenedRelation = deriveUx01DecoratedFrameRelation(reopenedInspection.windows[0], reopenedMeasurement);
    failureDiagnostics = { ...failureDiagnostics, reopenedRelation };
    await expect(page.getByRole('button', { name: 'All open documents' })).toBeVisible();
    expect(externalRendererRequests).toEqual([]);
    for (const path of [configured.paths.providerCredentials, configured.paths.forbiddenNetwork]) {
      expect(await access(path).then(() => true, () => false), `${path} must remain absent`).toBe(false);
    }

    evidence = {
      scenario: UX01_WINDOW_CHROME_SCENARIO,
      result: 'passed',
      package: {
        executable,
        executableBytes: (await stat(executable)).size,
        executableSha256: configured.executableSha256,
        asar,
        asarBytes: (await stat(asar)).size,
        asarSha256: configured.asarSha256,
        platform: artifact.platform,
        arch: artifact.arch,
      },
      driver: {
        source: configured.driverSource,
        sourceSha256: await sha256(configured.driverSource),
        executable: configured.driverExecutable,
        executableBytes: (await stat(configured.driverExecutable)).size,
        executableSha256: await sha256(configured.driverExecutable),
        prelaunchPostEventAccessPreflight: true,
        actionTimePostEventAccessRechecks: true,
        api: 'public CoreGraphics exact-PID event posting plus read-only exact-owner Quartz window metadata; no Accessibility API',
      },
      isolation: {
        profile: configured.profile,
        defaultProfileUntouched: true,
        earlierRetainedEvidenceUntouched: true,
        remoteDebuggingAddress: '127.0.0.1',
        controllerEnvironment: 'explicit non-provider allowlist',
      },
      owner: {
        pid: ownerPid,
        spawnedOwnerPidBound: true,
        processShapeBefore,
        processShapeAfter,
        originalRendererPid,
        replacementRendererPid,
        exactWindowCount: 1,
      },
      windowChrome: {
        contract: MACOS_EDITOR_WINDOW_CHROME,
        coordinateModel: initialGeometry.coordinateModel,
        standardButtonMetrics: initialInspection.buttonMetrics,
        stability: {
          requiredObservations: WINDOW_STABILITY_OBSERVATIONS,
          intervalMs: WINDOW_STABILITY_INTERVAL_MS,
          timeoutMs: WINDOW_STABILITY_TIMEOUT_MS,
          observations: initialStability.observations,
          first: initialStability.first.geometry,
          stable: initialGeometry,
          deltas: initialStability.deltas,
        },
        actionAdmissions: {
          interactiveClick: initialClickAdmission.deltas,
          interactiveGesture: noDragAdmission.deltas,
          intendedDrag: dragAdmission.deltas,
          standardZoom: zoomAdmission.deltas,
          standardZoomRestore: zoomRestoreAdmission.deltas,
          minimize: minimizeAdmission.deltas,
          close: closeAdmission.deltas,
        },
        trafficLights: {
          nominalFrame: nominalTrafficLights,
          mappedZoomBeforeChange: draggedZoomPoint,
          mappedZoomBeforeRestore: zoomedZoomPoint,
          mappedMinimize: minimizePoint,
          mappedClose: closePoint,
        },
        initial: {
          renderer: initialMeasurement,
          native: initialWindow,
          decoratedFrameRelation: initialRelation,
          interactiveTarget: initialInteractiveClick,
        },
        noDrag: {
          nativeClickOpenedMenu: true,
          dragDidNotMoveWindow: true,
          keyboardStillUsable: true,
          clickDeltas: noDragClickDeltas,
          clickRelationDeltas: noDragClickRelationDeltas,
          gestureDeltas: noDragGestureDeltas,
          gestureRelationDeltas: noDragGestureRelationDeltas,
          completeHitTestStep: noDragTargets.verificationStep,
        },
        drag: {
          requestedDelta: delta,
          independentDeltas: dragDeltas,
          relationDeltas: dragRelationDeltas,
          target: dragStart,
          renderer: draggedMeasurement,
          native: draggedInspection.windows[0],
        },
        standardZoom: {
          action: 'native green-button Option-click',
          changed: { renderer: zoomedMeasurement, native: zoomedInspection.windows[0] },
          restored: { renderer: restoredAfterZoom, native: restoredAfterZoomInspection.windows[0] },
          restoreDeltas: zoomRestoreDeltas,
          relationDeltas: zoomRestoreRelationDeltas,
          workAreaContained: true,
          windowIdPreserved: true,
        },
        minimize: {
          native: minimizedInspection.windows[0],
          showSignal: minimizeShow,
          restored: { native: shownInspection.windows[0], renderer: shownMeasurement },
          restoreDeltas: minimizeRestoreDeltas,
          relationDeltas: minimizeRestoreRelationDeltas,
        },
        close: {
          windowsAfterClose: closedInspection.windows.length,
          showSignal: closeShow,
          reopened: { native: reopenedInspection.windows[0], renderer: reopenedMeasurement },
          reopenedRelation,
        },
      },
      privacy: {
        directlyObservedExternalRendererRequests: 0,
        providerCredentialsAbsent: true,
        forbiddenNetworkSentinelAbsent: true,
        controllerCredentialValuesAccessed: false,
      },
      nonClaims: [
        'os-accessibility-or-computer-use', 'arbitrary-macos-or-electron-version', 'windows-or-linux-window-chrome',
        'smaller-than-supported-work-area', 'custom-workspace-persistence', 'assistive-technology',
        'high-dpi-or-mixed-display', 'release-candidate', 'stable-v1',
      ],
    };
  } catch (error) {
    acceptanceFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    cleanup = await stopOwner(child, browser, configured.profile);
    const cleanupSerialized = `${JSON.stringify(cleanup, null, 2)}\n`;
    assertUx01EvidenceRedacted(cleanupSerialized);
    await writePrivateRecord(configured.paths.cleanup, cleanupSerialized);
  }

  if (!cleanup.graceful && !acceptanceFailure) acceptanceFailure = new Error(`The retained UX-01 owner did not clean up gracefully: ${JSON.stringify(cleanup)}.`);
  if (acceptanceFailure || !evidence) {
    const failure = {
      scenario: UX01_WINDOW_CHROME_SCENARIO,
      result: 'failed',
      package: { executableSha256: configured.executableSha256, asarSha256: configured.asarSha256, platform: artifact.platform, arch: artifact.arch },
      error: redactUx01FailureText(acceptanceFailure?.message ?? 'The UX-01 window-chrome acceptance did not complete.'),
      diagnostics: failureDiagnostics,
      cleanup,
    };
    const serialized = `${JSON.stringify(failure, null, 2)}\n`;
    assertUx01EvidenceRedacted(serialized);
    await writePrivateRecord(configured.paths.failure, serialized);
    throw acceptanceFailure ?? new Error('The UX-01 window-chrome acceptance did not produce evidence.');
  }

  const serialized = `${JSON.stringify({ ...evidence, cleanup }, null, 2)}\n`;
  assertUx01EvidenceRedacted(serialized);
  await writePrivateRecord(configured.paths.evidence, serialized);
  expect(cleanup.graceful).toBe(true);
  expect(cleanup.ownedSurvivors).toEqual([]);
});
