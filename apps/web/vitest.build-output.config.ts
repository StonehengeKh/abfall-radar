import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const WORKSPACE_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * The emitted-artifact verifier's own runner.
 *
 * It includes only the dist-reading entry and must be reached through Turbo, whose declared
 * `dependsOn` guarantees a fresh web build first. `runScripts: 'outside-only'` keeps parsed inline and
 * external scripts from executing, and no `resources` loader is configured, so nothing is fetched.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': WORKSPACE_ROOT,
    },
  },
  test: {
    include: ['src/test/build-output.verify.ts'],
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        runScripts: 'outside-only',
      },
    },
  },
});
