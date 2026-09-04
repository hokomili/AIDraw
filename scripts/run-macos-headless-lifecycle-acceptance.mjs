import { execFile, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { parseFnd05OwnedProcesses } from './fnd05-packaged-acceptance.mjs';
import { readMcpConnectionHandoff } from './mcp-direct-client.mjs';
import { assertPackagedE2eArtifact, resolvePackagedE2eArtifact, waitForPackagedE2eReady } from './packaged-e2e-runtime.mjs';
import { inspectPackagedSecurity } from './packaged-security.mjs';
import { parseUx01WindowDriverInspection } from './ux01-window-chrome-acceptance.mjs';

const execute = promisify(execFile);
const fetchImplementation = globalThis.fetch;
const IDLE_OBSERVATION_MS = 5_000;
const PROCESS_TIMEOUT_MS = 20_000;
const networkDisabledArguments = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--no-pings',
];
const childEnvironmentNames = [
  'HOME', 'LOGNAME', 'USER', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING',
  'DEVELOPER_DIR', 'SDKROOT',
];

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`The macOS headless-lifecycle acceptance requires Node 24.x; received ${process.version}.`);
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`The macOS headless-lifecycle acceptance requires macOS/arm64; received ${process.platform}/${process.arch}.`);
}
if (process.argv.length !== 2) {
  throw new Error('The macOS headless-lifecycle acceptance accepts no command-line overrides. Select the package with AIDRAW_E2E_OUT_DIR.');
}

const artifact = assertPackagedE2eArtifact(resolvePackagedE2eArtifact());
if (artifact.platform !== 'darwin' || artifact.arch !== 'arm64') {
  throw new Error(`The selected lifecycle package is ${artifact.platform}/${artifact.arch}, not darwin/arm64.`);
}
await inspectPackagedSecurity({ executable: artifact.executable, archive: artifact.asar });

const childEnvironment = {};
for (const name of childEnvironmentNames) {
  const value = process.env[name];
  if (typeof value === 'string' && value) childEnvironment[name] = value;
}

