import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  API_BASE_URL_ENV_KEY,
  ApiOriginConfigurationError,
  assertReleasableApiBaseUrl,
  DEFAULT_API_BASE_URL,
  RELEASE_FLAG_ENV_KEY,
  ReleaseConfigurationError,
  resolveApiBaseUrl,
  toHostPermissionPattern,
} from './api-origin';

describe('resolveApiBaseUrl', () => {
  it.each([
    /**
     * Unset, and only unset. An absent or empty variable is a development machine that never configured one, so the
     * loopback default is the right answer — a value someone *set* is treated as an attempt to configure and is
     * validated as written.
     */
    ['nothing is configured', undefined],
    ['the value is empty', ''],
  ])('resolves the loopback default when %s', (_reason, rawValue) => {
    const baseUrl = resolveApiBaseUrl(rawValue);

    expect(baseUrl.origin).toBe('http://127.0.0.1:3000');
    expect(baseUrl.origin).toBe(DEFAULT_API_BASE_URL);
    expect(baseUrl.isLoopback).toBe(true);
  });

  /**
   * A supplied value is used exactly as written or refused.
   *
   * `URL` strips leading and trailing C0 controls and space before it looks at anything, so each of these used to
   * become a perfectly good origin — silently repairing a configuration mistake, which is the one thing this
   * validator promises not to do. Whitespace-only is refused rather than treated as unset: somebody was trying to
   * configure something, and answering with the development default would hide the mistake.
   */
  describe('a supplied value carrying whitespace', () => {
    it.each([
      ['a leading space', ' https://api.example.test'],
      ['a trailing space', 'https://api.example.test '],
      ['spaces at both ends', ' https://api.example.test '],
      ['a leading tab', '\thttps://api.example.test'],
      ['a trailing tab', 'https://api.example.test\t'],
      ['a leading carriage return', '\rhttps://api.example.test'],
      ['a trailing carriage return', 'https://api.example.test\r'],
      ['a leading newline', '\nhttps://api.example.test'],
      ['a trailing newline', 'https://api.example.test\n'],
      ['a CRLF suffix', 'https://api.example.test\r\n'],
      ['only spaces', '   '],
      ['only a tab', '\t'],
    ])('is refused for %s', (_reason, rawValue) => {
      expect(() => resolveApiBaseUrl(rawValue)).toThrow(ApiOriginConfigurationError);
    });

    it('names which end carries it, with the character made visible', () => {
      // An invisible character is the whole difficulty: quoting the escaped run is what makes the mistake findable.
      expect(() => resolveApiBaseUrl('https://api.example.test\t')).toThrow(/trailing "\\t"/);
      expect(() => resolveApiBaseUrl(' https://api.example.test')).toThrow(/leading " "/);
    });

    it('names both ends when both carry it', () => {
      expect(() => resolveApiBaseUrl(' https://api.example.test ')).toThrow(
        /leading " " and trailing " "/,
      );
    });

    it('says a whitespace-only value should be left unset instead', () => {
      expect(() => resolveApiBaseUrl('   ')).toThrow(/only whitespace/);
    });

    it('never puts the configured value itself in the message', () => {
      /**
       * A configuration error goes to a build log, and the value may carry credentials. Only the offending
       * whitespace is quoted — never the origin, never the userinfo.
       */
      const thrown = (() => {
        try {
          resolveApiBaseUrl(' https://someone:hunter2@api.example.test ');

          return '';
        } catch (error) {
          return error instanceof Error ? error.message : '';
        }
      })();

      expect(thrown).toMatch(/leading " "/);
      expect(thrown).not.toContain('hunter2');
      expect(thrown).not.toContain('someone');
      expect(thrown).not.toContain('api.example.test');
    });

    it('does not normalize it into something that works', () => {
      // The failure this replaces: the value was accepted and quietly became a valid origin.
      expect(() => resolveApiBaseUrl(' https://api.example.test ')).toThrow();
      expect(resolveApiBaseUrl('https://api.example.test').origin).toBe('https://api.example.test');
    });
  });

  it('uses the loopback literal rather than a name, so resolution cannot reach another address', () => {
    // `apps/api` binds 127.0.0.1 by default. `localhost` can resolve to ::1 on some systems, where the
    // API is not listening.
    expect(DEFAULT_API_BASE_URL).toContain('127.0.0.1');
    expect(DEFAULT_API_BASE_URL).not.toContain('localhost');
  });

  it('matches the API’s own default port', () => {
    expect(DEFAULT_API_BASE_URL).toBe('http://127.0.0.1:3000');
  });

  it('resolves an explicitly configured origin', () => {
    expect(resolveApiBaseUrl('https://api.example.test').origin).toBe('https://api.example.test');
  });

  it.each([
    ['credentials', 'https://user:secret@api.example.test'],
    ['a path', 'https://api.example.test/api'],
    ['a query', 'https://api.example.test?token=1'],
    ['a fragment', 'https://api.example.test#anchor'],
    ['a malformed value', 'nonsense'],
    ['an unusable scheme', 'ftp://api.example.test'],
  ])('fails the build for a value carrying %s', (_reason, rawValue) => {
    // Failing rather than trimming: a silently discarded path would leave the author believing it took
    // effect.
    expect(() => resolveApiBaseUrl(rawValue)).toThrow(ApiOriginConfigurationError);
  });

  it('names the offending variable in the error', () => {
    expect(() => resolveApiBaseUrl('https://api.example.test/api')).toThrow(/WXT_API_BASE_URL/);
  });
});

