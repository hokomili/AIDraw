export const UX01_WINDOW_CHROME_SCENARIO: 'UX-01-WINDOW-CHROME exact package preserves native traffic lights and drag/no-drag routing';
export const UX01_WINDOW_CHROME_PROFILE_ENV: 'AIDRAW_E2E_UX01_WINDOW_CHROME_PROFILE';
export const UX01_WINDOW_CHROME_FAILURE_ROOT_ENV: 'AIDRAW_E2E_UX01_WINDOW_CHROME_FAILURE_ROOT';
export const UX01_WINDOW_CHROME_EXE_HASH_ENV: 'AIDRAW_E2E_UX01_WINDOW_CHROME_EXE_SHA256';
export const UX01_WINDOW_CHROME_ASAR_HASH_ENV: 'AIDRAW_E2E_UX01_WINDOW_CHROME_ASAR_SHA256';
export const UX01_WINDOW_CHROME_DISCOVERY_ENV: 'AIDRAW_E2E_UX01_WINDOW_CHROME_DISCOVERY_ONLY';
export const UX01_WINDOW_CHROME_PACKAGE_PREFIX: 'ux01-window-chrome-';
export const UX01_WINDOW_CHROME_PROFILE_PREFIX: 'aidraw-e2e-ux01-window-chrome-';
export const UX01_WINDOW_CHROME_FAILURE_PREFIX: 'ux01-window-chrome-native-';
export const UX01_WINDOW_CHROME_DRIVER_FILE: 'macos-window-chrome-driver';
export const UX01_WINDOW_CHROME_UNSAFE_REPORT_ENVIRONMENTS: readonly string[];
export const UX01_WINDOW_CHROME_FILES: Readonly<{
  evidence: string;
  failure: string;
  cleanup: string;
  forbiddenNetwork: string;
  providerCredentials: string;
}>;

export interface Ux01WindowChromeAcceptance {
  workspace: string;
  preparedRoot: string;
  retainedRoot: string;
  retainedFailureRoot: string;
  packageRoot: string;
  profile: string;
  runId: string;
  failureRoot: string;
  playwrightOutput: string;
  driverSource: string;
  driverExecutable: string;
  executableSha256: string;
  asarSha256: string;
  paths: Record<keyof typeof UX01_WINDOW_CHROME_FILES, string>;
}

export interface Ux01WindowRecord {
  windowId: number;
  onScreen: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface Ux01StandardButtonMetrics {
  close: { width: number; height: number };
  minimize: { width: number; height: number; offsetX: number };
  zoom: { width: number; height: number; offsetX: number };
}

export function resolveUx01WindowChromeAcceptance(options?: { workspacePath?: string; environment?: NodeJS.ProcessEnv }): Ux01WindowChromeAcceptance;
export function assertUx01WindowChromeSafeReporterEnvironment(environment?: NodeJS.ProcessEnv): true;
export function buildUx01WindowChromeChildEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function parseUx01WindowDriverPreflight(value: unknown): {
  version: 1;
  postEventAccess: boolean;
};
export function parseUx01WindowDriverInspection(value: unknown): {
  version: 1;
  pid: number;
  postEventAccess: boolean;
  windows: Ux01WindowRecord[];
  buttonMetrics: Ux01StandardButtonMetrics;
};
export function parseUx01WindowDriverAction(value: unknown): {
  version: 1;
  action: 'click' | 'option-click' | 'drag';
  posted: true;
  pid: number;
  windowId: number;
};
export function deriveUx01TrafficLightCenters(
  metrics: Ux01StandardButtonMetrics,
  contract: { trafficLightPosition: { x: number; y: number }; trafficLightReservedWidth: number; topbarHeight: number },
): { close: { x: number; y: number }; minimize: { x: number; y: number }; zoom: { x: number; y: number } };
export function assertUx01WindowBoundsMatchRenderer(
  windowRecord: Ux01WindowRecord,
  rendererOuter: { x: number; y: number; width: number; height: number },
  tolerance?: number,
): true;
export function assertUx01WindowInsideWorkArea(
  measurement: {
    outer: { x: number; y: number; width: number; height: number };
    screen: { availLeft: number; availTop: number; availWidth: number; availHeight: number };
  },
  tolerance?: number,
): true;