function fail(message, details) {
  throw new Error(details === undefined ? message : `${message}: ${JSON.stringify(details)}`);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback DevTools port.');
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForExit(child, label, timeoutMs = PROCESS_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signalCode: child.signalCode };
  }
  return new Promise((resolveExit, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = (exitCode, signalCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveExit({ exitCode, signalCode });
    };
    const onError = (error) => {
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

async function compileDriver(source, executable) {
  await execute('/usr/bin/xcrun', [
    'clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-O2',
    '-framework', 'AppKit', '-framework', 'ApplicationServices', source, '-o', executable,
  ], { env: childEnvironment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  await chmod(executable, 0o700);
  const metadata = await stat(executable);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error('The lifecycle driver is not one private executable file.');
  }
}

async function runDriver(driver, command, pid, ...arguments_) {
  const { stdout } = await execute(driver, [command, String(pid), ...arguments_.map(String)], {
    env: childEnvironment,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  try { return JSON.parse(stdout); }
  catch { throw new Error(`The lifecycle driver returned malformed ${command} JSON.`); }
}

async function inspectApplication(driver, pid, includeOffscreen = false) {
  const raw = await runDriver(driver, includeOffscreen ? 'inspect' : 'inspect-visible', pid);
  try { return parseUx01WindowDriverInspection(raw); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} Raw exact-PID inspection: ${JSON.stringify(raw)}`);
  }
}

function assertBackgroundInspection(inspection, label) {
  const application = inspection.applicationReadiness;
  if (inspection.windows.length !== 0
    || application.terminated
    || !application.finishedLaunching
    || application.activationPolicy !== 2
    || application.active
    || application.readyForInput) {
    fail(`${label} is not one silent prohibited macOS application`, {
      windows: inspection.windows,
      application,
    });
  }
  return {
    activationPolicy: 'prohibited',
    activationPolicyCode: application.activationPolicy,
    active: application.active,
    windows: inspection.windows.length,
  };
}

function assertEditorInspection(inspection, label, expectedWindowId) {
  const application = inspection.applicationReadiness;
  if (inspection.windows.length !== 1
    || !inspection.windows[0].onScreen
    || application.terminated
    || !application.finishedLaunching
    || application.activationPolicy !== 0
    || (expectedWindowId !== undefined && inspection.windows[0].windowId !== expectedWindowId)) {
    fail(`${label} is not one regular macOS editor application`, {
      windows: inspection.windows,
      application,
      expectedWindowId,
    });
  }
  return {
    activationPolicy: 'regular',
    activationPolicyCode: application.activationPolicy,
    active: application.active,
    windows: inspection.windows.length,
    windowId: inspection.windows[0].windowId,
  };
}

async function waitForInspection(driver, pid, predicate, label, includeOffscreen = false) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await inspectApplication(driver, pid, includeOffscreen);
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await delay(100);
  }
  fail(`${label} did not settle`, last);
}

function sameBounds(left, right, tolerance = 2) {
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(left[key] - right[key]) <= tolerance);
}

async function waitForStableVisibleEditor(driver, ownerPid, expectedWindowId, label) {
  const deadline = Date.now() + 5_000;
  let anchor;
  let stableObservations = 0;
  let last;
  while (Date.now() < deadline) {
    last = await inspectApplication(driver, ownerPid);
    const current = last.windows.length === 1 && last.windows[0].onScreen
      && last.windows[0].windowId === expectedWindowId ? last.windows[0] : undefined;
    if (current && anchor && sameBounds(anchor.bounds, current.bounds)) stableObservations += 1;
    else {
      anchor = current;
      stableObservations = current ? 1 : 0;
    }
    if (current && stableObservations >= 3) return last;
    await delay(100);
  }
  fail(`${label} did not reach three stable visible-window observations`, last);
}

async function ownedProcesses(profile) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseFnd05OwnedProcesses(stdout, profile);
}

function processShape(rows, ownerPid) {
  const owners = rows.filter((entry) => entry.type === 'browser');
  const renderers = rows.filter((entry) => entry.type === 'renderer');
  return {
    ownerPids: owners.map((entry) => entry.pid),
    rendererPids: renderers.map((entry) => entry.pid),
    rendererParents: renderers.map((entry) => entry.ppid),
    helperTypes: rows.filter((entry) => entry.type !== 'browser' && entry.type !== 'renderer').map((entry) => entry.type),
    exactOwner: owners.length === 1 && owners[0].pid === ownerPid,
  };
}

async function waitForProcessShape(profile, ownerPid, rendererCount, label) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await ownedProcesses(profile);
    const shape = processShape(rows, ownerPid);
    if (shape.exactOwner
      && shape.rendererPids.length === rendererCount
      && (rendererCount === 0 || shape.rendererParents.every((pid) => pid === ownerPid))) {
      return { rows, shape };
    }
    await delay(100);
  }
  fail(`${label} did not reach the expected process shape`, { rows, expectedOwnerPid: ownerPid, rendererCount });
}

async function waitForNoOwnedProcesses(profile, label) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  let rows = await ownedProcesses(profile);
  while (rows.length && Date.now() < deadline) {
    await delay(100);
    rows = await ownedProcesses(profile);
  }
  if (rows.length) fail(`${label} left AIDraw or helper processes`, rows);
  return [];
}

async function waitForConnection(connectionPath, child, label) {
  return waitForPackagedE2eReady({
    child,
    label,
    timeoutMs: PROCESS_TIMEOUT_MS,
    attempt: async () => {
      try { return await readMcpConnectionHandoff(connectionPath); }
      catch { return undefined; }
    },
  });
}

async function assertIdentity(connection, ownerPid, label) {
  const identityUrl = new URL('/mcp/identity', connection.url);
  const response = await fetchImplementation(identityUrl, {
    headers: { authorization: `Bearer ${connection.token}` },
  });
  const identity = await response.json();
  if (!response.ok || identity?.version !== 1 || identity?.pid !== ownerPid || typeof identity?.instanceId !== 'string') {
    fail(`${label} did not retain the exact responsive engine identity`, { status: response.status, identity });
  }
  return { status: response.status, pid: identity.pid, sameInstance: true };
}

async function signalOwner(executable, profile, argument, label) {
  const arguments_ = [`--user-data-dir=${profile}`, ...(argument ? [argument] : [])];
  const signal = spawn(executable, arguments_, {
    env: childEnvironment,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  const result = await waitForExit(signal, label, 10_000);
  if (result.exitCode !== 0 || result.signalCode !== null) fail(`${label} did not exit normally`, result);
  return { pid: signal.pid, exitCode: result.exitCode, command: argument ?? 'ordinary-open' };
}

async function connectDebugger(endpoint, child, label) {
  return waitForPackagedE2eReady({
    child,
    label,
    timeoutMs: PROCESS_TIMEOUT_MS,
    attempt: async () => {
      try { return await chromium.connectOverCDP(endpoint); }
      catch { return undefined; }
    },
  });
}

async function waitForSingleEditorPage(browser, label) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  let pageCount = 0;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages())
      .filter((page) => !page.isClosed() && page.url().startsWith('aidraw://app/'));
    pageCount = pages.length;
    if (pages.length === 1) {
      await pages[0].waitForLoadState('domcontentloaded');
      await pages[0].locator('.app-shell').waitFor({ state: 'visible' });
      return pages[0];
    }
    if (pages.length > 1) fail(`${label} admitted more than one editor page`, { pageCount });
    await delay(100);
  }
  fail(`${label} did not admit exactly one editor page`, { pageCount });
}

async function closeEditorPage(page, driver, ownerPid, inspection, label) {
  if (page.isClosed()) throw new Error(`${label} was already closed.`);
  if (inspection.windows.length !== 1 || !inspection.windows[0].onScreen) {
    fail(`${label} has no exact on-screen native close target`, inspection.windows);
  }
  const stableInspection = await waitForStableVisibleEditor(
    driver,
    ownerPid,
    inspection.windows[0].windowId,
    label,
  );
  const window = stableInspection.windows[0];
  const bounds = window.bounds;
  const closeEvent = page.waitForEvent('close', { timeout: PROCESS_TIMEOUT_MS });
  const action = await runDriver(
    driver,
    'close-window',
    ownerPid,
    window.windowId,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
  );
  if (action?.version !== 1 || action?.action !== 'close-window' || action?.posted !== true
    || action?.pid !== ownerPid || action?.windowId !== window.windowId) {
    fail(`${label} native close accelerator returned an invalid result`, action);
  }
  const closed = await Promise.race([
    closeEvent.then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!closed) {
    const after = await inspectApplication(driver, ownerPid);
    fail(`${label} did not close through the exact native close-window accelerator`, { action, after });
  }
  if (!page.isClosed()) throw new Error(`${label} did not close through the exact native close-window accelerator.`);
}

async function requestBackgroundActivation(driver, ownerPid) {
  const raw = await runDriver(driver, 'request-activation', ownerPid);
  if (!raw || raw.version !== 1 || raw.pid !== ownerPid
    || typeof raw.requestAccepted !== 'boolean'
    || !Array.isArray(raw.windowsBefore) || !Array.isArray(raw.windowsAfter)) {
    fail('The native background-activation probe returned an invalid result', raw);
  }
  const before = raw.before;
  const after = raw.after;
  if (!before || !after
    || before.activationPolicy !== 2 || after.activationPolicy !== 2
    || before.active || after.active || before.readyForInput || after.readyForInput
    || raw.windowsBefore.length !== 0 || raw.windowsAfter.length !== 0) {
    fail('A prohibited engine admitted an ordinary native activation request', raw);
  }
  return {
    requestAccepted: raw.requestAccepted,
    policyBefore: before.activationPolicy,
    policyAfter: after.activationPolicy,
    activeAfter: after.active,
    windowsAfter: raw.windowsAfter.length,
  };
}

async function launchOwner({ executable, profile, connectionPath, headless }) {
  const port = await reservePort();
  const stderr = [];
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    ...networkDisabledArguments,
    `--user-data-dir=${profile}`,
    ...(headless ? ['--headless'] : []),
    `--write-mcp-connection=${connectionPath}`,
  ], {
    env: childEnvironment,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false,
    shell: false,
  });
  child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  if (!child.pid) throw new Error('The packaged AIDraw launch returned no owner PID.');
  return {
    child,
    ownerPid: child.pid,
    debuggerEndpoint: `http://127.0.0.1:${port}`,
    stderr,
  };
}

async function terminateOwner(owner, profile, label, terminalSignal) {
  if (terminalSignal !== 'SIGINT' && terminalSignal !== 'SIGTERM') {
    throw new Error(`${label} received an unsupported terminal signal.`);
  }
  if (owner.child.exitCode === null && owner.child.signalCode === null) {
    if (!owner.child.kill(terminalSignal)) throw new Error(`${label} could not deliver ${terminalSignal} to the exact owner.`);
  }
  const result = await waitForExit(owner.child, label);
  if (result.exitCode !== 0 || result.signalCode !== null) fail(`${label} did not complete graceful ${terminalSignal} shutdown`, result);
  await waitForNoOwnedProcesses(profile, label);
  return { delivered: terminalSignal, ownerPid: owner.ownerPid, exitCode: result.exitCode, signalCode: result.signalCode, survivors: 0 };
}

async function forceCleanup(owner, profile) {
  if (!owner) return;
  if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGTERM');
  try { await waitForExit(owner.child, 'Lifecycle failure cleanup', 5_000); }
  catch {
    if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGKILL');
    await waitForExit(owner.child, 'Lifecycle forced failure cleanup', 5_000).catch(() => undefined);
  }
  await waitForNoOwnedProcesses(profile, 'Lifecycle failure cleanup').catch(() => undefined);
}

process.umask(0o077);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'aidraw-macos-headless-lifecycle-'));
const driver = join(temporaryRoot, 'macos-lifecycle-driver');
const headlessProfile = join(temporaryRoot, 'headless-profile');
const headlessConnectionPath = join(temporaryRoot, 'headless-connection.json');
const interactiveProfile = join(temporaryRoot, 'interactive-profile');
const interactiveConnectionPath = join(temporaryRoot, 'interactive-connection.json');
let headlessOwner;
let interactiveOwner;
let headlessBrowser;
let interactiveBrowser;

try {
  await compileDriver(resolve('scripts/macos-window-chrome-driver.m'), driver);

  headlessOwner = await launchOwner({
    executable: artifact.executable,
    profile: headlessProfile,
    connectionPath: headlessConnectionPath,
    headless: true,
  });
  const headlessConnection = await waitForConnection(
    headlessConnectionPath,
    headlessOwner.child,
    'The fresh packaged headless engine',
  );
  if (headlessConnection.pid !== headlessOwner.ownerPid) {
    fail('The headless connection PID did not match the exact spawned owner', {
      connectionPid: headlessConnection.pid,
      ownerPid: headlessOwner.ownerPid,
    });
  }

  const initialBackgroundInspection = await waitForInspection(
    driver,
    headlessOwner.ownerPid,
    (value) => value.applicationReadiness.finishedLaunching
      && value.applicationReadiness.activationPolicy === 2
      && !value.applicationReadiness.active
      && value.windows.length === 0,
    'Initial headless presentation',
    true,
  );
  const initialBackground = assertBackgroundInspection(initialBackgroundInspection, 'Initial headless presentation');
  const initialProcesses = await waitForProcessShape(headlessProfile, headlessOwner.ownerPid, 0, 'Initial headless engine');
  const initialIdentity = await assertIdentity(headlessConnection, headlessOwner.ownerPid, 'Initial headless engine');
  const activationAttempt = await requestBackgroundActivation(driver, headlessOwner.ownerPid);
  const headlessSignal = await signalOwner(
    artifact.executable,
    headlessProfile,
    '--headless',
    'The same-profile headless signal',
  );
  const afterNonShowInspection = await waitForInspection(
    driver,
    headlessOwner.ownerPid,
    (value) => value.applicationReadiness.activationPolicy === 2 && !value.applicationReadiness.active && value.windows.length === 0,
    'Headless presentation after non-show requests',
    true,
  );
  const afterNonShow = assertBackgroundInspection(afterNonShowInspection, 'Headless presentation after non-show requests');
  await waitForProcessShape(headlessProfile, headlessOwner.ownerPid, 0, 'Headless engine after non-show requests');
  await delay(IDLE_OBSERVATION_MS);
  const preShowIdentity = await assertIdentity(headlessConnection, headlessOwner.ownerPid, 'Idle headless engine');

  const showSignal = await signalOwner(artifact.executable, headlessProfile, '--show', 'The exact same-profile show signal');
  headlessBrowser = await connectDebugger(
    headlessOwner.debuggerEndpoint,
    headlessOwner.child,
    'The shown headless owner DevTools endpoint',
  );
  let page = await waitForSingleEditorPage(headlessBrowser, 'The exact same-profile show signal');
  const shownInspection = await waitForInspection(
    driver,
    headlessOwner.ownerPid,
    (value) => value.applicationReadiness.activationPolicy === 0 && value.windows.length === 1 && value.windows[0].onScreen,
    'Shown headless owner',
  );
  const shown = assertEditorInspection(shownInspection, 'Shown headless owner');
  const shownProcesses = await waitForProcessShape(headlessProfile, headlessOwner.ownerPid, 1, 'Shown headless owner');
  const shownRendererPid = shownProcesses.shape.rendererPids[0];

  const repeatedShowSignal = await signalOwner(
    artifact.executable,
    headlessProfile,
    '--show',
    'The repeated exact same-profile show signal',
  );
  const repeatedShownInspection = await waitForInspection(
    driver,
    headlessOwner.ownerPid,
    (value) => value.applicationReadiness.activationPolicy === 0
      && value.windows.length === 1
      && value.windows[0].onScreen
      && value.windows[0].windowId === shown.windowId,
    'Repeated show presentation',
  );
  const repeatedShown = assertEditorInspection(repeatedShownInspection, 'Repeated show presentation', shown.windowId);
  const repeatedShownProcesses = await waitForProcessShape(headlessProfile, headlessOwner.ownerPid, 1, 'Repeated show owner');
  if (repeatedShownProcesses.shape.rendererPids[0] !== shownRendererPid) {
    fail('A repeated show created a second renderer instead of focusing the existing editor', {
      before: shownRendererPid,
      after: repeatedShownProcesses.shape.rendererPids[0],
    });
  }

  await closeEditorPage(page, driver, headlessOwner.ownerPid, repeatedShownInspection, 'The shown editor');
  const detachedInspection = await waitForInspection(
    driver,
    headlessOwner.ownerPid,
    (value) => value.applicationReadiness.activationPolicy === 2 && !value.applicationReadiness.active && value.windows.length === 0,
    'Detached headless owner',
  );
  const detached = assertBackgroundInspection(detachedInspection, 'Detached headless owner');
  await waitForProcessShape(headlessProfile, headlessOwner.ownerPid, 0, 'Detached headless owner');
  const detachedIdentity = await assertIdentity(headlessConnection, headlessOwner.ownerPid, 'Detached headless owner');
  await delay(IDLE_OBSERVATION_MS);
  const postDetachIdleIdentity = await assertIdentity(headlessConnection, headlessOwner.ownerPid, 'Idle detached headless owner');

  const ordinaryOpenSignal = await signalOwner(
    artifact.executable,
    headlessProfile,
    undefined,
    'The exact same-profile ordinary open signal',
  );
  page = await waitForSingleEditorPage(headlessBrowser, 'The exact same-profile ordinary open signal');
  const reopenedInspection = await waitForInspection(
    driver,
    headlessOwner.ownerPid,
    (value) => value.applicationReadiness.activationPolicy === 0 && value.windows.length === 1 && value.windows[0].onScreen,
    'Ordinary-open headless owner',
  );
  const reopened = assertEditorInspection(reopenedInspection, 'Ordinary-open headless owner');
  const reopenedProcesses = await waitForProcessShape(headlessProfile, headlessOwner.ownerPid, 1, 'Ordinary-open headless owner');
  if (reopened.windowId === shown.windowId || reopenedProcesses.shape.rendererPids[0] === shownRendererPid) {
    fail('Ordinary open did not attach one fresh editor after confirmed detach', {
      firstWindowId: shown.windowId,
      reopenedWindowId: reopened.windowId,
      firstRendererPid: shownRendererPid,
      reopenedRendererPid: reopenedProcesses.shape.rendererPids[0],
    });
  }
  await closeEditorPage(page, driver, headlessOwner.ownerPid, reopenedInspection, 'The ordinary-open editor');
  const terminalBackgroundInspection = await waitForInspection(
    driver,
    headlessOwner.ownerPid,
    (value) => value.applicationReadiness.activationPolicy === 2 && !value.applicationReadiness.active && value.windows.length === 0,
    'Pre-terminal-quit headless owner',
  );
  const terminalBackground = assertBackgroundInspection(terminalBackgroundInspection, 'Pre-terminal-quit headless owner');
  await waitForProcessShape(headlessProfile, headlessOwner.ownerPid, 0, 'Pre-terminal-quit headless owner');
  const headlessShutdown = await terminateOwner(headlessOwner, headlessProfile, 'The packaged headless owner', 'SIGINT');
  if (headlessBrowser.isConnected()) await headlessBrowser.close();
  headlessBrowser = undefined;

  interactiveOwner = await launchOwner({
    executable: artifact.executable,
    profile: interactiveProfile,
    connectionPath: interactiveConnectionPath,
    headless: false,
  });
  const interactiveConnection = await waitForConnection(
    interactiveConnectionPath,
    interactiveOwner.child,
    'The fresh ordinary packaged launch',
  );
  if (interactiveConnection.pid !== interactiveOwner.ownerPid) {
    fail('The ordinary launch connection PID did not match the exact spawned owner', {
      connectionPid: interactiveConnection.pid,
      ownerPid: interactiveOwner.ownerPid,
    });
  }
  interactiveBrowser = await connectDebugger(
    interactiveOwner.debuggerEndpoint,
    interactiveOwner.child,
    'The ordinary packaged launch DevTools endpoint',
  );
  await waitForSingleEditorPage(interactiveBrowser, 'The ordinary packaged launch');
  const interactiveInspection = await waitForInspection(
    driver,
    interactiveOwner.ownerPid,
    (value) => value.applicationReadiness.activationPolicy === 0 && value.windows.length === 1 && value.windows[0].onScreen,
    'Ordinary packaged launch',
  );
  const interactive = assertEditorInspection(interactiveInspection, 'Ordinary packaged launch');
  const interactiveProcesses = await waitForProcessShape(interactiveProfile, interactiveOwner.ownerPid, 1, 'Ordinary packaged launch');
  const interactiveIdentity = await assertIdentity(interactiveConnection, interactiveOwner.ownerPid, 'Ordinary packaged launch');
  const interactiveShutdown = await terminateOwner(interactiveOwner, interactiveProfile, 'The ordinary packaged owner', 'SIGTERM');
  if (interactiveBrowser.isConnected()) await interactiveBrowser.close();
  interactiveBrowser = undefined;

  const result = {
    passed: true,
    scenario: 'FND-05 macOS native background-engine lifecycle',
    package: {
      platform: artifact.platform,
      arch: artifact.arch,
      executableBytes: (await stat(artifact.executable)).size,
      executableSha256: await sha256(artifact.executable),
      asarBytes: (await stat(artifact.asar)).size,
      asarSha256: await sha256(artifact.asar),
    },
    headless: {
      ownerPid: headlessOwner.ownerPid,
      initialBackground,
      initialProcesses: initialProcesses.shape,
      initialIdentity,
      activationAttempt,
      headlessSignal,
      afterNonShow,
      idleObservationMs: IDLE_OBSERVATION_MS,
      preShowIdentity,
      showSignal,
      shown,
      shownProcessShape: shownProcesses.shape,
      repeatedShowSignal,
      repeatedShown,
      repeatedShowPreservedWindowAndRenderer: true,
      detached,
      detachedIdentity,
      postDetachIdleIdentity,
      ordinaryOpenSignal,
      reopened,
      reopenedProcessShape: reopenedProcesses.shape,
      terminalBackground,
      shutdown: headlessShutdown,
    },
    interactive: {
      ownerPid: interactiveOwner.ownerPid,
      presentation: interactive,
      processShape: interactiveProcesses.shape,
      identity: interactiveIdentity,
      shutdown: interactiveShutdown,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (headlessBrowser?.isConnected()) await headlessBrowser.close().catch(() => undefined);
  if (interactiveBrowser?.isConnected()) await interactiveBrowser.close().catch(() => undefined);
  await forceCleanup(headlessOwner, headlessProfile);
  await forceCleanup(interactiveOwner, interactiveProfile);
  await rm(temporaryRoot, { recursive: true, force: true });
}
