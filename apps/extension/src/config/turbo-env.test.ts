import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_BASE_URL_ENV_KEY, RELEASE_FLAG_ENV_KEY } from './api-origin';

/**
 * The Turbo side of the same boundary.
 *
 * Turbo 2 runs tasks in **strict** environment mode: a variable the task did not declare is simply not passed to it.
 * `WXT_API_BASE_URL` was declared nowhere, so every `pnpm build` and `pnpm check` handed the extension build an
 * environment without it — the build fell back to the loopback default however the operator had configured the
 * origin. And because an undeclared variable is also absent from the task hash, an artifact built for one origin
 * could be replayed from cache for another.
 *
 * These read the real `turbo.json` and ask Turbo itself what it resolved, rather than restating the file's contents
 * as a fixture: the question is what Turbo does with the configuration, not what the JSON happens to say.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const EXTENSION_BUILD = '@abfall-radar/extension#build';

const EXTENSION_TEST = '@abfall-radar/extension#test';

interface DryRunTask {
  readonly taskId: string;
  readonly hash: string;
  /** Every file Turbo hashed for the task, keyed by package-relative path. */
  readonly inputs: Record<string, string>;
  readonly resolvedTaskDefinition: {
    readonly inputs?: string[];
    readonly env?: string[];
  };
  readonly environmentVariables: {
    readonly specified: { readonly env: string[] };
    readonly configured: string[];
  };
}

/**
 * Asks Turbo what it would do, under a chosen environment.
 *
 * `--dry=json` resolves the task graph, the declared environment and the hash without running anything, so this is
 * deterministic and does not build.
 */
