import { statSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { assertPackagedE2eLaunchBoundary } from './scripts/packaged-e2e-boundary.mjs';
import { assertPackagedE2eArtifact, resolvePackagedE2eArtifact } from './scripts/packaged-e2e-runtime.mjs';
import {
  assertFnd05UnresponsiveSafeReporterEnvironment,
  FND05_UNRESPONSIVE_DISCOVERY_ENV,
  FND05_UNRESPONSIVE_PACKAGED_SCENARIO,
  resolveFnd05UnresponsiveAcceptance,
} from './scripts/fnd05-packaged-acceptance.mjs';

const discoveryOnly = process.env[FND05_UNRESPONSIVE_DISCOVERY_ENV] === '1';
const playwrightListRequested = process.argv.includes('--list');
if (discoveryOnly !== playwrightListRequested) {
  throw new Error(`FND-05 unresponsive-renderer launch-free discovery requires both ${FND05_UNRESPONSIVE_DISCOVERY_ENV}=1 and Playwright --list.`);
}
const boundary = discoveryOnly
  ? { platform: process.platform, launchContext: 'launch-free-discovery' }
  : assertPackagedE2eLaunchBoundary();
const resolvedArtifact = resolvePackagedE2eArtifact();
const artifact = discoveryOnly ? resolvedArtifact : assertPackagedE2eArtifact(resolvedArtifact);
const configured = resolveFnd05UnresponsiveAcceptance();
assertFnd05UnresponsiveSafeReporterEnvironment();
if (process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1'
  || (!discoveryOnly && process.env.AIDRAW_E2E_FND05_UNRESPONSIVE_WRAPPER !== '1')) {
  throw new Error('FND-05 unresponsive-renderer acceptance must run through its credential-safe wrapper.');
}
if (!discoveryOnly) {
  const failureRoot = statSync(configured.failureRoot);
  if (!failureRoot.isDirectory() || (failureRoot.mode & 0o777) !== 0o700) {
    throw new Error('FND-05 unresponsive-renderer acceptance requires its precreated failure-output root to have mode 0700.');
  }
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'stale-renderer-recovery.spec.ts',
  outputDir: configured.playwrightOutput,
  timeout: 150_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'off', video: 'off', acceptDownloads: false },
  grep: new RegExp(FND05_UNRESPONSIVE_PACKAGED_SCENARIO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  metadata: {
    suite: 'retained-fnd05-unresponsive-renderer',
    platform: `${artifact.platform}/${artifact.arch}`,
    executable: artifact.executable,
    asar: artifact.asar,
    launchContext: boundary.launchContext,
    discoveryOnly,
    automaticCredentialCapableArtifacts: false,
  },
});
