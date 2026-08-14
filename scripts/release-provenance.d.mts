export interface ProvenanceFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export const RELEASE_PROVENANCE_SCHEMA_VERSION: 2;
export const REPRODUCIBILITY_REPORT_SCHEMA_VERSION: 1;

export interface ReleaseProvenance {
  schemaVersion: 2;
  capturedAt: string;
  platform: { label: string; nodePlatform: string; architecture: string };
  candidate: { version: string; commit: string };
  packageGeneration: { schemaVersion: 1; policy: string; target: { platform: string; architecture: string } };
  source: { clean: true; packageJsonSha256: string; packageLockSha256: string; lockfileVersion: number };
  runtime: { node: string; npm: string; nvmrc: string; nodeEngine: string; osRelease: string };
  toolchain: Record<string, string>;
  artifacts: ProvenanceFileRecord[];
  checksumManifest: ProvenanceFileRecord;
  licenseReports: ProvenanceFileRecord[];
}

export interface ReproducibilityDifference {
  field: string;
  left: unknown;
  right: unknown;
}

export interface ReproducibilityReport {
  schemaVersion: 1;
  comparedAt: string;
  result: 'PASS' | 'FAIL';
  platform: string | null;
  candidate: { version: string | null; commit: string | null };
  sourceIdentityEqual: boolean;
  toolchainIdentityEqual: boolean;
  artifactInventoryEqual: boolean;
  artifactCount: number;
  leftManifest?: ProvenanceFileRecord;
  rightManifest?: ProvenanceFileRecord;
  differences: ReproducibilityDifference[];
  environmentDifferences: ReproducibilityDifference[];
}

export function captureReleaseProvenance(options?: {
  cwd?: string;
  outDirectory?: string;
  outputPath?: string;
  checksumManifestName?: string;
  platformLabel?: string;
  repository?: { commit: string; status: string };
  runtime?: { nodeVersion?: string; npmVersion?: string; platform?: string; architecture?: string; osRelease?: string };
  capturedAt?: string;
  write?: boolean;
}): Promise<{ manifest: ReleaseProvenance; outputPath: string }>;

export function compareReleaseProvenance(left: unknown, right: unknown, options?: {
  comparedAt?: string;
  leftManifest?: ProvenanceFileRecord;
  rightManifest?: ProvenanceFileRecord;
}): ReproducibilityReport;
