export const EXPECTED_ELECTRON_VERSION: string;
export const COMPLETE_AUDIT_COMMAND: string;
export const REPOSITORY_WORKSPACE_PATHS: readonly string[];
export const REQUIRED_SECURITY_OVERRIDES: Readonly<Record<string, string>>;

export interface DependencySecurityPolicyResult {
  electron: string;
  forge: string;
  packager: string;
  extractor: string;
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