const dryRun = (env: Record<string, string | undefined>): DryRunTask[] => {
  const output = execFileSync(
    join(REPO_ROOT, 'node_modules', '.bin', 'turbo'),
    ['run', 'build', 'test', '--filter=@abfall-radar/extension', '--dry=json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  return (JSON.parse(output) as { tasks: DryRunTask[] }).tasks;
};

const taskNamed = (tasks: DryRunTask[], taskId: string): DryRunTask => {
  const task = tasks.find((candidate) => candidate.taskId === taskId);

  if (task === undefined) {
    throw new Error(`Turbo reported no ${taskId} task.`);
  }

  return task;
};

const turboConfig = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf-8')) as {
  tasks: Record<string, { env?: string[]; inputs?: string[] }>;
};

describe('the Turbo configuration for extension artifacts', () => {
  const artifactTasks = [EXTENSION_BUILD, EXTENSION_TEST];

  it.each(artifactTasks)('declares both build variables for %s', (taskId) => {
    const declared = turboConfig.tasks[taskId]?.env ?? [];

    expect(declared).toContain(API_BASE_URL_ENV_KEY);
    // Declared as well, because it changes the release gate and therefore the artifact. Declaring is not setting.
    expect(declared).toContain(RELEASE_FLAG_ENV_KEY);
  });

  it.each(artifactTasks)(
    'keeps the default source inputs for %s while adding env files',
    (taskId) => {
      /**
       * `$TURBO_DEFAULT$` is the whole point of this assertion. Listing `inputs` at all replaces Turbo's default set,
       * so adding `.env` patterns without the token would silently stop hashing every source file in the package — and
       * a code change would then replay a stale artifact.
       */
      const inputs = turboConfig.tasks[taskId]?.inputs ?? [];

      expect(inputs).toContain('$TURBO_DEFAULT$');
      expect(inputs).toContain('.env');
      // Covers `.env.local`, `.env.<mode>`, `.env.<browser>` and the mode/browser combinations WXT reads.
      expect(inputs).toContain('.env.*');
    },
  );

  it('carries no values, only variable names', () => {
    /**
     * A declaration names a variable; it must never carry an origin, a secret, or a default.
     *
     * Asserted over the **task definitions** rather than the whole file, because `$schema` is legitimately a URL —
     * scanning the raw text would fail on that and prove nothing about the configuration.
     */
    const tasks = JSON.stringify(turboConfig.tasks);

    expect(tasks).not.toContain('https://');
    expect(tasks).not.toContain('127.0.0.1');

    for (const taskId of artifactTasks) {
      for (const declared of turboConfig.tasks[taskId]?.env ?? []) {
        expect(declared).not.toContain('=');
      }
    }
  });
});

describe('what Turbo resolves for the extension build', () => {
  it('passes the configured origin to the task', () => {
    const task = taskNamed(
      dryRun({ [API_BASE_URL_ENV_KEY]: 'https://api.example.test' }),
      EXTENSION_BUILD,
    );

    expect(task.environmentVariables.specified.env).toContain(API_BASE_URL_ENV_KEY);
    expect(task.environmentVariables.specified.env).toContain(RELEASE_FLAG_ENV_KEY);
  }, 60_000);

  it('hashes the configured origin', () => {
    const task = taskNamed(
      dryRun({ [API_BASE_URL_ENV_KEY]: 'https://api.example.test' }),
      EXTENSION_BUILD,
    );

    // Turbo reports hashed variables as `NAME=<digest>`, never the value itself.
    expect(
      task.environmentVariables.configured.some((entry) =>
        entry.startsWith(`${API_BASE_URL_ENV_KEY}=`),
      ),
    ).toBe(true);
  }, 60_000);

  it('cannot replay an artifact built for a different origin', () => {
    /**
     * The cache-safety guarantee, stated as the property that matters: two different origins are two different
     * hashes. Undeclared, both produced the same hash and the second build silently restored the first's artifact.
     */
    const first = taskNamed(
      dryRun({ [API_BASE_URL_ENV_KEY]: 'https://one.example.test' }),
      EXTENSION_BUILD,
    );
    const second = taskNamed(
      dryRun({ [API_BASE_URL_ENV_KEY]: 'https://two.example.test' }),
      EXTENSION_BUILD,
    );

    expect(first.hash).not.toBe(second.hash);
  }, 60_000);

  it('reuses the hash when the origin is unchanged', () => {
    // The counterweight: the hash tracks the origin rather than simply differing every run.
    const first = taskNamed(
      dryRun({ [API_BASE_URL_ENV_KEY]: 'https://one.example.test' }),
      EXTENSION_BUILD,
    );
    const second = taskNamed(
      dryRun({ [API_BASE_URL_ENV_KEY]: 'https://one.example.test' }),
      EXTENSION_BUILD,
    );

    expect(first.hash).toBe(second.hash);
  }, 60_000);

  it('separates a release build from an ordinary one', () => {
    // `WXT_RELEASE` changes the gate and therefore the artifact, so it must not share a hash with a normal build.
    const ordinary = taskNamed(
      dryRun({ [API_BASE_URL_ENV_KEY]: 'https://one.example.test' }),
      EXTENSION_BUILD,
    );
    const release = taskNamed(
      dryRun({ [API_BASE_URL_ENV_KEY]: 'https://one.example.test', [RELEASE_FLAG_ENV_KEY]: '1' }),
      EXTENSION_BUILD,
    );

    expect(ordinary.hash).not.toBe(release.hash);
  }, 60_000);

  it('leaves the release flag unset for an ordinary verification run', () => {
    /**
     * Declaring a variable must not set it. `WXT_RELEASE` absent is what keeps `dev`, `build`, `test` and
     * `pnpm check` off the release gate, and Turbo reports only *present* variables as configured.
     */
    const task = taskNamed(
      dryRun({
        [API_BASE_URL_ENV_KEY]: 'https://one.example.test',
        [RELEASE_FLAG_ENV_KEY]: undefined,
      }),
      EXTENSION_BUILD,
    );

    expect(
      task.environmentVariables.configured.some((entry) =>
        entry.startsWith(`${RELEASE_FLAG_ENV_KEY}=`),
      ),
    ).toBe(false);
  }, 60_000);

  it('still hashes every package source file, so the default inputs really survived', () => {
    /**
     * The direct evidence, rather than an inference from hashes. Turbo reports the exact file set it hashed, so this
     * asks it: adding `inputs` replaces the default set, and without `$TURBO_DEFAULT$` this map would contain the
     * `.env` patterns alone — a source change would then replay a stale artifact.
     */
    const task = taskNamed(
      dryRun({ [API_BASE_URL_ENV_KEY]: 'https://one.example.test' }),
      EXTENSION_BUILD,
    );
    const hashed = Object.keys(task.inputs);

    expect(hashed).toContain('wxt.config.ts');
    expect(hashed).toContain('src/config/manifest.ts');
    expect(hashed).toContain('src/config/api-origin.ts');
    // Not a handful of env patterns: the whole package.
    expect(hashed.filter((file) => file.startsWith('src/')).length).toBeGreaterThan(20);
  }, 60_000);
});
