export const EXPECTED_ELECTRON_VERSION: string;
export const COMPLETE_AUDIT_COMMAND: string;
export const EXPECTED_DIRECT_DEPENDENCY_COUNTS: Readonly<DependencyCounts>;
export const EXPECTED_EXTERNAL_REGISTRY_PACKAGES: number;
export const REPOSITORY_WORKSPACE_PATHS: readonly string[];
export const REQUIRED_SECURITY_OVERRIDES: Readonly<Record<string, string>>;

export interface DependencyCounts {
  runtime: number;
  development: number;
  optional: number;
  peer: number;
  total: number;
}

export interface DependencySecurityPolicyResult {
  electron: string;
  forge: string;
  packager: string;
  extractor: string;
  manifestDependencyCounts: DependencyCounts;
  lockRootDependencyCounts: DependencyCounts;
  externalRegistryPackages: number;
  repositoryWorkspaces: string[];
  overrides: Record<string, string>;
  removedBuildPackages: string[];
}

export function inspectDependencySecurityPolicy(input: {
  packageJson: Record<string, unknown>;
  lockJson: Record<string, unknown>;
}): DependencySecurityPolicyResult;

export function assertPackagedElectronVersion(expected: string, packagedVersionText: string): string;
