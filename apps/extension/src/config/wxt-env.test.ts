import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'wxt';
import { API_BASE_URL_ENV_KEY, DEFAULT_API_BASE_URL, RELEASE_FLAG_ENV_KEY } from './api-origin';

/**
 * The build-configuration boundary, exercised through a **real WXT build**.
 *
 * WXT resolves configuration in a fixed order: it imports `wxt.config.ts`, *then* calls `loadEnv(mode, browser)` to
 * apply `.env`, `.env.<mode>`, `.env.<browser>` and the mode/browser combinations, and only after that resolves a
 * functional manifest. Reading `process.env` in the config module body therefore ran one step too early — so an
 * origin supplied through a `.env` file produced a manifest carrying the loopback default host permission while Vite
 * inlined the real value into the worker. The artifact asked permission for one host and contacted another.
 *
 * Nothing short of a real build proves that ordering. A test that called the validator, or that set `process.env`
 * itself, would pass against the broken configuration too: the whole defect is *when* the value is read, and only
 * WXT decides that. So these builds go through `wxt`'s own entry point with a `.env` fixture on disk and then read
 * the artifact.
 *
 * Every build restores `process.env` afterwards, because `loadEnv` expands its result **into** `process.env` — so a
 * fixture would otherwise leak into every later test in the process.
 */

/** WXT reads env files relative to the working directory, which for this package's tests is the package root. */
const ENV_FILE = '.env.production';

