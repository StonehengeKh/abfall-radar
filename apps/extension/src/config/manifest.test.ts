import { describe, expect, it } from 'vitest';
import { ReleaseConfigurationError } from './api-origin';
import { buildManifest } from './manifest';

const developmentManifest = () => buildManifest({ rawApiBaseUrl: undefined, isRelease: false });

describe('buildManifest', () => {
  it('requests exactly the permission set the implemented behavior needs', () => {
    expect(developmentManifest().permissions).toEqual(['alarms', 'notifications', 'storage']);
  });

  it('requests exactly one host permission, derived from the validated origin', () => {
    expect(developmentManifest().host_permissions).toEqual(['http://127.0.0.1/*']);
  });

  it('derives the host permission from an explicitly configured origin', () => {
    expect(
      buildManifest({ rawApiBaseUrl: 'https://api.example.test:8443', isRelease: false })
        .host_permissions,
    ).toEqual(['https://api.example.test/*']);
  });

  it.each(['<all_urls>', 'optional_host_permissions', 'tabs', 'activeTab', '*://*/*'])(
    'never requests %s',
    (forbidden) => {
      expect(JSON.stringify(developmentManifest())).not.toContain(forbidden);
    },
  );

  it('requests no municipal host, because no municipal host is contacted', () => {
    // The API is the extension's only data boundary. Ingestion happens server-side, so the extension
    // never needs permission to reach an operator's calendar.
    expect(JSON.stringify(developmentManifest())).not.toContain('koblenz');
  });

  it('carries no port in the host permission', () => {
    expect(developmentManifest().host_permissions[0]).not.toContain('3000');
  });

  it('fails a release build without an explicit origin', () => {
    expect(() => buildManifest({ rawApiBaseUrl: undefined, isRelease: true })).toThrow(
      ReleaseConfigurationError,
    );
  });

  it.each([
    ['a loopback origin', 'http://127.0.0.1:3000'],
    ['a non-HTTPS origin', 'http://api.example.test'],
  ])('fails a release build for %s', (_reason, rawApiBaseUrl) => {
    expect(() => buildManifest({ rawApiBaseUrl, isRelease: true })).toThrow(
      ReleaseConfigurationError,
    );
  });

  it('produces a release manifest for a non-loopback HTTPS origin', () => {
    const manifest = buildManifest({
      rawApiBaseUrl: 'https://api.example.test',
      isRelease: true,
    });

    expect(manifest.host_permissions).toEqual(['https://api.example.test/*']);
    expect(manifest.permissions).toEqual(['alarms', 'notifications', 'storage']);
  });

  it('checks the release configuration before producing anything', () => {
    // A release build must fail on its configuration rather than emit an artifact pointed at a
    // development origin.
    expect(() =>
      buildManifest({ rawApiBaseUrl: 'http://127.0.0.1:3000', isRelease: true }),
    ).toThrow(/release build cannot be produced/);
  });

  it('keeps the action title and product name stable', () => {
    const manifest = developmentManifest();

    expect(manifest.name).toBe('AbfallRadar');
    expect(manifest.action.default_title).toBe('AbfallRadar');
  });
});
