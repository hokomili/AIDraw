export interface QaSessionManifestIdentity {
  pid: number | string;
  exe: string;
  exeSha256: string;
  profile: string;
  mcpUrl: string;
  trustedFolders?: string[];
}

export interface QaSessionConnectionIdentity {
  version?: number;
  pid: number | string;
  url: string;
  token?: string;
  activeDocumentId?: string;
  trustedFolders?: string[];
}

export interface QaSessionProcessIdentity {
  pid: number | string;
  executablePath: string;
  commandLine: string;
}

export interface ForceStopIdentityInput {
  manifest: QaSessionManifestIdentity;
  connection: QaSessionConnectionIdentity;
  currentExeSha256: string;
  processIdentity: QaSessionProcessIdentity;
  platform?: NodeJS.Platform;
}

export interface ForceStopIdentityEvidence {
  pid: number;
  mcpUrl: string;
  exeSha256: string;
  exe: string;
  profile: string;
}

export interface RedactedConnection {
  version: number;
  url: string;
  activeDocumentId?: string;
  pid: number | string;
  trustedFolders: string[];
  stoppedAt: string;
  credentialsRedacted: true;
}

export function assertForceStopIdentity(input: ForceStopIdentityInput): ForceStopIdentityEvidence;
export function buildRedactedConnection(connection: QaSessionConnectionIdentity, manifest: QaSessionManifestIdentity, stoppedAt?: string): RedactedConnection;
