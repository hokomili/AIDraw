import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@aidraw/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@common': resolve(__dirname, 'src/common'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      external: ['electron', '@napi-rs/canvas'],
    },
  },
});
