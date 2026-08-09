import type { OpenCodeDiscoveryPlan, OpenCodeDiscoveryPlanInput } from './opencode-discovery-safety.mjs';

export interface PreparedOpenCodeDiscoveryManifest extends OpenCodeDiscoveryPlan {
  preparedAt: string;
  clientEnvironment: Record<string, string>;
  configSummary: {
    schema: unknown;
    configured: boolean;
    urlMatches: boolean | undefined;
    authorizationState: 'missing' | 'redacted' | 'bearer' | 'invalid';
    obsoleteWrapperAbsent: boolean;
  };
  credentialStatus: 'live-in-isolated-config';
}

export function prepareIsolatedOpenCodeDiscovery(input: OpenCodeDiscoveryPlanInput, now?: Date): Promise<PreparedOpenCodeDiscoveryManifest>;
export function redactIsolatedOpenCodeDiscovery(manifestPath: string, now?: Date): Promise<{
  version: 1;
  kind: 'aidraw-opencode-installed-discovery';
  redactedAt: string;
  configPath: string;
  authorizationState: 'redacted';
  credentialStatus: 'redacted-after-graceful-stop';
}>;
export function launchIsolatedOpenCodeDiscovery(manifestPath: string, declarations: { launchContext: string; offlineBoundary: string }, now?: Date): Promise<{
  version: 1;
  kind: 'aidraw-opencode-installed-discovery';
  startedAt: string;
  pid: number;
  executable: string;
  executableBytes: number;
  executableSha256: string;
  arguments: string[];
  configRoot: string;
  userData: string;
  launchContext: 'unsandboxed-gui' | 'not-required';
  offlineBoundary: 'coordinator-enforced-offline';
  exitCode: number;
  cleanup: { credentialStatus: 'redacted-after-graceful-stop' };
}>;
