import { spawn } from 'node:child_process';
import { access, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  assertUx01SafeReporterEnvironment,
  resolveUx01PackagedAcceptance,
  UX01_PACKAGED_SCENARIO,
} from './ux01-packaged-acceptance.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`UX-01 native acceptance requires pinned Node 24.x; received ${process.version}.`);
}
if (process.argv.length !== 2) {
  throw new Error('The UX-01 native acceptance wrapper accepts no command-line overrides.');
}
assertUx01SafeReporterEnvironment();
const configured = resolveUx01PackagedAcceptance();
if (await access(configured.profile).then(() => true, () => false)) {
  throw new Error('The UX-01 native acceptance profile already exists and must remain immutable.');
}
if (await access(configured.failureRoot).then(() => true, () => false)) {
  throw new Error('The UX-01 native acceptance failure-output root already exists and must remain immutable.');
}

process.umask(0o077);
await mkdir(configured.failureRoot, { recursive: false, mode: 0o700 });
if (((await stat(configured.failureRoot)).mode & 0o777) !== 0o700) {
  throw new Error('The UX-01 native acceptance could not establish a user-only failure-output root.');
}

const playwrightCli = resolve(configured.workspace, 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [
  playwrightCli,
  'test',
  '--config=playwright.ux01.config.ts',
  '--workers=1',
  '--grep',
  UX01_PACKAGED_SCENARIO,
], {
  env: { ...process.env, PLAYWRIGHT_NO_COPY_PROMPT: '1' },
  stdio: 'inherit',
  windowsHide: process.platform === 'win32',
  shell: false,
});

child.once('error', (error) => {
  process.stderr.write(`Could not start the UX-01 native acceptance: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`The UX-01 native acceptance ended from signal ${signal}; retained outputs require inspection.\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
