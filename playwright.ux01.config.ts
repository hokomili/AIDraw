import { statSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { assertPackagedE2eLaunchBoundary } from './scripts/packaged-e2e-boundary.mjs';
import { assertPackagedE2eArtifact, resolvePackagedE2eArtifact } from './scripts/packaged-e2e-runtime.mjs';
import {
  assertUx01SafeReporterEnvironment,
  resolveUx01PackagedAcceptance,
  UX01_PACKAGED_SCENARIO,
} from './scripts/ux01-packaged-acceptance.mjs';

const boundary = assertPackagedE2eLaunchBoundary();
const artifact = assertPackagedE2eArtifact(resolvePackagedE2eArtifact());
const configured = resolveUx01PackagedAcceptance();
assertUx01SafeReporterEnvironment();
if (process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1') {
  throw new Error('UX-01 native acceptance requires Playwright page-snapshot/error prompting to be disabled.');
}
const failureRoot = statSync(configured.failureRoot);
if (!failureRoot.isDirectory() || (failureRoot.mode & 0o777) !== 0o700) {
  throw new Error('UX-01 native acceptance requires its precreated failure-output root to have mode 0700.');
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'editor-density.spec.ts',
  outputDir: configured.playwrightOutput,
  timeout: 180_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'off', video: 'off', acceptDownloads: false },
  grep: new RegExp(UX01_PACKAGED_SCENARIO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  metadata: {
    suite: 'retained-ux01-density',
    platform: `${artifact.platform}/${artifact.arch}`,
    executable: artifact.executable,
    asar: artifact.asar,
    launchContext: boundary.launchContext,
    automaticCredentialCapableArtifacts: false,
  },
});
