import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

export default defineConfig({
  // Sets up the WXT auto-imports and an in-memory `browser` backed by `@webext-core/fake-browser`, so
  // storage, alarms, and messaging behave like the real extension APIs without a browser. Part of the
  // already-declared `wxt` package rather than a new test dependency.
  plugins: [WxtVitest()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