describe('assertReleasableApiBaseUrl', () => {
  it('accepts an explicitly supplied non-loopback HTTPS origin', () => {
    expect(() => assertReleasableApiBaseUrl('https://api.example.test')).not.toThrow();
  });

  it.each([
    ['the value is unset', undefined],
    ['the value is empty', ''],
  ])('fails a release build when %s', (_reason, rawValue) => {
    // The default is not good enough for a release: every installation would talk to the user's own
    // machine.
    expect(() => assertReleasableApiBaseUrl(rawValue)).toThrow(ReleaseConfigurationError);
  });

  it.each([
    ['the loopback address', 'http://127.0.0.1:3000'],
    ['another address in the loopback block', 'https://127.1.2.3:3000'],
    ['the loopback name', 'https://localhost:3000'],
    ['the IPv6 loopback', 'https://[::1]:3000'],
    ['an IPv4-mapped IPv6 loopback address', 'https://[::ffff:7f00:1]:3000'],
    /**
     * Aliases of the same machine that used to pass the gate.
     *
     * Each names loopback as surely as `localhost` does: the trailing dot is the root label of the same name, and
     * RFC 6761 reserves everything under `localhost` for loopback too. A release built against any of them would
     * ship pointed at whatever machine happened to run it.
     */
    ['the fully qualified loopback name', 'https://localhost.'],
    ['the loopback name in upper case', 'https://LOCALHOST'],
    ['the fully qualified loopback name in upper case', 'https://LOCALHOST.'],
    ['a subdomain of the reserved loopback name', 'https://api.localhost'],
    ['a fully qualified subdomain of it', 'https://api.localhost.'],
    ['a mixed-case subdomain of it', 'https://API.LocalHost.'],
  ])('fails a release build for %s', (_reason, rawValue) => {
    expect(() => assertReleasableApiBaseUrl(rawValue)).toThrow(ReleaseConfigurationError);
  });

  it.each([
    /**
     * The release gate is where this mattered: `URL` strips surrounding whitespace, so a stray space in an
     * environment file produced a valid non-loopback HTTPS origin and shipped. Reported as an invalid
     * configuration rather than trimmed, because the build is the only place that mistake can still be fixed.
     */
    ['a leading space', ' https://api.example.test'],
    ['a trailing space', 'https://api.example.test '],
    ['spaces at both ends', ' https://api.example.test '],
    ['a trailing newline', 'https://api.example.test\n'],
  ])('fails a release build for %s', (_reason, rawValue) => {
    expect(() => assertReleasableApiBaseUrl(rawValue)).toThrow(ApiOriginConfigurationError);
  });

  it.each([
    ['a public host whose first label is the loopback name', 'https://localhost.example.test'],
    ['a public host whose label merely ends with the text', 'https://mylocalhost.example.test'],
    ['a public single-label host containing the text', 'https://notlocalhost'],
  ])('still releases against %s', (_reason, rawValue) => {
    // The counterweight: the gate matches the label, so a real deployment is not blocked by a coincidence in
    // its name.
    expect(() => assertReleasableApiBaseUrl(rawValue)).not.toThrow();
  });

  it('fails a release build for a non-HTTPS origin', () => {
    expect(() => assertReleasableApiBaseUrl('http://api.example.test')).toThrow(
      ReleaseConfigurationError,
    );
  });

  it('still rejects a malformed value on the release path', () => {
    expect(() => assertReleasableApiBaseUrl('nonsense')).toThrow(ApiOriginConfigurationError);
  });
});

