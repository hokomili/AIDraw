import { execFile, spawn } from 'node:child_process';
import { access, chmod, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { inspectPackagedSecurity } from './packaged-security.mjs';
import { assertPackagedE2eArtifact, resolvePackagedE2eArtifact } from './packaged-e2e-runtime.mjs';
import {
  assertUx01WindowChromeSafeReporterEnvironment,
  buildUx01WindowChromeChildEnvironment,
  parseUx01WindowDriverPreflight,
  resolveUx01WindowChromeAcceptance,
  UX01_WINDOW_CHROME_SCENARIO,
} from './ux01-window-chrome-acceptance.mjs';

const execute = promisify(execFile);

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`UX-01 window-chrome acceptance requires pinned Node 24.x; received ${process.version}.`);
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`UX-01 window-chrome acceptance is prepared only for macOS/arm64; received ${process.platform}/${process.arch}.`);
}
if (process.argv.length !== 2) {
  throw new Error('The UX-01 window-chrome acceptance wrapper accepts no command-line overrides.');
}
assertUx01WindowChromeSafeReporterEnvironment();
const configured = resolveUx01WindowChromeAcceptance();
const childEnvironment = buildUx01WindowChromeChildEnvironment();
if (await access(configured.profile).then(() => true, () => false)) {
  throw new Error('The UX-01 window-chrome profile already exists and must remain immutable.');
}
if (await access(configured.failureRoot).then(() => true, () => false)) {
  throw new Error('The UX-01 window-chrome failure-output root already exists and must remain immutable.');
}

const artifact = assertPackagedE2eArtifact(resolvePackagedE2eArtifact());
if (artifact.outRoot !== configured.packageRoot) {
  throw new Error('The UX-01 window-chrome package subject does not match its correlated prepared-package root.');
}
await inspectPackagedSecurity({ executable: artifact.executable, archive: artifact.asar });

process.umask(0o077);
await mkdir(configured.failureRoot, { recursive: false, mode: 0o700 });
if (((await stat(configured.failureRoot)).mode & 0o777) !== 0o700) {
  throw new Error('The UX-01 window-chrome acceptance could not establish a user-only failure-output root.');
}

async function waitForExit(child, label) {
  return new Promise((resolveExit, reject) => {
    child.once('error', (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (signal || code !== 0) reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit ${String(code)}`}.`));
      else resolveExit();
    });
  });
}

const compiler = spawn('/usr/bin/xcrun', [
  'clang',
  '-fobjc-arc',
  '-fblocks',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-O2',
  '-framework',
  'AppKit',
  '-framework',
  'ApplicationServices',
  configured.driverSource,
  '-o',
  configured.driverExecutable,
], { env: childEnvironment, stdio: 'inherit', windowsHide: false, shell: false });
await waitForExit(compiler, 'The exact UX-01 macOS window driver compilation');
await chmod(configured.driverExecutable, 0o700);
const driverMetadata = await stat(configured.driverExecutable);
if (!driverMetadata.isFile() || (driverMetadata.mode & 0o777) !== 0o700) {
  throw new Error('The UX-01 macOS window driver is not one private executable file.');
}

let rawPreflight;
try {
  const { stdout } = await execute(configured.driverExecutable, ['preflight'], {
    env: childEnvironment,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  rawPreflight = JSON.parse(stdout);
} catch {
  throw new Error('The UX-01 macOS window driver could not complete its no-prompt event-posting preflight.');
}
const preflight = parseUx01WindowDriverPreflight(rawPreflight);
if (!preflight.postEventAccess) {
  throw new Error('CoreGraphics event-posting access is not pre-authorized; the exact package and profile were not launched or created.');
}

const playwrightCli = resolve(configured.workspace, 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [
  playwrightCli,
  'test',
  '--config=playwright.ux01-window-chrome.config.ts',
  '--workers=1',
  '--grep',
  UX01_WINDOW_CHROME_SCENARIO,
], {
  env: childEnvironment,
  stdio: 'inherit',
  windowsHide: false,
  shell: false,
});

child.once('error', (error) => {
  process.stderr.write(`Could not start the UX-01 window-chrome acceptance: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`The UX-01 window-chrome acceptance ended from signal ${signal}; retained outputs require inspection.\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
