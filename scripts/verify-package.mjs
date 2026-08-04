import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { listPackage } from '@electron/asar';

const outDir = resolve(process.env.AIDRAW_FORGE_OUT_DIR || 'out');
const platform = process.env.AIDRAW_PACKAGE_PLATFORM || process.platform;
const architecture = process.env.AIDRAW_PACKAGE_ARCH || process.arch;
const packageDir = join(outDir, `AIDraw-${platform}-${architecture}`);
const executableCandidates = platform === 'win32'
  ? [join(packageDir, 'AIDraw.exe')]
  : platform === 'darwin'
    ? [join(packageDir, 'AIDraw.app', 'Contents', 'MacOS', 'AIDraw')]
    : [join(packageDir, 'AIDraw'), join(packageDir, 'aidraw')];
const archive = platform === 'darwin'
  ? join(packageDir, 'AIDraw.app', 'Contents', 'Resources', 'app.asar')
  : join(packageDir, 'resources', 'app.asar');

try {
  let executable;
  for (const candidate of executableCandidates) {
    if (await access(candidate).then(() => true, () => false)) { executable = candidate; break; }
  }
  if (!executable) throw new Error(`Packaged executable is missing (${executableCandidates.join(', ')}).`);
  await access(executable);
  await access(archive);
  const executableBytes = await readFile(executable);
  const executableInfo = await stat(executable);
  const archiveInfo = await stat(archive);
  if (executableInfo.size < 1_000_000 || archiveInfo.size < 1_000) throw new Error('Packaged files are unexpectedly small.');
  const archiveFiles = listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'));
  if (!archiveFiles.includes('/.vite/build/utility-worker.js')) throw new Error('Packaged raster utility worker is missing.');
  process.stdout.write(`${JSON.stringify({
    verified: true,
    node: process.version,
    platform,
    architecture,
    packageDir,
    executable,
    executableBytes: executableInfo.size,
    executableSha256: createHash('sha256').update(executableBytes).digest('hex').toUpperCase(),
    appAsarBytes: archiveInfo.size,
    rasterUtilityWorker: true,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`AIDraw package verification failed for ${packageDir}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
