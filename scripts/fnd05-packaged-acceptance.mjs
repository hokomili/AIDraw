import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

export const FND05_PACKAGED_SCENARIO = 'FND-05-STALE-RENDERER exact package replaces one lost renderer without replacing its engine';
export const FND05_PACKAGED_PROFILE_ENV = 'AIDRAW_E2E_FND05_STALE_RENDERER_PROFILE';
export const FND05_PACKAGED_EXE_HASH_ENV = 'AIDRAW_E2E_FND05_STALE_RENDERER_EXE_SHA256';
export const FND05_PACKAGED_ASAR_HASH_ENV = 'AIDRAW_E2E_FND05_STALE_RENDERER_ASAR_SHA256';
export const FND05_PACKAGED_PROFILE_PREFIX = 'aidraw-e2e-fnd05-stale-renderer-';
export const FND05_PACKAGED_FILES = Object.freeze({
  ownerConnection: 'mcp-owner-connection.json',
  relaunchConnection: 'mcp-relaunch-connection.json',
  evidence: 'fnd05-stale-renderer-evidence.json',
  failure: 'fnd05-stale-renderer-failure.json',
  cleanup: 'fnd05-stale-renderer-cleanup.json',
  forbiddenNetwork: 'fnd05-forbidden-network.json',
  providerCredentials: join('credentials', 'generation.json'),
  tokenCredentials: join('credentials', 'mcp-token.json'),
});

export const FND05_UNRESPONSIVE_PACKAGED_SCENARIO = 'FND-05-UNRESPONSIVE-RENDERER exact package replaces one persistently unresponsive renderer without replacing its engine';
export const FND05_UNRESPONSIVE_PROFILE_ENV = 'AIDRAW_E2E_FND05_UNRESPONSIVE_RENDERER_PROFILE';
export const FND05_UNRESPONSIVE_FAILURE_ROOT_ENV = 'AIDRAW_E2E_FND05_UNRESPONSIVE_RENDERER_FAILURE_ROOT';
export const FND05_UNRESPONSIVE_EXE_HASH_ENV = 'AIDRAW_E2E_FND05_UNRESPONSIVE_RENDERER_EXE_SHA256';
export const FND05_UNRESPONSIVE_ASAR_HASH_ENV = 'AIDRAW_E2E_FND05_UNRESPONSIVE_RENDERER_ASAR_SHA256';
export const FND05_UNRESPONSIVE_DISCOVERY_ENV = 'AIDRAW_E2E_FND05_UNRESPONSIVE_DISCOVERY_ONLY';
export const FND05_UNRESPONSIVE_PACKAGE_PREFIX = 'fnd05-unresponsive-renderer-';
export const FND05_UNRESPONSIVE_PROFILE_PREFIX = 'aidraw-e2e-fnd05-unresponsive-renderer-';
export const FND05_UNRESPONSIVE_FAILURE_PREFIX = 'fnd05-unresponsive-renderer-native-';
export const FND05_UNRESPONSIVE_POLICY_GRACE_MS = 10_000;
export const FND05_UNRESPONSIVE_OBSERVATION_MS = 2_000;
// Electron 43.4.0 bundles Chromium 150.0.7871.224. Its compiled input route
// contains the input-event ACK timeout that feeds renderer-unresponsive state.
// Keep this as a conservative source-derived budget rather than claiming a
// runtime-observed threshold; the exact package must still prove the event.
export const FND05_UNRESPONSIVE_INPUT_ACK_BUDGET_MS = 15_000;
export const FND05_UNRESPONSIVE_INPUT_ADMISSION_WAIT_MS = 1_000;
export const FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS = 2_000;
export const FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS = FND05_UNRESPONSIVE_OBSERVATION_MS
  + FND05_UNRESPONSIVE_INPUT_ADMISSION_WAIT_MS
  + FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS;
export const FND05_UNRESPONSIVE_CONFIRMATION_MARGIN_MS = 10_000;
export const FND05_UNRESPONSIVE_CONFIRMATION_WAIT_MS = FND05_UNRESPONSIVE_INPUT_ACK_BUDGET_MS
  + FND05_UNRESPONSIVE_POLICY_GRACE_MS
  + FND05_UNRESPONSIVE_CONFIRMATION_MARGIN_MS;
