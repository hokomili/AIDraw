import { spawn } from 'node:child_process';
import { access, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  assertFnd05UnresponsiveSafeReporterEnvironment,
  FND05_UNRESPONSIVE_PACKAGED_SCENARIO,
  resolveFnd05UnresponsiveAcceptance,
} from './fnd05-packaged-acceptance.mjs';
import { inspectPackagedSecurity } from './packaged-security.mjs';
import { assertPackagedE2eArtifact, resolvePackagedE2eArtifact } from './packaged-e2e-runtime.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`FND-05 unresponsive-renderer acceptance requires pinned Node 24.x; received ${process.version}.`);
}
if (process.argv.length !== 2) {
  throw new Error('The FND-05 unresponsive-renderer acceptance wrapper accepts no command-line overrides.');
}
assertFnd05UnresponsiveSafeReporterEnvironment();
const configured = resolveFnd05UnresponsiveAcceptance();
if (await access(configured.profile).then(() => true, () => false)) {
  throw new Error('The FND-05 unresponsive-renderer profile already exists and must remain immutable.');
}
if (await access(configured.failureRoot).then(() => true, () => false)) {
  throw new Error('The FND-05 unresponsive-renderer failure-output root already exists and must remain immutable.');
}

const artifact = assertPackagedE2eArtifact(resolvePackagedE2eArtifact());
if (artifact.outRoot !== configured.packageRoot) {
  throw new Error('The FND-05 unresponsive-renderer package subject does not match its correlated prepared-package root.');
}
await inspectPackagedSecurity({ executable: artifact.executable, archive: artifact.asar });

process.umask(0o077);
await mkdir(configured.failureRoot, { recursive: false, mode: 0o700 });
if (((await stat(configured.failureRoot)).mode & 0o777) !== 0o700) {
  throw new Error('The FND-05 unresponsive-renderer acceptance could not establish a user-only failure-output root.');
}

const playwrightCli = resolve(configured.workspace, 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [
  playwrightCli,
  'test',
  '--config=playwright.fnd05-unresponsive.config.ts',
  '--workers=1',
  '--grep',
  FND05_UNRESPONSIVE_PACKAGED_SCENARIO,
], {
  env: {
    ...process.env,
    AIDRAW_E2E_FND05_UNRESPONSIVE_WRAPPER: '1',
    PLAYWRIGHT_NO_COPY_PROMPT: '1',
  },
  stdio: 'inherit',
  windowsHide: process.platform === 'win32',
  shell: false,
});

child.once('error', (error) => {
  process.stderr.write(`Could not start the FND-05 unresponsive-renderer acceptance: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`The FND-05 unresponsive-renderer acceptance ended from signal ${signal}; retained outputs require inspection.\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
