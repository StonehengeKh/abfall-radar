import { type ApiBaseUrl, parseApiBaseUrl } from '@abfall-radar/api-client';

/**
 * Resolves the configured API origin and derives the one host permission the manifest requests.
 *
 * Pure and environment-free: the build configuration passes `process.env.WXT_API_BASE_URL` and the
 * application passes `import.meta.env.WXT_API_BASE_URL`, and because both go through the same validator
 * from `@abfall-radar/api-client`, the permission the manifest asks for and the origin runtime requests
 * are built from cannot disagree.
 *
 * The base URL is **build-time configuration only**. There is no user-editable API URL, no settings
 * field, and no runtime override: a user-supplied URL would make the extension a request-forgery surface
 * and would make every response impossible to attribute to a known contract.
 */

/**
 * Where `apps/api` listens by default. The loopback literal is used rather than `localhost` so no name
 * resolution can send a request to an address the API is not bound to.
 */
export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000';

/** Set only by the controlled release and packaging path. Never by development or verification. */
export const RELEASE_FLAG_ENV_KEY = 'WXT_RELEASE';

export const API_BASE_URL_ENV_KEY = 'WXT_API_BASE_URL';

export class ApiOriginConfigurationError extends Error {
  constructor(message: string) {
    super(`${API_BASE_URL_ENV_KEY} is invalid: ${message}`);
    this.name = 'ApiOriginConfigurationError';
  }
}

const REJECTION_MESSAGES = {
  malformed: 'the value is not a URL.',
  unsupported_scheme: 'only http and https can serve the API.',
  credentials_present: 'an origin must not carry credentials.',
  path_present: 'an origin must not carry a path.',
  query_present: 'an origin must not carry a query.',
  fragment_present: 'an origin must not carry a fragment.',
} as const;

/**
 * The characters the WHATWG URL parser strips from both ends before it looks at anything.
 *
 * Matched as a class rather than with `trim()`, because the two disagree: `trim()` also removes Unicode
 * whitespace the parser keeps, and a value ending in a non-breaking space genuinely is malformed to `URL` rather
 * than merely padded. This names exactly what would have been silently removed.
 */
const STRIPPED_BY_URL = '[\\u0000-\\u0020]';

const LEADING_STRIPPED = new RegExp(`^${STRIPPED_BY_URL}+`);

const TRAILING_STRIPPED = new RegExp(`${STRIPPED_BY_URL}+$`);

const ONLY_STRIPPED = new RegExp(`^${STRIPPED_BY_URL}+$`);

/**
 * Why a supplied value cannot be used as written, or `undefined` when it can.
 *
 * Its own check, ahead of `parseApiBaseUrl`, because the parser is what destroys the evidence: `URL` strips
 * surrounding whitespace, so `' https://api.example.test '` became a perfectly good origin and passed the release
 * gate. This validator promises not to trim or repair configuration, and a stray space in an environment file is
 * exactly the mistake that promise exists to surface.
 *
 * The message quotes **only the offending whitespace**, escaped so an invisible character becomes visible. That is
 * what makes the mistake findable, and it exposes nothing else: the value itself may carry credentials, and a
 * configuration error is written to a build log.
 */
const whitespaceRejection = (value: string): string | undefined => {
  if (ONLY_STRIPPED.test(value)) {
    return 'the value is only whitespace. Leave it unset to use the development default.';
  }

  const ends = [
    { where: 'leading', run: LEADING_STRIPPED.exec(value)?.[0] },
    { where: 'trailing', run: TRAILING_STRIPPED.exec(value)?.[0] },
  ].filter((end): end is { where: string; run: string } => end.run !== undefined);

  if (ends.length === 0) {
    return undefined;
  }

  const described = ends.map((end) => `${end.where} ${JSON.stringify(end.run)}`).join(' and ');

  return `the value carries ${described}. An origin is used exactly as supplied and is never trimmed.`;
};

/**
 * Validates the configured value, or falls back to the loopback default when nothing is configured.
 *
 * Throws rather than returning a result, because every caller is a build step: a malformed value must
 * fail the build instead of being trimmed into something that silently works differently.
 *
 * **Unset and supplied-but-wrong are different things.** An absent variable is a development machine that never
 * configured one, and the loopback default is the right answer. A variable that was set to whitespace is a mistake
 * someone made while trying to configure it, and answering that with the default would hide it — which is how
 * `' https://api.example.test '` used to ship. Only a genuinely absent or empty variable takes the default.
 */
export const resolveApiBaseUrl = (rawValue: string | undefined): ApiBaseUrl => {
  const isUnset = rawValue === undefined || rawValue === '';
  const value = isUnset ? DEFAULT_API_BASE_URL : rawValue;

  if (!isUnset) {
    const whitespace = whitespaceRejection(value);

    if (whitespace !== undefined) {
      throw new ApiOriginConfigurationError(whitespace);
    }
  }

  const parsed = parseApiBaseUrl(value);

  if (!parsed.ok) {
    throw new ApiOriginConfigurationError(REJECTION_MESSAGES[parsed.rejection]);
  }

  return parsed.baseUrl;
};

export class ReleaseConfigurationError extends Error {
  constructor(message: string) {
    super(`A release build cannot be produced: ${message}`);
    this.name = 'ReleaseConfigurationError';
  }
}

/**
 * The release gate.
 *
 * There is no deployed API and no production domain yet, so this milestone deliberately cannot produce a
 * shippable artifact. Shipping a development configuration by accident is what this prevents: a release
 * or packaging build requires an explicitly supplied, non-loopback HTTPS origin, and the default is not
 * good enough because every installation would then talk to the user's own machine.
 */
export const assertReleasableApiBaseUrl = (rawValue: string | undefined): void => {
  if (rawValue === undefined || rawValue === '') {
    // Unset, which is not the same as supplied-but-wrong: a whitespace value falls to `resolveApiBaseUrl`, which
    // reports the mistake rather than pretending nothing was configured.
    throw new ReleaseConfigurationError(`${API_BASE_URL_ENV_KEY} must be supplied explicitly.`);
  }

  const baseUrl = resolveApiBaseUrl(rawValue);

  if (baseUrl.isLoopback) {
    throw new ReleaseConfigurationError(
      `${API_BASE_URL_ENV_KEY} must not be a loopback origin in a release build.`,
    );
  }

  if (!baseUrl.isHttps) {
    throw new ReleaseConfigurationError(
      `${API_BASE_URL_ENV_KEY} must use https in a release build.`,
    );
  }
};

/**
 * Derives the single `host_permissions` match pattern from the validated origin.
 *
 * **A Chrome match pattern cannot express a port.** The pattern derived from `http://127.0.0.1:3000`
 * grants the host, not the port, so the granted permission is broader than the requests this extension
 * makes. The port is still enforced where it can be: every request is built from the exact configured
 * base URL by `@abfall-radar/api-client`, so no other port is ever contacted. Recording that openly
 * matters more than implying a narrower grant than Chrome can represent.
 */
export const toHostPermissionPattern = (baseUrl: ApiBaseUrl): string =>
  `${baseUrl.scheme}://${baseUrl.hostname}/*`;