export const FND05_UNRESPONSIVE_REPLACEMENT_WAIT_MS = 15_000;
export const FND05_UNRESPONSIVE_POST_REPLACEMENT_MARGIN_MS = 10_000;
export const FND05_UNRESPONSIVE_STALL_MS = FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS
  + FND05_UNRESPONSIVE_CONFIRMATION_WAIT_MS
  + FND05_UNRESPONSIVE_REPLACEMENT_WAIT_MS
  + FND05_UNRESPONSIVE_POST_REPLACEMENT_MARGIN_MS;
export const FND05_UNRESPONSIVE_STALL_EXPRESSION = `(() => {
  const deadline = performance.now() + ${FND05_UNRESPONSIVE_STALL_MS};
  while (performance.now() < deadline) { /* bounded test-only renderer main-thread stall */ }
  return 'fnd05-bounded-stall-finished';
})()`;
export const FND05_UNRESPONSIVE_INPUT_EVENT = Object.freeze({
  type: 'rawKeyDown',
  key: 'F24',
  code: 'F24',
  modifiers: 0,
  windowsVirtualKeyCode: 135,
  nativeVirtualKeyCode: 0,
  autoRepeat: false,
  isKeypad: false,
});
export const FND05_UNRESPONSIVE_CONFIRMATION_MARKER = `AIDraw editor recovery: renderer remained unresponsive for ${FND05_UNRESPONSIVE_POLICY_GRACE_MS} ms. The editor was detached without replacing canonical engine state.`;
export const FND05_UNRESPONSIVE_UNSAFE_REPORT_ENVIRONMENTS = Object.freeze([
  'PLAYWRIGHT_HTML_OUTPUT_DIR',
  'PLAYWRIGHT_HTML_OPEN',
  'PLAYWRIGHT_HTML_HOST',
  'PLAYWRIGHT_HTML_PORT',
  'PLAYWRIGHT_JSON_OUTPUT_FILE',
  'PLAYWRIGHT_JSON_OUTPUT_NAME',
  'PLAYWRIGHT_JUNIT_OUTPUT_FILE',
  'PLAYWRIGHT_JUNIT_OUTPUT_NAME',
  'PLAYWRIGHT_BLOB_OUTPUT_DIR',
  'PLAYWRIGHT_BLOB_OUTPUT_FILE',
  'PLAYWRIGHT_BLOB_OUTPUT_NAME',
  'PW_TEST_HTML_REPORT_OPEN',
]);
export const FND05_UNRESPONSIVE_FILES = Object.freeze({
  ownerConnection: 'mcp-owner-connection.json',
  evidence: 'fnd05-unresponsive-renderer-evidence.json',
  failure: 'fnd05-unresponsive-renderer-failure.json',
  cleanup: 'fnd05-unresponsive-renderer-cleanup.json',
  forbiddenNetwork: 'fnd05-unresponsive-renderer-forbidden-network.json',
  providerCredentials: join('credentials', 'generation.json'),
  tokenCredentials: join('credentials', 'mcp-token.json'),
});

