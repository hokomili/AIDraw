export const FND05_PACKAGED_SCENARIO: 'FND-05-STALE-RENDERER exact package replaces one lost renderer without replacing its engine';
export const FND05_PACKAGED_PROFILE_ENV: 'AIDRAW_E2E_FND05_STALE_RENDERER_PROFILE';
export const FND05_PACKAGED_EXE_HASH_ENV: 'AIDRAW_E2E_FND05_STALE_RENDERER_EXE_SHA256';
export const FND05_PACKAGED_ASAR_HASH_ENV: 'AIDRAW_E2E_FND05_STALE_RENDERER_ASAR_SHA256';
export const FND05_PACKAGED_PROFILE_PREFIX: 'aidraw-e2e-fnd05-stale-renderer-';
export const FND05_PACKAGED_FILES: Readonly<{
  ownerConnection: string;
  relaunchConnection: string;
  evidence: string;
  failure: string;
  cleanup: string;
  forbiddenNetwork: string;
  providerCredentials: string;
  tokenCredentials: string;
}>;

export interface Fnd05PackagedAcceptance {
  workspace: string;
  retainedRoot: string;
  profile: string;
  runId: string;
  executableSha256: string;
  asarSha256: string;
  paths: Record<keyof typeof FND05_PACKAGED_FILES, string>;
}

export function resolveFnd05PackagedAcceptance(options?: { workspacePath?: string; environment?: NodeJS.ProcessEnv }): Fnd05PackagedAcceptance;
export function parseFnd05OwnedProcesses(processTable: string, profilePath: string): Array<{ pid: number; ppid: number; type: string }>;
export function redactFnd05FailureText(value: unknown, secrets?: readonly string[]): string;
export function assertFnd05EvidenceRedacted(serialized: string, forbiddenValues?: readonly string[]): true;
export function observeFnd05DeliberatePageCrash(
  crashEvent: PromiseLike<unknown>,
  crashCommand: PromiseLike<unknown>,
): Promise<{ crashObserved: true; command: 'resolved' | 'rejected-after-crash' }>;

export const FND05_UNRESPONSIVE_PACKAGED_SCENARIO: 'FND-05-UNRESPONSIVE-RENDERER exact package replaces one persistently unresponsive renderer without replacing its engine';
export const FND05_UNRESPONSIVE_PROFILE_ENV: 'AIDRAW_E2E_FND05_UNRESPONSIVE_RENDERER_PROFILE';
export const FND05_UNRESPONSIVE_FAILURE_ROOT_ENV: 'AIDRAW_E2E_FND05_UNRESPONSIVE_RENDERER_FAILURE_ROOT';
export const FND05_UNRESPONSIVE_EXE_HASH_ENV: 'AIDRAW_E2E_FND05_UNRESPONSIVE_RENDERER_EXE_SHA256';
export const FND05_UNRESPONSIVE_ASAR_HASH_ENV: 'AIDRAW_E2E_FND05_UNRESPONSIVE_RENDERER_ASAR_SHA256';
export const FND05_UNRESPONSIVE_PACKAGE_PREFIX: 'fnd05-unresponsive-renderer-';
export const FND05_UNRESPONSIVE_PROFILE_PREFIX: 'aidraw-e2e-fnd05-unresponsive-renderer-';
export const FND05_UNRESPONSIVE_FAILURE_PREFIX: 'fnd05-unresponsive-renderer-native-';
export const FND05_UNRESPONSIVE_POLICY_GRACE_MS: 10000;
export const FND05_UNRESPONSIVE_OBSERVATION_MS: 2000;
export const FND05_UNRESPONSIVE_STALL_MS: 30000;
export const FND05_UNRESPONSIVE_STALL_EXPRESSION: string;
export const FND05_UNRESPONSIVE_UNSAFE_REPORT_ENVIRONMENTS: readonly string[];
export const FND05_UNRESPONSIVE_FILES: Readonly<{
  ownerConnection: string;
  evidence: string;
  failure: string;
  cleanup: string;
  forbiddenNetwork: string;
  providerCredentials: string;
  tokenCredentials: string;
}>;

export interface Fnd05UnresponsiveAcceptance {
  workspace: string;
  preparedRoot: string;
  retainedRoot: string;
  retainedFailureRoot: string;
  packageRoot: string;
  profile: string;
  runId: string;
  failureRoot: string;
  playwrightOutput: string;
  executableSha256: string;
  asarSha256: string;
  paths: Record<keyof typeof FND05_UNRESPONSIVE_FILES, string>;
}

export function resolveFnd05UnresponsiveAcceptance(options?: { workspacePath?: string; environment?: NodeJS.ProcessEnv }): Fnd05UnresponsiveAcceptance;
export function assertFnd05UnresponsiveSafeReporterEnvironment(environment?: NodeJS.ProcessEnv): true;
export function inspectFnd05EncryptedToken(value: unknown, liveToken: string): { version: 1; encryption: 'electron-safe-storage'; encryptedValuePresent: true };
export function assertFnd05OwnedProcessShape(
  rows: Array<{ pid: number; ppid: number; type: string }>,
  expectedOwnerPid: number,
  previousRendererPid?: number,
): { ownerPid: number; rendererPid: number };
export function classifyFnd05BoundedStallSettlement(
  settlement: { status: 'resolved' } | { status: 'rejected'; reason: unknown } | { status: 'timeout' },
  proof: {
    originalRendererAliveBeforeStall: boolean;
    originalRendererResponsiveBeforeStall: boolean;
    commandPendingDuringObservation: boolean;
    originalRendererAliveDuringObservation: boolean;
    sameOwnerMcpResponsiveDuringObservation: boolean;
    replacementCount: number;
    replacementElapsedMs: number;
  },
): {
  originalRendererAliveBeforeStall: true;
  commandPendingDuringObservation: true;
  originalRendererAliveDuringObservation: true;
  sameOwnerMcpResponsiveDuringObservation: true;
  replacementCount: 1;
  replacementElapsedMs: number;
  command: 'rejected-after-confirmed-replacement';
};
