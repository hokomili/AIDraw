import { defineConfig } from '@playwright/test';
import { assertPackagedE2eLaunchBoundary } from './scripts/packaged-e2e-boundary.mjs';

assertPackagedE2eLaunchBoundary();

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/playwright',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
