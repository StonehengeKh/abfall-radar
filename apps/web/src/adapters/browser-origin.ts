/**
 * Resolves the origin the web application may send its API requests to.
 *
 * Pure over two primitive strings so every case — including a sandboxed frame — is testable without a
 * real browsing context.
 *
 * The **serialized global origin** (`window.origin`) is authoritative for whether this context has a
 * usable tuple origin. `location.origin` alone never proves one: a sandboxed frame reports an ordinary
 * HTTPS location alongside a `"null"` global origin, and requests issued from it would be attributed to
 * an opaque origin the API cannot trust. `document.domain` is never consulted, and there is no fallback
 * to loopback or to anywhere else — a context this function cannot attribute issues no request at all.
 */

export type BrowserOriginRejection =
  | 'opaque_global_origin'
  | 'malformed_global_origin'
  | 'unsupported_scheme'
  | 'origin_mismatch';

export type BrowserOriginResult =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly rejection: BrowserOriginRejection };

const reject = (rejection: BrowserOriginRejection): BrowserOriginResult => ({
  ok: false,
  rejection,
});

/** The normalized tuple origin, or `undefined` when the value is not an absolute HTTP(S) origin. */
const tupleOrigin = (
  value: string,
): { readonly origin: string; readonly http: boolean } | undefined => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  return { origin: url.origin, http: url.protocol === 'https:' || url.protocol === 'http:' };
};

export const resolveBrowserOrigin = (
  globalOrigin: string,
  locationOrigin: string,
): BrowserOriginResult => {
  // `"null"` is how every opaque origin serializes: sandboxed frames, `data:` documents, and some
  // `file:` contexts. It is refused before anything tries to parse it as a URL.
  if (globalOrigin === '' || globalOrigin === 'null') {
    return reject('opaque_global_origin');
  }

  const global = tupleOrigin(globalOrigin);

  if (global === undefined || global.origin === 'null') {
    return reject('malformed_global_origin');
  }

  if (!global.http) {
    return reject('unsupported_scheme');
  }

  const location = tupleOrigin(locationOrigin);

  if (location === undefined || location.origin !== global.origin) {
    return reject('origin_mismatch');
  }

  return { ok: true, origin: global.origin };
};
