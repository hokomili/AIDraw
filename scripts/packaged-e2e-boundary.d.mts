export const PACKAGED_E2E_LAUNCH_CONTEXT_ENV: 'AIDRAW_E2E_LAUNCH_CONTEXT';
export const PACKAGED_E2E_UNSANDBOXED_CONTEXT: 'unsandboxed-gui';

export interface PackagedE2eLaunchBoundary {
  platform: NodeJS.Platform;
  launchContext: 'unsandboxed-gui' | 'not-required';
}

export function assertPackagedE2eLaunchBoundary(
  environment?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): PackagedE2eLaunchBoundary;
