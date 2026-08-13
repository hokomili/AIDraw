import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';
import { MakerBase } from '@electron-forge/maker-base';

const execute = promisify(execFile);
const SAFE_DMG_LEAF = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const EXECUTION_BUFFER_BYTES = 4 * 1024 * 1024;

function requireSafeLeaf(value, label) {
  if (typeof value !== 'string' || !SAFE_DMG_LEAF.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} is not a safe DMG artifact leaf.`);
  }
  return value;
}

export function planSafeDmg({ dir, makeDir, appName, configuredName }) {
  const safeAppName = requireSafeLeaf(appName, 'Application name');
  const volumeName = requireSafeLeaf(configuredName || safeAppName, 'DMG volume name');
  return {
    appPath: resolve(dir, `${safeAppName}.app`),
    outputPath: resolve(makeDir, `${volumeName}.dmg`),
    volumeName,
  };
}

export class SafeDmgMaker extends MakerBase {
  name = 'dmg';

  defaultPlatforms = ['darwin', 'mas'];

  requiredExternalBinaries = ['/usr/bin/ditto', '/usr/bin/hdiutil'];

  isSupportedOnCurrentPlatform() {
    return process.platform === 'darwin';
  }

  async make({ dir, makeDir, appName, targetPlatform }) {
    if (targetPlatform !== 'darwin' || process.platform !== 'darwin') throw new Error('The safe DMG maker requires a native macOS host.');
    const plan = planSafeDmg({ dir, makeDir, appName, configuredName: this.config?.name });
    const sourceInfo = await stat(plan.appPath);
    if (!sourceInfo.isDirectory()) throw new Error(`Packaged app is not a directory: ${plan.appPath}`);

    await this.ensureFile(plan.outputPath);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'aidraw-safe-dmg-'));
    const stagedApp = join(temporaryDirectory, `${appName}.app`);
    let primaryError;
    try {
      await execute('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', plan.appPath, stagedApp], {
        encoding: 'utf8',
        maxBuffer: EXECUTION_BUFFER_BYTES,
      });
      await symlink('/Applications', join(temporaryDirectory, 'Applications'));
      await execute('/usr/bin/hdiutil', [
        'create',
        '-volname', plan.volumeName,
        '-srcfolder', temporaryDirectory,
        '-format', 'UDZO',
        '-imagekey', 'zlib-level=9',
        '-ov',
        plan.outputPath,
      ], { encoding: 'utf8', maxBuffer: EXECUTION_BUFFER_BYTES });
      await execute('/usr/bin/hdiutil', ['verify', plan.outputPath], { encoding: 'utf8', maxBuffer: EXECUTION_BUFFER_BYTES });
      const outputInfo = await stat(plan.outputPath);
      if (!outputInfo.isFile() || outputInfo.size < 1_000_000) throw new Error('Generated DMG is missing or unexpectedly small.');
    } catch (error) {
      primaryError = error;
    }

    const cleanupError = await rm(temporaryDirectory, { recursive: true, force: true }).then(() => undefined, (error) => error);
    if (primaryError || cleanupError) {
      await rm(plan.outputPath, { force: true }).catch(() => undefined);
      throw primaryError ?? cleanupError;
    }
    return [plan.outputPath];
  }
}
