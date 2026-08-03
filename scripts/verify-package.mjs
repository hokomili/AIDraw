import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const outDir = resolve(process.env.AIDRAW_FORGE_OUT_DIR || 'out');
const packageDir = join(outDir, 'AIDraw-win32-x64');
const executable = join(packageDir, 'AIDraw.exe');
const archive = join(packageDir, 'resources', 'app.asar');

try {
  await access(executable);
  await access(archive);
  const executableBytes = await readFile(executable);
  const executableInfo = await stat(executable);
  const archiveInfo = await stat(archive);
  if (executableInfo.size < 1_000_000 || archiveInfo.size < 1_000) throw new Error('Packaged files are unexpectedly small.');
  process.stdout.write(`${JSON.stringify({
    verified: true,
    node: process.version,
    packageDir,
    executable,
    executableBytes: executableInfo.size,
    executableSha256: createHash('sha256').update(executableBytes).digest('hex').toUpperCase(),
    appAsarBytes: archiveInfo.size,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`AIDraw package verification failed for ${packageDir}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
