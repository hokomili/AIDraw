import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  assertFnd05OwnedProcessShape,
  assertFnd05EvidenceRedacted,
  assertFnd05DebuggerDetachProof,
  assertFnd05UnresponsiveSafeReporterEnvironment,
  classifyFnd05DebuggerDetachCommandObservation,
  classifyFnd05UnresponsiveFailureStage,
  FND05_PACKAGED_ASAR_HASH_ENV,
  FND05_PACKAGED_EXE_HASH_ENV,
  FND05_PACKAGED_FILES,
  FND05_PACKAGED_PROFILE_ENV,
  FND05_UNRESPONSIVE_ASAR_HASH_ENV,
  FND05_UNRESPONSIVE_CONFIRMATION_MARGIN_MS,
  FND05_UNRESPONSIVE_CONFIRMATION_MARKER,
  FND05_UNRESPONSIVE_CONFIRMATION_WAIT_MS,
  FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS,
  FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS,
  FND05_UNRESPONSIVE_DISCOVERY_ENV,
  FND05_UNRESPONSIVE_EXE_HASH_ENV,
  FND05_UNRESPONSIVE_FAILURE_PREFIX,
  FND05_UNRESPONSIVE_FAILURE_ROOT_ENV,
  FND05_UNRESPONSIVE_INPUT_ACK_BUDGET_MS,
  FND05_UNRESPONSIVE_INPUT_ADMISSION_WAIT_MS,
  FND05_UNRESPONSIVE_INPUT_EVENT,
  FND05_UNRESPONSIVE_OBSERVATION_MS,
  FND05_UNRESPONSIVE_PACKAGE_PREFIX,
  FND05_UNRESPONSIVE_PACKAGED_SCENARIO,
  FND05_UNRESPONSIVE_POST_DETACH_COMMAND_OBSERVATION_MS,
  FND05_UNRESPONSIVE_POLICY_GRACE_MS,
  FND05_UNRESPONSIVE_POST_REPLACEMENT_MARGIN_MS,
  FND05_UNRESPONSIVE_PROFILE_ENV,
  FND05_UNRESPONSIVE_PROFILE_PREFIX,
  FND05_UNRESPONSIVE_REPLACEMENT_WAIT_MS,
  FND05_UNRESPONSIVE_STALL_EXPRESSION,
  FND05_UNRESPONSIVE_STALL_MS,
  FND05_UNRESPONSIVE_UNSAFE_REPORT_ENVIRONMENTS,
  inspectFnd05EncryptedToken,
  observeFnd05DeliberatePageCrash,
  parseFnd05OwnedProcesses,
  redactFnd05FailureText,
  resolveFnd05PackagedAcceptance,
  resolveFnd05UnresponsiveAcceptance,
} from '../../scripts/fnd05-packaged-acceptance.mjs';
import { EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS } from '../../src/main/editor-window-lifecycle';
import { parseFeatureTracker } from '../../scripts/check-rc-readiness.mjs';

const digest = 'A'.repeat(64);
const execute = promisify(execFile);

function environment(profile: string): NodeJS.ProcessEnv {
  return {
    [FND05_PACKAGED_PROFILE_ENV]: profile,
    [FND05_PACKAGED_EXE_HASH_ENV]: digest,
    [FND05_PACKAGED_ASAR_HASH_ENV]: digest.toLowerCase(),
  };
}

function unresponsiveEnvironment(workspace: string, runId: string): NodeJS.ProcessEnv {
  return {
    AIDRAW_E2E_OUT_DIR: join(workspace, 'test-results', 'prepared-packages', `${FND05_UNRESPONSIVE_PACKAGE_PREFIX}${runId}`),
    [FND05_UNRESPONSIVE_PROFILE_ENV]: join(workspace, 'test-results', 'retained', `${FND05_UNRESPONSIVE_PROFILE_PREFIX}${runId}`),
    [FND05_UNRESPONSIVE_FAILURE_ROOT_ENV]: join(workspace, 'test-results', 'retained-failures', `${FND05_UNRESPONSIVE_FAILURE_PREFIX}${runId}`),
    [FND05_UNRESPONSIVE_EXE_HASH_ENV]: digest,
    [FND05_UNRESPONSIVE_ASAR_HASH_ENV]: digest.toLowerCase(),
  };
}

