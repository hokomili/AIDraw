import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  inspectPackagedMcpCredential,
  resolvePackagedE2eArtifact,
  spawnPackagedE2e,
  waitForPackagedE2eReady,
} from '../../scripts/packaged-e2e-runtime.mjs';

const scenarioName = 'FND-02-PACKAGED-SECURITY exact package preserves the renderer security boundary';
const profilePrefix = 'aidraw-e2e-fnd02-packaged-security-';
const packagedArtifact = resolvePackagedE2eArtifact();
const packagedExecutable = packagedArtifact.executable;
const packagedAsar = packagedArtifact.asar;
const expectedBridgeKeys = [
  'bootstrap', 'newDocument', 'activateDocument', 'applyTransaction', 'undo', 'redo', 'undoAgent', 'redoAgent',
  'createCheckpoint', 'compareCheckpoint', 'restoreCheckpoint', 'mergeCheckpoint', 'deleteCheckpoint',
  'listDocumentPresets', 'saveDocumentPreset', 'deleteDocumentPreset', 'listInterchangeReports', 'exportInterchangeReport',
  'openDocuments', 'saveDocument', 'saveDocumentAs', 'saveAllDocuments', 'batchExportDocuments', 'closeAllDocuments',
  'closeDocument', 'stopAgents', 'acquireHumanLock', 'releaseHumanLock', 'getMcpConnectionInfo', 'getMcpCredentials',
  'rotateMcpCredential', 'revokeMcpAccess',
  'getEngineStatus', 'setEngineStartAtLogin', 'configureAgentClient', 'configureCodex', 'resolveJob',
  'setProviderCredential', 'getProviderStatus', 'generationStart', 'generationAccept', 'generationReject', 'jobCancel',
  'importFiles', 'importPalette', 'exportPalette', 'managePixelLink', 'selectSpriteSheet', 'importSpriteSheet',
  'exportActiveDocument', 'copySelection', 'pasteClipboard', 'replayTrace', 'updateEditorAdvisory',
  'writePixelSelectionClipboard', 'readPixelSelectionClipboard', 'setOnionSkinPreferences', 'setOrderedDitherPreferences',
  'setSpriteSymmetryPreferences',
  'exportRendererDiagnostics', 'injectRendererRecoveryTestEvent', 'onEvent', 'onNewDocumentRequested',
].sort();

