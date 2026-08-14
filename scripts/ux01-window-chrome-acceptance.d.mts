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
export const UX01_WINDOW_COORDINATE_SPACES: Readonly<{
  native: 'quartz-visible-window-main-display-upper-left';
  renderer: 'blink-root-window-css-pixels-from-electron-nswindow-frame';
}>;
export const UX01_WINDOW_ACTION_MAPPING_UNCERTAINTY: 2;
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
export interface Ux01WindowGeometryDiagnostics {
  coordinateModel: {
    native: typeof UX01_WINDOW_COORDINATE_SPACES.native;
    renderer: typeof UX01_WINDOW_COORDINATE_SPACES.renderer;
    sharedBasis: 'electron-43-primary-screen-top-left-at-dpr-1';
    directBoundsEquality: false;
    dynamicDecoratedFrameRelationRequired: true;
  };
  native: ReturnType<typeof parseUx01WindowDriverInspection>;
  renderer: {
    outer: { x: number; y: number; width: number; height: number };
    location?: string;
    content?: unknown;
    screen?: unknown;
    layout?: unknown;
  };
}

export function createUx01WindowGeometryDiagnostics(
  nativeInspection: ReturnType<typeof parseUx01WindowDriverInspection>,
  rendererMeasurement: Ux01WindowGeometryDiagnostics['renderer'],
): Ux01WindowGeometryDiagnostics;
export interface Ux01DecoratedFrameRelation {
  model: 'dynamic-contained-quartz-visible-frame';
  windowId: number;
  nativeBounds: { x: number; y: number; width: number; height: number };
  rendererOuter: { x: number; y: number; width: number; height: number };
  rendererContent: { width: number; height: number; devicePixelRatio: number };
  mainDisplay: { x: 0; y: 0; width: number; height: number };
  insets: { left: number; top: number; right: number; bottom: number };
  mappingUncertainty: {
    x: typeof UX01_WINDOW_ACTION_MAPPING_UNCERTAINTY;
    y: typeof UX01_WINDOW_ACTION_MAPPING_UNCERTAINTY;
    source: 'exact-driver-current-bounds-reinspection';
  };
}
export function deriveUx01DecoratedFrameRelation(
  windowRecord: Ux01WindowRecord,
  rendererMeasurement: {
    outer: { x: number; y: number; width: number; height: number };
    content: { width: number; height: number; devicePixelRatio: number };
    screen: {
      width: number;
      height: number;
      availLeft: number;
      availTop: number;
      availWidth: number;
      availHeight: number;
    };
    layout: {
      root: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number };
      body: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number };
    };
  },
): Ux01DecoratedFrameRelation;
export function mapUx01FramePointToQuartzLocal(
  relation: Ux01DecoratedFrameRelation,
  point: { x: number; y: number },
): { x: number; y: number };
export interface Ux01RendererHitTarget {
  region: 'drag' | 'no-drag';
  point: { x: number; y: number };
  safeRect: { x: number; y: number; width: number; height: number };
}
export function mapUx01RendererHitTargetToQuartzLocal(
  relation: Ux01DecoratedFrameRelation,
  target: Ux01RendererHitTarget,
): {
  region: Ux01RendererHitTarget['region'];
  point: { x: number; y: number };
  rendererPoint: { x: number; y: number };
  safeRect: Ux01RendererHitTarget['safeRect'];
  mappingUncertainty: Ux01DecoratedFrameRelation['mappingUncertainty'];
};
export function assertUx01DecoratedFrameRelationStable(
  before: Ux01DecoratedFrameRelation,
  after: Ux01DecoratedFrameRelation,
  tolerance?: number,
): { left: number; top: number; right: number; bottom: number };
export interface Ux01WindowCoordinateSamples {
  nativeBefore: Ux01WindowRecord;
  nativeAfter: Ux01WindowRecord;
  rendererBefore: { x: number; y: number; width: number; height: number };
  rendererAfter: { x: number; y: number; width: number; height: number };
}
export function assertUx01WindowStationaryWithinCoordinateSpaces(
  samples: Ux01WindowCoordinateSamples,
  tolerance?: number,
): {
  native: { x: number; y: number; width: number; height: number };
  renderer: { x: number; y: number; width: number; height: number };
};
export function assertUx01WindowMovedWithinCoordinateSpaces(
  samples: Ux01WindowCoordinateSamples & { requestedDelta: { x: number; y: number } },
  options?: { tolerance?: number; minimumDistance?: number },
): {
  native: { x: number; y: number; width: number; height: number };
  renderer: { x: number; y: number; width: number; height: number };
};
export function assertUx01WindowInsideWorkArea(
  measurement: {
    outer: { x: number; y: number; width: number; height: number };
    screen: { availLeft: number; availTop: number; availWidth: number; availHeight: number };
  },
  tolerance?: number,
): true;