describe('the packaging entry point', () => {
  const releaseScript = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/release.ts'),
    'utf8',
  );

  it('sets the same variable the release gate reads', () => {
    // The script cannot import this constant: it is executed by Node rather than bundled, and the
    // workspace's extensionless relative imports would fail to resolve — dragging in the transport client
    // and failing before the gate could run. The literal is duplicated on purpose, and this is what keeps
    // the two from drifting.
    expect(RELEASE_FLAG_ENV_KEY).toBe('WXT_RELEASE');
    expect(releaseScript).toContain(`process.env.${RELEASE_FLAG_ENV_KEY} = '1'`);
  });

  it('never supplies the base URL itself, so no production domain can be baked in', () => {
    expect(releaseScript).not.toContain(`${API_BASE_URL_ENV_KEY} =`);
    expect(releaseScript).not.toMatch(/https:\/\/(?!api\.example)/);
  });

  it('imports nothing from the bundler-resolved application graph', () => {
    // A single import from `src/` is what previously made packaging fail on module resolution instead of
    // on its configuration.
    expect(releaseScript).not.toMatch(/from\s+'\.\.\/src\//);
    expect(releaseScript).not.toMatch(/from\s+'@\//);
  });
});

describe('toHostPermissionPattern', () => {
  it.each([
    ['http://127.0.0.1:3000', 'http://127.0.0.1/*'],
    ['https://api.example.test', 'https://api.example.test/*'],
    ['https://api.example.test:8443', 'https://api.example.test/*'],
  ])('derives the pattern for %s', (rawValue, expected) => {
    expect(toHostPermissionPattern(resolveApiBaseUrl(rawValue))).toBe(expected);
  });

  it('carries no port, because a Chrome match pattern cannot express one', () => {
    // Recorded openly rather than implied away: the grant is broader than the requests the extension
    // makes, and the exact base URL in the client is what keeps those narrow.
    const pattern = toHostPermissionPattern(resolveApiBaseUrl('http://127.0.0.1:3000'));

    expect(pattern).not.toContain('3000');
    expect(pattern).toBe('http://127.0.0.1/*');
  });

  it('never produces a wildcard host', () => {
    for (const rawValue of ['http://127.0.0.1:3000', 'https://api.example.test']) {
      const pattern = toHostPermissionPattern(resolveApiBaseUrl(rawValue));

      expect(pattern).not.toContain('<all_urls>');
      expect(pattern).not.toContain('://*');
    }
  });
});

describe('IPv4-mapped IPv6 loopback origins', () => {
  /**
   * `URL` normalizes every spelling of the mapped form to compressed lowercase hex, so a release gate that
   * only recognized the dotted spelling would ship an artifact pointed at the user's own machine.
   */
  it.each([
    ['the dotted mapped form', 'https://[::ffff:127.0.0.1]'],
    ['the hex mapped form', 'https://[::ffff:7f00:1]'],
    ['a fully expanded mapped form', 'https://[0:0:0:0:0:ffff:7f00:0001]'],
    ['a mapped address elsewhere in 127.0.0.0/8', 'https://[::ffff:7f01:0203]'],
  ])('reports %s as loopback', (_reason, rawValue) => {
    expect(resolveApiBaseUrl(rawValue).isLoopback).toBe(true);
  });

  it.each([
    ['the dotted mapped form', 'https://[::ffff:127.0.0.1]'],
    ['the hex mapped form', 'https://[::ffff:7f00:1]'],
    ['a fully expanded mapped form', 'https://[0:0:0:0:0:ffff:7f00:0001]'],
  ])('fails a release build for %s', (_reason, rawValue) => {
    expect(() => assertReleasableApiBaseUrl(rawValue)).toThrow(ReleaseConfigurationError);
  });

  it('still reports the plain IPv6 loopback as loopback', () => {
    expect(resolveApiBaseUrl('https://[::1]').isLoopback).toBe(true);
  });

  it.each([
    ['a routable IPv6 address', 'https://[2001:db8::1]'],
    ['a mapped address outside the loopback block', 'https://[::ffff:8.8.8.8]'],
    ['the hex form of that mapped address', 'https://[::ffff:808:808]'],
  ])('accepts %s as a releasable origin', (_reason, rawValue) => {
    expect(resolveApiBaseUrl(rawValue).isLoopback).toBe(false);
    expect(() => assertReleasableApiBaseUrl(rawValue)).not.toThrow();
  });

  it('derives a host permission for a routable IPv6 origin', () => {
    expect(toHostPermissionPattern(resolveApiBaseUrl('https://[2001:db8::1]'))).toBe(
      'https://[2001:db8::1]/*',
    );
  });
});
