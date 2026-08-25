export const PACKAGE_BUILD_INPUT_MANIFEST: string;
export const PACKAGE_BUILD_INPUT_POLICY: string;
export const PACKAGE_BUILD_INPUT_PATHS: readonly string[];

export interface PackageBuildInputOptions {
  workspace?: string;
  outputDirectory: string;
  inputPaths?: string[];
}

export interface PackageBuildInputRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PackageBuildInputManifest {
  schemaVersion: 1;
  policy: string;
  inputs: string[];
  summary: {
    files: number;
    bytes: number;
    recordsBytes: number;
    recordsSha256: string;
  };
  records: PackageBuildInputRecord[];
}

export function capturePackageBuildInput(options: PackageBuildInputOptions): Promise<{
  manifestPath: string;
  manifest: PackageBuildInputManifest;
  fileSha256: string;
}>;

export function readPackageBuildInput(options: PackageBuildInputOptions): Promise<{
  manifestPath: string;
  manifest: PackageBuildInputManifest;
  fileBytes: number;
  fileSha256: string;
}>;
