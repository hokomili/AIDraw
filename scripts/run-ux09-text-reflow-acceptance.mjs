import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { inspectPackagedSecurity } from './packaged-security.mjs';
import { assertPackagedE2eArtifact, resolvePackagedE2eArtifact } from './packaged-e2e-runtime.mjs';
import { readPackageGeneration } from './package-output-policy.mjs';
import {
  assertUx09TextReflowSafeReporterEnvironment,
  buildUx09TextReflowChildEnvironment,
  resolveUx09TextReflowAcceptance,
  UX09_TEXT_REFLOW_SCENARIO,
} from './ux09-text-reflow-acceptance.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`UX-09 text-reflow acceptance requires pinned Node 24.x; received ${process.version}.`);
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`UX-09 text-reflow acceptance is prepared only for macOS/arm64; received ${process.platform}/${process.arch}.`);
}
if (process.argv.length !== 2) {
  throw new Error('The UX-09 text-reflow acceptance wrapper accepts no command-line overrides.');
}
assertUx09TextReflowSafeReporterEnvironment();
const configured = resolveUx09TextReflowAcceptance();
if (await access(configured.profile).then(() => true, () => false)) {
  throw new Error('The UX-09 text-reflow profile already exists and must remain immutable.');
}
if (await access(configured.failureRoot).then(() => true, () => false)) {
  throw new Error('The UX-09 text-reflow failure-output root already exists and must remain immutable.');
}

const artifact = assertPackagedE2eArtifact(resolvePackagedE2eArtifact());
if (artifact.outRoot !== configured.packageRoot) {
  throw new Error('The UX-09 text-reflow package subject does not match its correlated prepared-package root.');
}
await readPackageGeneration({ outputDirectory: configured.packageRoot, platform: 'darwin', architecture: 'arm64' });
await inspectPackagedSecurity({ executable: artifact.executable, archive: artifact.asar });
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
if (await sha256(artifact.executable) !== configured.executableSha256 || await sha256(artifact.asar) !== configured.asarSha256) {
  throw new Error('The UX-09 text-reflow package bytes do not match the declared launcher and ASAR hashes.');
}

process.umask(0o077);
await mkdir(configured.failureRoot, { recursive: false, mode: 0o700 });
if (((await stat(configured.failureRoot)).mode & 0o777) !== 0o700) {
  throw new Error('The UX-09 text-reflow acceptance could not establish a user-only failure-output root.');
}

const playwrightCli = resolve(configured.workspace, 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [
  playwrightCli,
  'test',
  '--config=playwright.ux09-text-reflow.config.ts',
  '--workers=1',
  '--grep',
  UX09_TEXT_REFLOW_SCENARIO,
], {
  env: buildUx09TextReflowChildEnvironment(),
  stdio: 'inherit',
  windowsHide: false,
  shell: false,
});

child.once('error', (error) => {
  process.stderr.write(`Could not start the UX-09 text-reflow acceptance: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`The UX-09 text-reflow acceptance ended from signal ${signal}; retained outputs require inspection.\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
