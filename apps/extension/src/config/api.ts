import { resolveApiBaseUrl } from './api-origin';

/**
 * The API origin the application uses at runtime.
 *
 * Separate from `./api-origin` because that module must stay callable from `wxt.config.ts`, where
 * `import.meta.env` does not exist. Both read the same variable through the same validator, so the host
 * permission the manifest requests and the origin every request is built from cannot diverge.
 *
 * WXT inlines a `WXT_`-prefixed variable at build time. There is deliberately no runtime override.
 */
export const API_ORIGIN = resolveApiBaseUrl(import.meta.env.WXT_API_BASE_URL).origin;
