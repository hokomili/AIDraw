import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@aidraw/core': resolve(__dirname, '../packages/core/src/index.ts') } },
  test: { environment: 'node', include: ['**/autonomous-draws.test.ts'] },
});
