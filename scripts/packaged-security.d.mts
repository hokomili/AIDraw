export const PACKAGED_SECURITY_CSP: string;
export const PACKAGED_PRELOAD_CHANNELS: readonly string[];
export const PACKAGED_FUSE_EXPECTATIONS: ReadonlyArray<readonly [string, number, number]>;

export interface PackagedSecuritySources {
  mainSource: string;
  preloadSource: string;
  rendererHtml: string;
}

export function assertHardenedFuseWire(wire: Record<string | number, unknown>): Record<string, 'enabled' | 'disabled'>;
export function assertPackagedSecuritySources(sources: PackagedSecuritySources): Record<string, unknown>;
export function inspectPackagedSecurity(input: { executable: string; archive: string }): Promise<Record<string, unknown>>;
