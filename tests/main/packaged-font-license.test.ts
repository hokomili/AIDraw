import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PACKAGED_FONT_LICENSE_SHA256,
  inspectPackagedFontLicense,
  packagedFontLicensePath,
} from '../../scripts/packaged-font-license.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('packaged font license', () => {
  it('ships the tracked exact OFL notice as an extra resource on every desktop layout', async () => {
    const forge = await readFile(resolve('forge.config.ts'), 'utf8');
    const verifier = await readFile(resolve('scripts/verify-package.mjs'), 'utf8');
    expect(forge).toContain("extraResource: [resolve('resources/licenses/LiberationSans-OFL-1.1.txt')]");
    expect(verifier).toContain('const packagedFontLicense = await inspectPackagedFontLicense({ packageDirectory: packageDir, platform });');
    expect(verifier).toContain('packagedFontLicense,');
    const notice = await readFile(resolve('resources/licenses/LiberationSans-OFL-1.1.txt'));
    expect(PACKAGED_FONT_LICENSE_SHA256).toBe('93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b');
    for (const platform of ['win32', 'linux', 'darwin']) {
      const packageDirectory = await mkdtemp(join(tmpdir(), `aidraw-font-license-${platform}-`)); temporaryDirectories.push(packageDirectory);
      const target = packagedFontLicensePath(packageDirectory, platform); await mkdir(dirname(target), { recursive: true }); await writeFile(target, notice);
      await expect(inspectPackagedFontLicense({ packageDirectory, platform })).resolves.toEqual({ path: target, bytes: 4_414, sha256: PACKAGED_FONT_LICENSE_SHA256 });
    }
  });

  it('rejects a missing or changed packaged notice', async () => {
    const packageDirectory = await mkdtemp(join(tmpdir(), 'aidraw-font-license-invalid-')); temporaryDirectories.push(packageDirectory);
    await expect(inspectPackagedFontLicense({ packageDirectory, platform: 'win32' })).rejects.toThrow('OFL notice is missing');
    const target = packagedFontLicensePath(packageDirectory, 'win32'); await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'changed');
    await expect(inspectPackagedFontLicense({ packageDirectory, platform: 'win32' })).rejects.toThrow('OFL notice hash is');
  });
});
