import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('macOS packaged headless lifecycle acceptance boundary', () => {
  it('uses public exact-package, exact-PID macOS observations without a product test hook', async () => {
    const [runner, driver, main] = await Promise.all([
      readFile(resolve('scripts/run-macos-headless-lifecycle-acceptance.mjs'), 'utf8'),
      readFile(resolve('scripts/macos-window-chrome-driver.m'), 'utf8'),
      readFile(resolve('src/main/main.ts'), 'utf8'),
    ]);

    expect(runner).toContain('assertPackagedE2eArtifact(resolvePackagedE2eArtifact())');
    expect(runner).toContain('inspectPackagedSecurity');
    expect(runner).toContain("process.platform !== 'darwin' || process.arch !== 'arm64'");
    expect(runner).toContain("readMcpConnectionHandoff(connectionPath)");
    expect(runner).toContain("execute('/bin/ps', ['-axo', 'pid=,ppid=,command=']");
    expect(runner).toContain("runDriver(driver, includeOffscreen ? 'inspect' : 'inspect-visible', pid)");
    expect(runner).toContain("runDriver(driver, 'request-activation', ownerPid)");
    expect(runner).toContain("'close-window'");
    expect(runner).toContain("'--headless'");
    expect(runner).toContain("'--show'");
    expect(runner).toContain("command: argument ?? 'ordinary-open'");
    expect(runner).toContain('IDLE_OBSERVATION_MS = 5_000');
    expect(runner).toContain("'SIGINT'");
    expect(runner).toContain("'SIGTERM'");
    expect(runner).toContain('waitForNoOwnedProcesses(profile, label)');
    expect(runner).toContain('headless: false');
    expect(runner).not.toContain('AXUIElement');
    expect(runner).not.toContain('CGRequestPostEventAccess');

    expect(driver).toContain('NSApplicationActivationPolicyRegular');
    expect(driver).toContain('RequestExactApplicationActivation');
    expect(driver).toContain('VisibleWindowsForPid');
    expect(driver).toContain('CloseExactApplicationWindow');
    expect(driver).toContain('CGEventCreateKeyboardEvent');
    expect(driver).toContain('CGEventPostToPid');
    expect(driver).not.toContain('AXUIElement');
    expect(driver).not.toContain('CGRequestPostEventAccess');

    expect(main).not.toContain('AIDRAW_E2E_MACOS_HEADLESS_LIFECYCLE');
    expect(main).not.toContain('run-macos-headless-lifecycle-acceptance');
  });

  it('keeps cold headless strict while treating detach as zero visible editors and zero renderers', async () => {
    const runner = await readFile(resolve('scripts/run-macos-headless-lifecycle-acceptance.mjs'), 'utf8');
    expect(runner).toContain("'Initial headless presentation',\n    true");
    expect(runner).toContain('value.applicationReadiness.activationPolicy === 2');
    expect(runner).toContain('value.windows.length === 0');
    expect(runner).toContain("waitForProcessShape(headlessProfile, headlessOwner.ownerPid, 0, 'Initial headless engine')");
    expect(runner).toContain("waitForProcessShape(headlessProfile, headlessOwner.ownerPid, 0, 'Detached headless owner')");
    expect(runner).toContain('repeatedShowPreservedWindowAndRenderer: true');
    expect(runner).toContain('if (reopened.windowId === shown.windowId');
  });
});
