import {
  assertReleasableApiBaseUrl,
  resolveApiBaseUrl,
  toHostPermissionPattern,
} from './api-origin';

/**
 * Builds the extension manifest from the validated API origin.
 *
 * Extracted from `wxt.config.ts` so the permission set and the derived host pattern are unit-testable
 * rather than only inspectable after a build. A permission is capability, and a test that can only read
 * the output of a successful build is a test nobody runs on the change that widens one.
 */

/**
 * Exactly what the implemented behavior needs. No `<all_urls>`, no `optional_host_permissions`, no
 * `tabs`, and no `activeTab`: the extension contacts one configured origin and reads no page.
 *
 * No municipal host permission appears either, because no municipal host is contacted — the API is the
 * extension's only data boundary, and ingestion happens server-side.
 */
export const EXTENSION_PERMISSIONS = ['alarms', 'notifications', 'storage'] as const;

export interface BuildManifestInput {
  /** The raw `WXT_API_BASE_URL` value, or `undefined` when nothing is configured. */
  readonly rawApiBaseUrl: string | undefined;
  /** True on the controlled release and packaging path, which `WXT_RELEASE` marks. */
  readonly isRelease: boolean;
}

export interface ExtensionManifest {
  readonly name: string;
  readonly description: string;
  readonly permissions: string[];
  readonly host_permissions: string[];
  readonly action: { readonly default_title: string };
}

export const buildManifest = ({
  rawApiBaseUrl,
  isRelease,
}: BuildManifestInput): ExtensionManifest => {
  if (isRelease) {
    // Checked before anything else, so a release build fails on its configuration rather than producing
    // an artifact pointed at a development origin.
    assertReleasableApiBaseUrl(rawApiBaseUrl);
  }

  const baseUrl = resolveApiBaseUrl(rawApiBaseUrl);

  return {
    name: 'AbfallRadar',
    description: 'Never miss the next waste collection.',
    permissions: [...EXTENSION_PERMISSIONS],
    // Exactly one entry, derived from the validated origin. Never hand-written, so it cannot describe a
    // host the extension does not actually contact.
    host_permissions: [toHostPermissionPattern(baseUrl)],
    action: { default_title: 'AbfallRadar' },
  };
};
