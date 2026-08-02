import { z } from 'zod';

/**
 * A URL that is safe to put behind a link a person can click.
 *
 * `z.url()` accepts any parseable URL, which includes schemes that are not addresses at all. Every value
 * validated by it here ends up as an `href` on a user-visible link — the operator's landing page, shown as the
 * official source of the schedule — so accepting `javascript:` would put script execution one click away, and
 * `data:` or `blob:` would let a response render arbitrary content under the extension's own origin. `file:` and
 * `ftp:` are neither, and would simply fail in a way that reads as the extension being broken.
 *
 * React escaping does not help: it escapes *text*, and this value is an attribute whose scheme is what decides
 * what activating it does. The scheme therefore has to be decided here, at the boundary that accepts the value,
 * rather than anywhere it happens to be used.
 *
 * Credentials are refused for a different reason: a URL carrying a username and password is one this extension
 * would display in full and hand to the browser, so an official-looking link could leak a secret or point at a
 * host chosen by whoever supplied the userinfo. A public landing page has no business carrying either.
 *
 * Paths, queries and fragments are preserved untouched — the official Koblenz landing page is a deep path, and
 * normalizing it would misrepresent the address the operator published.
 */

/** The two schemes a person can safely be sent to. */
const WEB_PROTOCOLS = ['http:', 'https:'] as const;

export const isWebUrl = (value: string): boolean => {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    // Not a URL at all. `new URL` is the authority here rather than a pattern, because it is what the browser
    // will use to resolve the value if it ever reaches an `href`.
    return false;
  }

  if (!(WEB_PROTOCOLS as readonly string[]).includes(parsed.protocol)) {
    return false;
  }

  // Either half of the userinfo is enough to refuse it.
  return parsed.username === '' && parsed.password === '';
};

/**
 * The validator every externally supplied link goes through.
 *
 * Its output stays `string`, so nothing downstream changes shape and the generated-contract pinning in
 * `compatibility.ts` keeps holding.
 */
export const WebUrlSchema = z
  .string()
  .min(1)
  .refine(isWebUrl, { error: 'The URL must be an http(s) address without credentials.' });
