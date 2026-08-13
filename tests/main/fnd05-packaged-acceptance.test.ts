import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertFnd05EvidenceRedacted,
  FND05_PACKAGED_ASAR_HASH_ENV,
  FND05_PACKAGED_EXE_HASH_ENV,
  FND05_PACKAGED_FILES,
  FND05_PACKAGED_PROFILE_ENV,
  observeFnd05DeliberatePageCrash,
  parseFnd05OwnedProcesses,
  redactFnd05FailureText,
  resolveFnd05PackagedAcceptance,
} from '../../scripts/fnd05-packaged-acceptance.mjs';

const digest = 'A'.repeat(64);

function environment(profile: string): NodeJS.ProcessEnv {
  return {
    [FND05_PACKAGED_PROFILE_ENV]: profile,
    [FND05_PACKAGED_EXE_HASH_ENV]: digest,
    [FND05_PACKAGED_ASAR_HASH_ENV]: digest.toLowerCase(),
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
});
