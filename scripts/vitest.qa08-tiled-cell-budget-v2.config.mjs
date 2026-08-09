import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import process from 'node:process';

export default defineConfig({
  cacheDir: resolve(String(process.env.AIDRAW_QA08_CELL_BUDGET_ROOT ?? ''), 'vite-cache'),
  resolve: {
    alias: {
      '@aidraw/core': resolve(process.cwd(), 'packages/core/src/index.ts'),
      '@common': resolve(process.cwd(), 'src/common'),
      '@main': resolve(process.cwd(), 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/opt-in/qa08-tiled-cell-budget-v2.acceptance.ts'],
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 0,
    hookTimeout: 0,
  },
});
