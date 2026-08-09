import type { ChildProcess, SpawnOptions } from 'node:child_process';

export const PACKAGED_E2E_SUITE_ENV: 'AIDRAW_E2E_SUITE';
export const PACKAGED_E2E_RETAINED_TITLE_PATTERN: RegExp;
export const PACKAGED_E2E_SELF_CONTAINED_CASES: 27;
export const PACKAGED_E2E_RETAINED_CASES: 10;
export const PACKAGED_E2E_RETAINED_PROFILE_ENVS: readonly string[];

export interface PackagedE2eArtifact {
  workspace: string;
  outRoot: string;
  platform: NodeJS.Platform;
  arch: string;
  executable: string;
  asar: string;
}

export interface PackagedE2eArtifactOptions {
  workspacePath?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function resolvePackagedE2eArtifact(options?: PackagedE2eArtifactOptions): PackagedE2eArtifact;
export function assertPackagedE2eArtifact(artifact: PackagedE2eArtifact): PackagedE2eArtifact;

export interface PackagedE2eSelection {
  suite: 'self-contained' | 'retained' | 'all';
  configuredRetainedProfiles: string[];
  grep?: RegExp;
  grepInvert?: RegExp;
}

export function resolvePackagedE2eSelection(environment?: NodeJS.ProcessEnv, argv?: string[]): PackagedE2eSelection;
export function packagedE2eSpawnOptions(options?: SpawnOptions, platform?: NodeJS.Platform): SpawnOptions;
export function spawnPackagedE2e(executable: string, args: readonly string[], options?: SpawnOptions, platform?: NodeJS.Platform): ChildProcess;
export function assertPackagedE2eProfile(profilePath: string, workspacePath?: string): string;
export function createPackagedE2eProfile(workspacePath?: string, label?: string): Promise<string>;
export function canonicalPackagedE2ePath(path: string, platform?: NodeJS.Platform): Promise<string>;
export function packagedE2ePrimaryShortcut(key: string, platform?: NodeJS.Platform): string;
export function packagedE2ePrimaryModifier(platform?: NodeJS.Platform): 'Meta' | 'Control';

export interface PackagedE2eReadinessOptions<T> {
  child: ChildProcess;
  attempt: () => Promise<T | undefined | null | false>;
  label: string;
  stderr?: () => string;
  timeoutMs?: number;
  intervalMs?: number;
}

export function waitForPackagedE2eReady<T>(options: PackagedE2eReadinessOptions<T>): Promise<T>;
