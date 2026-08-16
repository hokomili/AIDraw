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
  assertUx09LocalAxisReachability,
  assertUx09EvidenceRedacted,
  classifyUx09RendererRequest,
  exerciseUx09ScrollBoundaries,
  hasExactUx09ProcessShape,
  inspectUx09EncryptedToken,
  isUx09ExactTextFit,
  isUx09RectContained,
  parseUx09OwnedProcesses,
  redactUx09FailureText,
  resolveUx09TextReflowAcceptance,
  UX09_TEXT_REFLOW_MECHANISM,
  UX09_TEXT_REFLOW_SCENARIO,
  writeUx09ExclusiveRecord,
  type Ux09LocalAxisContainment,
  type Ux09LocalAxisLayout,
} from '../../scripts/ux09-text-reflow-acceptance.mjs';
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

interface LocalAxisMetric extends Ux09LocalAxisLayout {
  layoutBefore: Ux09LocalAxisLayout;
  layoutAfter: Ux09LocalAxisLayout;
  boundaryDimensions: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  originalX: number;
  originalY: number;
  maxX: number;
  maxY: number;
  startX: number;
  endX: number;
  startY: number;
  endY: number;
  restoredX: number;
  restoredY: number;
  reachedStartX: boolean;
  reachedEndX: boolean;
  reachedStartY: boolean;
  reachedEndY: boolean;
  movedX: boolean;
  movedY: boolean;
  admission: {
    x: 'not-requested' | 'policy-only' | 'scrollable' | 'contained-zero-range';
    y: 'not-requested' | 'policy-only' | 'scrollable' | 'contained-zero-range';
  };
}

interface LocalAxisOptions {
  requireMovement?: boolean;
  admitContainedZeroRange?: boolean;
}

