import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { PACKAGED_E2E_SUITE_ENV } from './packaged-e2e-runtime.mjs';

const suite = String(process.argv[2] ?? '').trim().toLowerCase();
if (suite !== 'retained' && suite !== 'all') {
  throw new Error('run-packaged-e2e.mjs requires retained or all. The ordinary Playwright command already selects the self-contained suite.');
}

const playwrightCli = resolve('node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [playwrightCli, 'test', ...process.argv.slice(3)], {
  env: { ...process.env, [PACKAGED_E2E_SUITE_ENV]: suite },
  stdio: 'inherit',
  windowsHide: process.platform === 'win32',
});

child.once('error', (error) => {
  process.stderr.write(`Could not start the ${suite} packaged Playwright suite: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`The ${suite} packaged Playwright suite ended from signal ${signal}.\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
