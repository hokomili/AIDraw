export interface SourceSubjectRecord {
  status: string;
  path: string;
}

export interface SourceSubjectManifest {
  records: SourceSubjectRecord[];
  bytes: Buffer;
}

export function parsePorcelainV1Z(output: Buffer | string): SourceSubjectRecord[];
export function buildSourceSubjectManifest(root?: string, statusOutput?: Buffer | string): Promise<SourceSubjectManifest>;
export function summarizeSourceSubjectManifest(manifest: SourceSubjectManifest): {
  version: 1;
  encoding: 'UTF-8';
  ordering: string;
  recordFormat: string;
  finalNewline: boolean;
  clean: boolean;
  entries: number;
  modified: number;
  deleted: number;
  added: number;
  other: number;
  bytes: number;
  sha256: string;
};