describe('FND-05 retained exact-package acceptance boundary', () => {
  it('requires one immutable direct-child retained profile and exact package hashes', () => {
    const workspace = resolve('synthetic-workspace');
    const profile = join(workspace, 'test-results', 'retained', 'aidraw-e2e-fnd05-stale-renderer-20260814t120000z');
    const resolved = resolveFnd05PackagedAcceptance({ workspacePath: workspace, environment: environment(profile) });
    expect(resolved).toMatchObject({ workspace, profile, runId: '20260814t120000z', executableSha256: digest, asarSha256: digest });
    expect(resolved.paths.ownerConnection).toBe(join(profile, FND05_PACKAGED_FILES.ownerConnection));
    expect(resolved.paths.relaunchConnection).not.toBe(resolved.paths.ownerConnection);
  });

  it('fails closed for a default, nested, reused-looking, or underdeclared profile/hash contract', () => {
    const workspace = resolve('synthetic-workspace');
    const valid = join(workspace, 'test-results', 'retained', 'aidraw-e2e-fnd05-stale-renderer-20260814t120000z');
    expect(() => resolveFnd05PackagedAcceptance({ workspacePath: workspace, environment: environment(join(workspace, 'Default')) })).toThrow(/direct child/);
    expect(() => resolveFnd05PackagedAcceptance({ workspacePath: workspace, environment: environment(join(valid, 'nested')) })).toThrow(/direct child/);
    expect(() => resolveFnd05PackagedAcceptance({ workspacePath: workspace, environment: environment(join(workspace, 'test-results', 'retained', 'aidraw-e2e-fnd05-stale-renderer-short')) })).toThrow(/8-80/);
    expect(() => resolveFnd05PackagedAcceptance({ workspacePath: workspace, environment: { ...environment(valid), [FND05_PACKAGED_ASAR_HASH_ENV]: 'abc' } })).toThrow(/SHA-256/);
    expect(() => resolveFnd05PackagedAcceptance({ workspacePath: workspace, environment: {} })).toThrow(/is required/);
  });

  it('finds only processes carrying the exact run-owned profile and reports renderer identity separately', () => {
    const profile = resolve('test-results/retained/aidraw-e2e-fnd05-stale-renderer-20260814t120000z');
    const table = [
      ` 100 1 /candidate/AIDraw --user-data-dir=${profile}`,
      ` 101 100 /candidate/AIDraw Helper --type=renderer --user-data-dir=${profile}`,
      ` 102 100 /candidate/AIDraw Helper --type=gpu-process --user-data-dir=${profile}`,
      ` 103 100 /candidate/AIDraw Helper --type=renderer --user-data-dir=${profile}-sibling`,
      ' 999 1 /candidate/AIDraw --user-data-dir=/Users/example/Library/Application Support/AIDraw',
    ].join('\n');
    expect(parseFnd05OwnedProcesses(table, profile)).toEqual([
      { pid: 100, ppid: 1, type: 'browser' },
      { pid: 101, ppid: 100, type: 'renderer' },
      { pid: 102, ppid: 100, type: 'gpu-process' },
    ]);
  });

  it('redacts live values and rejects credential-shaped retained evidence', () => {
    const secret = 'fnd05-private-token-value';
    const failure = redactFnd05FailureText(`Authorization: Bearer ${secret}; token=${secret}`, [secret]);
    expect(failure).not.toContain(secret);
    expect(assertFnd05EvidenceRedacted(JSON.stringify({ status: 'failed', failure }), [secret])).toBe(true);
    expect(() => assertFnd05EvidenceRedacted(JSON.stringify({ token: secret }), [secret])).toThrow(/credential-shaped/);
    expect(() => assertFnd05EvidenceRedacted(JSON.stringify({ detail: `Bearer ${secret}` }), [secret])).toThrow(/credential-shaped/);
  });

  it('accepts only a positively observed deliberate crash and its expected command settlement', async () => {
    await expect(observeFnd05DeliberatePageCrash(Promise.resolve(), Promise.resolve())).resolves.toEqual({ crashObserved: true, command: 'resolved' });
    await expect(observeFnd05DeliberatePageCrash(
      Promise.resolve(),
      Promise.reject(new Error('cdpSession.send: Protocol error (Page.crash): Target closed')),
    )).resolves.toEqual({ crashObserved: true, command: 'rejected-after-crash' });
    await expect(observeFnd05DeliberatePageCrash(
      Promise.resolve(),
      Promise.reject(new Error('cdpSession.send: Page crashed')),
    )).resolves.toEqual({ crashObserved: true, command: 'rejected-after-crash' });
  });

  it('does not swallow an unrelated Page.crash protocol failure', async () => {
    await expect(observeFnd05DeliberatePageCrash(
      Promise.resolve(),
      Promise.reject(new Error('cdpSession.send: Protocol error (Page.crash): Permission denied')),
    )).rejects.toThrow(/unrelated reason:.*Permission denied/);
    await expect(observeFnd05DeliberatePageCrash(
      Promise.resolve(),
      Promise.reject(new Error('cdpSession.send: Protocol error (Page.crash): Permission denied: Target closed')),
    )).rejects.toThrow(/unrelated reason:.*Permission denied/);
  });

  it('requires the crash event even when the Page.crash command reports target closure', async () => {
    await expect(observeFnd05DeliberatePageCrash(
      Promise.reject(new Error('page.waitForEvent: Page closed before a crash event')),
      Promise.reject(new Error('cdpSession.send: Protocol error (Page.crash): Target closed')),
    )).rejects.toThrow(/not positively observed:.*Page closed/);
  });

  it('keeps deliberate renderer loss inside the loopback Playwright controller with graceful-only cleanup', async () => {
    const source = await readFile(resolve('tests/e2e/stale-renderer-recovery.spec.ts'), 'utf8');
    expect(source).toContain("session.send('Page.crash')");
    expect(source).toContain("page.waitForEvent('crash')");
    expect(source).toContain('observeFnd05DeliberatePageCrash');
    expect(source).not.toContain("page.waitForEvent('close')");
    expect(source).toContain("'--remote-debugging-address=127.0.0.1'");
    expect(source).toContain("signalOwner(profile, '--quit-engine')");
    expect(source).not.toContain('forcefullyCrashRenderer');
    expect(source).not.toContain('injectRendererRecoveryTestEvent');
    expect(source).not.toMatch(/\.kill\s*\(/);
    expect(source).not.toMatch(/\brm\s*\(/);
  });

  it('correlates one fresh prepared package, profile, failure root, selector, and exact hashes for the alive-hang route', () => {
    const workspace = resolve('synthetic-workspace');
    const runId = '20260814t120000z-a3e4de5-r1';
    const configured = resolveFnd05UnresponsiveAcceptance({ workspacePath: workspace, environment: unresponsiveEnvironment(workspace, runId) });
    expect(configured).toMatchObject({
      workspace,
      runId,
      packageRoot: join(workspace, 'test-results', 'prepared-packages', `${FND05_UNRESPONSIVE_PACKAGE_PREFIX}${runId}`),
      profile: join(workspace, 'test-results', 'retained', `${FND05_UNRESPONSIVE_PROFILE_PREFIX}${runId}`),
      failureRoot: join(workspace, 'test-results', 'retained-failures', `${FND05_UNRESPONSIVE_FAILURE_PREFIX}${runId}`),
      executableSha256: digest,
      asarSha256: digest,
    });
    expect(configured.playwrightOutput).toBe(join(configured.failureRoot, 'playwright'));
    expect(FND05_UNRESPONSIVE_PACKAGED_SCENARIO).toContain('exact package replaces one persistently unresponsive renderer');
  });

  it('fails closed on uncorrelated output/failure roots, nested profiles, and wrong hashes', () => {
    const workspace = resolve('synthetic-workspace');
    const runId = '20260814t120000z-a3e4de5-r1';
    const valid = unresponsiveEnvironment(workspace, runId);
    expect(() => resolveFnd05UnresponsiveAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [FND05_UNRESPONSIVE_PROFILE_ENV]: join(String(valid[FND05_UNRESPONSIVE_PROFILE_ENV]), 'nested') },
    })).toThrow(/direct child/);
    expect(() => resolveFnd05UnresponsiveAcceptance({
      workspacePath: workspace,
      environment: { ...valid, AIDRAW_E2E_OUT_DIR: join(workspace, 'test-results', 'prepared-packages', `${FND05_UNRESPONSIVE_PACKAGE_PREFIX}other-run`) },
    })).toThrow(/matching fresh/);
    expect(() => resolveFnd05UnresponsiveAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [FND05_UNRESPONSIVE_FAILURE_ROOT_ENV]: join(workspace, 'test-results', 'retained-failures', `${FND05_UNRESPONSIVE_FAILURE_PREFIX}other-run`) },
    })).toThrow(/matching fresh/);
    expect(() => resolveFnd05UnresponsiveAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [FND05_UNRESPONSIVE_EXE_HASH_ENV]: 'not-a-digest' },
    })).toThrow(/SHA-256/);
    expect(() => resolveFnd05UnresponsiveAcceptance({ workspacePath: workspace, environment: {} })).toThrow(/is required/);
  });

  it('requires one exact owner and one direct-child renderer for the declared profile', () => {
    const rows = [
      { pid: 100, ppid: 1, type: 'browser' },
      { pid: 101, ppid: 100, type: 'renderer' },
      { pid: 102, ppid: 100, type: 'gpu-process' },
    ];
    expect(assertFnd05OwnedProcessShape(rows, 100)).toEqual({ ownerPid: 100, rendererPid: 101 });
    expect(assertFnd05OwnedProcessShape([{ pid: 100, ppid: 1, type: 'browser' }, { pid: 201, ppid: 100, type: 'renderer' }], 100, 101)).toEqual({ ownerPid: 100, rendererPid: 201 });
    expect(() => assertFnd05OwnedProcessShape([...rows, { pid: 103, ppid: 100, type: 'renderer' }], 100)).toThrow(/one expected owner/);
    expect(() => assertFnd05OwnedProcessShape([{ pid: 100, ppid: 1, type: 'browser' }, { pid: 101, ppid: 999, type: 'renderer' }], 100)).toThrow(/direct-child renderer/);
    expect(() => assertFnd05OwnedProcessShape(rows, 999)).toThrow(/one expected owner/);
  });

  it('binds the bounded stall to a complete pre-ACK debugger detach and classifies bounded post-detach command observations', () => {
    expect(FND05_UNRESPONSIVE_POLICY_GRACE_MS).toBe(EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS);
    expect(FND05_UNRESPONSIVE_OBSERVATION_MS).toBeLessThan(FND05_UNRESPONSIVE_POLICY_GRACE_MS);
    expect(FND05_UNRESPONSIVE_INPUT_ACK_BUDGET_MS).toBe(15_000);
    expect(FND05_UNRESPONSIVE_INPUT_ADMISSION_WAIT_MS).toBeLessThan(FND05_UNRESPONSIVE_OBSERVATION_MS);
    expect(FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS).toBe(2_000);
    expect(FND05_UNRESPONSIVE_POST_DETACH_COMMAND_OBSERVATION_MS).toBe(2_000);
    expect(FND05_UNRESPONSIVE_POST_DETACH_COMMAND_OBSERVATION_MS).toBeLessThan(FND05_UNRESPONSIVE_POLICY_GRACE_MS);
    expect(FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS).toBe(
      FND05_UNRESPONSIVE_OBSERVATION_MS
        + FND05_UNRESPONSIVE_INPUT_ADMISSION_WAIT_MS
        + FND05_UNRESPONSIVE_DEBUGGER_DETACH_TIMEOUT_MS,
    );
    expect(FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS).toBeLessThan(FND05_UNRESPONSIVE_INPUT_ACK_BUDGET_MS);
    expect(FND05_UNRESPONSIVE_CONFIRMATION_WAIT_MS).toBe(
      FND05_UNRESPONSIVE_INPUT_ACK_BUDGET_MS
        + FND05_UNRESPONSIVE_POLICY_GRACE_MS
        + FND05_UNRESPONSIVE_CONFIRMATION_MARGIN_MS,
    );
    expect(FND05_UNRESPONSIVE_STALL_MS).toBe(
      FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS
        + FND05_UNRESPONSIVE_CONFIRMATION_WAIT_MS
        + FND05_UNRESPONSIVE_REPLACEMENT_WAIT_MS
        + FND05_UNRESPONSIVE_POST_REPLACEMENT_MARGIN_MS,
    );
    expect(FND05_UNRESPONSIVE_STALL_MS).toBe(65_000);
    expect(FND05_UNRESPONSIVE_STALL_EXPRESSION).toContain('performance.now()');
    expect(FND05_UNRESPONSIVE_STALL_EXPRESSION).toContain(String(FND05_UNRESPONSIVE_STALL_MS));
    expect(FND05_UNRESPONSIVE_STALL_EXPRESSION).not.toMatch(/aidraw|ipc|preload|fetch|WebSocket|Page\.crash/);
    const proof = {
      originalRendererAliveBeforeStall: true,
      originalRendererResponsiveBeforeStall: true,
      commandPendingDuringObservation: true,
      originalRendererAliveDuringObservation: true,
      sameOwnerMcpResponsiveDuringObservation: true,
      inputAdmission: 'ack-pending' as const,
      productConfirmationAbsentThroughDebuggerDetach: true,
      allDebuggerAttachmentsDetached: true,
      debuggerDetachedElapsedMs: FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS - 1,
      ownerAliveAfterDebuggerDetach: true,
      sameOwnerMcpResponsiveAfterDebuggerDetach: true,
    };
    expect(assertFnd05DebuggerDetachProof(proof)).toMatchObject({
      allDebuggerAttachmentsDetached: true,
      ownerAliveAfterDebuggerDetach: true,
    });
    expect(classifyFnd05DebuggerDetachCommandObservation(
      { status: 'rejected', reason: new Error('cdpSession.send: Protocol error (Runtime.evaluate): Target closed') },
      'Runtime.evaluate',
      proof,
    )).toEqual({ method: 'Runtime.evaluate', command: 'rejected-after-debugger-detach' });
    expect(classifyFnd05DebuggerDetachCommandObservation(
      { status: 'pending', observedForMs: FND05_UNRESPONSIVE_POST_DETACH_COMMAND_OBSERVATION_MS },
      'Runtime.evaluate',
      proof,
    )).toEqual({
      method: 'Runtime.evaluate',
      command: 'pending-after-debugger-detach',
      observedForMs: FND05_UNRESPONSIVE_POST_DETACH_COMMAND_OBSERVATION_MS,
    });
    expect(classifyFnd05DebuggerDetachCommandObservation(
      { status: 'resolved' },
      'Input.dispatchKeyEvent',
      { ...proof, inputAdmission: 'admitted' },
    )).toEqual({ method: 'Input.dispatchKeyEvent', command: 'resolved-after-browser-admission' });
    expect(classifyFnd05DebuggerDetachCommandObservation(
      { status: 'rejected', reason: new Error('cdpSession.send: Target page, context or browser has been closed') },
      'Input.dispatchKeyEvent',
      proof,
    )).toEqual({ method: 'Input.dispatchKeyEvent', command: 'rejected-after-debugger-detach' });
    expect(classifyFnd05DebuggerDetachCommandObservation(
      { status: 'pending', observedForMs: FND05_UNRESPONSIVE_POST_DETACH_COMMAND_OBSERVATION_MS },
      'Input.dispatchKeyEvent',
      proof,
    )).toEqual({
      method: 'Input.dispatchKeyEvent',
      command: 'pending-after-debugger-detach',
      observedForMs: FND05_UNRESPONSIVE_POST_DETACH_COMMAND_OBSERVATION_MS,
    });
    expect(() => classifyFnd05DebuggerDetachCommandObservation({ status: 'resolved' }, 'Runtime.evaluate', proof)).toThrow(/resolved unexpectedly/);
    expect(() => classifyFnd05DebuggerDetachCommandObservation(
      { status: 'pending', observedForMs: FND05_UNRESPONSIVE_POST_DETACH_COMMAND_OBSERVATION_MS - 1 },
      'Runtime.evaluate',
      proof,
    )).toThrow(/exact bounded post-detach interval/);
    expect(() => classifyFnd05DebuggerDetachCommandObservation(
      { status: 'rejected', reason: new Error('cdpSession.send: Protocol error (Runtime.evaluate): Permission denied: Target closed') },
      'Runtime.evaluate',
      proof,
    )).toThrow(/unrelated reason/);
    expect(() => assertFnd05DebuggerDetachProof({ ...proof, debuggerDetachedElapsedMs: FND05_UNRESPONSIVE_DEBUGGER_DETACH_DEADLINE_MS + 1 })).toThrow(/before the ACK deadline/);
    expect(() => assertFnd05DebuggerDetachProof({ ...proof, productConfirmationAbsentThroughDebuggerDetach: false })).toThrow(/complete debugger detach/);
    expect(() => assertFnd05DebuggerDetachProof({ ...proof, sameOwnerMcpResponsiveAfterDebuggerDetach: false })).toThrow(/same-owner continuity/);
  });

  it('uses one exact-target benign input ACK stimulus and classifies private failure progress without overclaiming', () => {
    expect(FND05_UNRESPONSIVE_INPUT_EVENT).toEqual({
      type: 'rawKeyDown',
      key: 'F24',
      code: 'F24',
      modifiers: 0,
      windowsVirtualKeyCode: 135,
      nativeVirtualKeyCode: 0,
      autoRepeat: false,
      isKeypad: false,
    });
    expect(Object.isFrozen(FND05_UNRESPONSIVE_INPUT_EVENT)).toBe(true);
    expect(FND05_UNRESPONSIVE_CONFIRMATION_MARKER).toBe(
      `AIDraw editor recovery: renderer remained unresponsive for ${EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS} ms. The editor was detached without replacing canonical engine state.`,
    );
    expect(classifyFnd05UnresponsiveFailureStage()).toBe('pre-input-stimulus');
    expect(classifyFnd05UnresponsiveFailureStage({ inputAdmission: 'rejected' })).toBe('input-stimulus-not-admitted');
    expect(classifyFnd05UnresponsiveFailureStage({ inputAdmission: 'unexpected' as never })).toBe('input-stimulus-admission-unconfirmed');
    expect(classifyFnd05UnresponsiveFailureStage({ inputAdmission: 'ack-pending' })).toBe('debugger-detach-not-completed');
    expect(classifyFnd05UnresponsiveFailureStage({ inputAdmission: 'admitted', allDebuggerAttachmentsDetached: true })).toBe('product-unresponsive-confirmation-not-observed');
    expect(classifyFnd05UnresponsiveFailureStage({ inputAdmission: 'admitted', allDebuggerAttachmentsDetached: true, productUnresponsiveConfirmationObserved: true })).toBe('replacement-not-admitted');
    expect(classifyFnd05UnresponsiveFailureStage({ inputAdmission: 'admitted', allDebuggerAttachmentsDetached: true, productUnresponsiveConfirmationObserved: true, replacementProcessAdmitted: true })).toBe('debugger-transport-reconnect-not-completed');
    expect(classifyFnd05UnresponsiveFailureStage({ inputAdmission: 'ack-pending', allDebuggerAttachmentsDetached: true, productUnresponsiveConfirmationObserved: true, replacementProcessAdmitted: true, debuggerTransportReconnected: true, replacementAdmitted: true })).toBe('post-replacement-assertion');
  });

  it('keeps token/ciphertext values out of reporter surfaces and rejects credential-capable reporters', () => {
    const liveToken = 'synthetic-live-token-that-must-not-reach-playwright';
    expect(inspectFnd05EncryptedToken({ version: 1, encryption: 'electron-safe-storage', value: 'encrypted-ciphertext' }, liveToken)).toEqual({
      version: 1,
      encryption: 'electron-safe-storage',
      encryptedValuePresent: true,
    });
    let message = '';
    try {
      inspectFnd05EncryptedToken({ version: 1, encryption: 'electron-safe-storage', value: liveToken }, liveToken);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/expected encrypted safe-storage record/);
    expect(message).not.toContain(liveToken);
    expect(assertFnd05UnresponsiveSafeReporterEnvironment({})).toBe(true);
    for (const name of ['PLAYWRIGHT_HTML_OUTPUT_DIR', 'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JUNIT_OUTPUT_FILE', 'PLAYWRIGHT_BLOB_OUTPUT_DIR']) {
      expect(() => assertFnd05UnresponsiveSafeReporterEnvironment({ [name]: '/tmp/unsafe' })).toThrow(new RegExp(name));
    }
  });

  it('orders the exact-target stall and benign input before product confirmation and keeps the wrapper private and graceful-only', async () => {
    const [source, wrapper, config, mainSource, preloadSource, rendererAppSource, rendererShortcutSource, electronTypes, electronPackageText, playwrightArtifacts, playwrightCore] = await Promise.all([
      readFile(resolve('tests/e2e/stale-renderer-recovery.spec.ts'), 'utf8'),
      readFile(resolve('scripts/run-fnd05-unresponsive-acceptance.mjs'), 'utf8'),
      readFile(resolve('playwright.fnd05-unresponsive.config.ts'), 'utf8'),
      readFile(resolve('src/main/main.ts'), 'utf8'),
      readFile(resolve('src/preload/preload.ts'), 'utf8'),
      readFile(resolve('src/renderer/App.tsx'), 'utf8'),
      readFile(resolve('src/renderer/shortcuts.ts'), 'utf8'),
      readFile(resolve('node_modules/electron/electron.d.ts'), 'utf8'),
      readFile(resolve('node_modules/electron/package.json'), 'utf8'),
      readFile(resolve('node_modules/playwright/lib/index.js'), 'utf8'),
      readFile(resolve('node_modules/playwright-core/lib/coreBundle.js'), 'utf8'),
    ]);
    const start = source.indexOf('test(FND05_UNRESPONSIVE_PACKAGED_SCENARIO');
    expect(start).toBeGreaterThan(0);
    const acceptance = source.slice(start);
    expect(acceptance).toContain("beforeTarget.session.send('Runtime.evaluate'");
    expect(acceptance).toContain('FND05_UNRESPONSIVE_STALL_EXPRESSION');
    expect(acceptance).toContain("'Input.dispatchKeyEvent'");
    expect(acceptance).toContain('FND05_UNRESPONSIVE_INPUT_EVENT');
    expect(acceptance).toContain('FND05_UNRESPONSIVE_CONFIRMATION_MARKER');
    expect(acceptance).toContain('classifyFnd05UnresponsiveFailureStage(unresponsiveProgress)');
    const stallIndex = acceptance.indexOf("beforeTarget.session.send('Runtime.evaluate'");
    const observationIndex = acceptance.indexOf('await new Promise((resolveWait) => setTimeout(resolveWait, FND05_UNRESPONSIVE_OBSERVATION_MS))');
    const inputIndex = acceptance.indexOf("'Input.dispatchKeyEvent'", observationIndex);
    const prematureConfirmationGuardIndex = acceptance.indexOf('product confirmation appeared before every debugger attachment was detached', inputIndex);
    const detachIndex = acceptance.indexOf('disconnectOwnerDebugger(owner, stallStartedAt)', inputIndex);
    const debuggerFreeConfirmationGuardIndex = acceptance.indexOf('product confirmation appeared before the debugger-free boundary was proven', detachIndex);
    const postDetachObservationIndex = acceptance.indexOf('const [detachedInputObservation, detachedStallObservation]', debuggerFreeConfirmationGuardIndex);
    const policyFloorIndex = acceptance.indexOf('const untilPolicyFloorMs', postDetachObservationIndex);
    const policyFloorConfirmationGuardIndex = acceptance.indexOf('product confirmation appeared before the debugger-free policy floor elapsed', policyFloorIndex);
    const confirmationIndex = acceptance.indexOf('waitForStderrMarker(owner, FND05_UNRESPONSIVE_CONFIRMATION_MARKER');
    const reconnectIndex = acceptance.indexOf('connectOwnerDebugger(owner, reconnectBudgetMs)', confirmationIndex);
    const replacementIndex = acceptance.indexOf('const replacementPage = owner.page!', reconnectIndex);
    expect(stallIndex).toBeGreaterThanOrEqual(0);
    expect(observationIndex).toBeGreaterThan(stallIndex);
    expect(inputIndex).toBeGreaterThan(observationIndex);
    expect(prematureConfirmationGuardIndex).toBeGreaterThan(inputIndex);
    expect(detachIndex).toBeGreaterThan(prematureConfirmationGuardIndex);
    expect(debuggerFreeConfirmationGuardIndex).toBeGreaterThan(detachIndex);
    expect(postDetachObservationIndex).toBeGreaterThan(debuggerFreeConfirmationGuardIndex);
    expect(policyFloorIndex).toBeGreaterThan(postDetachObservationIndex);
    expect(policyFloorConfirmationGuardIndex).toBeGreaterThan(policyFloorIndex);
    expect(confirmationIndex).toBeGreaterThan(policyFloorConfirmationGuardIndex);
    expect(reconnectIndex).toBeGreaterThan(confirmationIndex);
    expect(replacementIndex).toBeGreaterThan(reconnectIndex);
    expect(acceptance).toContain('replacementElapsedMs');
    expect(acceptance).toContain('allDebuggerAttachmentsDetached');
    expect(acceptance).toContain('debuggerTransportReconnected');
    expect(acceptance).toContain('productConfirmationAbsentThroughPolicyFloor');
    expect(acceptance).toContain('observedForMs: FND05_UNRESPONSIVE_POST_DETACH_COMMAND_OBSERVATION_MS');
    expect(acceptance.slice(postDetachObservationIndex, policyFloorIndex)).toContain('await Promise.all([');
    expect(acceptance).toContain("AIDRAW_E2E_FND05_UNRESPONSIVE_WRAPPER !== '1'");
    expect(acceptance).toContain('assertFnd05UnresponsiveSafeReporterEnvironment()');
    expect(acceptance).toContain("testInfo.project.metadata.suite !== 'retained-fnd05-unresponsive-renderer'");
    expect(acceptance).toContain('stopOwner(owner, configured.profile, secrets)');
    expect(source).toContain("signalOwner(profile, '--quit-engine')");
    expect(acceptance).toContain('inspectFnd05EncryptedToken(encryptedCredential, ownerConnection.token)');
    expect(acceptance).not.toContain('Page.crash');
    expect(acceptance).not.toContain('injectRendererRecoveryTestEvent');
    expect(acceptance).not.toContain('renderer-recovery:test-event');
    expect(acceptance).not.toContain("session.send('Browser.close'");
    expect(acceptance).not.toContain('Target.detachFromTarget');
    expect(acceptance).not.toMatch(/\._(?:channel|connection|transport)\b/);
    expect(acceptance).not.toMatch(/\.kill\s*\(/);
    expect(acceptance).not.toMatch(/\brm\s*\(/);
    expect(mainSource).not.toContain('FND05_UNRESPONSIVE_STALL_EXPRESSION');
    expect(mainSource).not.toContain('FND05_UNRESPONSIVE_INPUT_EVENT');
    expect(preloadSource).not.toContain('FND05_UNRESPONSIVE_STALL_EXPRESSION');
    expect(preloadSource).not.toContain('FND05_UNRESPONSIVE_INPUT_EVENT');
    expect(`${rendererAppSource}\n${rendererShortcutSource}`).not.toContain('F24');
    expect(electronTypes).toContain("on(event: 'unresponsive', listener: () => void): this;");
    expect(electronTypes).toContain("on(event: 'responsive', listener: () => void): this;");
    expect(JSON.parse(electronPackageText)).toMatchObject({ version: '43.4.0' });

    expect(wrapper).toContain('process.umask(0o077)');
    expect(wrapper).toContain('inspectPackagedSecurity');
    expect(wrapper).toContain("mode: 0o700");
    expect(wrapper).toContain("'--config=playwright.fnd05-unresponsive.config.ts'");
    expect(wrapper).toContain('assertFnd05UnresponsiveSafeReporterEnvironment()');
    expect(wrapper).not.toMatch(/\.kill\s*\(/);
    expect(wrapper).not.toMatch(/\brm\s*\(/);
    expect(config).toContain("reporter: [['list']]");
    expect(config).toContain("trace: 'off'");
    expect(config).toContain("screenshot: 'off'");
    expect(config).toContain("video: 'off'");
    expect(config).toContain("AIDRAW_E2E_FND05_UNRESPONSIVE_WRAPPER !== '1'");
    expect(config).not.toContain("['html'");
    expect(playwrightArtifacts).toMatch(/if \(process\.env\.PLAYWRIGHT_NO_COPY_PROMPT\)\s+return;/);

    const cdpConnectStart = playwrightCore.indexOf('async _connectOverCDPInternal(progress2, endpointURL, options, onClose)');
    const cdpConnectEnd = playwrightCore.indexOf('async connectToTransport', cdpConnectStart);
    expect(cdpConnectStart).toBeGreaterThan(0);
    expect(cdpConnectEnd).toBeGreaterThan(cdpConnectStart);
    const cdpConnectImplementation = playwrightCore.slice(cdpConnectStart, cdpConnectEnd);
    expect(cdpConnectImplementation).toContain('const closeAndWait = async () => await chromeTransport.closeAndWait()');
    expect(cdpConnectImplementation).toContain('const browserProcess = { close: doClose, kill: doClose }');
    expect(cdpConnectImplementation).not.toContain('method: "Browser.close"');
    expect(playwrightCore).toContain('Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }');
    expect(playwrightCore).toContain('attemptToGracefullyCloseBrowser(transport)');
    expect(playwrightCore).toContain('const message = { method: "Browser.close"');

    const crConnectionStart = playwrightCore.indexOf('CRConnection = class extends SdkObject');
    const crSessionStart = playwrightCore.indexOf('CRSession = class _CRSession extends SdkObject', crConnectionStart);
    const cdpSessionStart = playwrightCore.indexOf('CDPSession = class _CDPSession extends SdkObject', crSessionStart);
    const crConnectionImplementation = playwrightCore.slice(crConnectionStart, crSessionStart);
    const crSessionImplementation = playwrightCore.slice(crSessionStart, cdpSessionStart);
    const cdpSessionImplementation = playwrightCore.slice(cdpSessionStart, playwrightCore.indexOf('// packages/playwright-core/src/server/chromium/crCoverage.ts', cdpSessionStart));
    expect(crConnectionImplementation).toContain('this.rootSession.dispose()');
    expect(crConnectionImplementation).not.toContain('this._sessions.values()');
    expect(crSessionImplementation).toContain('this._callbacks.set(id');
    expect(crSessionImplementation).toContain('this._rejectPendingCallbacks(`Internal server error, session closed.`)');
    expect(cdpSessionImplementation).toContain('parentSession.createChildSession(sessionId');
    expect(cdpSessionImplementation).toContain('return await this._session.send(method, params2)');
    expect(playwrightCore).toContain('return { result: await this._object.send(progress2, params2.method, params2.params) }');
    expect(playwrightCore).toContain('const result2 = await this._channel.send({ method, params: params2 }, kNoTimeout)');
  });

  it('discovers exactly the dedicated alive-hang selector through real Playwright without creating run roots', async () => {
    const workspace = process.cwd();
    const runId = 'source-list-discovery-fixture';
    const configuredEnvironment = unresponsiveEnvironment(workspace, runId);
    const packageRoot = configuredEnvironment.AIDRAW_E2E_OUT_DIR!;
    const profile = configuredEnvironment[FND05_UNRESPONSIVE_PROFILE_ENV]!;
    const failureRoot = configuredEnvironment[FND05_UNRESPONSIVE_FAILURE_ROOT_ENV]!;
    const roots = [packageRoot, profile, failureRoot];
    for (const path of roots) expect(await access(path).then(() => true, () => false), `${path} must start absent`).toBe(false);

    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      ...configuredEnvironment,
      [FND05_UNRESPONSIVE_DISCOVERY_ENV]: '1',
      PLAYWRIGHT_NO_COPY_PROMPT: '1',
    };
    delete childEnvironment.AIDRAW_E2E_FND05_UNRESPONSIVE_WRAPPER;
    delete childEnvironment.AIDRAW_E2E_LAUNCH_CONTEXT;
    for (const name of FND05_UNRESPONSIVE_UNSAFE_REPORT_ENVIRONMENTS) delete childEnvironment[name];

    const playwrightCli = resolve('node_modules', '@playwright', 'test', 'cli.js');
    const { stdout, stderr } = await execute(process.execPath, [
      playwrightCli,
      'test',
      '--config=playwright.fnd05-unresponsive.config.ts',
      '--list',
      '--grep',
      FND05_UNRESPONSIVE_PACKAGED_SCENARIO,
    ], { cwd: workspace, env: childEnvironment, maxBuffer: 4 * 1024 * 1024 });
    const listing = `${stdout}\n${stderr}`;
    expect(listing).not.toContain('First argument must use the object destructuring pattern');
    expect(listing.split(FND05_UNRESPONSIVE_PACKAGED_SCENARIO)).toHaveLength(2);
    expect(listing).toContain('Total: 1 test in 1 file');
    for (const path of roots) expect(await access(path).then(() => true, () => false), `${path} must remain absent`).toBe(false);
  });

  it('records consumed alive-hang r1/r2/r3/r4 failures and the narrow r5 PASS without widening its observation boundary', async () => {
    const [changelog, tracker, testing] = await Promise.all([
      readFile(resolve('CHANGELOG.md'), 'utf8'),
      readFile(resolve('docs/FEATURE_TRACKER.md'), 'utf8'),
      readFile(resolve('docs/TESTING.md'), 'utf8'),
    ]);
    const parsed = parseFeatureTracker(tracker);
    expect(parsed.errors).toEqual([]);
    const fnd05 = parsed.items.find((item) => item.id === 'FND-05');
    expect(fnd05).toMatchObject({ status: '🟢 Working', priority: 'P0' });
    const truth = fnd05?.truth ?? '';
    for (const claim of [
      '20260814t023118z-eab3063-r1',
      'failed before launch during Playwright callback discovery',
      '20260814t030554z-d082ab7-r2',
      '20260814t040447z-b111d9b-r3',
      '1/1 failed in 40.7 seconds',
      '20260814t051235z-6d7a896-r4',
      '1/1 failed in 7.7 seconds',
      '3,030.6915 ms',
      '5,000 ms',
      '2,000 ms',
      '65,000 ms',
      'F24',
      'DevToolsAgentHost',
      'closeAndWait',
      'pending-after-debugger-detach',
      '**10,000 ms** no-replacement floor',
      '20260814t062017z-41a3b0c-r5',
      'passed **1/1 in 31.2 seconds**',
      '3,030.199709 ms',
      '28,176.619584 ms',
      'owner/MCP PID 91335',
      'renderer PID 91345',
      'PID 91362',
      'Zero external renderer requests were directly observed only during attached intervals',
      'not directly observed',
      'Renderer-local work never submitted to the canonical engine is not promised',
    ]) expect(truth).toContain(claim);
    expect(truth).toContain('The initiating renderer-loss trigger');
    expect(truth).toContain('customer updater/restart semantics');
    expect(truth).not.toContain('alive-hang route has no PASS');
    expect(tracker).toContain('synchronized through base `f7e6d0cf836fce37763616395209ed654140bb53`');
    expect(tracker).toContain('This bounded **10-path** source/headless UX-01 correction');
    expect(tracker).toContain("clean synchronized base's non-certifying audit remains Level 3 blocked **1** / stable v1 blocked **4**");
    expect(tracker).toContain('producing **2 / 5** until ordinary review and commit');

    const changelogEntry = changelog.split(/\r?\n/u).find((line) => line.startsWith('- Prepare and execute a separate retained exact-package acceptance')) ?? '';
    expect(changelogEntry).toContain('Consumed r1 remains the immutable pre-launch Playwright callback-discovery failure');
    expect(changelogEntry).toContain('Consumed r3');
    expect(changelogEntry).toContain('Consumed r4');
    expect(changelogEntry).toContain('child `CDPSession.send` promise remained pending after detach');
    expect(changelogEntry).toContain('no exact AIDraw unresponsive-confirmation marker appeared within 35,000 ms');
    expect(changelogEntry).toContain('ShouldIgnoreUnresponsiveRenderer');
    expect(changelogEntry).toContain('public `connectOverCDP`');
    expect(changelogEntry).toContain('rather than protocol `Browser.close`');
    expect(changelogEntry).toContain('root-versus-child callback behavior');
    expect(changelogEntry).toContain('`pending-after-debugger-detach`');
    expect(changelogEntry).toContain('F24');
    expect(changelogEntry).toContain('20260814t062017z-41a3b0c-r5');
    expect(changelogEntry).toContain('passed **1/1 in 31.2 seconds**');
    expect(changelogEntry).toContain('3,030.199709 ms');
    expect(changelogEntry).toContain('28,176.619584 ms');
    expect(changelogEntry).toContain('zero external renderer requests only while Playwright was attached');
    expect(changelogEntry).toContain('detached interval was not directly observed');
    expect(changelogEntry).toContain('renderer-local work never submitted to the canonical engine');
    expect(changelogEntry).not.toContain('no fresh native recovery PASS');
    expect(changelog).not.toContain('native packaged alive-hang recovery');
    expect(changelog).toContain('The separate immutable r5 result above supplies narrow macOS/arm64 current-package input-ACK-hang acceptance');
    expect(changelog).not.toContain('still needs native packaged acceptance');
    expect(tracker).not.toContain('still lacks native packaged acceptance');
    expect(testing).toContain('Fourteen exact-checkpoint cases');
    expect(testing).toContain('### FND-05 alive-but-unresponsive controller, consumed r1/r2/r3/r4 failures, and narrow r5 PASS');
    expect(testing).toContain('exited 1 before any application/helper launch, stall, or product assertion');
    expect(testing).toContain('object-destructures the built-in `browserName` fixture');
    expect(testing).toContain('spawns the pinned local Playwright CLI');
    expect(testing).toContain('These are naming templates, not reserved or runnable identities');
    expect(testing).toContain('R1/r2/r3/r4/r5 remain immutable and non-reusable');
    expect(testing).toContain('Chromium **150.0.7871.224**');
    expect(testing).toContain('`ShouldIgnoreUnresponsiveRenderer()`');
    expect(testing).toContain('one-shot in-flight input-event ACK timer');
    expect(testing).toContain('public `browser.close()` is wired to the WebSocket transport');
    expect(testing).toContain('calls only `rootSession.dispose()`');
    expect(testing).toContain('one bounded **2,000 ms** post-detach interval');
    expect(testing).toContain('neither child promise can hang the controller');
    expect(testing).toContain('**5,000 ms** deadline');
    expect(testing).toContain('product-unresponsive-confirmation-not-observed');
    expect(testing).toContain('debugger-transport-reconnect-not-completed');
    expect(testing).toContain('passed **1/1 in 31.2 seconds** (30.9-second test body)');
    expect(testing).toContain('Owner/MCP PID 91335');
    expect(testing).toContain('3,030.199709 ms');
    expect(testing).toContain('28,176.619584 ms');
    expect(testing).toContain('e11f095ebe1a233d416b5e01f5b743a3bbd477e7e32ad1fd2e182b9a6d1033d6');
    expect(testing).toContain('zero external requests only while Playwright was attached');
    expect(testing).toContain('not a direct whole-run zero-request observation claim');
    expect(testing).toContain('R1/r2/r3/r4/r5 remain immutable and non-reusable');
    expect(testing).toContain('Renderer-local work never submitted before the confirmed hang may be lost');
    expect(testing).toContain('FND-05 stays **Working/P0**');
    expect(testing).toContain('This exact **four-path** r5 truth reconciliation');
    expect(testing).toContain('focused FND-05/tracker/RC corpus at **3 files / 29 tests**');
    expect(testing).toContain('complete safe gate passes TypeScript, full ESLint, and **193 files / 1,186 tests**');
    expect(testing).toContain('clean committed `41a3b0c` audit remains Level 3 blocked **1** / stable v1 blocked **4**');
    expect(testing).not.toContain('A future run must first independently review and synchronize this exact correction');
    expect(testing).not.toContain('native alive-hang recovery, cache repair');
  });
});
