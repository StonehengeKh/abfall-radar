import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The workspace root. `@/` resolves here, matching `apps/extension`'s established convention. */
const WORKSPACE_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * The only development API target. It is build tooling, never production source: Vite consumes it in
 * the dev-server process and it does not enter the module graph a production build emits.
 */
export const DEVELOPMENT_API_TARGET = 'http://127.0.0.1:3000';

/**
 * Segment-aware, so `/api`, `/api/`, and `/api/v1/…` are proxied while `/apiary` and `/api-old` are not.
 * A plain `/api` key would match both by prefix.
 */
export const API_PROXY_CONTEXT = '^/api(?:/|$)';

export default defineConfig({
  root: WORKSPACE_ROOT,
  // Nothing is copied verbatim into the build: every shipped file is an audited module output.
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': WORKSPACE_ROOT,
    },
  },
  server: {
    proxy: {
      [API_PROXY_CONTEXT]: {
        target: DEVELOPMENT_API_TARGET,
        changeOrigin: false,
      },
    },
  },
});
