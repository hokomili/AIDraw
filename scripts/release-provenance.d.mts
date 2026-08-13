export interface ProvenanceFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ReleaseProvenance {
  schemaVersion: 1;
  capturedAt: string;
  platform: { label: string; nodePlatform: string; architecture: string };
  candidate: { version: string; commit: string };
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
