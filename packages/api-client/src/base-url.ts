/**
 * Validation and normalization of a configured API base URL.
 *
 * Pure and environment-free on purpose: the browser extension's build configuration and its
 * application code both call this, so the manifest's derived host permission and the origin every
 * runtime request is built from cannot disagree.
 *
 * A rejected value is returned rather than thrown, so a caller decides whether that is a failed build,
 * a configuration error, or a message. Nothing is trimmed or repaired: a value carrying credentials, a
 * path, a query, or a fragment is a configuration mistake, and silently discarding the extra part
 * would leave the author believing it took effect.
 */

export const API_BASE_URL_REJECTIONS = [
  'malformed',
  'unsupported_scheme',
  'credentials_present',
  'path_present',
  'query_present',
  'fragment_present',
] as const;

export type ApiBaseUrlRejection = (typeof API_BASE_URL_REJECTIONS)[number];

export type ApiBaseUrlScheme = 'http' | 'https';

export interface ApiBaseUrl {
  /**
   * Scheme, host, and non-default port, with no trailing slash — the exact prefix every request URL is
   * built from. A default port is dropped, so `http://host:80` and `http://host` are one origin and a
   * cache entry cannot be keyed under two names for the same server.
   */
  readonly origin: string;
  readonly scheme: ApiBaseUrlScheme;
  readonly hostname: string;
  readonly isHttps: boolean;
  /**
   * True for a loopback host. A release build refuses one, because a development configuration that
   * shipped would leave every installation talking to the user's own machine.
   */
  readonly isLoopback: boolean;
}

export type ApiBaseUrlResult =
  | { readonly ok: true; readonly baseUrl: ApiBaseUrl }
  | { readonly ok: false; readonly rejection: ApiBaseUrlRejection };

/** `URL` reports an IPv6 host in its bracketed form, so both spellings of the IPv6 loopback appear. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);

/** The whole `127.0.0.0/8` block is loopback, not only `127.0.0.1`. */
const IPV4_LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * An IPv4-mapped IPv6 address pointing into `127.0.0.0/8`.
 *
 * `URL` normalizes every spelling of the mapped form to compressed lowercase hex, so
 * `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, and `[0:0:0:0:0:ffff:7f00:0001]` all arrive as
 * `[::ffff:7f00:1]`. Matching only the dotted spelling would let the hex one through, and a release build
 * would then ship pointed at the user's own machine. The dotted form is matched too, in case a runtime
 * declines to normalize it.
 *
 * The first mapped group carries the top two IPv4 octets, so `7f` there is `127.` — and `::ffff:808:808`
 * is `8.8.8.8`, which is correctly not matched.
 */
const IPV4_MAPPED_LOOPBACK_PATTERN =
  /^\[::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\]$/i;

/**
 * The `localhost` label, which RFC 6761 reserves for loopback along with everything under it.
 *
 * `api.localhost` resolves to loopback on every conforming resolver, so a release build pointed at one would
 * ship talking to the user's own machine exactly as `localhost` would.
 */
const LOOPBACK_SUFFIX = '.localhost';

/**
 * Hostname syntax reduced to one spelling before it is classified.
 *
 * Two things vary without changing which host is meant, and both were letting a loopback name through:
 *
 * - the **root label**. `localhost.` is a fully qualified spelling of `localhost`, and `URL` keeps that trailing
 *   dot on a DNS name — it only strips it from an IPv4 literal. So `https://localhost.` arrived as `localhost.`,
 *   matched nothing, and passed the release gate.
 * - **case**. `URL` already lowercases a hostname, but doing it here as well means this classification does not
 *   depend on that: a runtime whose parser differs still cannot get `LOCALHOST` past the gate.
 *
 * Only syntax is normalized. Nothing here resolves a name or assumes anything about what it points at.
 */
const normalizeHostname = (hostname: string): string => {
  const lowercased = hostname.toLowerCase();

  return lowercased.endsWith('.') ? lowercased.slice(0, -1) : lowercased;
};

/**
 * Whether a hostname names the local machine.
 *
 * Matched on the **label**, never as a substring: `localhost.example.com` and `mylocalhost.de` are ordinary public
 * names that merely contain the text, and refusing them would block real deployments on the strength of a
 * coincidence. Only the exact name and things genuinely under it count.
 */
const isLoopbackHostname = (hostname: string): boolean => {
  const name = normalizeHostname(hostname);

  return (
    LOOPBACK_HOSTNAMES.has(name) ||
    name.endsWith(LOOPBACK_SUFFIX) ||
    IPV4_LOOPBACK_PATTERN.test(name) ||
    IPV4_MAPPED_LOOPBACK_PATTERN.test(name)
  );
};

