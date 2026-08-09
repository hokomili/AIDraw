export interface PortabilityViolation {
  code: string;
  path: string;
  otherPath?: string;
  message: string;
}

export interface PortabilityReport {
  cwd: string;
  node: string;
  platform: NodeJS.Platform;
  architecture: string;
  trackedCount: number;
  untrackedCount: number;
  violations: PortabilityViolation[];
}

export function inspectRepositoryPaths(paths: string[]): PortabilityViolation[];
export function inspectReleaseHost(expectedPlatform?: string, expectedArchitecture?: string, actual?: { platform: string; architecture: string }): PortabilityViolation[];
export function inspectRepository(options?: { cwd?: string; includeUntracked?: boolean; expectedPlatform?: string; expectedArchitecture?: string; actualHost?: { platform: string; architecture: string } }): Promise<PortabilityReport>;
