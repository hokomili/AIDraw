export const PACKAGE_GENERATION_MARKER: string;
export const PACKAGE_GENERATION_POLICY: string;

export interface PackageOutputOptions {
  workspace?: string;
  outputDirectory?: string;
  environment?: Record<string, string | undefined>;
}

export interface PackageOutputContext {
  workspace: string;
  outputDirectory: string;
  relativeOutputDirectory: string;
  packageName: string;
  packageVersion: string;
}

export interface PackageGenerationRecord {
  schemaVersion: 1;
  policy: string;
  package: { name: string; version: string };
  target: { platform: string; architecture: string };
  outputDirectory: string;
}

export function resolvePackageOutputRoot(options?: PackageOutputOptions): string;
export function assertPackageOutputAvailable(options?: PackageOutputOptions): Promise<PackageOutputContext>;
export function reservePackageGeneration(options: PackageOutputOptions & {
  platform: string;
  architecture: string;
}): Promise<PackageOutputContext & { generation: PackageGenerationRecord; markerPath: string }>;
export function readPackageGeneration(options: PackageOutputOptions & {
  platform: string;
  architecture: string;
}): Promise<PackageOutputContext & { generation: PackageGenerationRecord; markerPath: string }>;
