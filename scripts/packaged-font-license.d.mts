export const PACKAGED_FONT_LICENSE_FILE: string;
export const PACKAGED_FONT_LICENSE_SHA256: string;
export function packagedFontLicensePath(packageDirectory: string, platform: string): string;
export function inspectPackagedFontLicense(input: { packageDirectory: string; platform: string }): Promise<{ path: string; bytes: number; sha256: string }>;