interface LocalAxisLayoutSettings {
  expectedAxis: LocalAxisMetric['axis'];
  captureContainment: boolean;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

function textSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve the isolated UX-09 DevTools port.');
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
    label: 'The retained UX-09 MCP connection',
    timeoutMs: 20_000,
    attempt: async () => {
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as Partial<McpConnection>;
        if (value.version !== 1 || !value.url || !value.token || !value.activeDocumentId || !Number.isInteger(value.pid)) return undefined;
        const url = new URL(value.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp') {
          throw new Error('The UX-09 MCP endpoint is not an exact loopback /mcp URL.');
        }
        return { ...value, trustedFolders: value.trustedFolders ?? [] } as McpConnection;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
      }
    },
  });
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
    if (pages.length > 1) throw new Error(`The retained UX-09 owner admitted ${pages.length} renderer pages; expected exactly one.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('The retained UX-09 owner did not expose exactly one trusted renderer page.');
}

async function processRows(profile: string): Promise<OwnedProcess[]> {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return parseUx09OwnedProcesses(stdout, profile);
}

async function waitForProcessShape(profile: string, expectedOwnerPid: number): Promise<OwnedProcess[]> {
  const deadline = Date.now() + 20_000;
  let last: OwnedProcess[] = [];
  while (Date.now() < deadline) {
    last = await processRows(profile);
    if (hasExactUx09ProcessShape(last, expectedOwnerPid)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`The retained UX-09 process shape never reached one owner and one renderer: ${JSON.stringify(last)}.`);
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
      const signal = spawnPackagedE2e(executable, [`--user-data-dir=${profile}`, '--quit-engine'], { stdio: 'ignore' });
      signalPid = signal.pid;
      signalExitCode = await waitForExit(signal, 'The retained UX-09 graceful quit signal', 10_000);
      if (signalExitCode !== 0) throw new Error(`The retained UX-09 graceful quit signal exited with ${String(signalExitCode)}.`);
      await waitForExit(child, 'The retained UX-09 owner', 15_000);
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
    cleanupError ??= error instanceof Error ? error : new Error('The retained UX-09 connection could not be redacted.');
  }
  if ('secret' in redacted && redacted.secret) secrets.push(redacted.secret);
  let ownedSurvivors: OwnedProcess[] = [];
  try {
    ownedSurvivors = await waitForNoOwnedProcesses(profile);
  } catch (error) {
    cleanupError ??= error instanceof Error ? error : new Error('The retained UX-09 process survivors could not be inspected.');
  }
  const graceful = Boolean(child && child.exitCode === 0 && signalExitCode === 0
    && redacted.status === 'redacted-after-graceful-stop' && ownedSurvivors.length === 0 && !cleanupError);
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

async function requestContentSize(page: Page, width: number, height: number): Promise<void> {
  if (width !== 980 || height !== 640) throw new Error('UX-09 admits only its exact 980 × 640 renderer-content viewport.');
  await page.evaluate((size) => {
    if (typeof window.resizeTo !== 'function') throw new Error('The exact renderer has no native content-size request mechanism.');
    window.resizeTo(size.width, size.height);
  }, { width, height });
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
}

function inspectLocalAxisLayout(element: Element, settings: LocalAxisLayoutSettings): Ux09LocalAxisLayout {
  const style = getComputedStyle(element);
  const rectangle = (rect: DOMRect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
  const elementRect = element.getBoundingClientRect();
  const contentLeft = elementRect.left + element.clientLeft;
  const contentTop = elementRect.top + element.clientTop;
  const viewport = { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
  const scrollport = {
    left: contentLeft,
    right: contentLeft + element.clientWidth,
    top: contentTop,
    bottom: contentTop + element.clientHeight,
  };
  let visibleScrollport = {
    left: Math.max(scrollport.left, viewport.left),
    right: Math.min(scrollport.right, viewport.right),
    top: Math.max(scrollport.top, viewport.top),
    bottom: Math.min(scrollport.bottom, viewport.bottom),
  };
  const clippingAncestors: Ux09LocalAxisContainment['clippingAncestors'] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const ancestorStyle = getComputedStyle(ancestor);
    const clipsX = /(?:auto|scroll|hidden|clip)/.test(ancestorStyle.overflowX);
    const clipsY = /(?:auto|scroll|hidden|clip)/.test(ancestorStyle.overflowY);
    if (!clipsX && !clipsY) continue;
    const ancestorRect = rectangle(ancestor.getBoundingClientRect());
    clippingAncestors.push({
      label: `${ancestor.tagName.toLowerCase()}${ancestor.classList.length ? `.${Array.from(ancestor.classList).slice(0, 3).join('.')}` : ''}`,
      overflowX: ancestorStyle.overflowX,
      overflowY: ancestorStyle.overflowY,
      rect: ancestorRect,
    });
    visibleScrollport = {
      left: clipsX ? Math.max(visibleScrollport.left, ancestorRect.left) : visibleScrollport.left,
      right: clipsX ? Math.min(visibleScrollport.right, ancestorRect.right) : visibleScrollport.right,
      top: clipsY ? Math.max(visibleScrollport.top, ancestorRect.top) : visibleScrollport.top,
      bottom: clipsY ? Math.min(visibleScrollport.bottom, ancestorRect.bottom) : visibleScrollport.bottom,
    };
  }
  const containment = settings.captureContainment ? {
    viewport,
    scrollport,
    visibleScrollport,
    clippingAncestors,
    children: Array.from(element.children).map((child, index) => {
      const childStyle = getComputedStyle(child);
      const classes = Array.from(child.classList).slice(0, 3).join('.');
      const childRect = child.getBoundingClientRect();
      return {
        index,
        label: `${index}:${child.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`,
        flexShrink: Number(childStyle.flexShrink),
        rendered: childStyle.display !== 'none'
          && childStyle.visibility !== 'hidden'
          && childStyle.visibility !== 'collapse'
          && childRect.width > 0
          && childRect.height > 0,
        rect: rectangle(childRect),
      };
    }),
  } : undefined;
  return {
    selector: element instanceof HTMLElement ? `.${element.classList[0]}` : element.tagName,
    axis: settings.expectedAxis,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
    ...(containment ? { containment } : {}),
  };
}

async function localAxisMetric(
  page: Page,
  selector: string,
  axis: LocalAxisMetric['axis'],
  options: LocalAxisOptions = {},
): Promise<LocalAxisMetric> {
  const locator = page.locator(selector);
  const settings = { expectedAxis: axis, captureContainment: options.admitContainedZeroRange === true };
  const layoutBefore = await locator.evaluate(inspectLocalAxisLayout, settings);
  let boundary: Awaited<ReturnType<typeof exerciseUx09ScrollBoundaries>>;
  try {
    boundary = await locator.evaluate(exerciseUx09ScrollBoundaries, axis);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`UX-09 ${selector} scroll-boundary exercise failed: ${message} Before-layout diagnostics: ${JSON.stringify(layoutBefore)}.`);
  }
  let layoutAfter: Ux09LocalAxisLayout;
  try {
    layoutAfter = await locator.evaluate(inspectLocalAxisLayout, settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`UX-09 ${selector} post-restoration layout sample failed: ${message} Probe diagnostics: ${JSON.stringify({ layoutBefore, boundary })}.`);
  }
  const metric = {
    ...layoutAfter,
    ...boundary,
    layoutBefore,
    layoutAfter,
    movedX: boundary.maxX > 0 && boundary.reachedStartX && boundary.reachedEndX,
    movedY: boundary.maxY > 0 && boundary.reachedStartY && boundary.reachedEndY,
  };
  const admission = assertUx09LocalAxisReachability(metric, options);
  return { ...metric, selector, admission };
}

async function containedControl(locator: Locator, label: string): Promise<Record<string, unknown>> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const metric = await locator.evaluate((element, name) => {
    const rect = element.getBoundingClientRect();
    let local: Element | null = element.parentElement;
    while (local) {
      const style = getComputedStyle(local);
      if (/(?:auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) break;
      local = local.parentElement;
    }
    const localRect = local?.getBoundingClientRect();
    return {
      label: name,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewportContained: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      localContained: !localRect || (rect.left >= localRect.left - 1 && rect.top >= localRect.top - 1
        && rect.right <= localRect.right + 1 && rect.bottom <= localRect.bottom + 1),
    };
  }, label);
  expect(metric.viewportContained, `${label} viewport containment`).toBe(true);
  expect(metric.localContained, `${label} local-scroll containment`).toBe(true);
  return metric;
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

async function activeDocumentJson(page: Page): Promise<string> {
  return page.evaluate(async () => JSON.stringify((await window.aidraw.bootstrap()).activeDocument));
}

async function activePixelObservation(page: Page, x: number, y: number): Promise<{ revision: number; value: number; nonzero: number }> {
  return page.evaluate(async (point) => {
    const document = (await window.aidraw.bootstrap()).activeDocument;
    if (!document || document.kind !== 'pixel') throw new Error('UX-09 expected one active pixel document.');
    const asset = document.pixelAssets[document.activeAssetId];
    if (!asset || asset.type !== 'sprite') throw new Error('UX-09 expected one active sprite.');
    const frameId = asset.frameIds[0];
    const layerId = asset.layerIds.find((id) => asset.layers[id]?.type === 'pixel');
    const cel = Object.values(asset.cels).find((candidate) => candidate.frameId === frameId && candidate.layerId === layerId);
    if (!cel) throw new Error('UX-09 expected the active sprite pixel cel.');
    let value = 0;
    let nonzero = 0;
    for (const chunk of Object.values(cel.chunks)) {
      const binary = atob(chunk.data);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      for (const index of bytes) if (index !== 0) nonzero += 1;
      if (point.x >= chunk.x && point.x < chunk.x + 32 && point.y >= chunk.y && point.y < chunk.y + 32) {
        value = bytes[(point.y - chunk.y) * 32 + point.x - chunk.x] ?? 0;
      }
    }
    return { revision: document.revision, value, nonzero };
  }, { x, y });
}

test(UX09_TEXT_REFLOW_SCENARIO, async () => {
  test.skip(process.platform !== 'darwin' || process.arch !== 'arm64', 'This is the exact current macOS/arm64 packaged acceptance only.');
  test.setTimeout(150_000);
  const configured = resolveUx09TextReflowAcceptance();
  expect(artifact.platform).toBe('darwin');
  expect(artifact.arch).toBe('arm64');
  expect(await sha256(executable)).toBe(configured.executableSha256);
  expect(await sha256(asar)).toBe(configured.asarSha256);
  expect(await access(configured.profile).then(() => true, () => false), 'The private UX-09 profile must be absent before launch.').toBe(false);
  await mkdir(configured.profile, { recursive: false, mode: 0o700 });
  await mkdir(dirname(configured.screenshots[0]), { recursive: false, mode: 0o700 });
  for (const path of [...Object.values(configured.paths), ...configured.screenshots]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const port = await reservePort();
  const stderr: Buffer[] = [];
  const observedRendererRequests: Array<ReturnType<typeof classifyUx09RendererRequest>> = [];
  const unexpectedRendererRequests: Array<ReturnType<typeof classifyUx09RendererRequest>> = [];
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
    if (!child.pid || connection.pid !== child.pid) throw new Error('The UX-09 connection PID does not match the exact spawned owner.');
    expect(connection.trustedFolders).toEqual([]);
    secrets.push(connection.token);
    inspectUx09EncryptedToken(JSON.parse(await readFile(configured.paths.tokenCredentials, 'utf8')), connection.token);
    browser = await waitForPackagedE2eReady({
      child,
      label: 'The retained UX-09 DevTools endpoint',
      stderr: () => Buffer.concat(stderr).toString('utf8'),
      attempt: async () => {
        try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
        catch { return undefined; }
      },
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error('The UX-09 owner has no default browser context.');
    const rendererRequestObservation = 'begins when the CDP context request listener attaches, before trusted renderer page selection; earlier renderer requests are outside this evidence';
    context.on('request', (request) => {
      const classified = classifyUx09RendererRequest(request.url());
      observedRendererRequests.push(classified);
      if (!classified.permitted) unexpectedRendererRequests.push(classified);
    });
    const page = await waitForSingleRendererPage(context);
    const processShape = await waitForProcessShape(configured.profile, child.pid);
    failureDiagnostics = { stage: 'exact-viewport', ownerPid: child.pid, processShape };
    await requestContentSize(page, 980, 640);

    const documents = await page.evaluate(async () => {
      const spriteSnapshot = await window.aidraw.newDocument({
        kind: 'sprite',
        name: 'UX-09 200% text — exact primary pixel sprite workflow',
        width: 64,
        height: 64,
      });
      const sprite = spriteSnapshot.activeDocument;
      if (!sprite) throw new Error('UX-09 could not create its primary sprite.');
      const overflow = [];
      for (let index = 1; index <= 8; index += 1) {
        const snapshot = await window.aidraw.newDocument({
          kind: index % 2 ? 'illustration' : 'sprite',
          name: `UX-09 deliberately crowded document ${String(index).padStart(2, '0')} — local horizontal recovery`,
        });
        if (!snapshot.activeDocument) throw new Error('UX-09 could not create its crowded document set.');
        overflow.push({ id: snapshot.activeDocument.id, name: snapshot.activeDocument.name });
      }
      await window.aidraw.activateDocument(sprite.id);
      return { sprite: { id: sprite.id, name: sprite.name }, overflow };
    });
    await expect(page).toHaveTitle(`${documents.sprite.name} — AIDraw`);
    const canonicalBeforeMechanism = await activeDocumentJson(page);

    failureDiagnostics = { ...failureDiagnostics, stage: 'activate-explicit-32px-root-mechanism' };
    const presentation = await page.evaluate(({ mechanism }) => {
      document.documentElement.style.fontSize = '32px';
      document.documentElement.dataset.ux09TextReflowMechanism = mechanism;
      const shell = document.querySelector<HTMLElement>('.app-shell');
      return {
        mechanism: document.documentElement.dataset.ux09TextReflowMechanism,
        inlineRootFontSize: document.documentElement.style.fontSize,
        computedRootFontSize: getComputedStyle(document.documentElement).fontSize,
        shellTransform: shell ? getComputedStyle(shell).transform : 'missing',
        viewport: { width: innerWidth, height: innerHeight },
      };
    }, { mechanism: UX09_TEXT_REFLOW_MECHANISM });
    expect(presentation).toEqual({
      mechanism: UX09_TEXT_REFLOW_MECHANISM,
      inlineRootFontSize: '32px',
      computedRootFontSize: '32px',
      shellTransform: 'none',
      viewport: { width: 980, height: 640 },
    });
    const canonicalAfterMechanism = await activeDocumentJson(page);
    expect(canonicalAfterMechanism).toBe(canonicalBeforeMechanism);
    const viewport = await page.evaluate(() => ({
      root: { clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
      body: { clientWidth: document.body.clientWidth, clientHeight: document.body.clientHeight, scrollWidth: document.body.scrollWidth, scrollHeight: document.body.scrollHeight },
    }));
    expect(viewport.root).toEqual({ clientWidth: 980, clientHeight: 640, scrollWidth: 980, scrollHeight: 640 });
    expect(viewport.body).toEqual(viewport.root);

    await page.getByRole('tab', { name: 'Layers', exact: true }).click();
    await page.locator('.palette-grid .swatch').nth(1).click();
    const addFrame = page.getByRole('button', { name: 'Add frame', exact: true });
    for (let expected = 2; expected <= 8; expected += 1) {
      await addFrame.click();
      await expect(page.locator('.frame-strip > button:not(.add-frame)')).toHaveCount(expected);
    }
    const firstFrame = page.locator('.frame-strip > button:not(.add-frame)').first();
    await firstFrame.dblclick();
    const duration = page.getByLabel('Duration (milliseconds)');
    await duration.fill('60000');
    await page.getByRole('button', { name: 'Set duration' }).click();
    await expect(firstFrame).toHaveAccessibleName('Frame 1, 60000 milliseconds');

    failureDiagnostics = { ...failureDiagnostics, stage: 'tab-and-frame-contained-fit' };
    const tabFit = await page.locator('.panel-tabs').evaluate((tabs) => {
      const stripRect = tabs.getBoundingClientRect();
      const contentLeft = stripRect.left + tabs.clientLeft;
      const contentTop = stripRect.top + tabs.clientTop;
      const visibleStrip = {
        left: contentLeft,
        right: contentLeft + tabs.clientWidth,
        top: contentTop,
        bottom: contentTop + tabs.clientHeight,
      };
      const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>('button'));
      const labels = buttons.map((button) => {
        button.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        const buttonRect = button.getBoundingClientRect();
        const label = button.querySelector('span');
        if (!label?.textContent?.trim()) throw new Error('An inspector tab has no visible span label.');
        const labelRect = label.getBoundingClientRect();
        return {
          label: label.textContent.trim(),
          button: { left: buttonRect.left, right: buttonRect.right, top: buttonRect.top, bottom: buttonRect.bottom },
          text: { left: labelRect.left, right: labelRect.right, top: labelRect.top, bottom: labelRect.bottom },
        };
      });
      return {
        offsetHeight: (tabs as HTMLElement).offsetHeight,
        clientWidth: tabs.clientWidth,
        clientHeight: tabs.clientHeight,
        scrollWidth: tabs.scrollWidth,
        scrollHeight: tabs.scrollHeight,
        visibleStrip,
        labels,
      };
    });
    expect(tabFit.offsetHeight).toBeGreaterThanOrEqual(70);
    expect(tabFit.labels.every((entry) => isUx09RectContained(entry.text, entry.button)
      && isUx09RectContained(entry.text, tabFit.visibleStrip))).toBe(true);
    const frameFit = await firstFrame.evaluate((button) => {
      const metadata = button.querySelector('em');
      if (!metadata) throw new Error('The maximum-duration frame has no metadata.');
      const buttonRect = button.getBoundingClientRect();
      const metadataRect = metadata.getBoundingClientRect();
      return {
        width: buttonRect.width,
        text: metadata.textContent,
        button: { left: buttonRect.left, right: buttonRect.right, top: buttonRect.top, bottom: buttonRect.bottom },
        metadata: { left: metadataRect.left, right: metadataRect.right, top: metadataRect.top, bottom: metadataRect.bottom },
        overflow: getComputedStyle(button).overflow,
        metadataClientWidth: metadata.clientWidth,
        metadataScrollWidth: metadata.scrollWidth,
        metadataOverflow: getComputedStyle(metadata).overflow,
        metadataTextOverflow: getComputedStyle(metadata).textOverflow,
      };
    });
    expect(frameFit.width).toBeGreaterThanOrEqual(140);
    expect(frameFit.overflow).toBe('hidden');
    expect(isUx09RectContained(frameFit.metadata, frameFit.button)).toBe(true);
    expect(isUx09ExactTextFit({
      text: frameFit.text,
      expected: '60000ms',
      clientWidth: frameFit.metadataClientWidth,
      scrollWidth: frameFit.metadataScrollWidth,
    })).toBe(true);

    const screenshots: Array<{ file: string; bytes: number; sha256: string }> = [];
    await page.locator('.document-tab-viewport').evaluate((element) => { element.scrollLeft = 0; });
    screenshots.push(await screenshotRecord(page, configured.screenshots[0]));

    failureDiagnostics = { ...failureDiagnostics, stage: 'local-axis-reachability' };
    const axes: LocalAxisMetric[] = [];
    axes.push(await localAxisMetric(page, '.document-tab-viewport', 'x'));
    axes.push(await localAxisMetric(page, '.context-bar', 'x', { admitContainedZeroRange: true }));
    axes.push(await localAxisMetric(page, '.tool-rail', 'y'));
    axes.push(await localAxisMetric(page, '.panel-tabs', 'x'));
    axes.push(await localAxisMetric(page, '.panel-content', 'y'));
    axes.push(await localAxisMetric(page, '.timeline', 'x', { requireMovement: false }));
    axes.push(await localAxisMetric(page, '.frame-strip', 'x'));
    axes.push(await localAxisMetric(page, '.statusbar', 'x'));

    const controls: Record<string, unknown>[] = [];
    controls.push(await containedControl(page.getByRole('button', { name: 'All open documents' }), 'All open documents'));
    controls.push(await containedControl(page.getByTitle('Set exact half-pixel symmetry axes for this sprite'), 'Symmetry setup'));
    controls.push(await containedControl(page.getByRole('button', { name: 'Palette picker', exact: true }), 'Palette picker'));
    controls.push(await containedControl(page.getByRole('tab', { name: 'Generate', exact: true }), 'Generate inspector tab'));
    controls.push(await containedControl(firstFrame, 'maximum-duration frame'));
    controls.push(await containedControl(page.getByRole('button', { name: 'Zoom in' }), 'Zoom in'));

    const layersTab = page.getByRole('tab', { name: 'Layers', exact: true });
    await layersTab.focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Generate', exact: true })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(layersTab).toBeFocused();
    screenshots.push(await screenshotRecord(page, configured.screenshots[1]));

    const keyboardRecovery: string[] = [];
    await page.locator('.topbar button').first().focus();
    await page.keyboard.press('Shift+Tab');
    const skipCanvas = page.getByRole('button', { name: 'Skip to canvas' });
    await expect(skipCanvas).toBeFocused();
    await expect(skipCanvas).toBeVisible();
    await page.keyboard.press('Enter');
    const pixelCanvas = page.getByRole('application', { name: `Pixel-art canvas for ${documents.sprite.name}` });
    await expect(pixelCanvas).toBeFocused();
    keyboardRecovery.push('Shift+Tab reveals named Skip to canvas; Enter focuses the pixel canvas');

    await page.keyboard.press('Meta+Shift+I');
    await expect(page.locator('#inspector-sidebar')).toBeHidden();
    const openInspector = page.getByRole('button', { name: 'Open inspector sidebar' });
    await expect(openInspector).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#inspector-sidebar')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Layers', exact: true })).toBeFocused();
    keyboardRecovery.push('Command+Shift+I collapses to the named top-bar route; Enter reopens and focuses the active inspector tab');

    await page.getByRole('button', { name: 'Pixel-perfect pencil', exact: true }).click();
    await page.getByRole('tab', { name: 'Layers', exact: true }).click();
    await page.locator('.palette-grid .swatch').nth(1).click();
    const canvasBounds = await pixelCanvas.boundingBox();
    if (!canvasBounds) throw new Error('The UX-09 pixel canvas has no rendered bounds.');
    const pointOnCanvas = { x: canvasBounds.x + canvasBounds.width / 2, y: canvasBounds.y + canvasBounds.height / 2 };
    await page.mouse.move(pointOnCanvas.x, pointOnCanvas.y);
    const cursorText = (await page.locator('.pixel-floating-controls > span:last-child').textContent())?.trim() ?? '';
    const cursorMatch = /^(\d+),\s*(\d+)$/.exec(cursorText);
    if (!cursorMatch) throw new Error(`The UX-09 canvas did not expose an exact pixel coordinate at its center: ${JSON.stringify(cursorText)}.`);
    const pixelPoint = { x: Number(cursorMatch[1]), y: Number(cursorMatch[2]) };
    const beforeEdit = await activePixelObservation(page, pixelPoint.x, pixelPoint.y);
    expect(beforeEdit).toMatchObject({ value: 0, nonzero: 0 });
    await page.mouse.click(pointOnCanvas.x, pointOnCanvas.y);
    await expect.poll(() => activePixelObservation(page, pixelPoint.x, pixelPoint.y)).toMatchObject({
      revision: beforeEdit.revision + 1,
      value: 1,
      nonzero: 1,
    });
    const afterEdit = await activePixelObservation(page, pixelPoint.x, pixelPoint.y);
    const undo = await page.evaluate((documentId) => window.aidraw.undo(documentId), documents.sprite.id);
    expect(undo.status).toBe('committed');
    const afterUndo = await activePixelObservation(page, pixelPoint.x, pixelPoint.y);
    expect(afterUndo).toEqual({ revision: afterEdit.revision + 1, value: 0, nonzero: 0 });

    const timelineBoundary = await page.locator('.timeline').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width };
    });
    expect(timelineBoundary.height).toBe(138);
    const revisionBeforeTimeline = afterUndo.revision;
    const inertTimelinePoint = await page.locator('.timeline').evaluate((timeline) => {
      const rect = timeline.getBoundingClientRect();
      for (let y = rect.top + 2; y < rect.bottom - 2; y += 4) {
        for (let x = rect.left + 2; x < rect.right - 2; x += 4) {
          const target = document.elementFromPoint(x, y);
          if (target?.closest('.timeline') && !target.closest('button,input,select')) return { x, y };
        }
      }
      throw new Error('The UX-09 timeline has no inert sample point.');
    });
    await page.mouse.click(inertTimelinePoint.x, inertTimelinePoint.y);
    expect((await activePixelObservation(page, pixelPoint.x, pixelPoint.y)).revision).toBe(revisionBeforeTimeline);
    screenshots.push(await screenshotRecord(page, configured.screenshots[2]));

    failureDiagnostics = { ...failureDiagnostics, stage: 'renderer-request-census' };
    expect(unexpectedRendererRequests).toEqual([]);
    for (const path of [configured.paths.providerCredentials, configured.paths.forbiddenNetwork]) {
      expect(await access(path).then(() => true, () => false), `${path} must remain absent`).toBe(false);
    }
    expect(screenshots).toHaveLength(3);
    expect(new Set(screenshots.map((entry) => entry.sha256)).size).toBe(3);
    evidence = {
      scenario: UX09_TEXT_REFLOW_SCENARIO,
      result: 'passed',
      presentation: {
        declaration: 'source/headless 200-percent text contract represented by an exact 32 px root at the supported minimum renderer-content viewport',
        mechanism: UX09_TEXT_REFLOW_MECHANISM,
        activationScope: 'trusted packaged renderer controlled by this exact Playwright acceptance only; not an operating-system setting or production preference',
        observed: presentation,
        canonicalBeforeSha256: textSha256(canonicalBeforeMechanism),
        canonicalAfterSha256: textSha256(canonicalAfterMechanism),
        canonicalUnchanged: true,
      },
      package: {
        runId: configured.runId,
        packageRoot: configured.packageRoot,
        generationMarker: configured.generationMarker,
        generationMarkerSha256: await sha256(configured.generationMarker),
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
        failureRoot: configured.failureRoot,
        earlierRetainedEvidenceUntouched: true,
        defaultProfileUntouched: true,
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
      viewport: { width: 980, height: 640, root: viewport.root, body: viewport.body, timelineHeight: 138 },
      fit: { inspectorTabs: tabFit, maximumDurationFrame: frameFit },
      reachability: { axes, controls, keyboardRecovery },
      canonicalEdit: {
        canvasCssPoint: pointOnCanvas,
        mappedPixel: pixelPoint,
        beforeEdit,
        afterEdit,
        afterUndo,
        oneIndexedPixelChanged: true,
        undoRestoredExactPixel: true,
        timelineBoundary,
        inertTimelinePoint,
        timelineClickRevisionUnchanged: true,
      },
      screenshots,
      privacy: {
        rendererRequestObservation,
        observedRendererRequests,
        unexpectedRendererRequests: 0,
        providerCredentialsAbsent: true,
        forbiddenNetworkSentinelAbsent: true,
        credentialStorage: 'electron-safe-storage',
      },
      nonClaims: [
        'operating-system-accessibility-setting-activation',
        'browser-native-text-only-zoom',
        'screen-reader-certification',
        'windows-high-contrast-or-color-vision',
        'high-dpi-tablet-touchpad-or-mixed-monitor',
        'level-3',
        'release-candidate',
        'stable-v1',
      ],
    };
  } catch (error) {
    acceptanceFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    cleanup = await stopOwner(child, browser, configured.profile, configured.paths.ownerConnection, secrets);
    const cleanupSerialized = `${JSON.stringify(cleanup, null, 2)}\n`;
    assertUx09EvidenceRedacted(cleanupSerialized, secrets);
    await writeUx09ExclusiveRecord(configured.paths.cleanup, cleanupSerialized);
  }

  if (!cleanup.graceful && !acceptanceFailure) {
    acceptanceFailure = new Error(`The retained UX-09 owner did not clean up gracefully: ${JSON.stringify(cleanup)}.`);
  }
  if (acceptanceFailure || !evidence) {
    const failure = {
      scenario: UX09_TEXT_REFLOW_SCENARIO,
      result: 'failed',
      package: { executableSha256: configured.executableSha256, asarSha256: configured.asarSha256, platform: artifact.platform, arch: artifact.arch },
      error: redactUx09FailureText(acceptanceFailure?.message ?? 'The UX-09 acceptance did not complete.', secrets),
      diagnostics: failureDiagnostics,
      cleanup,
      completedScreenshots: await completedScreenshotRecords(configured.screenshots),
    };
    const serialized = `${JSON.stringify(failure, null, 2)}\n`;
    assertUx09EvidenceRedacted(serialized, secrets);
    await writeUx09ExclusiveRecord(configured.paths.failure, serialized);
    throw acceptanceFailure ?? new Error('The UX-09 acceptance did not produce evidence.');
  }

  const serialized = `${JSON.stringify({ ...evidence, cleanup }, null, 2)}\n`;
  assertUx09EvidenceRedacted(serialized, secrets);
  await writeUx09ExclusiveRecord(configured.paths.evidence, serialized);
  expect(cleanup.graceful).toBe(true);
  expect(cleanup.ownedSurvivors).toEqual([]);
});
