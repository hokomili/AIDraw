import { expect, test, type Locator } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import {
  assertUx01ContentSizeRequest,
  assertUx01EvidenceRedacted,
  inspectUx01EncryptedToken,
  parseUx01WindowMeasurement,
  parseUx01OwnedProcesses,
  redactUx01FailureText,
  resolveUx01PackagedAcceptance,
  UX01_PACKAGED_SCENARIO,
} from '../../scripts/ux01-packaged-acceptance.mjs';
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

interface McpConnection {
  version: number;
  url: string;
  token: string;
  activeDocumentId: string;
  pid: number;
  trustedFolders: string[];
}

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

interface ControlGeometry {
  label: string;
  width: number;
  height: number;
  viewportContained: boolean;
  scrollContainerContained: boolean;
}

interface CleanupRecord {
  ownerPid?: number;
  ownerExitCode?: number | null;
  signalPid?: number;
  signalExitCode?: number | null;
  connectionCredentials: 'redacted-after-graceful-stop' | 'absent' | 'live-owner-not-stopped';
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
  if (!address || typeof address === 'string') throw new Error('Could not reserve the isolated UX-01 DevTools port.');
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

async function waitForConnection(path: string, child: ChildProcess): Promise<McpConnection> {
  return waitForPackagedE2eReady({
    child,
    label: 'The retained UX-01 MCP connection',
    timeoutMs: 20_000,
    attempt: async () => {
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as Partial<McpConnection>;
        if (value.version !== 1 || !value.url || !value.token || !value.activeDocumentId || !Number.isInteger(value.pid)) return undefined;
        const url = new URL(value.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp') throw new Error('The UX-01 MCP endpoint is not an exact loopback /mcp URL.');
        return { ...value, trustedFolders: value.trustedFolders ?? [] } as McpConnection;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
      }
    },
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

async function signalOwner(profile: string, argument: '--quit-engine') {
  const signal = spawnPackagedE2e(executable, [`--user-data-dir=${profile}`, argument], { stdio: 'ignore' });
  const exitCode = await waitForExit(signal, `The retained UX-01 ${argument} signal`, 10_000);
  if (exitCode !== 0) throw new Error(`The retained UX-01 ${argument} signal exited with ${String(exitCode)}.`);
  return { pid: signal.pid, exitCode };
}

async function redactConnection(path: string): Promise<{ status: 'redacted-after-graceful-stop' | 'absent'; secret?: string }> {
  if (!await access(path).then(() => true, () => false)) return { status: 'absent' };
  const connection = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const secret = typeof connection.token === 'string' ? connection.token : undefined;
  delete connection.token;
  await writeFile(path, `${JSON.stringify({ ...connection, credentialStatus: 'redacted-after-graceful-stop' }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { status: 'redacted-after-graceful-stop', secret };
}

async function stopOwner(
  child: ChildProcess | undefined,
  browser: Browser | undefined,
  profile: string,
  connectionPath: string,
  secrets: string[],
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
      await waitForExit(child, 'The retained UX-01 owner', 15_000);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const ownerStopped = Boolean(child && child.exitCode !== null);
  if (ownerStopped && browser?.isConnected()) await browser.close().catch(() => undefined);
  let redacted: Awaited<ReturnType<typeof redactConnection>> | { status: 'live-owner-not-stopped' } = { status: 'live-owner-not-stopped' };
  try {
    redacted = ownerStopped ? await redactConnection(connectionPath) : redacted;
  } catch (error) {
    cleanupError ??= error instanceof Error ? error : new Error('The retained UX-01 connection could not be redacted.');
  }
  if ('secret' in redacted && redacted.secret) secrets.push(redacted.secret);
  let ownedSurvivors: OwnedProcess[] = [];
  try {
    ownedSurvivors = await waitForNoOwnedProcesses(profile);
  } catch (error) {
    cleanupError ??= error instanceof Error ? error : new Error('The retained UX-01 process survivors could not be inspected.');
  }
  const graceful = Boolean(child && child.exitCode === 0 && signalExitCode === 0 && redacted.status === 'redacted-after-graceful-stop' && ownedSurvivors.length === 0 && !cleanupError);
  return {
    ownerPid,
    ownerExitCode: child?.exitCode,
    signalPid,
    signalExitCode,
    connectionCredentials: redacted.status,
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

function expectNoRootViewportOverflow(measurement: NativeMeasurement): void {
  const exactViewport = {
    clientWidth: measurement.content.width,
    clientHeight: measurement.content.height,
    scrollWidth: measurement.content.width,
    scrollHeight: measurement.content.height,
  };
  expect(measurement.layout.root).toEqual(exactViewport);
  expect(measurement.layout.body).toEqual(exactViewport);
}

function expectOuterInsideWorkArea(measurement: NativeMeasurement): void {
  expect(measurement.outer.x).toBeGreaterThanOrEqual(measurement.screen.availLeft);
  expect(measurement.outer.y).toBeGreaterThanOrEqual(measurement.screen.availTop);
  expect(measurement.outer.x + measurement.outer.width)
    .toBeLessThanOrEqual(measurement.screen.availLeft + measurement.screen.availWidth);
  expect(measurement.outer.y + measurement.outer.height)
    .toBeLessThanOrEqual(measurement.screen.availTop + measurement.screen.availHeight);
}

async function requestNativeContentSize(page: Page, width: number, height: number): Promise<void> {
  const request = assertUx01ContentSizeRequest(width, height);
  await page.evaluate((size) => {
    if (typeof window.resizeTo !== 'function') throw new Error('The exact renderer has no native content-size request mechanism.');
    window.resizeTo(size.width, size.height);
  }, request);
}

async function waitForContentSize(page: Page, width: number, height: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })), { timeout: 8_000 }).toEqual({ width, height });
}

async function controlGeometry(locator: Locator, label: string, minimumWidth: number, minimumHeight: number): Promise<ControlGeometry> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const geometry = await locator.evaluate((element, expected) => {
    const rect = element.getBoundingClientRect();
    let scrollContainer: Element | null = element.parentElement;
    while (scrollContainer) {
      const style = getComputedStyle(scrollContainer);
      if (/(?:auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) break;
      scrollContainer = scrollContainer.parentElement;
    }
    const containerRect = scrollContainer?.getBoundingClientRect();
    const tolerance = 1;
    return {
      label: expected.label,
      width: rect.width,
      height: rect.height,
      viewportContained: rect.left >= -tolerance && rect.top >= -tolerance && rect.right <= innerWidth + tolerance && rect.bottom <= innerHeight + tolerance,
      scrollContainerContained: !containerRect || (rect.left >= containerRect.left - tolerance && rect.top >= containerRect.top - tolerance && rect.right <= containerRect.right + tolerance && rect.bottom <= containerRect.bottom + tolerance),
    };
  }, { label });
  expect(geometry.width, `${label} width`).toBeGreaterThanOrEqual(minimumWidth);
  expect(geometry.height, `${label} height`).toBeGreaterThanOrEqual(minimumHeight);
  expect(geometry.viewportContained, `${label} viewport containment`).toBe(true);
  expect(geometry.scrollContainerContained, `${label} local-scroll containment`).toBe(true);
  return geometry;
}

async function screenshotRecord(page: Page, path: string): Promise<{ file: string; bytes: number; sha256: string }> {
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', fullPage: false });
  return { file: basename(path), bytes: (await stat(path)).size, sha256: await sha256(path) };
}

async function completedScreenshotRecords(paths: readonly string[]): Promise<Array<{ file: string; bytes: number; sha256: string }>> {
  const records = await Promise.all(paths.map(async (path) => {
    if (!await access(path).then(() => true, () => false)) return undefined;
    return { file: basename(path), bytes: (await stat(path)).size, sha256: await sha256(path) };
  }));
  return records.filter((record): record is NonNullable<typeof record> => Boolean(record));
}

test(UX01_PACKAGED_SCENARIO, async () => {
  test.skip(process.platform !== 'darwin', 'This prepared checkpoint is the exact current macOS/arm64 acceptance only.');
  test.setTimeout(180_000);
  const configured = resolveUx01PackagedAcceptance();
  expect(artifact.platform).toBe('darwin');
  expect(artifact.arch).toBe('arm64');
  expect(await sha256(executable)).toBe(configured.executableSha256);
  expect(await sha256(asar)).toBe(configured.asarSha256);
  expect(await access(configured.profile).then(() => true, () => false), 'The retained UX-01 profile must not exist before launch.').toBe(false);
  await mkdir(configured.profile, { recursive: false, mode: 0o700 });
  await mkdir(dirname(configured.screenshots[0]), { recursive: false, mode: 0o700 });
  for (const path of [...Object.values(configured.paths), ...configured.screenshots]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const port = await reservePort();
  const stderr: Buffer[] = [];
  const externalRendererRequests: string[] = [];
  const secrets: string[] = [];
  const child = spawnPackagedE2e(executable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    ...networkDisabledArguments,
    `--user-data-dir=${configured.profile}`,
    `--write-mcp-connection=${configured.paths.ownerConnection}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

  let browser: Browser | undefined;
  let acceptanceFailure: Error | undefined;
  let evidence: Record<string, unknown> | undefined;
  let cleanup: CleanupRecord | undefined;
  let failureDiagnostics: Record<string, unknown> = { stage: 'launch' };
  try {
    const connection = await waitForConnection(configured.paths.ownerConnection, child);
    if (!child.pid || connection.pid !== child.pid) throw new Error('The retained UX-01 connection PID does not match the exact spawned owner.');
    expect(connection.trustedFolders).toEqual([]);
    secrets.push(connection.token);
    const tokenFile = JSON.parse(await readFile(configured.paths.tokenCredentials, 'utf8')) as Record<string, unknown>;
    inspectUx01EncryptedToken(tokenFile, connection.token);

    browser = await waitForPackagedE2eReady({
      child,
      label: 'The retained UX-01 DevTools endpoint',
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
    const page = await waitForSingleRendererPage(context);
    const processShape = await waitForProcessShape(configured.profile, child.pid);

    failureDiagnostics = {
      stage: 'default-content-viewport',
      requestedContent: { width: 1_520, height: 940 },
      ownerPid: child.pid,
      processShape,
    };
    const defaultWindow = await nativeMeasurement(page);
    failureDiagnostics = { ...failureDiagnostics, observed: defaultWindow };
    expect(defaultWindow.content).toMatchObject({ width: 1_520, height: 940 });
    expectOuterInsideWorkArea(defaultWindow);
    expect(defaultWindow.outer.width).toBeGreaterThanOrEqual(defaultWindow.content.width);
    expect(defaultWindow.outer.height).toBeGreaterThanOrEqual(defaultWindow.content.height);
    expectNoRootViewportOverflow(defaultWindow);
    const nativeInset = {
      width: defaultWindow.outer.width - defaultWindow.content.width,
      height: defaultWindow.outer.height - defaultWindow.content.height,
    };
    const regularCompactState = await page.evaluate(() => ({
      compact: matchMedia('(max-width: 1120px)').matches,
      brandDisplay: getComputedStyle(document.querySelector('.brand-name')!).display,
      agentTextDisplay: getComputedStyle(document.querySelector('.agent-pill span')!).display,
      transformed: getComputedStyle(document.querySelector('.app-shell')!).transform,
    }));
    expect(regularCompactState).toMatchObject({ compact: false, transformed: 'none' });
    expect(regularCompactState.brandDisplay).not.toBe('none');
    expect(regularCompactState.agentTextDisplay).not.toBe('none');

    const documents = await page.evaluate(async () => {
      const create = async (options: { kind: 'illustration' | 'sprite' | 'tilemap'; name: string; width?: number; height?: number }) => {
        const snapshot = await window.aidraw.newDocument(options);
        const document = snapshot.activeDocument;
        if (!document) throw new Error(`Could not create ${options.name}.`);
        return { id: document.id, name: document.name, kind: document.kind };
      };
      const illustration = await create({ kind: 'illustration', name: 'Professional illustration — Long context and inspector acceptance', width: 1_920, height: 1_080 });
      const sprite = await create({ kind: 'sprite', name: 'Professional sprite — Palette animation and timeline acceptance', width: 64, height: 64 });
      const map = await create({ kind: 'tilemap', name: 'Professional map — Tiles terrain and inspector acceptance', width: 64, height: 64 });
      const overflow = [];
      for (let index = 1; index <= 9; index += 1) {
        overflow.push(await create({ kind: index % 2 ? 'illustration' : 'sprite', name: `Density overflow document ${String(index).padStart(2, '0')} — deliberately long tab label` }));
      }
      await window.aidraw.activateDocument(illustration.id);
      return { illustration, sprite, map, overflow };
    });
    await expect(page).toHaveTitle(`${documents.illustration.name} — AIDraw`);
    const screenshots: Array<{ file: string; bytes: number; sha256: string }> = [];
    screenshots.push(await screenshotRecord(page, configured.screenshots[0]));

    const tabsViewport = page.locator('.document-tab-viewport');
    failureDiagnostics = {
      ...failureDiagnostics,
      stage: 'long-document-menu-pointer-navigation',
      activeDocumentId: documents.illustration.id,
      targetDocumentId: documents.map.id,
    };
    await expect.poll(() => tabsViewport.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const pointerActions: string[] = [];
    const keyboardActions: string[] = [];
    const controls: ControlGeometry[] = [];
    const allDocuments = page.getByRole('button', { name: 'All open documents' });
    const allDocumentsMenu = page.getByRole('menu', { name: 'All open documents' });
    const mapMenuItem = allDocumentsMenu.getByRole('menuitem', { name: documents.map.name, exact: true });
    controls.push(await controlGeometry(allDocuments, 'All open documents', 32, 32));
    await allDocuments.click();
    await mapMenuItem.click();
    await expect(page).toHaveTitle(`${documents.map.name} — AIDraw`);
    pointerActions.push('long-tab map selection through All open documents');
    failureDiagnostics = {
      ...failureDiagnostics,
      stage: 'long-document-menu-keyboard-navigation',
      activeDocumentId: documents.map.id,
      targetDocumentId: documents.illustration.id,
      keyboardRoute: ['Home', 'ArrowDown', 'Enter'],
    };
    await allDocuments.click();
    await expect(mapMenuItem).toBeFocused();
    const firstMenuItem = allDocumentsMenu.getByRole('menuitem').first();
    await page.keyboard.press('Home');
    await expect(firstMenuItem).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const illustrationMenuItem = allDocumentsMenu.getByRole('menuitem', { name: documents.illustration.name, exact: true });
    await expect(illustrationMenuItem).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveTitle(`${documents.illustration.name} — AIDraw`);
    keyboardActions.push('long-tab illustration selection through menu Home/ArrowDown/Enter');

    const minimumContentRequest = { width: 980, height: 640 };
    failureDiagnostics = { stage: 'minimum-content-request', requestedContent: minimumContentRequest };
    await requestNativeContentSize(page, minimumContentRequest.width, minimumContentRequest.height);
    await waitForContentSize(page, 980, 640);
    const minimumRequestMeasurement = await nativeMeasurement(page);
    failureDiagnostics = { ...failureDiagnostics, observed: minimumRequestMeasurement };
    expectNoRootViewportOverflow(minimumRequestMeasurement);
    expect(Math.abs(minimumRequestMeasurement.outer.width - minimumRequestMeasurement.content.width - nativeInset.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(minimumRequestMeasurement.outer.height - minimumRequestMeasurement.content.height - nativeInset.height)).toBeLessThanOrEqual(1);
    const belowMinimumContentRequest = { width: 860, height: 550 };
    failureDiagnostics = { stage: 'below-minimum-content-request', requestedContent: belowMinimumContentRequest };
    await requestNativeContentSize(page, belowMinimumContentRequest.width, belowMinimumContentRequest.height);
    await waitForContentSize(page, 980, 640);
    const minimumWindow = await nativeMeasurement(page);
    failureDiagnostics = { ...failureDiagnostics, observed: minimumWindow };
    expectNoRootViewportOverflow(minimumWindow);
    expect(Math.abs(minimumWindow.outer.width - minimumWindow.content.width - nativeInset.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(minimumWindow.outer.height - minimumWindow.content.height - nativeInset.height)).toBeLessThanOrEqual(1);
    const compactState = await page.evaluate(() => ({
      compact: matchMedia('(max-width: 1120px)').matches,
      brandDisplay: getComputedStyle(document.querySelector('.brand-name')!).display,
      agentTextDisplay: getComputedStyle(document.querySelector('.agent-pill span')!).display,
      agentName: document.querySelector('.agent-pill')?.getAttribute('aria-label'),
      columns: getComputedStyle(document.querySelector('.app-shell')!).gridTemplateColumns,
    }));
    expect(compactState).toMatchObject({ compact: true, brandDisplay: 'none', agentTextDisplay: 'none', agentName: 'Open agent activity' });
    expect(compactState.columns).toBe('62px 632px 286px');

    const illustrationToolbar = page.getByRole('toolbar', { name: 'illustration tools' });
    await expect.poll(() => illustrationToolbar.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const rasterBrush = page.getByRole('button', { name: 'Raster brush' });
    controls.push(await controlGeometry(rasterBrush, 'Raster brush', 38, 38));
    await rasterBrush.click();
    pointerActions.push('illustration Raster brush through scrolled tool rail');
    const brushLibrary = page.getByRole('button', { name: 'Brush library', exact: true });
    controls.push(await controlGeometry(brushLibrary, 'Brush library context action', 32, 32));
    await brushLibrary.click();
    await expect(page.getByRole('dialog', { name: 'Brush library' })).toBeVisible();
    await page.keyboard.press('Escape');
    pointerActions.push('far illustration context action and dialog');
    const customizeBrush = page.getByRole('button', { name: 'Customize', exact: true });
    await customizeBrush.focus();
    await expect(customizeBrush).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Create custom brush' })).toBeVisible();
    await page.keyboard.press('Escape');
    keyboardActions.push('far illustration context action by focus and Enter');

    const firstIllustrationTool = page.getByRole('button', { name: 'Select', exact: true });
    await firstIllustrationTool.focus();
    await page.keyboard.press('End');
    const lastIllustrationTool = page.getByRole('button', { name: 'Eyedropper', exact: true });
    await expect(lastIllustrationTool).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(lastIllustrationTool).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    keyboardActions.push('illustration tool rail End/Enter and Home/Enter');

    const layersTab = page.getByRole('tab', { name: 'Layers', exact: true });
    await layersTab.focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Generate', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(layersTab).toHaveAttribute('aria-selected', 'true');
    keyboardActions.push('inspector tablist End/Home navigation');
    const illustrationLayerCount = await page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      return document?.kind === 'illustration' ? document.layerIds.length : -1;
    });
    const addVector = page.getByTitle('Add vector layer');
    controls.push(await controlGeometry(addVector, 'Add vector layer', 32, 32));
    await addVector.click();
    await expect.poll(() => page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      return document?.kind === 'illustration' ? document.layerIds.length : -1;
    })).toBe(illustrationLayerCount + 1);
    const addPaint = page.getByTitle('Add paint layer');
    await addPaint.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      return document?.kind === 'illustration' ? document.layerIds.length : -1;
    })).toBe(illustrationLayerCount + 2);
    pointerActions.push('inspector Add vector layer');
    keyboardActions.push('inspector Add paint layer by Enter');
    screenshots.push(await screenshotRecord(page, configured.screenshots[1]));

    await page.evaluate((id) => window.aidraw.activateDocument(id), documents.sprite.id);
    await expect(page).toHaveTitle(`${documents.sprite.name} — AIDraw`);
    const pixelToolbar = page.getByRole('toolbar', { name: 'pixel tools' });
    await expect.poll(() => pixelToolbar.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const palettePicker = page.getByRole('button', { name: 'Palette picker', exact: true });
    controls.push(await controlGeometry(palettePicker, 'Palette picker', 38, 38));
    await palettePicker.click();
    pointerActions.push('last pixel tool through vertical overflow');
    const firstPixelTool = page.getByRole('button', { name: 'Select', exact: true });
    await firstPixelTool.focus();
    await page.keyboard.press('End');
    await expect(palettePicker).toBeFocused();
    await page.keyboard.press('Enter');
    keyboardActions.push('pixel tool rail End/Enter');

    await page.getByRole('tab', { name: 'Layers', exact: true }).click();
    const paletteSwatches = page.locator('.palette-grid .swatch');
    await expect(paletteSwatches.first()).toBeVisible();
    const lastSwatch = paletteSwatches.last();
    controls.push(await controlGeometry(lastSwatch, 'last indexed palette swatch', 24, 24));
    await lastSwatch.click();
    await expect(lastSwatch).toHaveClass(/is-active/);
    const firstSwatch = paletteSwatches.first();
    await firstSwatch.focus();
    await page.keyboard.press('Enter');
    await expect(firstSwatch).toHaveClass(/is-active/);
    await paletteSwatches.nth(1).click();
    await expect(paletteSwatches.nth(1)).toHaveClass(/is-active/);
    pointerActions.push('last palette swatch through inspector scroll');
    keyboardActions.push('first palette swatch by Enter');

    const onionSetup = page.getByTitle('Configure bounded onion skin frames, tint, and opacity');
    controls.push(await controlGeometry(onionSetup, 'Onion setup', 32, 32));
    await onionSetup.click();
    await expect(page.locator('.onion-settings-panel')).toBeVisible();
    await onionSetup.click();
    pointerActions.push('pixel Onion setup overlay toggle');
    const paletteCycle = page.getByTitle('Palette cycling preview');
    await paletteCycle.focus();
    await page.keyboard.press('Enter');
    await expect(paletteCycle).toHaveClass(/is-active/);
    keyboardActions.push('pixel palette cycle by Enter');

    const frameCount = async () => page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'pixel') return -1;
      const asset = document.pixelAssets[document.activeAssetId];
      return asset?.type === 'sprite' ? asset.frameIds.length : -1;
    });
    const addFrame = page.getByTitle(/Add frame/);
    controls.push(await controlGeometry(addFrame, 'Add frame', 38, 32));
    await addFrame.click();
    await expect.poll(frameCount).toBe(2);
    await addFrame.focus();
    await page.keyboard.press('Enter');
    await expect.poll(frameCount).toBe(3);
    for (let expectedFrames = 4; expectedFrames <= 10; expectedFrames += 1) {
      await addFrame.click();
      await expect.poll(frameCount).toBe(expectedFrames);
    }
    const frameStrip = page.locator('.frame-strip');
    await expect.poll(() => frameStrip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const frames = frameStrip.locator('> button:not(.add-frame)');
    const lastFrame = frames.last();
    await lastFrame.scrollIntoViewIfNeeded();
    await lastFrame.click();
    const firstFrame = frames.first();
    await firstFrame.scrollIntoViewIfNeeded();
    await firstFrame.focus();
    await page.keyboard.press('Enter');
    pointerActions.push('far timeline frame through horizontal overflow');
    keyboardActions.push('timeline Add frame and first-frame activation by Enter');

    const exposureGrid = page.getByTitle('Open layer-by-frame cel exposure grid');
    await exposureGrid.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cel-exposure-panel')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cel-exposure-panel')).toHaveCount(0);
    keyboardActions.push('cel-exposure action toggle by Enter');

    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    const zoomOut = page.getByRole('button', { name: 'Zoom out' });
    controls.push(await controlGeometry(zoomIn, 'Zoom in', 32, 32));
    const initialZoom = await page.locator('.zoom-control output').textContent();
    await zoomIn.click();
    await expect(page.locator('.zoom-control output')).not.toHaveText(initialZoom ?? '');
    await zoomOut.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.zoom-control output')).toHaveText(initialZoom ?? '');
    pointerActions.push('status Zoom in');
    keyboardActions.push('status Zoom out by Enter');

    await page.getByRole('button', { name: 'Pixel-perfect pencil', exact: true }).click();
    const pixelCanvas = page.getByRole('application', { name: `Pixel-art canvas for ${documents.sprite.name}` });
    const timelineBoundary = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#aidraw-canvas')!;
      const timeline = document.querySelector<HTMLElement>('.timeline')!;
      const canvasRect = canvas.getBoundingClientRect();
      const timelineRect = timeline.getBoundingClientRect();
      const sampleX = canvasRect.left + canvasRect.width / 2;
      const above = document.elementFromPoint(sampleX, timelineRect.top - 1);
      const below = document.elementFromPoint(sampleX, timelineRect.top + 1);
      return {
        canvas: { top: canvasRect.top, bottom: canvasRect.bottom, width: canvasRect.width, height: canvasRect.height },
        timeline: { top: timelineRect.top, bottom: timelineRect.bottom, width: timelineRect.width, height: timelineRect.height },
        gap: timelineRect.top - canvasRect.bottom,
        aboveIsCanvas: above === canvas,
        belowIsTimeline: Boolean(below?.closest('.timeline')),
      };
    });
    expect(timelineBoundary.timeline.height).toBe(138);
    expect(Math.abs(timelineBoundary.gap)).toBeLessThanOrEqual(1);
    expect(timelineBoundary.aboveIsCanvas).toBe(true);
    expect(timelineBoundary.belowIsTimeline).toBe(true);
    const canvasBounds = await pixelCanvas.boundingBox();
    if (!canvasBounds) throw new Error('The retained UX-01 pixel canvas has no bounds.');
    const revisionBeforeDraw = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument?.revision ?? -1);
    await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
    await expect(page.locator('.pixel-floating-controls > span:last-child')).not.toHaveText('—, —');
    await page.mouse.click(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
    await expect.poll(() => page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument?.revision ?? -1)).toBeGreaterThan(revisionBeforeDraw);
    const revisionAfterDraw = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument?.revision ?? -1);
    const safeTimelinePoint = await page.evaluate(() => {
      const timeline = document.querySelector<HTMLElement>('.timeline')!;
      const rect = timeline.getBoundingClientRect();
      for (let y = rect.top + 2; y < rect.bottom - 2; y += 4) {
        for (let x = rect.left + 2; x < rect.right - 2; x += 4) {
          const target = document.elementFromPoint(x, y);
          if (target?.closest('.timeline') && !target.closest('button,input,select')) return { x, y };
        }
      }
      throw new Error('The retained UX-01 timeline has no inert sample point.');
    });
    await page.mouse.move(safeTimelinePoint.x, safeTimelinePoint.y);
    await expect(page.locator('.pixel-floating-controls > span:last-child')).toHaveText('—, —');
    await page.mouse.click(safeTimelinePoint.x, safeTimelinePoint.y);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument?.revision ?? -1)).toBe(revisionAfterDraw);
    pointerActions.push('pixel draw inside canvas and inert click below 138px boundary');
    screenshots.push(await screenshotRecord(page, configured.screenshots[2]));

    await page.evaluate((id) => window.aidraw.activateDocument(id), documents.map.id);
    await expect(page).toHaveTitle(`${documents.map.name} — AIDraw`);
    await page.getByRole('tab', { name: 'Assets', exact: true }).click();
    const assetsBefore = await page.locator('.pixel-asset-list > button').count();
    const addTileset = page.getByRole('button', { name: 'Tileset', exact: true });
    controls.push(await controlGeometry(addTileset, 'Add Tileset asset', 32, 32));
    await addTileset.click();
    // A standalone map starts without source pixels; Add tileset therefore admits
    // one source sprite and its tileset as a single user action.
    await expect(page.locator('.pixel-asset-list > button')).toHaveCount(assetsBefore + 2);
    const tilesetAsset = page.locator('.pixel-asset-list > button').filter({ hasText: 'Tileset 1' });
    await tilesetAsset.focus();
    await page.keyboard.press('Enter');
    await expect(tilesetAsset).toHaveClass(/is-active/);
    await page.getByRole('tab', { name: 'Layers', exact: true }).click();
    const tileButtons = page.locator('.tile-definition-grid > button');
    await expect(tileButtons).toHaveCount(16);
    const lastTile = tileButtons.last();
    controls.push(await controlGeometry(lastTile, 'last visible tile cell', 20, 20));
    await lastTile.click();
    await expect(lastTile).toHaveClass(/is-active/);
    const firstTile = tileButtons.first();
    await firstTile.focus();
    await page.keyboard.press('Enter');
    await expect(firstTile).toHaveClass(/is-active/);
    pointerActions.push('map asset add and last tile-grid cell');
    keyboardActions.push('tileset asset and first tile-grid cell by Enter');
    await page.getByRole('tab', { name: 'Assets', exact: true }).click();
    const mapAsset = page.locator('.pixel-asset-list > button').filter({ hasText: 'Map 1' });
    await mapAsset.focus();
    await page.keyboard.press('Enter');
    await expect(mapAsset).toHaveClass(/is-active/);
    await page.getByRole('button', { name: 'Wang terrain', exact: true }).click();
    pointerActions.push('map Wang terrain through scrolled pixel tool rail');
    screenshots.push(await screenshotRecord(page, configured.screenshots[3]));

    expect(externalRendererRequests).toEqual([]);
    for (const path of [configured.paths.providerCredentials, configured.paths.forbiddenNetwork]) {
      expect(await access(path).then(() => true, () => false), `${path} must remain absent`).toBe(false);
    }
    expect(screenshots).toHaveLength(4);
    expect(new Set(screenshots.map((entry) => entry.sha256)).size).toBe(4);
    evidence = {
      scenario: UX01_PACKAGED_SCENARIO,
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
      isolation: {
        profile: configured.profile,
        defaultProfileUntouched: true,
        earlierRetainedEvidenceUntouched: true,
        remoteDebuggingAddress: '127.0.0.1',
      },
      launch: {
        ownerPid: child.pid,
        connectionPidMatched: true,
        processShape,
        rendererPages: 1,
        loopbackDevtools: true,
        trustedFolders: [],
        backgroundNetworkingDisabled: true,
      },
      window: {
        measurementMechanism: 'trusted-renderer window.inner/outer/screen/root-layout metrics plus Electron-routed window.resizeTo content-bounds request',
        workAreaPolicy: 'macOS hidden-inset native traffic lights share the AIDraw top bar; default outer bounds must remain inside the renderer-reported available work area',
        default: defaultWindow,
        nativeInset,
        minimumContentRequest,
        minimumRequestMeasurement,
        belowMinimumContentRequest,
        enforcedMinimum: minimumWindow,
        regularCompactState,
        compactState,
      },
      documents,
      reachability: {
        pointerActions,
        keyboardActions,
        controls,
        longTabsOverflow: true,
        pixelToolRailOverflow: true,
        timelineFrameOverflow: true,
      },
      timelineBoundary: { ...timelineBoundary, revisionBeforeDraw, revisionAfterDraw, cursorClearedBelowBoundary: true },
      screenshots,
      privacy: {
        externalRendererRequests: 0,
        providerCredentialsAbsent: true,
        forbiddenNetworkSentinelAbsent: true,
        credentialStorage: 'electron-safe-storage',
      },
      nonClaims: [
        '200-percent-text', 'screen-reader-or-assistive-technology', 'tablet-pressure-or-touchpad',
        'high-dpi-or-mixed-scale-monitor', 'custom-workspace-persistence', 'smaller-than-supported-work-area',
        'broad-visual-polish', 'release-candidate', 'stable-v1',
      ],
    };
  } catch (error) {
    acceptanceFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    cleanup = await stopOwner(child, browser, configured.profile, configured.paths.ownerConnection, secrets);
    const cleanupSerialized = `${JSON.stringify(cleanup, null, 2)}\n`;
    assertUx01EvidenceRedacted(cleanupSerialized, secrets);
    await writeFile(configured.paths.cleanup, cleanupSerialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }

  if (!cleanup.graceful && !acceptanceFailure) acceptanceFailure = new Error(`The retained UX-01 owner did not clean up gracefully: ${JSON.stringify(cleanup)}.`);
  if (acceptanceFailure || !evidence) {
    const failure = {
      scenario: UX01_PACKAGED_SCENARIO,
      result: 'failed',
      package: { executableSha256: configured.executableSha256, asarSha256: configured.asarSha256, platform: artifact.platform, arch: artifact.arch },
      error: redactUx01FailureText(acceptanceFailure?.message ?? 'The UX-01 acceptance did not complete.', secrets),
      diagnostics: failureDiagnostics,
      cleanup,
      completedScreenshots: await completedScreenshotRecords(configured.screenshots),
    };
    const serialized = `${JSON.stringify(failure, null, 2)}\n`;
    assertUx01EvidenceRedacted(serialized, secrets);
    await writeFile(configured.paths.failure, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    throw acceptanceFailure ?? new Error('The UX-01 acceptance did not produce evidence.');
  }

  const serialized = `${JSON.stringify({ ...evidence, cleanup }, null, 2)}\n`;
  assertUx01EvidenceRedacted(serialized, secrets);
  await writeFile(configured.paths.evidence, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  expect(cleanup.graceful).toBe(true);
  expect(cleanup.ownedSurvivors).toEqual([]);
});