function required(environment, name) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required for the retained FND-05 exact-package acceptance.`);
  return value;
}

function declaredSha256(environment, name) {
  const value = required(environment, name).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(value)) throw new Error(`${name} must be one exact SHA-256 digest.`);
  return value;
}

export function resolveFnd05PackagedAcceptance({ workspacePath = process.cwd(), environment = process.env } = {}) {
  const workspace = resolve(workspacePath);
  const retainedRoot = resolve(workspace, 'test-results', 'retained');
  const profile = resolve(required(environment, FND05_PACKAGED_PROFILE_ENV));
  const nested = relative(retainedRoot, profile);
  const leaf = basename(profile);
  if (!nested || nested.startsWith('..') || isAbsolute(nested) || dirname(profile) !== retainedRoot || !leaf.startsWith(FND05_PACKAGED_PROFILE_PREFIX)) {
    throw new Error(`${FND05_PACKAGED_PROFILE_ENV} must be a fresh ${FND05_PACKAGED_PROFILE_PREFIX}* direct child of test-results/retained.`);
  }
  const runId = leaf.slice(FND05_PACKAGED_PROFILE_PREFIX.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{6,78}[a-z0-9])$/.test(runId)) {
    throw new Error(`${FND05_PACKAGED_PROFILE_ENV} must end in a 8-80 character lowercase run identifier.`);
  }
  const paths = Object.fromEntries(Object.entries(FND05_PACKAGED_FILES).map(([key, file]) => [key, join(profile, file)]));
  return {
    workspace,
    retainedRoot,
    profile,
    runId,
    executableSha256: declaredSha256(environment, FND05_PACKAGED_EXE_HASH_ENV),
    asarSha256: declaredSha256(environment, FND05_PACKAGED_ASAR_HASH_ENV),
    paths,
  };
}

function directChildWithPrefix(root, candidate, prefix, environmentName) {
  const nested = relative(root, candidate);
  const leaf = basename(candidate);
  if (!nested || nested.startsWith('..') || isAbsolute(nested) || dirname(candidate) !== root || !leaf.startsWith(prefix)) {
    throw new Error(`${environmentName} must be a fresh ${prefix}* direct child of ${relative(process.cwd(), root) || root}.`);
  }
  return leaf.slice(prefix.length);
}

export function resolveFnd05UnresponsiveAcceptance({ workspacePath = process.cwd(), environment = process.env } = {}) {
  const workspace = resolve(workspacePath);
  const preparedRoot = resolve(workspace, 'test-results', 'prepared-packages');
  const retainedRoot = resolve(workspace, 'test-results', 'retained');
  const retainedFailureRoot = resolve(workspace, 'test-results', 'retained-failures');
  const packageRoot = resolve(workspace, required(environment, 'AIDRAW_E2E_OUT_DIR'));
  const profile = resolve(required(environment, FND05_UNRESPONSIVE_PROFILE_ENV));
  const failureRoot = resolve(required(environment, FND05_UNRESPONSIVE_FAILURE_ROOT_ENV));
  const runId = directChildWithPrefix(retainedRoot, profile, FND05_UNRESPONSIVE_PROFILE_PREFIX, FND05_UNRESPONSIVE_PROFILE_ENV);
  if (!/^[a-z0-9](?:[a-z0-9-]{6,78}[a-z0-9])$/.test(runId)) {
    throw new Error(`${FND05_UNRESPONSIVE_PROFILE_ENV} must end in an 8-80 character lowercase run identifier.`);
  }
  if (directChildWithPrefix(preparedRoot, packageRoot, FND05_UNRESPONSIVE_PACKAGE_PREFIX, 'AIDRAW_E2E_OUT_DIR') !== runId) {
    throw new Error(`AIDRAW_E2E_OUT_DIR must be the matching fresh ${FND05_UNRESPONSIVE_PACKAGE_PREFIX}${runId} direct child of test-results/prepared-packages.`);
  }
  if (directChildWithPrefix(retainedFailureRoot, failureRoot, FND05_UNRESPONSIVE_FAILURE_PREFIX, FND05_UNRESPONSIVE_FAILURE_ROOT_ENV) !== runId) {
    throw new Error(`${FND05_UNRESPONSIVE_FAILURE_ROOT_ENV} must be the matching fresh ${FND05_UNRESPONSIVE_FAILURE_PREFIX}${runId} direct child of test-results/retained-failures.`);
  }
  const paths = Object.fromEntries(Object.entries(FND05_UNRESPONSIVE_FILES).map(([key, file]) => [key, join(profile, file)]));
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
    executableSha256: declaredSha256(environment, FND05_UNRESPONSIVE_EXE_HASH_ENV),
    asarSha256: declaredSha256(environment, FND05_UNRESPONSIVE_ASAR_HASH_ENV),
    paths,
  };
}

export function assertFnd05UnresponsiveSafeReporterEnvironment(environment = process.env) {
  const configured = FND05_UNRESPONSIVE_UNSAFE_REPORT_ENVIRONMENTS.filter((name) => String(environment[name] ?? '').trim());
  if (configured.length) {
    throw new Error(`FND-05 unresponsive-renderer acceptance rejects credential-capable Playwright report configuration: ${configured.join(', ')}.`);
  }
  return true;
}

export function inspectFnd05EncryptedToken(value, liveToken) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The FND-05 MCP credential is not the expected encrypted safe-storage record.');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'encryption,value,version'
    || value.version !== 1
    || value.encryption !== 'electron-safe-storage'
    || typeof value.value !== 'string'
    || !value.value
    || typeof liveToken !== 'string'
    || !liveToken
    || value.value === liveToken) {
    throw new Error('The FND-05 MCP credential is not the expected encrypted safe-storage record.');
  }
  return { version: 1, encryption: 'electron-safe-storage', encryptedValuePresent: true };
}

export function parseFnd05OwnedProcesses(processTable, profilePath) {
  const profile = resolve(profilePath);
  const escapedProfile = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactProfile = new RegExp(`(?:=|\\s|["'])${escapedProfile}(?=$|[\\s/"'])`);
  const rows = [];
  for (const line of String(processTable).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || !exactProfile.test(match[3])) continue;
    const type = match[3].match(/(?:^|\s)--type=([^\s]+)/)?.[1] ?? 'browser';
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), type });
  }
  return rows.sort((left, right) => left.pid - right.pid);
}

