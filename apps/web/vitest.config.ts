import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const WORKSPACE_ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': WORKSPACE_ROOT,
    },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        runScripts: 'outside-only',
      },
    },
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The verification entry reads `dist`, which ordinary tests must never do: it runs only through
    // Turbo's `test:build-output`, after a fresh build.
    exclude: ['src/test/build-output.verify.ts', '**/node_modules/**'],
  },
});
