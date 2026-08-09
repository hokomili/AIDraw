import process from 'node:process';

export const PACKAGED_E2E_LAUNCH_CONTEXT_ENV = 'AIDRAW_E2E_LAUNCH_CONTEXT';
export const PACKAGED_E2E_UNSANDBOXED_CONTEXT = 'unsandboxed-gui';

export function assertPackagedE2eLaunchBoundary(environment = process.env, platform = process.platform) {
  const launchContext = String(environment[PACKAGED_E2E_LAUNCH_CONTEXT_ENV] ?? '').trim().toLowerCase();
  const requiresNativeUserSession = platform === 'win32' || platform === 'darwin';
  if (requiresNativeUserSession && launchContext !== PACKAGED_E2E_UNSANDBOXED_CONTEXT) {
    const platformName = platform === 'darwin' ? 'macOS' : 'Windows';
    const failureExamples = platform === 'darwin'
      ? 'blocked native services, process inspection, or DevTools startup'
      : '0xC0000135 / exit_code=-1073741515';
    throw new Error(
      `Refusing to launch packaged AIDraw from an unacknowledged ${platformName} execution boundary. `
      + `In Codex, rerun the entire package/Playwright command with explicit shell sandbox escalation and set ${PACKAGED_E2E_LAUNCH_CONTEXT_ENV}=${PACKAGED_E2E_UNSANDBOXED_CONTEXT} only on that escalated call. `
      + `A sandbox-child Electron failure (including ${failureExamples}) is invalid launch evidence and must not be diagnosed as a ${platformName} or AIDraw runtime defect.`,
    );
  }
  return {
    platform,
    launchContext: requiresNativeUserSession ? PACKAGED_E2E_UNSANDBOXED_CONTEXT : 'not-required',
  };
}
