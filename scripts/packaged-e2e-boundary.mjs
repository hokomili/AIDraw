import process from 'node:process';

export const PACKAGED_E2E_LAUNCH_CONTEXT_ENV = 'AIDRAW_E2E_LAUNCH_CONTEXT';
export const PACKAGED_E2E_UNSANDBOXED_CONTEXT = 'unsandboxed-gui';

export function assertPackagedE2eLaunchBoundary(environment = process.env, platform = process.platform) {
  const launchContext = String(environment[PACKAGED_E2E_LAUNCH_CONTEXT_ENV] ?? '').trim().toLowerCase();
  if (platform === 'win32' && launchContext !== PACKAGED_E2E_UNSANDBOXED_CONTEXT) {
    throw new Error(
      'Refusing to launch packaged AIDraw from an unacknowledged Windows execution boundary. '
      + `In Codex, rerun the entire package/Playwright command with explicit shell sandbox escalation and set ${PACKAGED_E2E_LAUNCH_CONTEXT_ENV}=${PACKAGED_E2E_UNSANDBOXED_CONTEXT} only on that escalated call. `
      + 'A sandbox-child Electron failure (including 0xC0000135 / exit_code=-1073741515) is invalid launch evidence and must not be diagnosed as a Windows or AIDraw runtime defect.',
    );
  }
  return {
    platform,
    launchContext: platform === 'win32' ? PACKAGED_E2E_UNSANDBOXED_CONTEXT : 'not-required',
  };
}
