import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { API_BASE_URL_ENV_KEY, RELEASE_FLAG_ENV_KEY } from './src/config/api-origin';
import { buildManifest } from './src/config/manifest';

/**
 * The manifest is derived from the validated API base URL rather than written by hand, so the requested
 * host permission always describes the origin this build really contacts. A malformed value fails the
 * build here instead of producing an artifact that silently talks to nothing.
 *
 * `WXT_RELEASE` marks the controlled release and packaging path. It belongs to `pnpm zip` and the release
 * workflow alone and is never set by `dev`, `build`, `test`, `typecheck`, or `pnpm check`.
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  autoIcons: {
    baseIconPath: 'assets/icon.svg',
    developmentIndicator: 'overlay',
  },
  /**
   * A **function**, and the timing is the whole reason.
   *
   * WXT resolves its configuration in a fixed order: it imports this module, *then* calls `loadEnv(mode, browser)`
   * to read `.env`, `.env.local`, `.env.<mode>`, `.env.<browser>` and the mode/browser combinations, and only after
   * that resolves a functional manifest. Reading `process.env` in the module body therefore ran one step too early —
   * before any `.env` file had been applied — so an origin supplied that way produced a manifest carrying the
   * **loopback default** host permission while Vite went on to inline the real value into the worker. The artifact
   * requested permission for one host and sent every request to another, and nothing in the build said so.
   *
   * Evaluating it here reads the same `process.env` WXT has by then populated and Vite will inline from, which is
   * what makes the manifest permission and the compiled origin two views of one value rather than two independent
   * reads taken at different moments.
   *
   * `mode` and `browser` are deliberately not used: they select which files `loadEnv` reads, and by now it has read
   * them. The origin is one value for the whole build rather than something that varies per target.
   */
  manifest: () =>
    buildManifest({
      rawApiBaseUrl: process.env[API_BASE_URL_ENV_KEY],
      isRelease: process.env[RELEASE_FLAG_ENV_KEY] !== undefined,
    }),
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