interface BuiltArtifact {
  readonly manifest: { readonly host_permissions: string[] };
  readonly background: string;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  // Unconditional, so a failing expectation cannot leave a `.env` fixture or a temporary output tree behind.
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

/**
 * Builds the extension with an optional `.env.production` fixture and returns what landed on disk.
 *
 * The fixture and the output directory are registered for cleanup **before** the build runs, so they are removed
 * even if it throws — which several cases below deliberately expect it to.
 */
const buildWith = async ({
  envFileContents,
  release = false,
}: {
  readonly envFileContents?: string | undefined;
  readonly release?: boolean;
}): Promise<BuiltArtifact> => {
  const outDir = mkdtempSync(join(tmpdir(), 'abfall-radar-wxt-'));
  const before = {
    apiBaseUrl: process.env[API_BASE_URL_ENV_KEY],
    release: process.env[RELEASE_FLAG_ENV_KEY],
  };

  cleanups.push(() => {
    rmSync(outDir, { recursive: true, force: true });

    if (envFileContents !== undefined) {
      rmSync(ENV_FILE, { force: true });
    }

    // `loadEnv` expands into `process.env`, so the fixture is undone here rather than left for the next test.
    for (const [key, value] of [
      [API_BASE_URL_ENV_KEY, before.apiBaseUrl],
      [RELEASE_FLAG_ENV_KEY, before.release],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // A genuinely unset variable is the development case, and an ambient one would defeat the point of the fixture.
  delete process.env[API_BASE_URL_ENV_KEY];

  if (release) {
    process.env[RELEASE_FLAG_ENV_KEY] = '1';
  } else {
    delete process.env[RELEASE_FLAG_ENV_KEY];
  }

  if (envFileContents !== undefined) {
    writeFileSync(ENV_FILE, envFileContents, 'utf-8');
  }

  await build({ mode: 'production', browser: 'chrome', outDir });

  /**
   * Located rather than assumed. WXT appends its own `<browser>-mv<version>` directory to `outDir`, and hard-coding
   * that would make this test depend on a naming template it does not own.
   */
  const artifactDir = join(outDir, readdirSync(outDir)[0] ?? '');
  const manifest = JSON.parse(readFileSync(join(artifactDir, 'manifest.json'), 'utf-8')) as {
    host_permissions: string[];
  };

  return {
    manifest,
    background: readFileSync(join(artifactDir, 'background.js'), 'utf-8'),
  };
};

describe('an API origin supplied only through a WXT env file', () => {
  it('reaches both the manifest host permission and the compiled worker', async () => {
    /**
     * The regression. Before the manifest became a function this produced
     * `host_permissions: ['http://127.0.0.1/*']` — the loopback default — beside a worker compiled against
     * `https://api.example.test`, and nothing in the build reported the disagreement.
     */
    const built = await buildWith({
      envFileContents: `${API_BASE_URL_ENV_KEY}=https://api.example.test\n`,
    });

    expect(built.manifest.host_permissions).toEqual(['https://api.example.test/*']);

    /**
     * The bundle carrying this string is the discriminating evidence: Vite inlines
     * `import.meta.env.WXT_API_BASE_URL` as a literal, so it can only appear if WXT's env loading reached the
     * worker's compilation.
     *
     * The loopback default is *not* asserted absent, and could not be: it is a module constant of the validator
     * that is compiled into every bundle as the fallback, whatever the configured origin turns out to be.
     */
    expect(built.background).toContain('https://api.example.test');
  }, 120_000);

  it('keeps the manifest permission port-free while the worker keeps the exact origin', async () => {
    // A Chrome match pattern cannot express a port, so the two are deliberately different strings derived from one
    // value — which is exactly why they have to come from the same read.
    const built = await buildWith({
      envFileContents: `${API_BASE_URL_ENV_KEY}=https://api.example.test:8443\n`,
    });

    expect(built.manifest.host_permissions).toEqual(['https://api.example.test/*']);
    expect(built.background).toContain('https://api.example.test:8443');
  }, 120_000);

  it('cannot resolve a different origin for the manifest than for the worker', async () => {
    /**
     * Stated as a relation rather than as two fixed strings: whatever origin the worker was compiled against, the
     * single host permission is that origin's host. Two independent reads of `process.env` at different moments in
     * the build could not satisfy this.
     */
    const built = await buildWith({
      envFileContents: `${API_BASE_URL_ENV_KEY}=https://schedules.example.test\n`,
    });

    expect(built.manifest.host_permissions).toHaveLength(1);

    const permittedHost = built.manifest.host_permissions[0]
      ?.replace(/^https?:\/\//, '')
      .replace(/\/\*$/, '');

    expect(permittedHost).toBe('schedules.example.test');
    expect(built.background).toContain('https://schedules.example.test');
  }, 120_000);
});

describe('a development build with no configured origin', () => {
  it('still uses the loopback default in both the manifest and the worker', async () => {
    // No fixture and no ambient variable: the development fallback is unchanged by the deferral.
    const built = await buildWith({});

    // The manifest is the discriminating half here — the bundle contains the default constant either way.
    expect(built.manifest.host_permissions).toEqual(['http://127.0.0.1/*']);
    expect(built.background).toContain(DEFAULT_API_BASE_URL);
    // And no fixture from a neighbouring case leaked into this build.
    expect(built.background).not.toContain('example.test');
  }, 120_000);
});

describe('the release gate against an env-file origin', () => {
  /**
   * Each of these fails while WXT is resolving the manifest — before any bundling — so they are fast despite going
   * through the real build entry point. What matters is that the gate sees the value WXT loaded rather than the
   * value that existed when the config module was imported.
   */
  it('rejects a release build whose origin is only the loopback default', async () => {
    await expect(buildWith({ release: true })).rejects.toThrow(/must be supplied explicitly/);
  }, 120_000);

  it('rejects a release build pointed at a loopback origin from an env file', async () => {
    await expect(
      buildWith({
        release: true,
        envFileContents: `${API_BASE_URL_ENV_KEY}=http://127.0.0.1:3000\n`,
      }),
    ).rejects.toThrow(/must not be a loopback origin/);
  }, 120_000);

  it('rejects a release build pointed at a non-HTTPS origin from an env file', async () => {
    await expect(
      buildWith({
        release: true,
        envFileContents: `${API_BASE_URL_ENV_KEY}=http://api.example.test\n`,
      }),
    ).rejects.toThrow(/must use https/);
  }, 120_000);

  it('accepts a release build whose env-file origin is a non-loopback HTTPS origin', async () => {
    // The counterweight: the gate refuses the three bad cases without refusing a legitimate release.
    const built = await buildWith({
      release: true,
      envFileContents: `${API_BASE_URL_ENV_KEY}=https://api.example.test\n`,
    });

    expect(built.manifest.host_permissions).toEqual(['https://api.example.test/*']);
  }, 120_000);
});

/**
 * Hygiene, asserted rather than assumed.
 *
 * These tests write a real `.env` file into the package to exercise WXT's loader. A fixture left behind would change
 * every later build on the machine and would be a genuinely dangerous thing to commit — so its removal is checked
 * here, in the same file, after the builds above have run.
 */
describe('the env fixtures these tests create', () => {
  it('leaves no env file in the package', () => {
    // `afterEach` removes each fixture unconditionally; this is the standing check that it really did.
    expect(readdirSync('.').filter((entry) => entry.startsWith('.env'))).toEqual([]);
  });

  it('keeps no env file under version control anywhere in the repository', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: join(import.meta.dirname, '..', '..', '..', '..'),
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\0')
      .filter((file) => file.split('/').at(-1)?.startsWith('.env') === true);

    expect(tracked).toEqual([]);
  });

  it('names only reserved example hosts, never a real domain', () => {
    /**
     * `example.test` is reserved by RFC 6761 and can never resolve to anything, so a fixture using it cannot become a
     * request to somebody's server if one of these strings ever escaped into a build.
     */
    const ownSource = readFileSync(join(import.meta.dirname, 'wxt-env.test.ts'), 'utf-8');
    const hosts = [...ownSource.matchAll(/https?:\/\/([\w.-]+)/g)]
      .map(([, host]) => host)
      .filter((host): host is string => host !== undefined);

    expect(hosts.length).toBeGreaterThan(0);

    for (const host of hosts) {
      expect(host === '127.0.0.1' || host.endsWith('.example.test')).toBe(true);
    }
  });
});
