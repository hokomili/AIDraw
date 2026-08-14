import { statSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { assertPackagedE2eLaunchBoundary } from './scripts/packaged-e2e-boundary.mjs';
import { assertPackagedE2eArtifact, resolvePackagedE2eArtifact } from './scripts/packaged-e2e-runtime.mjs';
import {
  assertUx01WindowChromeSafeReporterEnvironment,
  resolveUx01WindowChromeAcceptance,
  UX01_WINDOW_CHROME_DISCOVERY_ENV,
  UX01_WINDOW_CHROME_SCENARIO,
} from './scripts/ux01-window-chrome-acceptance.mjs';

const discoveryOnly = process.env[UX01_WINDOW_CHROME_DISCOVERY_ENV] === '1';
const playwrightListRequested = process.argv.includes('--list');
if (discoveryOnly !== playwrightListRequested) {
  throw new Error(`UX-01 window-chrome launch-free discovery requires both ${UX01_WINDOW_CHROME_DISCOVERY_ENV}=1 and Playwright --list.`);
}
const boundary = discoveryOnly
  ? { platform: process.platform, launchContext: 'launch-free-discovery' }
  : assertPackagedE2eLaunchBoundary();
const resolvedArtifact = resolvePackagedE2eArtifact();
const artifact = discoveryOnly ? resolvedArtifact : assertPackagedE2eArtifact(resolvedArtifact);
const configured = resolveUx01WindowChromeAcceptance();
assertUx01WindowChromeSafeReporterEnvironment();
if (process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1'
  || (!discoveryOnly && process.env.AIDRAW_E2E_UX01_WINDOW_CHROME_WRAPPER !== '1')) {
  throw new Error('UX-01 window-chrome acceptance must run through its credential-safe wrapper.');
}
if (!discoveryOnly) {
  const failureRoot = statSync(configured.failureRoot);
  const driver = statSync(configured.driverExecutable);
  if (!failureRoot.isDirectory() || (failureRoot.mode & 0o777) !== 0o700
    || !driver.isFile() || (driver.mode & 0o777) !== 0o700) {
    throw new Error('UX-01 window-chrome acceptance requires its private failure root and compiled driver.');
  }
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'editor-window-chrome.spec.ts',
  outputDir: configured.playwrightOutput,
  timeout: 150_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'off', video: 'off', acceptDownloads: false },
  grep: new RegExp(UX01_WINDOW_CHROME_SCENARIO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  metadata: {
    suite: 'retained-ux01-window-chrome',
    platform: `${artifact.platform}/${artifact.arch}`,
    executable: artifact.executable,
    asar: artifact.asar,
    launchContext: boundary.launchContext,
    discoveryOnly,
    automaticCredentialCapableArtifacts: false,
  },
});
