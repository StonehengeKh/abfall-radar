/**
 * The controlled packaging entry point.
 *
 * `zip` and `zip:firefox` run this so `WXT_RELEASE` is always set for a packaging build. Packaging can
 * therefore never silently produce an artifact pointed at a development origin because an operator forgot
 * the variable: `wxt.config.ts` refuses to build unless `WXT_API_BASE_URL` is explicitly supplied and is
 * a non-loopback HTTPS origin.
 *
 * `WXT_API_BASE_URL` itself is never set here. It stays externally supplied by the release workflow,
 * because this repository must not carry a production domain.
 *
 * Run with `node scripts/release.ts`. Node 24 executes TypeScript directly, so this needs no `tsx` and no
 * `cross-env`, and setting the variable in JavaScript rather than in a shell prefix keeps the script
 * portable across shells.
 *
 * It deliberately imports **nothing** from `src/`. This file is executed by Node rather than bundled, and
 * the workspace's relative imports are extensionless because a bundler resolves them — so importing even
 * one constant from the application graph would drag `@abfall-radar/api-client` in and fail resolution
 * before the release gate could run. The variable name is therefore written literally here, and
 * `src/config/api-origin.test.ts` asserts that literal still matches `RELEASE_FLAG_ENV_KEY`.
 */
import { zip } from 'wxt';

const BROWSERS = ['chrome', 'firefox'] as const;

type Browser = (typeof BROWSERS)[number];

const isBrowser = (value: string | undefined): value is Browser =>
  value !== undefined && BROWSERS.includes(value as Browser);

const [requested = 'chrome'] = process.argv.slice(2);

if (!isBrowser(requested)) {
  throw new Error(`Unknown packaging target ${requested}. Expected one of ${BROWSERS.join(', ')}.`);
}

// Set before wxt loads its configuration, which is what the release gate reads.
process.env.WXT_RELEASE = '1';

await zip({ browser: requested });
