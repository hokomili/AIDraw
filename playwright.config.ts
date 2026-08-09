import { defineConfig } from '@playwright/test';
import { assertPackagedE2eLaunchBoundary } from './scripts/packaged-e2e-boundary.mjs';
import {
  assertPackagedE2eArtifact,
  resolvePackagedE2eArtifact,
  resolvePackagedE2eSelection,
} from './scripts/packaged-e2e-runtime.mjs';

const boundary = assertPackagedE2eLaunchBoundary();
const artifact = assertPackagedE2eArtifact(resolvePackagedE2eArtifact());
const selection = resolvePackagedE2eSelection();

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/playwright',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  grep: selection.grep,
  grepInvert: selection.grepInvert,
  metadata: {
    suite: selection.suite,
    platform: `${artifact.platform}/${artifact.arch}`,
    executable: artifact.executable,
    asar: artifact.asar,
    launchContext: boundary.launchContext,
  },
});