export function assertFnd05OwnedProcessShape(rows, expectedOwnerPid, previousRendererPid) {
  const owners = rows.filter((entry) => entry.type === 'browser');
  const renderers = rows.filter((entry) => entry.type === 'renderer');
  if (!Number.isInteger(expectedOwnerPid)
    || owners.length !== 1
    || owners[0].pid !== expectedOwnerPid
    || renderers.length !== 1
    || renderers[0].ppid !== expectedOwnerPid
    || (previousRendererPid !== undefined && renderers[0].pid === previousRendererPid)) {
    throw new Error('The FND-05 exact-profile process set is not one expected owner with one direct-child renderer.');
  }
  return { ownerPid: owners[0].pid, rendererPid: renderers[0].pid };
}

export function redactFnd05FailureText(value, secrets = []) {
  let text = String(value ?? '').slice(0, 16_384);
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, '[redacted]');
  }
  return text
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|token)\s*[:=]\s*)[^\s,;}]+/gi, '$1[redacted]');
}

export function assertFnd05EvidenceRedacted(serialized, forbiddenValues = []) {
  const text = String(serialized);
  if (/"(?:token|authorization)"\s*:/i.test(text) || /Bearer\s+(?!\[redacted\])[^\s"']+/i.test(text)) {
    throw new Error('FND-05 retained evidence contains a credential-shaped field or bearer value.');
  }
  const leaked = forbiddenValues.filter((value) => value && text.includes(value));
  if (leaked.length) throw new Error('FND-05 retained evidence contains a declared secret value.');
  return true;
}

const EXPECTED_PAGE_CRASH_COMMAND_ERROR = /^(?:cdpSession\.send:\s*)?(?:Protocol error \(Page\.crash\):\s*)?(?:Page crashed|Target crashed|Target closed|Session closed(?:\..*)?|Target page, context or browser has been closed)\.?\s*$/i;

function crashErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function observeFnd05DeliberatePageCrash(crashEvent, crashCommand) {
  const [eventOutcome, commandOutcome] = await Promise.allSettled([crashEvent, crashCommand]);
  if (eventOutcome.status === 'rejected') {
    const message = crashErrorMessage(eventOutcome.reason);
    throw new Error(`The deliberate FND-05 renderer crash was not positively observed: ${message}`, { cause: eventOutcome.reason });
  }
  if (commandOutcome.status === 'rejected') {
    const message = crashErrorMessage(commandOutcome.reason);
    if (!EXPECTED_PAGE_CRASH_COMMAND_ERROR.test(message)) {
      throw new Error(`The FND-05 Page.crash command failed for an unrelated reason: ${message}`, { cause: commandOutcome.reason });
    }
    return { crashObserved: true, command: 'rejected-after-crash' };
  }
  return { crashObserved: true, command: 'resolved' };
}

const EXPECTED_DEBUGGER_DETACH_ERROR = /^(?:cdpSession\.send:\s*)?(?:Protocol error \((?:Runtime\.evaluate|Input\.dispatchKeyEvent)\):\s*)?(?:Target closed|Session closed(?:\. Most likely the page has been closed\.)?|Target page, context or browser has been closed|Execution context was destroyed, most likely because of a navigation\.?|Inspected target navigated or closed)\.?\s*$/i;

export function classifyFnd05UnresponsiveFailureStage(progress) {
  if (!progress || progress.inputAdmission === 'not-attempted') return 'pre-input-stimulus';
  if (progress.inputAdmission === 'rejected') return 'input-stimulus-not-admitted';
  if (!['admitted', 'ack-pending'].includes(progress.inputAdmission)) return 'input-stimulus-admission-unconfirmed';
  if (progress.allDebuggerAttachmentsDetached !== true) return 'debugger-detach-not-completed';
  if (progress.productUnresponsiveConfirmationObserved !== true) return 'product-unresponsive-confirmation-not-observed';
  if (progress.replacementProcessAdmitted !== true) return 'replacement-not-admitted';
  if (progress.debuggerTransportReconnected !== true) return 'debugger-transport-reconnect-not-completed';
  if (progress.replacementAdmitted !== true) return 'replacement-not-admitted';
  return 'post-replacement-assertion';
}

export function assertFnd05DebuggerDetachProof(proof) {
  if (!proof
    || proof.originalRendererAliveBeforeStall !== true
    || proof.originalRendererResponsiveBeforeStall !== true
    || proof.commandPendingDuringObservation !== true
    || proof.originalRendererAliveDuringObservation !== true
    || proof.sameOwnerMcpResponsiveDuringObservation !== true
    || !['admitted', 'ack-pending'].includes(proof.inputAdmission)
    || proof.productConfirmationAbsentThroughDebuggerDetach !== true
    || proof.allDebuggerAttachmentsDetached !== true
    || proof.ownerAliveAfterDebuggerDetach !== true
    || proof.sameOwnerMcpResponsiveAfterDebuggerDetach !== true
    || !Number.isFinite(proof.debuggerDetachedElapsedMs)
    || proof.debuggerDetachedElapsedMs < FND05_UNRESPONSIVE_OBSERVATION_MS
    || proof.debuggerDetachedElapsedMs > FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS) {
    throw new Error('The FND-05 controller did not prove exact-target admission, complete debugger detach before the ACK deadline, and same-owner continuity.');
  }
  return {
    allDebuggerAttachmentsDetached: true,
    debuggerDetachedElapsedMs: proof.debuggerDetachedElapsedMs,
    ownerAliveAfterDebuggerDetach: true,
    sameOwnerMcpResponsiveAfterDebuggerDetach: true,
  };
}

export function classifyFnd05DebuggerDetachCommandSettlement(settlement, method, proof) {
  assertFnd05DebuggerDetachProof(proof);
  if (!['Runtime.evaluate', 'Input.dispatchKeyEvent'].includes(method)) {
    throw new Error(`The FND-05 debugger-detach settlement method is unsupported: ${String(method)}.`);
  }
  if (!settlement || settlement.status === 'timeout') {
    throw new Error(`The FND-05 ${method} command did not settle after the bounded debugger transport disconnect.`);
  }
  if (settlement.status === 'resolved') {
    if (method !== 'Input.dispatchKeyEvent' || proof.inputAdmission !== 'admitted') {
      throw new Error(`The FND-05 ${method} command resolved unexpectedly before debugger detach.`);
    }
    return { method, command: 'resolved-after-browser-admission' };
  }
  const message = crashErrorMessage(settlement.reason);
  if (!EXPECTED_DEBUGGER_DETACH_ERROR.test(message)) {
    throw new Error(`The FND-05 ${method} command failed for an unrelated reason: ${message}`, { cause: settlement.reason });
  }
  return {
    method,
    command: 'rejected-after-debugger-detach',
  };
}
