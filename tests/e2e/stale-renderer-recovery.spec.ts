import { expect, test } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { HUMAN_ACTOR, type Actor, type IllustrationDocument, type IllustrationObject } from '@aidraw/core';
import {
  assertFnd05OwnedProcessShape,
  assertFnd05EvidenceRedacted,
  assertFnd05DebuggerDetachProof,
  assertFnd05UnresponsiveSafeReporterEnvironment,
  classifyFnd05DebuggerDetachCommandSettlement,
  classifyFnd05UnresponsiveFailureStage,
  FND05_PACKAGED_SCENARIO,
  FND05_UNRESPONSIVE_CONFIRMATION_MARKER,
  FND05_UNRESPONSIVE_CONFIRMATION_WAIT_MS,
  FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS,
  FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS,
  FND05_UNRESPONSIVE_INPUT_ADMISSION_WAIT_MS,
  FND05_UNRESPONSIVE_INPUT_EVENT,
  FND05_UNRESPONSIVE_OBSERVATION_MS,
  FND05_UNRESPONSIVE_PACKAGED_SCENARIO,
  FND05_UNRESPONSIVE_POLICY_GRACE_MS,
  FND05_UNRESPONSIVE_REPLACEMENT_WAIT_MS,
  FND05_UNRESPONSIVE_STALL_EXPRESSION,
  FND05_UNRESPONSIVE_STALL_MS,
  inspectFnd05EncryptedToken,
  observeFnd05DeliberatePageCrash,
  parseFnd05OwnedProcesses,
  redactFnd05FailureText,
  resolveFnd05PackagedAcceptance,
  resolveFnd05UnresponsiveAcceptance,
} from '../../scripts/fnd05-packaged-acceptance.mjs';
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

interface OwnerRun {
  phase: 'owner' | 'relaunch' | 'unresponsive-owner';
  connectionPath: string;
  child?: ChildProcess;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  connection?: McpConnection;
  debuggerEndpoint?: string;
  stderr: Buffer[];
  externalRendererRequests: string[];
}

interface CleanupRecord {
  phase: OwnerRun['phase'];
  ownerPid?: number;
  ownerExitCode?: number | null;
  signalPid?: number;
  signalExitCode?: number | null;
  connectionCredentials: 'redacted-after-graceful-stop' | 'absent' | 'live-owner-not-stopped';
  ownedSurvivors: Array<{ pid: number; ppid: number; type: string }>;
  graceful: boolean;
  error?: string;
}

