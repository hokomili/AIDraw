import { statSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { assertPackagedE2eLaunchBoundary } from './scripts/packaged-e2e-boundary.mjs';
import { assertPackagedE2eArtifact, resolvePackagedE2eArtifact } from './scripts/packaged-e2e-runtime.mjs';
import {
  assertUx09TextReflowSafeReporterEnvironment,
  resolveUx09TextReflowAcceptance,
  UX09_TEXT_REFLOW_MECHANISM,
  UX09_TEXT_REFLOW_SCENARIO,
} from './scripts/ux09-text-reflow-acceptance.mjs';

const boundary = assertPackagedE2eLaunchBoundary();
const artifact = assertPackagedE2eArtifact(resolvePackagedE2eArtifact());
const configured = resolveUx09TextReflowAcceptance();
assertUx09TextReflowSafeReporterEnvironment();
if (artifact.outRoot !== configured.packageRoot) {
  throw new Error('UX-09 text-reflow Playwright configuration requires its correlated prepared package root.');
}
if (process.env.AIDRAW_E2E_UX09_TEXT_REFLOW_WRAPPER !== '1') {
  throw new Error('UX-09 text-reflow acceptance must be launched through its exact wrapper.');
}
if (process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1') {
  throw new Error('UX-09 text-reflow acceptance requires Playwright page-snapshot/error prompting to be disabled.');
}
const failureRoot = statSync(configured.failureRoot);
if (!failureRoot.isDirectory() || (failureRoot.mode & 0o777) !== 0o700) {
  throw new Error('UX-09 text-reflow acceptance requires its precreated failure-output root to have mode 0700.');
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'editor-text-reflow.spec.ts',
  outputDir: configured.playwrightOutput,
  timeout: 150_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'off', video: 'off', acceptDownloads: false },
  grep: new RegExp(UX09_TEXT_REFLOW_SCENARIO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  metadata: {
    suite: 'retained-ux09-text-reflow',
    platform: `${artifact.platform}/${artifact.arch}`,
    executable: artifact.executable,
    asar: artifact.asar,
    launchContext: boundary.launchContext,
    presentationMechanism: UX09_TEXT_REFLOW_MECHANISM,
    automaticCredentialCapableArtifacts: false,
  },
});
