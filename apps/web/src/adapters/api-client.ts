import {
  type ApiClient,
  createApiClient,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  parseApiBaseUrl,
} from '@abfall-radar/api-client';

/**
 * Wraps a `FetchLike` so every AbfallRadar request bypasses the browser HTTP cache.
 *
 * Every supplied `RequestInit` member is preserved, and `cache` is set **last**, so a caller-supplied
 * cache mode cannot override it. `no-store` stops the browser cache from answering or storing these
 * requests; it does not bypass the API's own deliberate server-side official-source cache.
 */
export const withNoStore =
  (fetchImpl: FetchLike): FetchLike =>
  (input, init) =>
    fetchImpl(input, { ...init, cache: 'no-store' });

export class WebApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebApiConfigurationError';
  }
}

export interface WebApiClientOptions {
  /** The origin resolved by `resolveBrowserOrigin`. Never repaired and never defaulted. */
  readonly origin: string;
  /** Injected in tests so no test reaches the network. */
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export const createWebApiClient = ({
  origin,
  fetch: fetchImpl = (input, init) => fetch(input, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: WebApiClientOptions): ApiClient => {
  const parsed = parseApiBaseUrl(origin);

  if (!parsed.ok) {
    throw new WebApiConfigurationError(`The resolved origin is not usable: ${parsed.rejection}.`);
  }

  return createApiClient({
    baseUrl: parsed.baseUrl.origin,
    fetch: withNoStore(fetchImpl),
    timeoutMs,
  });
};
