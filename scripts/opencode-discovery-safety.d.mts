export interface OpenCodeDiscoveryPlanInput {
  workspacePath: string;
  runRoot: string;
  aidrawExecutable: string;
  aidrawExecutableBytes: number;
  aidrawExecutableSha256: string;
  aidrawAsar: string;
  aidrawAsarBytes: number;
  aidrawAsarSha256: string;
  clientProductVersion: string;
  clientExecutable: string;
  clientExecutableBytes: number;
  clientExecutableSha256: string;
}

export interface OpenCodeDiscoveryPlan {
  version: 1;
  kind: 'aidraw-opencode-installed-discovery';
  workspacePath: string;
  runRoot: string;
  aidraw: {
    executable: string;
    executableBytes: number;
    executableSha256: string;
    asar: string;
    asarBytes: number;
    asarSha256: string;
    profile: string;
    connectionPath: string;
  };
  client: {
    id: 'opencode';
    productVersion: string;
    executable: string;
    executableBytes: number;
    executableSha256: string;
    configRoot: string;
    configPath: string;
    home: string;
    roamingAppData: string;
    localAppData: string;
    userData: string;
    temp: string;
    arguments: string[];
  };
  outputRoot: string;
  manifestPath: string;
  clientProcessPath: string;
  evidencePath: string;
  cleanupAuditPath: string;
  screenshotPath: string;
  sentinels: { forbiddenNetwork: string; providerCredentialAccess: string };
  networkBoundary: { requiresIndependentOfflineEnforcement: true; note: string };
}

export const OPENCODE_DISCOVERY_RUN_PREFIX: 'aidraw-agt14-opencode-discovery-';
export const OPENCODE_DISCOVERY_LAUNCH_CONTEXT: 'unsandboxed-gui';
export const OPENCODE_DISCOVERY_OFFLINE_BOUNDARY: 'coordinator-enforced-offline';
export function buildOpenCodeDiscoveryPlan(input: OpenCodeDiscoveryPlanInput, platform?: NodeJS.Platform): OpenCodeDiscoveryPlan;
export function assertOpenCodeDiscoveryLaunchBoundary(declarations: { launchContext?: string; offlineBoundary?: string }, platform?: NodeJS.Platform): {
  launchContext: 'unsandboxed-gui' | 'not-required';
  offlineBoundary: 'coordinator-enforced-offline';
};
export function buildOpenCodeChildEnvironment(baseEnvironment: NodeJS.ProcessEnv, plan: OpenCodeDiscoveryPlan): Record<string, string>;
export function buildOpenCodeConfig(connection: { url: string; token: string }): string;
export function inspectOpenCodeConfig(text: string, expectedUrl?: string): {
  schema: unknown;
  configured: boolean;
  urlMatches: boolean | undefined;
  authorizationState: 'missing' | 'redacted' | 'bearer' | 'invalid';
  obsoleteWrapperAbsent: boolean;
};
export function redactOpenCodeConfig(text: string): string;
