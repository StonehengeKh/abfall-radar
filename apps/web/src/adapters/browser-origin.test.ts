// @vitest-environment node
import type { FetchLike } from '@abfall-radar/api-client';
import { describe, expect, it, vi } from 'vitest';
import {
  createWebApiClient,
  WebApiConfigurationError,
  withNoStore,
} from '@/src/adapters/api-client';
import { resolveBrowserOrigin } from '@/src/adapters/browser-origin';

/**
 * The two adapter decisions every request depends on: which origin may be addressed at all, and that
 * nothing the product sends can be answered from the browser HTTP cache.
 */

describe('resolveBrowserOrigin', () => {
  it('accepts a matching HTTP or HTTPS context and returns the normalized origin', () => {
    expect(
      resolveBrowserOrigin('https://abfall.example.test', 'https://abfall.example.test'),
    ).toEqual({ ok: true, origin: 'https://abfall.example.test' });
    expect(resolveBrowserOrigin('http://localhost:5173', 'http://localhost:5173/')).toEqual({
      ok: true,
      origin: 'http://localhost:5173',
    });
    // The default port is dropped by URL normalization, on both sides of the comparison.
    expect(
      resolveBrowserOrigin('https://abfall.example.test:443', 'https://abfall.example.test'),
    ).toEqual({ ok: true, origin: 'https://abfall.example.test' });
  });

  it('refuses an opaque global origin before parsing anything', () => {
    for (const globalOrigin of ['', 'null']) {
      expect(resolveBrowserOrigin(globalOrigin, 'https://abfall.example.test')).toEqual({
        ok: false,
        rejection: 'opaque_global_origin',
      });
    }
  });

  it('refuses a global origin that is not an absolute URL', () => {
    for (const globalOrigin of ['abfall.example.test', '/', 'https://']) {
      expect(resolveBrowserOrigin(globalOrigin, 'https://abfall.example.test').ok).toBe(false);
    }
    expect(resolveBrowserOrigin('abfall.example.test', 'https://abfall.example.test')).toEqual({
      ok: false,
      rejection: 'malformed_global_origin',
    });
  });

  it('refuses a scheme the API cannot attribute a request to', () => {
    // A `file:` document and an extension page both serialize their global origin as `null`.
    for (const globalOrigin of ['file:///app/index.html', 'chrome-extension://abcdefghijklmnop']) {
      expect(resolveBrowserOrigin(globalOrigin, globalOrigin)).toEqual({
        ok: false,
        rejection: 'malformed_global_origin',
      });
    }

    // A scheme that does have a tuple origin is still refused unless it is HTTP or HTTPS.
    for (const globalOrigin of ['ws://abfall.example.test', 'ftp://abfall.example.test']) {
      expect(resolveBrowserOrigin(globalOrigin, globalOrigin)).toEqual({
        ok: false,
        rejection: 'unsupported_scheme',
      });
    }
  });

  it('refuses a location that disagrees with the global origin', () => {
    expect(
      resolveBrowserOrigin('https://abfall.example.test', 'https://other.example.test'),
    ).toEqual({
      ok: false,
      rejection: 'origin_mismatch',
    });
    expect(resolveBrowserOrigin('https://abfall.example.test', 'not-a-url')).toEqual({
      ok: false,
      rejection: 'origin_mismatch',
    });
  });

  it('constructs no client for an origin the resolver would reject', () => {
    expect(() => createWebApiClient({ origin: 'not-an-origin' })).toThrow(WebApiConfigurationError);
  });
});

describe('withNoStore', () => {
  it('preserves every supplied member and sets the cache mode last', async () => {
    const inner = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const controller = new AbortController();
    const wrapped = withNoStore(inner);

    await wrapped('https://abfall.example.test/api/v1/providers', {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      // A caller-supplied mode must not win: the product never reads an API answer from the HTTP cache.
      cache: 'force-cache',
    });

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]?.[1]).toEqual({
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
  });

  it('sets the cache mode even when no init is supplied', async () => {
    const inner = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));

    await withNoStore(inner)('https://abfall.example.test/api/v1/providers');

    expect(inner.mock.calls[0]?.[1]).toEqual({ cache: 'no-store' });
  });
});
