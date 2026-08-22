export const UX09_TEXT_REFLOW_SCENARIO: 'UX-09-TEXT-REFLOW exact package keeps the 200-percent primary pixel workspace reachable';
export const UX09_TEXT_REFLOW_MECHANISM: 'Playwright trusted-renderer inline documentElement.style.fontSize = 32px after app-shell readiness';
export const UX09_TEXT_REFLOW_PROFILE_ENV: 'AIDRAW_E2E_UX09_TEXT_REFLOW_PROFILE';
export const UX09_TEXT_REFLOW_FAILURE_ROOT_ENV: 'AIDRAW_E2E_UX09_TEXT_REFLOW_FAILURE_ROOT';
export const UX09_TEXT_REFLOW_EXE_HASH_ENV: 'AIDRAW_E2E_UX09_TEXT_REFLOW_EXE_SHA256';
export const UX09_TEXT_REFLOW_ASAR_HASH_ENV: 'AIDRAW_E2E_UX09_TEXT_REFLOW_ASAR_SHA256';
export const UX09_TEXT_REFLOW_PACKAGE_PREFIX: 'ux09-text-reflow-';
export const UX09_TEXT_REFLOW_PROFILE_PREFIX: 'aidraw-e2e-ux09-text-reflow-';
export const UX09_TEXT_REFLOW_FAILURE_PREFIX: 'ux09-text-reflow-native-';
export const UX09_TEXT_REFLOW_FILES: Readonly<Record<string, string>>;
export const UX09_TEXT_REFLOW_SCREENSHOTS: readonly string[];
export const UX09_TEXT_REFLOW_UNSAFE_REPORT_ENVIRONMENTS: readonly string[];

export interface Ux09TextReflowAcceptance {
  workspace: string;
  preparedRoot: string;
  retainedRoot: string;
  retainedFailureRoot: string;
  packageRoot: string;
  generationMarker: string;
  profile: string;
  runId: string;
  failureRoot: string;
  playwrightOutput: string;
  executableSha256: string;
  asarSha256: string;
  paths: Record<string, string>;
  screenshots: string[];
}

export interface Ux09OwnedProcess {
  pid: number;
  ppid: number;
  type: string;
}

export interface Ux09ScrollableElement {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

export interface Ux09Rectangle {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Ux09LocalAxisContainment {
  viewport: Ux09Rectangle;
  scrollport: Ux09Rectangle;
  visibleScrollport: Ux09Rectangle;
  clippingAncestors: Array<{
    label: string;
    overflowX: string;
    overflowY: string;
    rect: Ux09Rectangle;
  }>;
  children: Array<{
    index: number;
    label: string;
    flexShrink: number;
    rendered: boolean;
    rect: Ux09Rectangle;
  }>;
}

export interface Ux09LocalAxisLayout {
  selector: string;
  axis: 'x' | 'y' | 'both';
  overflowX: string;
  overflowY: string;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  containment?: Ux09LocalAxisContainment;
}

export interface Ux09LocalAxisMetric {
  layoutBefore: Ux09LocalAxisLayout;
  layoutAfter: Ux09LocalAxisLayout;
  boundaryDimensions: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  originalX: number;
  originalY: number;
  maxX: number;
  maxY: number;
  startX: number;
  endX: number;
  startY: number;
  endY: number;
  restoredX: number;
  restoredY: number;
  reachedStartX: boolean;
  reachedEndX: boolean;
  reachedStartY: boolean;
  reachedEndY: boolean;
}

export function resolveUx09TextReflowAcceptance(options?: { workspacePath?: string; environment?: NodeJS.ProcessEnv }): Ux09TextReflowAcceptance;
export function assertUx09TextReflowSafeReporterEnvironment(environment?: NodeJS.ProcessEnv): true;
export function buildUx09TextReflowChildEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function parseUx09OwnedProcesses(processTable: string, profilePath: string): Ux09OwnedProcess[];
export function hasExactUx09ProcessShape(rows: Ux09OwnedProcess[], expectedOwnerPid: number): boolean;
export function exerciseUx09ScrollBoundaries(element: Ux09ScrollableElement, axis: 'x' | 'y' | 'both'): Promise<{
  originalX: number;
  originalY: number;
  boundaryDimensions: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  maxX: number;
  maxY: number;
  startX: number;
  endX: number;
  startY: number;
  endY: number;
  restoredX: number;
  restoredY: number;
  reachedStartX: boolean;
  reachedEndX: boolean;
  reachedStartY: boolean;
  reachedEndY: boolean;
}>;
export function assertUx09LocalAxisReachability(metric: Ux09LocalAxisMetric, options?: {
  requireMovement?: boolean;
  admitContainedZeroRange?: boolean;
}): {
  x: 'not-requested' | 'policy-only' | 'scrollable' | 'contained-zero-range';
  y: 'not-requested' | 'policy-only' | 'scrollable' | 'contained-zero-range';
};
export function isUx09RectContained(inner: Ux09Rectangle, outer: Ux09Rectangle, tolerance?: number): boolean;
export function isUx09ExactTextFit(value: { text: string | null; expected: string; clientWidth: number; scrollWidth: number }): boolean;
export function classifyUx09RendererRequest(value: string): { permitted: boolean; descriptor: string; reason: string };
export function writeUx09ExclusiveRecord(path: string, serialized: string): Promise<void>;
export function redactUx09FailureText(value: unknown, secrets?: string[]): string;
export function assertUx09EvidenceRedacted(serialized: string, forbiddenValues?: string[]): true;
