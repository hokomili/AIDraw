export interface FeatureTrackerItem {
  id: string;
  feature: string;
  status: string;
  priority: string;
  truth: string;
}

export interface ReadinessIssue {
  rank: number;
  code: string;
  message: string;
  scope: 'both' | 'stable-v1';
  trackerIds: string[];
}

export interface ReadinessReport {
  schemaVersion: 1;
  cwd: string;
  packageVersion: string;
  commit: string;
  evidencePath?: string;
  tracker: { itemCount: number; p0NotVerified: string[]; p1NotClosed: string[] };
  level3: { ready: boolean; issueCount: number };
  stableV1: { ready: boolean; issueCount: number };
  issues: ReadinessIssue[];
}

export function parseFeatureTracker(markdown: string): { items: FeatureTrackerItem[]; errors: string[] };
export function inspectReleaseReadiness(options?: {
  cwd?: string;
  trackerMarkdown?: string;
  packageJson?: { version: string };
  repository?: { commit: string; status: string };
  evidence?: unknown;
  evidencePath?: string;
}): Promise<ReadinessReport>;