interface McpConnection {
  version: number;
  url: string;
  token: string;
  activeDocumentId: string;
  pid: number;
  trustedFolders: string[];
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve the isolated security-audit DevTools port.');
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForExit(child: ChildProcess, label: string, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveWait, reject) => {
    const onExit = () => { clearTimeout(timer); resolveWait(); };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`${label} did not exit gracefully within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function quitGracefully(profile: string, child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const signal = spawnPackagedE2e(packagedExecutable, [`--user-data-dir=${profile}`, '--quit-engine'], { stdio: 'ignore' });
  await waitForExit(signal, 'The isolated security-audit quit signal', 5_000);
  await waitForExit(child, 'The isolated packaged security-audit process', 15_000);
}

async function waitForConnection(path: string, child: ChildProcess): Promise<McpConnection> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The packaged security-audit process exited before startup with code ${child.exitCode}.`);
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<McpConnection>;
      if (value.version === 1 && value.url && value.token && value.activeDocumentId && Number.isInteger(value.pid)) return value as McpConnection;
    } catch { /* The isolated package is still starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('The packaged security-audit process did not write its isolated connection in time.');
}

async function connectRenderer(port: number, child: ChildProcess, stderr: Buffer[]): Promise<{ browser: Browser; page: Page }> {
  const endpoint = `http://127.0.0.1:${port}`;
  const browser = await waitForPackagedE2eReady({
    child,
    label: 'The packaged security renderer DevTools endpoint',
    stderr: () => Buffer.concat(stderr).toString('utf8'),
    attempt: async () => {
      try { return await chromium.connectOverCDP(endpoint); }
      catch { return undefined; }
    },
  });
  const deadline = Date.now() + (process.platform === 'darwin' ? 30_000 : 15_000);
  while (Date.now() < deadline) {
    const page = browser.contexts()[0]?.pages().find((candidate) => candidate.url().startsWith('aidraw://app/'));
    if (page) { await page.waitForLoadState('domcontentloaded'); return { browser, page }; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await browser.close().catch(() => undefined);
  throw new Error('The packaged security renderer did not load the trusted aidraw://app origin.');
}

async function redactConnection(path: string): Promise<'redacted-after-graceful-stop' | 'absent'> {
  if (!await access(path).then(() => true, () => false)) return 'absent';
  const connection = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  delete connection.token;
  await writeFile(path, `${JSON.stringify({ ...connection, credentialStatus: 'redacted-after-graceful-stop' }, null, 2)}\n`, 'utf8');
  return 'redacted-after-graceful-stop';
}

test(scenarioName, async () => {
  test.setTimeout(45_000);
  const configuredProfile = process.env.AIDRAW_E2E_FND02_SECURITY_PROFILE;
  if (!configuredProfile) throw new Error('AIDRAW_E2E_FND02_SECURITY_PROFILE must name the fresh retained profile authorized for this exact run.');
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const profile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, profile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || dirname(profile) !== retainedRoot || !basename(profile).startsWith(profilePrefix)) {
    throw new Error(`AIDRAW_E2E_FND02_SECURITY_PROFILE must be a new ${profilePrefix}* direct child of test-results/retained.`);
  }
  if (await access(profile).then(() => true, () => false)) throw new Error(`The immutable packaged-security profile already exists: ${profile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_FND02_SECURITY_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_FND02_SECURITY_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact packaged-security executable and ASAR SHA-256 declarations are required.');
  const executableHash = await sha256(packagedExecutable);
  const asarHash = await sha256(packagedAsar);
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  await mkdir(profile, { recursive: false });
  const connectionPath = join(profile, 'mcp-connection.json');
  const evidencePath = join(profile, 'fnd02-packaged-security-evidence.json');
  const tokenPath = join(profile, 'credentials', 'mcp-token.json');
  const trustSettingsPath = join(profile, 'trusted-folders.json');
  const providerCredentialsPath = join(profile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(profile, 'fnd02-forbidden-network.json');
  for (const path of [connectionPath, evidencePath, tokenPath, trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const debuggingPort = await reservePort();
  const stderr: Buffer[] = [];
  const child = spawnPackagedE2e(packagedExecutable, [
    `--remote-debugging-port=${debuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    `--user-data-dir=${profile}`,
    `--write-mcp-connection=${connectionPath}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

  let browser: Browser | undefined;
  let failure: Error | undefined;
  let runtimeEvidence: Record<string, unknown> | undefined;
  let connection: McpConnection | undefined;
  let credentialStatus: 'redacted-after-graceful-stop' | 'absent' = 'absent';
  try {
    connection = await waitForConnection(connectionPath, child);
    expect(connection.pid).toBe(child.pid);
    expect(connection.trustedFolders).toEqual([]);
    const connectionUrl = new URL(connection.url);
    expect(connectionUrl.protocol).toBe('http:');
    expect(connectionUrl.hostname).toBe('127.0.0.1');
    expect(connectionUrl.pathname).toBe('/mcp');

    const tokenFile = JSON.parse(await readFile(tokenPath, 'utf8')) as unknown;
    inspectPackagedMcpCredential(tokenFile, connection.token);

    const connected = await connectRenderer(debuggingPort, child, stderr);
    browser = connected.browser;
    const page = connected.page;
    const originalUrl = page.url();
    const initialPageCount = browser.contexts()[0]?.pages().length ?? 0;
    const nonLoopbackRequests: string[] = [];
    page.on('request', (request) => {
      try {
        const url = new URL(request.url());
        if ((url.protocol === 'http:' || url.protocol === 'https:') && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
          nonLoopbackRequests.push(`${url.protocol}//${url.host}${url.pathname}`);
        }
      } catch { /* Non-URL renderer requests are ignored. */ }
    });

    const renderer = await page.evaluate(async (expectedKeys) => {
      const bridge = window.aidraw as unknown as Record<string, (...args: unknown[]) => unknown>;
      const ownKeys = Object.keys(bridge).sort();
      const descriptors = Object.values(Object.getOwnPropertyDescriptors(bridge));
      const forbiddenOwnKeys = [
        'ipcRenderer', 'contextBridge', 'invoke', 'send', 'sendSync', 'postMessage', 'on', 'once',
        'removeListener', 'require', 'process', 'Buffer', 'electron', 'shell', 'dialog', 'webContents',
      ].filter((key) => Object.hasOwn(bridge, key));
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const csp = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? '';
      delete globals.__aidrawInlineSecurityProbe;
      const inlineScript = document.createElement('script');
      inlineScript.textContent = 'globalThis.__aidrawInlineSecurityProbe = true';
      document.head.append(inlineScript);
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      inlineScript.remove();
      const notificationPermission = typeof Notification === 'undefined' ? 'unavailable' : await Notification.requestPermission();
      const opened = window.open('data:text/html,<title>blocked-window</title>', '_blank');
      const webview = document.createElement('webview') as HTMLElement & { getWebContentsId?: unknown };
      webview.setAttribute('src', 'data:text/html,<title>blocked-webview</title>');
      document.body.append(webview);
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      const webviewPrimitiveAbsent = typeof webview.getWebContentsId === 'undefined';
      webview.remove();
      const snapshot = await window.aidraw.bootstrap();
      return {
        origin: location.href,
        ownKeys,
        expectedKeysMatched: JSON.stringify(ownKeys) === JSON.stringify(expectedKeys),
        frozen: Object.isFrozen(bridge),
        functionOnly: descriptors.every((descriptor) => typeof descriptor.value === 'function' && descriptor.get === undefined && descriptor.set === undefined),
        forbiddenOwnKeys,
        nodeGlobals: {
          require: typeof globals.require,
          process: typeof globals.process,
          Buffer: typeof globals.Buffer,
          module: typeof globals.module,
        },
        csp,
        inlineScriptBlocked: globals.__aidrawInlineSecurityProbe !== true,
        notificationPermission,
        windowOpenDenied: opened === null,
        webviewPrimitiveAbsent,
        bootstrapDocumentCount: snapshot.documents.length,
      };
    }, expectedBridgeKeys);

    expect(renderer).toMatchObject({
      origin: expect.stringMatching(/^aidraw:\/\/app\//),
      expectedKeysMatched: true,
      frozen: true,
      functionOnly: true,
      forbiddenOwnKeys: [],
      nodeGlobals: { require: 'undefined', process: 'undefined', Buffer: 'undefined', module: 'undefined' },
      inlineScriptBlocked: true,
      notificationPermission: 'denied',
      windowOpenDenied: true,
      webviewPrimitiveAbsent: true,
    });
    expect(renderer.ownKeys).toHaveLength(63);
    expect(renderer.csp).toContain("default-src 'self'");
    expect(renderer.csp).toContain("script-src 'self'");
    expect(renderer.csp).toContain("object-src 'none'");
    expect(renderer.csp).toContain("frame-src 'none'");
    expect(renderer.csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(renderer.bootstrapDocumentCount).toBeGreaterThan(0);

    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'data:text/html,<title>blocked-navigation</title>';
      link.textContent = 'blocked navigation';
      document.body.append(link);
      link.click();
      link.remove();
    });
    await page.waitForTimeout(200);
    expect(page.url()).toBe(originalUrl);
    expect(browser.contexts()[0]?.pages()).toHaveLength(initialPageCount);
    expect(nonLoopbackRequests).toEqual([]);
    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) expect(await access(sentinel).then(() => true, () => false)).toBe(false);

    runtimeEvidence = {
      scenario: scenarioName,
      package: {
        executable: packagedExecutable,
        executableBytes: (await stat(packagedExecutable)).size,
        executableSha256: executableHash,
        asar: packagedAsar,
        asarBytes: (await stat(packagedAsar)).size,
        asarSha256: asarHash,
      },
      process: { pidMatchedConnection: true, devtoolsLoopbackOnly: true },
      renderer,
      denials: { windowOpen: true, navigation: true, notificationPermission: true, webviewPrimitiveAbsent: true },
      network: { nonLoopbackRequests: 0, providerRequests: 0, paidRequests: 0 },
      sentinels: { trustAbsent: true, providerCredentialsAbsent: true, forbiddenNetworkAbsent: true },
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
    let cleanupError: Error | undefined;
    try { await quitGracefully(profile, child); }
    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged security audit did not stop gracefully.'); }
    try { credentialStatus = await redactConnection(connectionPath); }
    catch (error) { cleanupError ??= error instanceof Error ? error : new Error('The packaged security connection could not be redacted.'); }

    const retainedEvidence = {
      ...(runtimeEvidence ?? {
        scenario: scenarioName,
        package: { executable: packagedExecutable, executableSha256: executableHash, asar: packagedAsar, asarSha256: asarHash },
      }),
      result: failure || cleanupError ? 'failed' : 'passed',
      error: failure?.message ?? cleanupError?.message,
      cleanup: { gracefulOnly: true, exitCode: child.exitCode, credentialStatus },
    };
    await writeFile(evidencePath, `${JSON.stringify(retainedEvidence, null, 2)}\n`, 'utf8');
    if (!failure && cleanupError) failure = cleanupError;
  }

  expect(child.exitCode).toBe(0);
  expect(credentialStatus).toBe('redacted-after-graceful-stop');
  if (failure) throw failure;
});