const asSupportedScheme = (protocol: string): ApiBaseUrlScheme | undefined => {
  if (protocol === 'https:') {
    return 'https';
  }

  return protocol === 'http:' ? 'http' : undefined;
};

const reject = (rejection: ApiBaseUrlRejection): ApiBaseUrlResult => ({ ok: false, rejection });

/**
 * Inspects the **raw** string, before `URL` can normalize the evidence away.
 *
 * `URL` resolves and collapses a path: `https://host/path/..` and `https://host/.` both arrive with a
 * pathname of exactly `/`, and `https://host?` and `https://host#` arrive with an empty search and hash.
 * Every one of those carries syntax an origin may not have, and checking the parsed object alone accepted
 * all four — so an author who wrote a path in the configuration would have been told nothing while the path
 * was silently discarded, which is the specific failure this validator exists to prevent.
 *
 * The authority runs from `://` to the first `/`, `?`, or `#`. A single trailing slash is the one accepted
 * remainder, because it carries no information; anything else is reported by what it actually is, so the
 * build error names the mistake rather than a generic malformed value.
 */
const rawSyntaxRejection = (value: string): ApiBaseUrlRejection | undefined => {
  const schemeEnd = value.indexOf('://');

  if (schemeEnd === -1) {
    return 'malformed';
  }

  const authority = value.slice(schemeEnd + '://'.length);
  const delimiter = authority.search(/[/?#]/);

  if (delimiter === -1) {
    // A bare host, optionally with a port. Credentials contain no delimiter, so `URL` still catches those.
    return undefined;
  }

  const remainder = authority.slice(delimiter);

  if (remainder === '/') {
    return undefined;
  }

  if (remainder.startsWith('?') || remainder.startsWith('/?')) {
    return 'query_present';
  }

  if (remainder.startsWith('#') || remainder.startsWith('/#')) {
    return 'fragment_present';
  }

  return 'path_present';
};

/**
 * Whether the value carries surrounding whitespace that `URL` would quietly strip.
 *
 * The WHATWG parser removes leading and trailing C0 controls and space before it looks at anything, so
 * `' https://api.example.test '` arrives as a perfectly good origin and every later check passes. That silently
 * repairs a configuration mistake, which is the one thing this validator promises not to do: a stray space in an
 * environment file would have been accepted here and reported nowhere, and the release gate would have passed on a
 * value nobody had actually written correctly.
 *
 * Matched by code point rather than by `trim()`, because the two disagree. `trim()` also removes Unicode
 * whitespace the URL parser keeps — a value ending in a non-breaking space genuinely is malformed to `URL`, and
 * refusing it here would report the wrong reason for it. This checks exactly what the parser would have removed.
 */
const hasSurroundingWhitespace = (value: string): boolean => {
  const isStripped = (code: number | undefined): boolean => code !== undefined && code <= 0x20;

  return isStripped(value.codePointAt(0)) || isStripped(value.codePointAt(value.length - 1));
};

export const parseApiBaseUrl = (value: string): ApiBaseUrlResult => {
  // Before parsing, because the parser is what erases the evidence. Reported as malformed: a value with
  // whitespace around it is not a URL, whatever it becomes once the whitespace is discarded.
  if (hasSurroundingWhitespace(value)) {
    return reject('malformed');
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return reject('malformed');
  }

  const scheme = asSupportedScheme(url.protocol);

  if (scheme === undefined) {
    return reject('unsupported_scheme');
  }

  if (url.username !== '' || url.password !== '') {
    return reject('credentials_present');
  }

  // Checked on the raw value, because normalization has already erased some of what has to be refused.
  const rawRejection = rawSyntaxRejection(value);

  if (rawRejection !== undefined) {
    return reject(rawRejection);
  }

  // Kept as well as the raw check rather than instead of it: these are what the parsed object says, and a
  // runtime whose parser differs from the one this was written against still cannot get a path through.
  if (url.pathname !== '/') {
    return reject('path_present');
  }

  if (url.search !== '') {
    return reject('query_present');
  }

  if (url.hash !== '') {
    return reject('fragment_present');
  }

  return {
    ok: true,
    baseUrl: {
      origin: url.origin,
      scheme,
      hostname: url.hostname,
      isHttps: scheme === 'https',
      isLoopback: isLoopbackHostname(url.hostname),
    },
  };
};
