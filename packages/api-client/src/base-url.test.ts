import { describe, expect, it } from 'vitest';
import { parseApiBaseUrl } from './base-url';

const parseOk = (value: string) => {
  const result = parseApiBaseUrl(value);

  if (!result.ok) {
    throw new Error(`${value} was expected to be a usable origin, got ${result.rejection}.`);
  }

  return result.baseUrl;
};

describe('parseApiBaseUrl', () => {
  it('accepts the loopback default the extension resolves when nothing is configured', () => {
    expect(parseOk('http://127.0.0.1:3000')).toEqual({
      origin: 'http://127.0.0.1:3000',
      scheme: 'http',
      hostname: '127.0.0.1',
      isHttps: false,
      isLoopback: true,
    });
  });

  it('preserves a non-default port in the normalized origin', () => {
    // The port is load-bearing: a Chrome match pattern cannot express one, so the exact origin is what
    // keeps a request from reaching another service on the same host.
    expect(parseOk('http://127.0.0.1:3000').origin).toBe('http://127.0.0.1:3000');
    expect(parseOk('https://api.example.test:8443').origin).toBe('https://api.example.test:8443');
  });

  it('drops a default port, so one server cannot be keyed under two origins', () => {
    expect(parseOk('https://api.example.test:443').origin).toBe('https://api.example.test');
    expect(parseOk('http://api.example.test:80').origin).toBe('http://api.example.test');
  });

  it('accepts an origin with a trailing slash without discarding any path information', () => {
    expect(parseOk('https://api.example.test/').origin).toBe('https://api.example.test');
  });

  it('reports HTTPS', () => {
    expect(parseOk('https://api.example.test').isHttps).toBe(true);
    expect(parseOk('http://api.example.test').isHttps).toBe(false);
  });

  it.each([
    ['the IPv4 loopback address', 'http://127.0.0.1:3000'],
    ['another address in the loopback block', 'http://127.1.2.3:3000'],
    ['the loopback name', 'http://localhost:3000'],
    ['the IPv6 loopback', 'http://[::1]:3000'],
    /**
     * Spellings of the same name that used to pass.
     *
     * `URL` lowercases a hostname but keeps a trailing dot on a DNS name — it only strips one from an IPv4
     * literal — so the fully qualified spelling arrived as `localhost.` and matched nothing. And RFC 6761
     * reserves everything under `localhost` for loopback too, so a subdomain resolves to the local machine
     * exactly as the bare name does.
     */
    ['the fully qualified loopback name', 'https://localhost.'],
    ['the loopback name in upper case', 'https://LOCALHOST'],
    ['the fully qualified loopback name in upper case', 'https://LOCALHOST.'],
    ['a subdomain of the reserved loopback name', 'https://api.localhost'],
    ['a fully qualified subdomain of it', 'https://api.localhost.'],
    ['a mixed-case subdomain of it', 'https://API.LocalHost.'],
    ['a nested subdomain of it', 'https://a.b.localhost'],
  ])('reports %s as loopback', (_reason, value) => {
    expect(parseOk(value).isLoopback).toBe(true);
  });

  it.each([
    ['a public host', 'https://api.example.test'],
    ['a host that merely starts with the loopback digits', 'https://127.example.test'],
    ['a private address outside the loopback block', 'http://10.0.0.1:3000'],
    /**
     * Public names that merely contain the text. Matching a substring rather than the label would block real
     * deployments on the strength of a coincidence, so these are the counterweight to the cases above.
     */
    ['a public host whose first label is the loopback name', 'https://localhost.example.test'],
    ['a fully qualified public host starting with that label', 'https://localhost.example.test.'],
    ['a public host whose label merely ends with the text', 'https://mylocalhost.example.test'],
    ['a public single-label host containing the text', 'https://notlocalhost'],
  ])('does not report %s as loopback', (_reason, value) => {
    expect(parseOk(value).isLoopback).toBe(false);
  });

  it.each([
    /**
     * The WHATWG parser strips leading and trailing C0 controls and space before it looks at anything, so each of
     * these arrived as a perfectly good origin and passed every later check — silently repairing a configuration
     * mistake, which is the one thing this validator promises not to do.
     */
    ['a leading space', ' https://api.example.test', 'malformed'],
    ['a trailing space', 'https://api.example.test ', 'malformed'],
    ['spaces at both ends', ' https://api.example.test ', 'malformed'],
    ['a leading tab', '\thttps://api.example.test', 'malformed'],
    ['a trailing newline', 'https://api.example.test\n', 'malformed'],
    ['a trailing carriage return', 'https://api.example.test\r', 'malformed'],
    ['a leading NUL', '\u0000https://api.example.test', 'malformed'],
  ])('rejects %s', (_reason, value, rejection) => {
    expect(parseApiBaseUrl(value)).toEqual({ ok: false, rejection });
  });

  it('accepts a value with no surrounding whitespace, so the check is not refusing everything', () => {
    expect(parseApiBaseUrl('https://api.example.test').ok).toBe(true);
  });

  it('reports the parser\u2019s own verdict for whitespace inside the value', () => {
    // Not this check's business: internal whitespace is not something `URL` strips, so it is refused by the parser
    // for its own reasons and reported as what it is.
    expect(parseApiBaseUrl('https://api.example .test')).toEqual({
      ok: false,
      rejection: 'malformed',
    });
  });

  it.each([
    ['a value that is not a URL at all', 'not a url', 'malformed'],
    ['an empty value', '', 'malformed'],
    ['a host with no scheme', 'api.example.test', 'malformed'],
    ['a scheme that cannot serve the API', 'ftp://api.example.test', 'unsupported_scheme'],
    ['a file URL', 'file:///etc/hosts', 'unsupported_scheme'],
    ['a user name', 'https://user@api.example.test', 'credentials_present'],
    ['a user name and password', 'https://user:secret@api.example.test', 'credentials_present'],
    ['a path', 'https://api.example.test/api', 'path_present'],
    ['a deeper path', 'https://api.example.test/api/v1/', 'path_present'],
    ['a query', 'https://api.example.test?token=1', 'query_present'],
    ['a fragment', 'https://api.example.test#anchor', 'fragment_present'],
  ])('rejects %s', (_reason, value, rejection) => {
    // Rejected rather than trimmed: silently discarding the extra part would leave the author believing
    // it took effect.
    expect(parseApiBaseUrl(value)).toEqual({ ok: false, rejection });
  });

  it('is pure, so the build configuration and the application always agree', () => {
    const first = parseApiBaseUrl('https://api.example.test:8443');
    const second = parseApiBaseUrl('https://api.example.test:8443');

    expect(first).toEqual(second);
  });
});
