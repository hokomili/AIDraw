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
      // Paper's Node entry contains optional jsdom/canvas integration. Keeping
      // Paper external preserves its guarded `require('jsdom')` fallback;
      // bundling it would hoist an optional private jsdom import and make the
      // packaged application fail before Electron can create a window.
      external: ['electron', '@napi-rs/canvas', 'paper'],
    },
  },
});
