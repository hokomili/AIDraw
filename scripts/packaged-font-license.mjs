import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PACKAGED_FONT_LICENSE_FILE = 'LiberationSans-OFL-1.1.txt';
export const PACKAGED_FONT_LICENSE_SHA256 = '93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b';

export function packagedFontLicensePath(packageDirectory, platform) {
  return platform === 'darwin'
    ? join(packageDirectory, 'AIDraw.app', 'Contents', 'Resources', PACKAGED_FONT_LICENSE_FILE)
    : join(packageDirectory, 'resources', PACKAGED_FONT_LICENSE_FILE);
}

export async function inspectPackagedFontLicense({ packageDirectory, platform }) {
  const path = packagedFontLicensePath(packageDirectory, platform);
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) throw new Error(`Packaged Liberation Sans OFL notice is missing (${path}).`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== PACKAGED_FONT_LICENSE_SHA256) throw new Error(`Packaged Liberation Sans OFL notice hash is ${sha256}; expected ${PACKAGED_FONT_LICENSE_SHA256}.`);
  return { path, bytes: bytes.length, sha256 };
}
