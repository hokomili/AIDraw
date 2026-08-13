export const UX01_PACKAGED_SCENARIO: 'UX-01-DENSITY exact package preserves supported content viewports and reachable editor controls';
export const UX01_PACKAGED_PROFILE_ENV: 'AIDRAW_E2E_UX01_DENSITY_PROFILE';
export const UX01_PACKAGED_FAILURE_ROOT_ENV: 'AIDRAW_E2E_UX01_DENSITY_FAILURE_ROOT';
export const UX01_PACKAGED_EXE_HASH_ENV: 'AIDRAW_E2E_UX01_DENSITY_EXE_SHA256';
export const UX01_PACKAGED_ASAR_HASH_ENV: 'AIDRAW_E2E_UX01_DENSITY_ASAR_SHA256';
export const UX01_PACKAGED_PROFILE_PREFIX: 'aidraw-e2e-ux01-density-';
export const UX01_PACKAGED_FAILURE_PREFIX: 'ux01-density-native-';
export const UX01_UNSAFE_REPORT_ENVIRONMENTS: readonly string[];
export const UX01_PACKAGED_SCREENSHOTS: readonly string[];
export const UX01_PACKAGED_FILES: Readonly<{
  ownerConnection: string;
  evidence: string;
  failure: string;
  cleanup: string;
  forbiddenNetwork: string;
  providerCredentials: string;
  tokenCredentials: string;
}>;

export interface Ux01PackagedAcceptance {
  workspace: string;
  retainedRoot: string;
  retainedFailureRoot: string;
  profile: string;
  runId: string;
  failureRoot: string;
  playwrightOutput: string;
  executableSha256: string;
  asarSha256: string;
  paths: Record<keyof typeof UX01_PACKAGED_FILES, string>;
  screenshots: string[];
}

export function resolveUx01PackagedAcceptance(options?: { workspacePath?: string; environment?: NodeJS.ProcessEnv }): Ux01PackagedAcceptance;
export function assertUx01SafeReporterEnvironment(environment?: NodeJS.ProcessEnv): true;
export function inspectUx01EncryptedToken(value: unknown, liveToken: string): { version: 1; encryption: 'electron-safe-storage'; encryptedValuePresent: true };
export function parseUx01WindowMeasurement(value: unknown): {
  location: string;
  content: { width: number; height: number; devicePixelRatio: number };
  outer: { x: number; y: number; width: number; height: number };
  screen: { width: number; height: number; availLeft: number; availTop: number; availWidth: number; availHeight: number };
  layout: {
    root: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number };
    body: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number };
  };
};
export function assertUx01ContentSizeRequest(width: number, height: number): { width: number; height: number };
export function parseUx01OwnedProcesses(processTable: string, profilePath: string): Array<{ pid: number; ppid: number; type: string }>;
export function redactUx01FailureText(value: unknown, secrets?: readonly string[]): string;
export function assertUx01EvidenceRedacted(serialized: string, forbiddenValues?: readonly string[]): true;