interface UnresponsiveProgress {
  stallPendingAtObservation: boolean;
  inputMethod: 'Input.dispatchKeyEvent';
  inputKey: 'F24';
  inputTargetId?: string;
  inputAdmission: 'not-attempted' | 'admitted' | 'ack-pending' | 'rejected';
  inputCommandSettlement: 'not-started' | 'pending' | 'resolved' | 'rejected';
  productConfirmationAbsentThroughDebuggerDetach: boolean;
  debuggerDetachRequested: boolean;
  allDebuggerAttachmentsDetached: boolean;
  debuggerDetachedElapsedMs?: number;
  ownerAliveAfterDebuggerDetach: boolean;
  sameOwnerMcpResponsiveAfterDebuggerDetach: boolean;
  productUnresponsiveConfirmationObserved: boolean;
  productUnresponsiveConfirmationElapsedMs?: number;
  replacementProcessAdmitted: boolean;
  debuggerTransportReconnectAttempted: boolean;
  debuggerTransportReconnected: boolean;
  debuggerTransportReconnectedElapsedMs?: number;
  replacementAdmitted: boolean;
  replacementElapsedMs?: number;
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
  if (!address || typeof address === 'string') throw new Error('Could not reserve the isolated FND-05 DevTools port.');
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
    label: 'The retained FND-05 MCP connection',
    timeoutMs: 20_000,
    attempt: async () => {
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as Partial<McpConnection>;
        if (value.version !== 1 || !value.url || !value.token || !value.activeDocumentId || !Number.isInteger(value.pid)) return undefined;
        const url = new URL(value.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp') throw new Error('The FND-05 MCP endpoint is not an exact loopback /mcp URL.');
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

async function startOwner(run: OwnerRun, profile: string, stripProviderEnvironment = false): Promise<void> {
  const port = await reservePort();
  run.child = spawnPackagedE2e(executable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    ...networkDisabledArguments,
    ...(stripProviderEnvironment ? ['--proxy-server=http://127.0.0.1:9'] : []),
    `--user-data-dir=${profile}`,
    `--write-mcp-connection=${run.connectionPath}`,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    ...(stripProviderEnvironment ? {
      env: {
        OPENAI_API_KEY: '',
        STABILITY_API_KEY: '',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        ALL_PROXY: 'socks5://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost',
        http_proxy: 'http://127.0.0.1:9',
        https_proxy: 'http://127.0.0.1:9',
        all_proxy: 'socks5://127.0.0.1:9',
        no_proxy: '127.0.0.1,localhost',
      },
    } : {}),
  });
  run.child.stderr?.on('data', (chunk: Buffer) => run.stderr.push(chunk));
  run.connection = await waitForConnection(run.connectionPath, run.child);
  if (!run.child.pid || run.connection.pid !== run.child.pid) throw new Error('The retained connection PID does not match the exact spawned owner.');
  if (run.connection.trustedFolders.length !== 0) throw new Error('The retained FND-05 owner unexpectedly received filesystem trust.');

  run.debuggerEndpoint = `http://127.0.0.1:${port}`;
  await connectOwnerDebugger(run);
}

async function connectOwnerDebugger(run: OwnerRun, timeoutMs = 20_000): Promise<void> {
  if (!run.child || !run.debuggerEndpoint || new URL(run.debuggerEndpoint).hostname !== '127.0.0.1') {
    throw new Error('The retained FND-05 debugger reconnect is not bound to the exact loopback owner endpoint.');
  }
  const startedAt = Date.now();
  run.browser = await waitForPackagedE2eReady({
    child: run.child,
    label: 'The retained FND-05 DevTools endpoint',
    stderr: () => Buffer.concat(run.stderr).toString('utf8'),
    attempt: async () => {
      try { return await chromium.connectOverCDP(run.debuggerEndpoint!); }
      catch { return undefined; }
    },
    timeoutMs,
  });
  run.context = run.browser.contexts()[0];
  if (!run.context) throw new Error('The retained FND-05 owner has no default browser context.');
  run.context.on('request', (request) => {
    if (!isPermittedRendererUrl(request.url())) run.externalRendererRequests.push(request.url());
  });
  const pageTimeoutMs = timeoutMs - (Date.now() - startedAt);
  if (pageTimeoutMs <= 0) throw new Error('The retained FND-05 debugger transport connected after its bounded page-admission deadline.');
  run.page = await waitForSingleRendererPage(run.context, undefined, pageTimeoutMs);
}

async function disconnectOwnerDebugger(run: OwnerRun, stallStartedAt: number): Promise<number> {
  const browser = run.browser;
  if (!browser?.isConnected() || !run.child || run.child.exitCode !== null) {
    throw new Error('The retained FND-05 debugger transport cannot detach from a disconnected or stopped owner.');
  }
  const detached = await Promise.race([
    browser.close().then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(
      () => resolveTimeout(false),
      FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS,
    )),
  ]);
  if (!detached || browser.isConnected()) {
    throw new Error(`The retained FND-05 debugger transport did not fully detach within ${FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS} ms.`);
  }
  if (run.child.exitCode !== null) throw new Error('The retained FND-05 owner exited while its debugger transport detached.');
  run.browser = undefined;
  run.context = undefined;
  run.page = undefined;
  const elapsedMs = performance.now() - stallStartedAt;
  if (elapsedMs > FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS) {
    throw new Error(`The retained FND-05 debugger transport detached after the ${FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS} ms ACK-deadline budget.`);
  }
  return elapsedMs;
}

async function waitForSingleRendererPage(context: BrowserContext, previous?: Page, timeoutMs = 20_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = context.pages().filter((candidate) => !candidate.isClosed() && candidate.url().startsWith('aidraw://app/') && candidate !== previous);
    if (pages.length === 1) {
      await pages[0].waitForLoadState('domcontentloaded');
      return pages[0];
    }
    if (pages.length > 1) throw new Error(`The retained FND-05 owner admitted ${pages.length} renderer pages; expected exactly one.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('The retained FND-05 owner did not expose exactly one trusted renderer page.');
}

async function waitForStderrMarker(run: OwnerRun, marker: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Buffer.concat(run.stderr).includes(Buffer.from(marker))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`The retained FND-05 owner did not report the expected product unresponsive confirmation within ${timeoutMs} ms.`);
}

async function processRows(profile: string): Promise<Array<{ pid: number; ppid: number; type: string }>> {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return parseFnd05OwnedProcesses(stdout, profile);
}

async function waitForProcessShape(profile: string, expectedOwnerPid: number, previousRendererPid?: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last: Array<{ pid: number; ppid: number; type: string }> = [];
  const observedReplacementRendererPids = new Set<number>();
  while (Date.now() < deadline) {
    last = await processRows(profile);
    if (previousRendererPid !== undefined) {
      for (const entry of last) {
        if (entry.type === 'renderer' && entry.ppid === expectedOwnerPid && entry.pid !== previousRendererPid) {
          observedReplacementRendererPids.add(entry.pid);
        }
      }
      if (observedReplacementRendererPids.size > 1) {
        throw new Error(`The retained FND-05 owner admitted multiple replacement renderer processes: ${JSON.stringify([...observedReplacementRendererPids])}.`);
      }
    }
    try {
      const shape = assertFnd05OwnedProcessShape(last, expectedOwnerPid, previousRendererPid);
      return { rows: last, rendererPid: shape.rendererPid, observedReplacementRendererPids: [...observedReplacementRendererPids] };
    } catch { /* continue until the exact owner/renderer shape settles */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`The retained FND-05 process shape never reached one owner and one renderer: ${JSON.stringify(last)}.`);
}

async function waitForNoOwnedProcesses(profile: string): Promise<Array<{ pid: number; ppid: number; type: string }>> {
  const deadline = Date.now() + 15_000;
  let rows = await processRows(profile);
  while (rows.length && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    rows = await processRows(profile);
  }
  return rows;
}

function parseMcpPayload(text: string): { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: unknown } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as ReturnType<typeof parseMcpPayload>;
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (!data.length) throw new Error(`MCP returned an unrecognized response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data.at(-1)!) as ReturnType<typeof parseMcpPayload>;
}

async function callMcpTool(url: string, headers: Record<string, string>, id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const payload = parseMcpPayload(await response.text());
  if (!response.ok || payload.error) throw new Error(`${name} failed: ${JSON.stringify(payload.error ?? payload)}`);
  const text = payload.result?.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) throw new Error(`${name} did not return structured JSON text.`);
  if (payload.result?.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function connectMcp(connection: McpConnection): Promise<{ actor: Actor; headers: Record<string, string> }> {
  const initialize = await fetch(connection.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'fnd05-stale-renderer-e2e', version: '1.0' } } }),
  });
  const sessionId = initialize.headers.get('mcp-session-id');
  if (!initialize.ok || !sessionId) throw new Error('The retained FND-05 MCP session is unavailable.');
  const headers = { authorization: `Bearer ${connection.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
  await fetch(connection.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const joined = await callMcpTool(connection.url, headers, 2, 'session_manage', {
    action: 'join',
    name: 'FND-05 recovery probe',
    color: '#2f9d8f',
    documentId: connection.activeDocumentId,
  });
  const actor = joined.actor as Actor | undefined;
  if (!actor?.id || actor.kind !== 'agent') throw new Error('The retained FND-05 MCP actor identity is invalid.');
  return { actor, headers };
}

async function rendererTarget(page: Page): Promise<{ session: CDPSession; targetId: string }> {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send('Target.getTargetInfo');
  return { session, targetId: targetInfo.targetId };
}

async function crashRenderer(session: CDPSession, page: Page): Promise<void> {
  const crashEvent = page.waitForEvent('crash');
  await observeFnd05DeliberatePageCrash(crashEvent, session.send('Page.crash'));
}

async function signalOwner(profile: string, argument: '--show' | '--quit-engine') {
  const signal = spawnPackagedE2e(executable, [`--user-data-dir=${profile}`, argument], { stdio: 'ignore' });
  const exitCode = await waitForExit(signal, `The retained FND-05 ${argument} signal`, 10_000);
  if (exitCode !== 0) throw new Error(`The retained FND-05 ${argument} signal exited with ${String(exitCode)}.`);
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

async function writePrivateRecord(path: string, text: string): Promise<void> {
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error(`The retained FND-05 record is not mode 0600: ${path}.`);
}

async function stopOwner(run: OwnerRun, profile: string, secrets: string[]): Promise<CleanupRecord> {
  const ownerPid = run.child?.pid;
  let signalPid: number | undefined;
  let signalExitCode: number | null | undefined;
  let cleanupError: Error | undefined;
  if (run.child?.exitCode === null) {
    try {
      const signal = await signalOwner(profile, '--quit-engine');
      signalPid = signal.pid;
      signalExitCode = signal.exitCode;
      await waitForExit(run.child, `The retained FND-05 ${run.phase} owner`, 15_000);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const ownerStopped = Boolean(run.child && run.child.exitCode !== null);
  // Normal cleanup waits for the exact owner to exit before closing any remaining
  // Playwright transport. The unresponsive route's earlier public close is a
  // separately audited connectOverCDP transport disconnect, never Browser.close.
  if (ownerStopped && run.browser?.isConnected()) await run.browser.close().catch(() => undefined);
  const redacted = ownerStopped ? await redactConnection(run.connectionPath) : { status: 'live-owner-not-stopped' as const };
  if ('secret' in redacted && redacted.secret) secrets.push(redacted.secret);
  const ownedSurvivors = await waitForNoOwnedProcesses(profile);
  const graceful = Boolean(run.child && run.child.exitCode === 0 && signalExitCode === 0 && redacted.status === 'redacted-after-graceful-stop' && ownedSurvivors.length === 0 && !cleanupError);
  return {
    phase: run.phase,
    ownerPid,
    ownerExitCode: run.child?.exitCode,
    signalPid,
    signalExitCode,
    connectionCredentials: redacted.status,
    ownedSurvivors,
    graceful,
    ...(cleanupError ? { error: cleanupError.message } : {}),
  };
}

test(FND05_PACKAGED_SCENARIO, async () => {
  test.skip(process.platform !== 'darwin', 'This prepared checkpoint is the exact current macOS/arm64 acceptance only.');
  test.setTimeout(120_000);
  const configured = resolveFnd05PackagedAcceptance();
  expect(artifact.platform).toBe('darwin');
  expect(artifact.arch).toBe('arm64');
  expect(await sha256(executable)).toBe(configured.executableSha256);
  expect(await sha256(asar)).toBe(configured.asarSha256);
  expect(await access(configured.profile).then(() => true, () => false), 'The retained FND-05 profile must not exist before launch.').toBe(false);
  await mkdir(configured.profile, { recursive: false, mode: 0o700 });
  for (const path of Object.values(configured.paths)) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const secrets: string[] = [];
  const cleanup: CleanupRecord[] = [];
  let active: OwnerRun | undefined;
  let acceptanceFailure: Error | undefined;
  let evidence: Record<string, unknown> | undefined;

  try {
    const owner: OwnerRun = { phase: 'owner', connectionPath: configured.paths.ownerConnection, stderr: [], externalRendererRequests: [] };
    active = owner;
    await startOwner(owner, configured.profile);
    const ownerPid = owner.child!.pid!;
    const ownerConnection = owner.connection!;
    secrets.push(ownerConnection.token);
    const beforeProcess = await waitForProcessShape(configured.profile, ownerPid);
    const beforeTarget = await rendererTarget(owner.page!);

    const canonicalBefore = await owner.page!.evaluate(async (actor) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      if (!document || document.kind !== 'illustration') throw new Error('The retained FND-05 illustration document is unavailable.');
      const layer = Object.values(document.layers).find((candidate) => candidate.type === 'vector');
      if (!layer) throw new Error('The retained FND-05 vector layer is unavailable.');
      const timestamp = new Date().toISOString();
      const object = {
        id: 'fnd05-stale-renderer-shape', revision: 0, name: 'Before renderer loss', createdAt: timestamp, updatedAt: timestamp,
        createdBy: actor.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const,
        transform: { x: 48, y: 52, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
        type: 'shape' as const, shape: 'rectangle' as const, width: 96, height: 72,
        fill: { kind: 'solid' as const, color: '#c86891' },
        stroke: { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] },
      };
      const applied = await window.aidraw.applyTransaction({
        id: 'tx-fnd05-before-renderer-loss', clientOperationId: 'fnd05-before-renderer-loss', documentId: document.id,
        actor, label: 'Prepare stale renderer recovery', createdAt: timestamp, operations: [{ kind: 'illustration.object.add', object }],
        playback: { mode: 'instant', speed: 1 },
      });
      if (applied.status !== 'committed') throw new Error(`The FND-05 human preparation did not commit: ${applied.status}.`);
      const prepared = await window.aidraw.bootstrap();
      const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [object.id] });
      if (!lock.acquired || !lock.lockId) throw new Error('The FND-05 transient human lock was not acquired.');
      const active = prepared.activeDocument;
      if (!active || active.kind !== 'illustration') throw new Error('The prepared FND-05 document is unavailable.');
      return {
        documentId: active.id,
        documentName: active.name,
        revision: active.revision,
        object: active.objects[object.id],
        activity: active.activity,
        canUndo: prepared.canUndo,
        canRedo: prepared.canRedo,
        lockId: lock.lockId,
      };
    }, HUMAN_ACTOR);
    expect(canonicalBefore).toMatchObject({ canUndo: true, canRedo: false, object: { id: 'fnd05-stale-renderer-shape', name: 'Before renderer loss', revision: 0 } });

    const client = await connectMcp(ownerConnection);
    let requestId = 3;
    const occupied = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'session_manage', { action: 'inspect', documentId: canonicalBefore.documentId });
    expect(occupied).toMatchObject({ workspace: { humanOccupancy: { active: true, locks: [{ objectIds: [canonicalBefore.object.id] }] }, editorAdvisory: { attached: true, documentId: canonicalBefore.documentId } } });

    const replacementObject = { ...canonicalBefore.object, name: 'Recovered renderer edit' } as IllustrationObject;
    const locked = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'canvas_apply', {
      documentId: canonicalBefore.documentId,
      clientOperationId: 'fnd05-agent-retry-after-renderer-loss',
      label: 'Retry after renderer loss',
      operations: [{ kind: 'illustration.object.replace', object: replacementObject, expectedRevision: canonicalBefore.object.revision }],
      playback: { mode: 'instant', speed: 1 },
    });
    expect(locked).toMatchObject({ status: 'locked', conflict: { retryable: true } });

    const replacementEvents: Page[] = [];
    const onReplacement = (candidate: Page) => {
      if (candidate.url().startsWith('aidraw://app/')) replacementEvents.push(candidate);
      else candidate.once('domcontentloaded', () => { if (candidate.url().startsWith('aidraw://app/')) replacementEvents.push(candidate); });
    };
    owner.context!.on('page', onReplacement);
    await crashRenderer(beforeTarget.session, owner.page!);
    const replacementPage = await waitForSingleRendererPage(owner.context!, owner.page);
    owner.page = replacementPage;
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    owner.context!.off('page', onReplacement);
    expect(replacementEvents).toHaveLength(1);
    expect(replacementEvents.filter((candidate) => candidate === replacementPage)).toHaveLength(1);
    expect(owner.context!.pages().filter((candidate) => candidate.url().startsWith('aidraw://app/'))).toEqual([replacementPage]);
    const replacementTarget = await rendererTarget(replacementPage);
    const afterProcess = await waitForProcessShape(configured.profile, ownerPid, beforeProcess.rendererPid);
    expect(replacementTarget.targetId).not.toBe(beforeTarget.targetId);
    expect(afterProcess.rendererPid).not.toBe(beforeProcess.rendererPid);
    expect(owner.child!.pid).toBe(ownerConnection.pid);
    expect((JSON.parse(await readFile(configured.paths.ownerConnection, 'utf8')) as McpConnection).pid).toBe(ownerPid);

    const inspectedAfterLoss = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'session_manage', { action: 'inspect', documentId: canonicalBefore.documentId });
    expect(inspectedAfterLoss).toMatchObject({ workspace: { humanOccupancy: { active: false, locks: [] }, editorAdvisory: { attached: true, documentId: canonicalBefore.documentId } } });
    const canonicalAfterLoss = await replacementPage.evaluate(async () => {
      const snapshot = await window.aidraw.bootstrap();
      const engine = await window.aidraw.getEngineStatus();
      return { snapshot, engine };
    });
    const recoveredDocument = canonicalAfterLoss.snapshot.activeDocument as IllustrationDocument;
    expect({
      documentId: recoveredDocument.id,
      name: recoveredDocument.name,
      revision: recoveredDocument.revision,
      object: recoveredDocument.objects[canonicalBefore.object.id],
      activity: recoveredDocument.activity,
      canUndo: canonicalAfterLoss.snapshot.canUndo,
      canRedo: canonicalAfterLoss.snapshot.canRedo,
      engine: canonicalAfterLoss.engine,
    }).toEqual({
      documentId: canonicalBefore.documentId,
      name: canonicalBefore.documentName,
      revision: canonicalBefore.revision,
      object: canonicalBefore.object,
      activity: canonicalBefore.activity,
      canUndo: true,
      canRedo: false,
      engine: expect.objectContaining({ running: true, uiAttached: true, mode: 'interactive' }),
    });

    const retried = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'canvas_apply', {
      documentId: canonicalBefore.documentId,
      clientOperationId: 'fnd05-agent-retry-after-renderer-loss',
      label: 'Retry after renderer loss',
      operations: [{ kind: 'illustration.object.replace', object: replacementObject, expectedRevision: canonicalBefore.object.revision }],
      playback: { mode: 'instant', speed: 1 },
    });
    expect(retried).toMatchObject({ status: 'committed', revision: canonicalBefore.revision + 1 });

    await replacementPage.close();
    await expect.poll(() => owner.context!.pages().filter((candidate) => candidate.url().startsWith('aidraw://app/')).length).toBe(0);
    const detached = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'session_manage', { action: 'inspect', documentId: canonicalBefore.documentId });
    expect(detached).toMatchObject({ workspace: { editorAdvisory: { attached: false }, humanOccupancy: { active: false } } });
    const show = await signalOwner(configured.profile, '--show');
    const reopenedPage = await waitForSingleRendererPage(owner.context!);
    const reopenedProcess = await waitForProcessShape(configured.profile, ownerPid);
    const reopened = await reopenedPage.evaluate(async (objectId) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      return { documentId: document?.id, revision: document?.revision, object: document?.kind === 'illustration' ? document.objects[objectId] : undefined, engine: await window.aidraw.getEngineStatus() };
    }, canonicalBefore.object.id);
    expect(reopened).toMatchObject({ documentId: canonicalBefore.documentId, revision: canonicalBefore.revision + 1, object: { name: 'Recovered renderer edit' }, engine: { running: true, uiAttached: true, mode: 'interactive' } });
    const firstCleanup = await stopOwner(owner, configured.profile, secrets);
    cleanup.push(firstCleanup);
    active = undefined;
    expect(firstCleanup).toMatchObject({ graceful: true, ownerPid, ownerExitCode: 0, signalExitCode: 0, connectionCredentials: 'redacted-after-graceful-stop', ownedSurvivors: [] });

    const relaunch: OwnerRun = { phase: 'relaunch', connectionPath: configured.paths.relaunchConnection, stderr: [], externalRendererRequests: [] };
    active = relaunch;
    await startOwner(relaunch, configured.profile);
    const relaunchPid = relaunch.child!.pid!;
    const relaunchConnection = relaunch.connection!;
    secrets.push(relaunchConnection.token);
    expect(relaunchPid).not.toBe(ownerPid);
    const relaunchProcess = await waitForProcessShape(configured.profile, relaunchPid);
    const relaunched = await relaunch.page!.evaluate(async (objectId) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      return {
        documentId: document?.id,
        revision: document?.revision,
        object: document?.kind === 'illustration' ? document.objects[objectId] : undefined,
        activityLabels: document?.activity.map((entry) => entry.label),
        engine: await window.aidraw.getEngineStatus(),
      };
    }, canonicalBefore.object.id);
    expect(relaunched).toMatchObject({
      documentId: canonicalBefore.documentId,
      revision: canonicalBefore.revision + 1,
      object: { name: 'Recovered renderer edit' },
      activityLabels: expect.arrayContaining(['Prepare stale renderer recovery', 'Retry after renderer loss']),
      engine: { running: true, uiAttached: true, mode: 'interactive' },
    });

    const encryptedCredential = JSON.parse(await readFile(configured.paths.tokenCredentials, 'utf8')) as Record<string, unknown>;
    expect(encryptedCredential).toMatchObject({ encryption: 'electron-safe-storage' });
    expect(encryptedCredential.value).not.toBe(ownerConnection.token);
    expect(encryptedCredential.value).not.toBe(relaunchConnection.token);
    expect(await access(configured.paths.providerCredentials).then(() => true, () => false)).toBe(false);
    expect(await access(configured.paths.forbiddenNetwork).then(() => true, () => false)).toBe(false);
    expect([...owner.externalRendererRequests, ...relaunch.externalRendererRequests]).toEqual([]);

    const relaunchCleanup = await stopOwner(relaunch, configured.profile, secrets);
    cleanup.push(relaunchCleanup);
    active = undefined;
    expect(relaunchCleanup).toMatchObject({ graceful: true, ownerPid: relaunchPid, ownerExitCode: 0, signalExitCode: 0, connectionCredentials: 'redacted-after-graceful-stop', ownedSurvivors: [] });

    const executableInfo = await stat(executable);
    const asarInfo = await stat(asar);
    evidence = {
      version: 1,
      scenario: FND05_PACKAGED_SCENARIO,
      package: { executable, asar, platform: artifact.platform, architecture: artifact.arch, executableBytes: executableInfo.size, asarBytes: asarInfo.size, executableSha256: configured.executableSha256, asarSha256: configured.asarSha256 },
      isolation: { profile: configured.profile, defaultProfileUntouched: true, priorPackageUntouched: true, remoteDebuggingAddress: '127.0.0.1' },
      rendererLoss: { mechanism: 'CDP Page.crash from the loopback Playwright controller', productionBridgeAdded: false, beforeTargetId: beforeTarget.targetId, replacementTargetId: replacementTarget.targetId, beforeRendererPid: beforeProcess.rendererPid, replacementRendererPid: afterProcess.rendererPid, replacementCount: replacementEvents.length },
      ownerContinuity: { ownerPid, connectionPid: ownerConnection.pid, sameOwnerThroughLossAndCloseReopen: true, closeSignalPid: show.pid, closeSignalExitCode: show.exitCode },
      canonicalContinuity: { documentId: canonicalBefore.documentId, revisionBeforeLoss: canonicalBefore.revision, revisionAfterRetry: canonicalBefore.revision + 1, objectId: canonicalBefore.object.id, humanUndoHistoryPresentAfterLoss: true, activityPreservedAfterLoss: true, transientHumanOccupancyCleared: true },
      closeAndReopen: { sameOwner: true, sameDocument: true, sameRevision: true, exactlyOneWindow: true, rendererPid: reopenedProcess.rendererPid },
      sameProfileRelaunch: { profile: configured.profile, previousOwnerPid: ownerPid, relaunchOwnerPid: relaunchPid, restoredDocumentId: canonicalBefore.documentId, restoredRevision: canonicalBefore.revision + 1, rendererPid: relaunchProcess.rendererPid },
      credentialsAndNetwork: { connectionFilesRedactedAfterConfirmedExit: true, localMcpCredentialEncryptedAtRest: true, providerCredentialFileAbsent: true, rendererExternalRequestsObserved: 0, backgroundNetworkDisabled: true },
      cleanup,
    };
  } catch (error) {
    acceptanceFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (active) {
      const cleanupRecord = await stopOwner(active, configured.profile, secrets);
      cleanup.push(cleanupRecord);
      if (!cleanupRecord.graceful) {
        const detail = `Graceful-only ${active.phase} cleanup failed${cleanupRecord.error ? `: ${cleanupRecord.error}` : '.'}`;
        acceptanceFailure = acceptanceFailure ? new Error(`${acceptanceFailure.message}\n${detail}`) : new Error(detail);
      }
    }

    const cleanupText = `${JSON.stringify({ version: 1, scenario: FND05_PACKAGED_SCENARIO, cleanup }, null, 2)}\n`;
    assertFnd05EvidenceRedacted(cleanupText, secrets);
    await writeFile(configured.paths.cleanup, cleanupText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

    if (acceptanceFailure) {
      const stderr = active ? Buffer.concat(active.stderr).toString('utf8') : '';
      const failureText = `${JSON.stringify({
        version: 1,
        scenario: FND05_PACKAGED_SCENARIO,
        status: 'failed',
        failure: redactFnd05FailureText(acceptanceFailure.message, secrets),
        stderr: redactFnd05FailureText(stderr, secrets),
        cleanup,
      }, null, 2)}\n`;
      assertFnd05EvidenceRedacted(failureText, secrets);
      await writeFile(configured.paths.failure, failureText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
  }

  if (acceptanceFailure) throw new Error(redactFnd05FailureText(acceptanceFailure.message, secrets));
  if (!evidence || cleanup.length !== 2 || cleanup.some((entry) => !entry.graceful)) throw new Error('The retained FND-05 evidence did not reach its complete graceful boundary.');
  const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
  assertFnd05EvidenceRedacted(evidenceText, secrets);
  await writeFile(configured.paths.evidence, evidenceText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
});

test(FND05_UNRESPONSIVE_PACKAGED_SCENARIO, async ({ browserName }, testInfo) => {
  test.skip(process.platform !== 'darwin', 'This prepared checkpoint is the exact current macOS/arm64 acceptance only.');
  test.setTimeout(180_000);
  expect(browserName).toBe('chromium');
  if (process.env.AIDRAW_E2E_FND05_UNRESPONSIVE_WRAPPER !== '1' || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1') {
    throw new Error('FND-05 unresponsive-renderer acceptance must run through its credential-safe wrapper.');
  }
  if (testInfo.project.metadata.suite !== 'retained-fnd05-unresponsive-renderer'
    || testInfo.project.metadata.automaticCredentialCapableArtifacts !== false) {
    throw new Error('FND-05 unresponsive-renderer acceptance refuses a non-dedicated Playwright project.');
  }
  assertFnd05UnresponsiveSafeReporterEnvironment();
  const configured = resolveFnd05UnresponsiveAcceptance();
  expect(artifact.platform).toBe('darwin');
  expect(artifact.arch).toBe('arm64');
  expect(artifact.outRoot).toBe(configured.packageRoot);
  expect(await sha256(executable)).toBe(configured.executableSha256);
  expect(await sha256(asar)).toBe(configured.asarSha256);
  expect(await access(configured.profile).then(() => true, () => false), 'The retained FND-05 unresponsive-renderer profile must not exist before launch.').toBe(false);
  await mkdir(configured.profile, { recursive: false, mode: 0o700 });
  if (((await stat(configured.profile)).mode & 0o777) !== 0o700) throw new Error('The retained FND-05 unresponsive-renderer profile is not mode 0700.');
  for (const path of Object.values(configured.paths)) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const secrets: string[] = [];
  const cleanup: CleanupRecord[] = [];
  let active: OwnerRun | undefined;
  let acceptanceFailure: Error | undefined;
  let evidence: Record<string, unknown> | undefined;
  const unresponsiveProgress: UnresponsiveProgress = {
    stallPendingAtObservation: false,
    inputMethod: 'Input.dispatchKeyEvent',
    inputKey: 'F24',
    inputAdmission: 'not-attempted',
    inputCommandSettlement: 'not-started',
    productConfirmationAbsentThroughDebuggerDetach: false,
    debuggerDetachRequested: false,
    allDebuggerAttachmentsDetached: false,
    ownerAliveAfterDebuggerDetach: false,
    sameOwnerMcpResponsiveAfterDebuggerDetach: false,
    productUnresponsiveConfirmationObserved: false,
    replacementProcessAdmitted: false,
    debuggerTransportReconnectAttempted: false,
    debuggerTransportReconnected: false,
    replacementAdmitted: false,
  };

  try {
    const owner: OwnerRun = { phase: 'unresponsive-owner', connectionPath: configured.paths.ownerConnection, stderr: [], externalRendererRequests: [] };
    active = owner;
    await startOwner(owner, configured.profile, true);
    const ownerPid = owner.child!.pid!;
    const ownerConnection = owner.connection!;
    secrets.push(ownerConnection.token);
    const beforeProcess = await waitForProcessShape(configured.profile, ownerPid);
    const beforeTarget = await rendererTarget(owner.page!);
    const aliveProbe = await beforeTarget.session.send('Runtime.evaluate', {
      expression: "'fnd05-original-renderer-alive'",
      returnByValue: true,
    });
    if (aliveProbe.result.value !== 'fnd05-original-renderer-alive') throw new Error('The original FND-05 renderer did not answer the pre-stall CDP probe.');

    const canonicalBefore = await owner.page!.evaluate(async (actor) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      if (!document || document.kind !== 'illustration') throw new Error('The FND-05 unresponsive-renderer illustration document is unavailable.');
      const layer = Object.values(document.layers).find((candidate) => candidate.type === 'vector');
      if (!layer) throw new Error('The FND-05 unresponsive-renderer vector layer is unavailable.');
      const timestamp = new Date().toISOString();
      const object = {
        id: 'fnd05-unresponsive-renderer-shape', revision: 0, name: 'Before persistent renderer stall', createdAt: timestamp, updatedAt: timestamp,
        createdBy: actor.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const,
        transform: { x: 56, y: 60, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
        type: 'shape' as const, shape: 'rectangle' as const, width: 104, height: 76,
        fill: { kind: 'solid' as const, color: '#4f9d92' },
        stroke: { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] },
      };
      const applied = await window.aidraw.applyTransaction({
        id: 'tx-fnd05-before-unresponsive-renderer', clientOperationId: 'fnd05-before-unresponsive-renderer', documentId: document.id,
        actor, label: 'Prepare persistent renderer recovery', createdAt: timestamp, operations: [{ kind: 'illustration.object.add', object }],
        playback: { mode: 'instant', speed: 1 },
      });
      if (applied.status !== 'committed') throw new Error(`The FND-05 unresponsive-renderer human preparation did not commit: ${applied.status}.`);
      const prepared = await window.aidraw.bootstrap();
      const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [object.id] });
      if (!lock.acquired || !lock.lockId) throw new Error('The FND-05 unresponsive-renderer transient human lock was not acquired.');
      const activeDocument = prepared.activeDocument;
      if (!activeDocument || activeDocument.kind !== 'illustration') throw new Error('The prepared FND-05 unresponsive-renderer document is unavailable.');
      return {
        documentId: activeDocument.id,
        documentName: activeDocument.name,
        revision: activeDocument.revision,
        object: activeDocument.objects[object.id],
        activity: activeDocument.activity,
        canUndo: prepared.canUndo,
        canRedo: prepared.canRedo,
        lockId: lock.lockId,
      };
    }, HUMAN_ACTOR);
    expect(canonicalBefore).toMatchObject({ canUndo: true, canRedo: false, object: { id: 'fnd05-unresponsive-renderer-shape', name: 'Before persistent renderer stall', revision: 0 } });

    const client = await connectMcp(ownerConnection);
    let requestId = 3;
    const occupied = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'session_manage', { action: 'inspect', documentId: canonicalBefore.documentId });
    expect(occupied).toMatchObject({ workspace: { humanOccupancy: { active: true, locks: [{ objectIds: [canonicalBefore.object.id] }] }, editorAdvisory: { attached: true, documentId: canonicalBefore.documentId } } });
    const replacementObject = { ...canonicalBefore.object, name: 'Recovered after persistent stall' } as IllustrationObject;
    const locked = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'canvas_apply', {
      documentId: canonicalBefore.documentId,
      clientOperationId: 'fnd05-agent-retry-after-unresponsive-renderer',
      label: 'Retry after persistent renderer stall',
      operations: [{ kind: 'illustration.object.replace', object: replacementObject, expectedRevision: canonicalBefore.object.revision }],
      playback: { mode: 'instant', speed: 1 },
    });
    expect(locked).toMatchObject({ status: 'locked', conflict: { retryable: true } });

    let stallCommandState: 'pending' | 'resolved' | 'rejected' = 'pending';
    const stallStartedAt = performance.now();
    const stallSettlement: Promise<{ status: 'resolved' } | { status: 'rejected'; reason: unknown }> = beforeTarget.session.send('Runtime.evaluate', {
      expression: FND05_UNRESPONSIVE_STALL_EXPRESSION,
      returnByValue: true,
    }).then(
      () => { stallCommandState = 'resolved'; return { status: 'resolved' as const }; },
      (reason: unknown) => { stallCommandState = 'rejected'; return { status: 'rejected' as const, reason }; },
    );

    await new Promise((resolveWait) => setTimeout(resolveWait, FND05_UNRESPONSIVE_OBSERVATION_MS));
    expect(stallCommandState).toBe('pending');
    unresponsiveProgress.stallPendingAtObservation = true;
    const duringProcess = await waitForProcessShape(configured.profile, ownerPid);
    expect(duringProcess.rendererPid).toBe(beforeProcess.rendererPid);
    expect(owner.context!.pages().filter((candidate) => !candidate.isClosed() && candidate.url().startsWith('aidraw://app/'))).toEqual([owner.page]);
    const occupiedDuringStall = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'session_manage', { action: 'inspect', documentId: canonicalBefore.documentId });
    expect(occupiedDuringStall).toMatchObject({ workspace: { humanOccupancy: { active: true, locks: [{ objectIds: [canonicalBefore.object.id] }] }, editorAdvisory: { attached: true, documentId: canonicalBefore.documentId } } });

    unresponsiveProgress.inputTargetId = beforeTarget.targetId;
    unresponsiveProgress.inputCommandSettlement = 'pending';
    const inputSettlement: Promise<{ status: 'resolved' } | { status: 'rejected'; reason: unknown }> = beforeTarget.session.send(
      'Input.dispatchKeyEvent',
      FND05_UNRESPONSIVE_INPUT_EVENT,
    ).then(
      () => {
        unresponsiveProgress.inputCommandSettlement = 'resolved';
        return { status: 'resolved' as const };
      },
      (reason: unknown) => {
        unresponsiveProgress.inputCommandSettlement = 'rejected';
        return { status: 'rejected' as const, reason };
      },
    );
    const inputAdmission = await Promise.race([
      inputSettlement,
      new Promise<{ status: 'pending' }>((resolvePending) => setTimeout(
        () => resolvePending({ status: 'pending' }),
        FND05_UNRESPONSIVE_INPUT_ADMISSION_WAIT_MS,
      )),
    ]);
    if (inputAdmission.status === 'rejected') {
      unresponsiveProgress.inputAdmission = 'rejected';
      const message = inputAdmission.reason instanceof Error ? inputAdmission.reason.message : String(inputAdmission.reason);
      throw new Error(`The benign FND-05 Input.dispatchKeyEvent stimulus was not admitted on the exact stalled renderer: ${message}`);
    }
    unresponsiveProgress.inputAdmission = inputAdmission.status === 'resolved' ? 'admitted' : 'ack-pending';

    if (Buffer.concat(owner.stderr).includes(Buffer.from(FND05_UNRESPONSIVE_CONFIRMATION_MARKER))) {
      throw new Error('The retained FND-05 product confirmation appeared before every debugger attachment was detached.');
    }
    unresponsiveProgress.debuggerDetachRequested = true;
    const debuggerDetachedElapsedMs = await disconnectOwnerDebugger(owner, stallStartedAt);
    if (Buffer.concat(owner.stderr).includes(Buffer.from(FND05_UNRESPONSIVE_CONFIRMATION_MARKER))) {
      throw new Error('The retained FND-05 product confirmation appeared before the debugger-free boundary was proven.');
    }
    unresponsiveProgress.productConfirmationAbsentThroughDebuggerDetach = true;
    unresponsiveProgress.allDebuggerAttachmentsDetached = true;
    unresponsiveProgress.debuggerDetachedElapsedMs = debuggerDetachedElapsedMs;
    unresponsiveProgress.ownerAliveAfterDebuggerDetach = owner.child!.exitCode === null;
    const occupiedAfterDebuggerDetach = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'session_manage', { action: 'inspect', documentId: canonicalBefore.documentId });
    expect(occupiedAfterDebuggerDetach).toMatchObject({ workspace: { humanOccupancy: { active: true, locks: [{ objectIds: [canonicalBefore.object.id] }] }, editorAdvisory: { attached: true, documentId: canonicalBefore.documentId } } });
    unresponsiveProgress.sameOwnerMcpResponsiveAfterDebuggerDetach = true;
    const debuggerProof = {
      originalRendererAliveBeforeStall: true,
      originalRendererResponsiveBeforeStall: true,
      commandPendingDuringObservation: true,
      originalRendererAliveDuringObservation: duringProcess.rendererPid === beforeProcess.rendererPid,
      sameOwnerMcpResponsiveDuringObservation: true,
      inputAdmission: unresponsiveProgress.inputAdmission,
      productConfirmationAbsentThroughDebuggerDetach: unresponsiveProgress.productConfirmationAbsentThroughDebuggerDetach,
      allDebuggerAttachmentsDetached: unresponsiveProgress.allDebuggerAttachmentsDetached,
      debuggerDetachedElapsedMs,
      ownerAliveAfterDebuggerDetach: unresponsiveProgress.ownerAliveAfterDebuggerDetach,
      sameOwnerMcpResponsiveAfterDebuggerDetach: unresponsiveProgress.sameOwnerMcpResponsiveAfterDebuggerDetach,
    };
    const detachProof = assertFnd05DebuggerDetachProof(debuggerProof);
    const detachedInputSettlement = await Promise.race([
      inputSettlement,
      new Promise<{ status: 'timeout' }>((resolveTimeout) => setTimeout(
        () => resolveTimeout({ status: 'timeout' }),
        FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS,
      )),
    ]);
    const inputProof = classifyFnd05DebuggerDetachCommandSettlement(
      detachedInputSettlement,
      'Input.dispatchKeyEvent',
      debuggerProof,
    );
    const detachedStallSettlement = await Promise.race([
      stallSettlement,
      new Promise<{ status: 'timeout' }>((resolveTimeout) => setTimeout(
        () => resolveTimeout({ status: 'timeout' }),
        FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS,
      )),
    ]);
    const stallProof = classifyFnd05DebuggerDetachCommandSettlement(
      detachedStallSettlement,
      'Runtime.evaluate',
      debuggerProof,
    );

    const untilPolicyFloorMs = FND05_UNRESPONSIVE_POLICY_GRACE_MS - (performance.now() - stallStartedAt);
    if (untilPolicyFloorMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, untilPolicyFloorMs));
    const beforePolicyProcess = await waitForProcessShape(configured.profile, ownerPid);
    expect(beforePolicyProcess.rendererPid).toBe(beforeProcess.rendererPid);

    const confirmationDeadline = stallStartedAt
      + FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS
      + FND05_UNRESPONSIVE_CONFIRMATION_WAIT_MS;
    const confirmationBudgetMs = Math.floor(confirmationDeadline - performance.now());
    if (confirmationBudgetMs <= 0) throw new Error('The retained FND-05 debugger-free product-confirmation deadline elapsed before observation.');
    await waitForStderrMarker(owner, FND05_UNRESPONSIVE_CONFIRMATION_MARKER, confirmationBudgetMs);
    unresponsiveProgress.productUnresponsiveConfirmationObserved = true;
    unresponsiveProgress.productUnresponsiveConfirmationElapsedMs = performance.now() - stallStartedAt;

    const replacementDeadline = performance.now() + FND05_UNRESPONSIVE_REPLACEMENT_WAIT_MS;
    const afterProcess = await waitForProcessShape(configured.profile, ownerPid, beforeProcess.rendererPid, FND05_UNRESPONSIVE_REPLACEMENT_WAIT_MS);
    unresponsiveProgress.replacementProcessAdmitted = true;
    const reconnectBudgetMs = Math.floor(replacementDeadline - performance.now());
    if (reconnectBudgetMs <= 0) throw new Error('The retained FND-05 replacement process left no bounded debugger reconnect budget.');
    unresponsiveProgress.debuggerTransportReconnectAttempted = true;
    await connectOwnerDebugger(owner, reconnectBudgetMs);
    unresponsiveProgress.debuggerTransportReconnected = true;
    unresponsiveProgress.debuggerTransportReconnectedElapsedMs = performance.now() - stallStartedAt;
    const replacementPage = owner.page!;
    const replacementElapsedMs = performance.now() - stallStartedAt;
    unresponsiveProgress.replacementAdmitted = true;
    unresponsiveProgress.replacementElapsedMs = replacementElapsedMs;
    expect(replacementElapsedMs).toBeGreaterThanOrEqual(FND05_UNRESPONSIVE_POLICY_GRACE_MS);
    expect(owner.context!.pages().filter((candidate) => !candidate.isClosed() && candidate.url().startsWith('aidraw://app/'))).toEqual([replacementPage]);
    const replacementTarget = await rendererTarget(replacementPage);
    expect(replacementTarget.targetId).not.toBe(beforeTarget.targetId);
    expect(afterProcess.rendererPid).not.toBe(beforeProcess.rendererPid);
    expect(afterProcess.observedReplacementRendererPids).toEqual([afterProcess.rendererPid]);
    expect(owner.child!.pid).toBe(ownerConnection.pid);
    expect((JSON.parse(await readFile(configured.paths.ownerConnection, 'utf8')) as McpConnection).pid).toBe(ownerPid);

    expect(stallProof.command).toBe('rejected-after-debugger-detach');

    const inspectedAfterDetach = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'session_manage', { action: 'inspect', documentId: canonicalBefore.documentId });
    expect(inspectedAfterDetach).toMatchObject({ workspace: { humanOccupancy: { active: false, locks: [] }, editorAdvisory: { attached: true, documentId: canonicalBefore.documentId } } });
    const canonicalAfterDetach = await replacementPage.evaluate(async () => {
      const snapshot = await window.aidraw.bootstrap();
      const engine = await window.aidraw.getEngineStatus();
      return { snapshot, engine };
    });
    const recoveredDocument = canonicalAfterDetach.snapshot.activeDocument as IllustrationDocument;
    expect({
      documentId: recoveredDocument.id,
      name: recoveredDocument.name,
      revision: recoveredDocument.revision,
      object: recoveredDocument.objects[canonicalBefore.object.id],
      activity: recoveredDocument.activity,
      canUndo: canonicalAfterDetach.snapshot.canUndo,
      canRedo: canonicalAfterDetach.snapshot.canRedo,
      engine: canonicalAfterDetach.engine,
    }).toEqual({
      documentId: canonicalBefore.documentId,
      name: canonicalBefore.documentName,
      revision: canonicalBefore.revision,
      object: canonicalBefore.object,
      activity: canonicalBefore.activity,
      canUndo: true,
      canRedo: false,
      engine: expect.objectContaining({ running: true, uiAttached: true, mode: 'interactive' }),
    });

    const retried = await callMcpTool(ownerConnection.url, client.headers, requestId++, 'canvas_apply', {
      documentId: canonicalBefore.documentId,
      clientOperationId: 'fnd05-agent-retry-after-unresponsive-renderer',
      label: 'Retry after persistent renderer stall',
      operations: [{ kind: 'illustration.object.replace', object: replacementObject, expectedRevision: canonicalBefore.object.revision }],
      playback: { mode: 'instant', speed: 1 },
    });
    expect(retried).toMatchObject({ status: 'committed', revision: canonicalBefore.revision + 1 });
    const afterRetry = await replacementPage.evaluate(async (objectId) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      return {
        documentId: document?.id,
        revision: document?.revision,
        object: document?.kind === 'illustration' ? document.objects[objectId] : undefined,
        activityLabels: document?.activity.map((entry) => entry.label),
      };
    }, canonicalBefore.object.id);
    expect(afterRetry).toMatchObject({
      documentId: canonicalBefore.documentId,
      revision: canonicalBefore.revision + 1,
      object: { name: 'Recovered after persistent stall' },
      activityLabels: expect.arrayContaining(['Prepare persistent renderer recovery', 'Retry after persistent renderer stall']),
    });

    const encryptedCredential = JSON.parse(await readFile(configured.paths.tokenCredentials, 'utf8')) as unknown;
    const encryptedToken = inspectFnd05EncryptedToken(encryptedCredential, ownerConnection.token);
    if (!encryptedToken.encryptedValuePresent) throw new Error('The FND-05 encrypted credential shape was not confirmed.');
    if (((await stat(configured.paths.tokenCredentials)).mode & 0o777) !== 0o600) throw new Error('The FND-05 encrypted credential record is not mode 0600.');
    expect(await access(configured.paths.providerCredentials).then(() => true, () => false)).toBe(false);
    expect(await access(configured.paths.forbiddenNetwork).then(() => true, () => false)).toBe(false);
    expect(owner.externalRendererRequests).toEqual([]);

    const ownerCleanup = await stopOwner(owner, configured.profile, secrets);
    cleanup.push(ownerCleanup);
    active = undefined;
    expect(ownerCleanup).toMatchObject({ graceful: true, ownerPid, ownerExitCode: 0, signalExitCode: 0, connectionCredentials: 'redacted-after-graceful-stop', ownedSurvivors: [] });

    const executableInfo = await stat(executable);
    const asarInfo = await stat(asar);
    evidence = {
      version: 1,
      scenario: FND05_UNRESPONSIVE_PACKAGED_SCENARIO,
      package: {
        packageRoot: configured.packageRoot,
        executable,
        asar,
        platform: artifact.platform,
        architecture: artifact.arch,
        executableBytes: executableInfo.size,
        asarBytes: asarInfo.size,
        executableSha256: configured.executableSha256,
        asarSha256: configured.asarSha256,
        hardenedFuseAndPackagedSecurityPreflight: true,
      },
      isolation: {
        profile: configured.profile,
        defaultProfileUntouched: true,
        priorRetainedRunsUntouched: true,
        remoteDebuggingAddress: '127.0.0.1',
        productionHookAdded: false,
      },
      rendererStall: {
        mechanism: `bounded ${FND05_UNRESPONSIVE_STALL_MS} ms synchronous Runtime.evaluate followed by one target-local F24 raw-key input, complete public connectOverCDP transport detach before the ACK deadline, then bounded reconnect after the exact product confirmation`,
        observationMs: FND05_UNRESPONSIVE_OBSERVATION_MS,
        declaredPolicyGraceMs: FND05_UNRESPONSIVE_POLICY_GRACE_MS,
        inputAdmissionWaitMs: FND05_UNRESPONSIVE_INPUT_ADMISSION_WAIT_MS,
        debuggerDetachDeadlineMs: FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS,
        productConfirmationWaitMs: FND05_UNRESPONSIVE_CONFIRMATION_WAIT_MS,
        replacementWaitMs: FND05_UNRESPONSIVE_REPLACEMENT_WAIT_MS,
        beforeTargetId: beforeTarget.targetId,
        replacementTargetId: replacementTarget.targetId,
        beforeRendererPid: beforeProcess.rendererPid,
        replacementRendererPid: afterProcess.rendererPid,
        inputStimulus: {
          method: unresponsiveProgress.inputMethod,
          key: unresponsiveProgress.inputKey,
          targetId: unresponsiveProgress.inputTargetId,
          admission: unresponsiveProgress.inputAdmission,
          settlement: inputProof.command,
          physicalKeyboardStateChanged: false,
        },
        debuggerTransport: {
          method: 'public Playwright connectOverCDP Browser.close transport disconnect',
          allAttachmentsDetached: detachProof.allDebuggerAttachmentsDetached,
          detachedElapsedMs: detachProof.debuggerDetachedElapsedMs,
          ownerAliveAfterDetach: detachProof.ownerAliveAfterDebuggerDetach,
          sameOwnerMcpResponsiveAfterDetach: detachProof.sameOwnerMcpResponsiveAfterDebuggerDetach,
          productConfirmationAbsentThroughDetach: unresponsiveProgress.productConfirmationAbsentThroughDebuggerDetach,
          productConfirmationObservedBeforeReconnect: true,
          reconnectAttempted: unresponsiveProgress.debuggerTransportReconnectAttempted,
          reconnected: unresponsiveProgress.debuggerTransportReconnected,
          reconnectedElapsedMs: unresponsiveProgress.debuggerTransportReconnectedElapsedMs,
          browserCloseProtocolSent: false,
        },
        productUnresponsiveConfirmationObserved: true,
        productUnresponsiveConfirmationElapsedMs: unresponsiveProgress.productUnresponsiveConfirmationElapsedMs,
        stallCommand: stallProof.command,
        replacementCount: 1,
        replacementElapsedMs,
        oldTargetAbsentAfterReconnect: true,
      },
      ownerContinuity: {
        ownerPid,
        connectionPid: ownerConnection.pid,
        sameOwnerAndMcpThroughReplacement: true,
        exactlyOneWindowBeforeAndAfter: true,
      },
      canonicalContinuity: {
        documentId: canonicalBefore.documentId,
        revisionBeforeStall: canonicalBefore.revision,
        revisionAfterAgentRetry: canonicalBefore.revision + 1,
        objectId: canonicalBefore.object.id,
        humanUndoHistoryPresentAfterDetach: true,
        activityPreservedAfterDetach: true,
        transientHumanOccupancyRetainedDuringStall: true,
        transientHumanOccupancyClearedAfterConfirmedDetach: true,
        sameAgentRetryCommitted: true,
      },
      credentialsAndNetwork: {
        connectionFileRedactedAfterConfirmedExit: true,
        localMcpCredentialEncryptedAtRest: true,
        providerCredentialFileAbsent: true,
        rendererExternalRequestsObserved: 0,
        backgroundNetworkDisabled: true,
      },
      nonclaims: {
        rendererLocalWorkNotSubmittedToCanonicalEnginePreserved: false,
        historicalDefaultProfileCauseEstablished: false,
        cacheOrProfileRepairEstablished: false,
        broaderPlatformsEstablished: false,
        releaseCandidateEstablished: false,
      },
      cleanup,
    };
  } catch (error) {
    acceptanceFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (active) {
      const cleanupRecord = await stopOwner(active, configured.profile, secrets);
      cleanup.push(cleanupRecord);
      if (!cleanupRecord.graceful) {
        const detail = `Graceful-only ${active.phase} cleanup failed${cleanupRecord.error ? `: ${cleanupRecord.error}` : '.'}`;
        acceptanceFailure = acceptanceFailure ? new Error(`${acceptanceFailure.message}\n${detail}`) : new Error(detail);
      }
    }

    const cleanupText = `${JSON.stringify({ version: 1, scenario: FND05_UNRESPONSIVE_PACKAGED_SCENARIO, cleanup }, null, 2)}\n`;
    assertFnd05EvidenceRedacted(cleanupText, secrets);
    await writePrivateRecord(configured.paths.cleanup, cleanupText);

    if (acceptanceFailure) {
      const stderr = active ? Buffer.concat(active.stderr).toString('utf8') : '';
      const failureText = `${JSON.stringify({
        version: 1,
        scenario: FND05_UNRESPONSIVE_PACKAGED_SCENARIO,
        status: 'failed',
        failure: redactFnd05FailureText(acceptanceFailure.message, secrets),
        stderr: redactFnd05FailureText(stderr, secrets),
        progress: {
          ...unresponsiveProgress,
          failureStage: classifyFnd05UnresponsiveFailureStage(unresponsiveProgress),
        },
        cleanup,
      }, null, 2)}\n`;
      assertFnd05EvidenceRedacted(failureText, secrets);
      await writePrivateRecord(configured.paths.failure, failureText);
    }
  }

  if (acceptanceFailure) throw new Error(redactFnd05FailureText(acceptanceFailure.message, secrets));
  if (!evidence || cleanup.length !== 1 || cleanup.some((entry) => !entry.graceful)) throw new Error('The retained FND-05 unresponsive-renderer evidence did not reach its complete graceful boundary.');
  const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
  assertFnd05EvidenceRedacted(evidenceText, secrets);
  await writePrivateRecord(configured.paths.evidence, evidenceText);
});
