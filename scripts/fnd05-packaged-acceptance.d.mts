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
