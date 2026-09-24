import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDestinationLocation,
  recoverInterruptedInstall,
  transactionPathFor,
  canonicalDestination,
  establishOwnership,
  install,
  INVENTORY_FILE,
  InstallerError,
  listFiles,
  validateOutput,
} from './install-local.ts';

/**
 * The installer's filesystem safety, driven against throwaway directories.
 *
 * Every case here is one an independent review **reproduced destructively** against the previous
 * implementation: a nested personal file deleted because its top-level directory name was allowlisted,
 * a file created in the destination while the build ran and then removed with no backup, a destination
 * symlink into the repository's own build output that was followed and emptied, and an extension with
 * no background service worker that validated and installed.
 *
 * Nothing here touches a real installation: destinations are `mkdtemp` directories, and the "build
 * output" is a fixture tree rather than a real build.
 */

const scratch: string[] = [];

const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'ar008-installer-'));

  scratch.push(path);

  return path;
};

afterEach(() => {
  while (scratch.length > 0) {
    rmSync(scratch.pop() as string, { recursive: true, force: true });
  }
});

/** A minimal but *complete* MV3 output tree: worker, popup, both icon maps, and every file present. */
const buildOutput = (
  overrides: { manifest?: Record<string, unknown>; popupChunk?: string } = {},
): string => {
  const popupChunk = overrides.popupChunk ?? 'chunks/popup.js';
  const root = join(temp(), 'chrome-mv3');

  mkdirSync(join(root, 'icons'), { recursive: true });
  mkdirSync(join(root, 'chunks'), { recursive: true });

  writeFileSync(join(root, 'background.js'), '// worker\n');
  writeFileSync(
    join(root, 'popup.html'),
    `<!doctype html><script type="module" src="/${popupChunk}"></script>`,
  );
  writeFileSync(join(root, popupChunk), '// popup\n');

  const icons: Record<string, string> = {};

  for (const size of [16, 32, 48, 128]) {
    writeFileSync(join(root, `icons/${size}.png`), `png-${size}`);
    icons[String(size)] = `icons/${size}.png`;
  }

  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'AbfallRadar',
      host_permissions: ['http://127.0.0.1/*'],
      background: { service_worker: 'background.js' },
      action: { default_title: 'AbfallRadar', default_popup: 'popup.html', default_icon: icons },
      icons,
      ...overrides.manifest,
    }),
  );

  return root;
};

const firstInstall = (destination: string, outputRoot: string) =>
  install(destination, {
    owned: establishOwnership(destination, {
      adopt: false,
      buildFiles: listFiles(outputRoot).map((entry) => entry.path),
    }).owned,
    takeBackup: true,
    outputRoot,
  });

describe('destination ownership', () => {
  it('refuses a nested file it did not install, however ordinary the directory name', () => {
    const destination = join(temp(), 'installed');

    mkdirSync(join(destination, 'assets'), { recursive: true });
    writeFileSync(join(destination, 'assets/personal.txt'), 'my notes');

    /*
     * The reproduced blocker: `assets` was an allowlisted top-level name, so the directory was accepted
     * and the nested file destroyed. Ownership is per file now, and unowned content is a refusal.
     */
    expect(() => establishOwnership(destination, { adopt: false, buildFiles: [] })).toThrow(
      InstallerError,
    );

    expect(existsSync(join(destination, 'assets/personal.txt'))).toBe(true);
  });

  it('refuses a populated directory it has never installed into, rather than guessing', () => {
    const destination = join(temp(), 'installed');

    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'manifest.json'), '{}');

    // Ownership cannot be established, so the tool fails safely instead of cleaning up.
    expect(() => establishOwnership(destination, { adopt: false, buildFiles: [] })).toThrow(
      /no \.abfall-radar-install\.json/,
    );
  });

  it('adopts a hand-installed directory from its own extension graph', () => {
    const output = buildOutput();
    const destination = join(temp(), 'installed');

    cpSync(output, destination, { recursive: true });

    // `buildFiles` is deliberately empty: ownership must rest on the directory, not on the new build.
    expect(establishOwnership(destination, { adopt: true, buildFiles: [] }).owned.size).toBe(
      listFiles(destination).length + 1,
    );
  });

  it('adopts an older build whose content-hashed names the new build no longer has', () => {
    const destination = join(temp(), 'installed');

    // The ordinary upgrade case: the installed popup references popup-old.js; the new build has its own.
    cpSync(buildOutput({ popupChunk: 'chunks/popup-old.js' }), destination, { recursive: true });

    const freshBuild = listFiles(buildOutput({ popupChunk: 'chunks/popup-new.js' })).map(
      (entry) => entry.path,
    );

    expect(freshBuild).not.toContain('chunks/popup-old.js');
    expect(() =>
      establishOwnership(destination, { adopt: true, buildFiles: freshBuild }),
    ).not.toThrow();
  });

  it('refuses to adopt a directory that is not a complete extension', () => {
    const destination = join(temp(), 'installed');
    const output = buildOutput();

    cpSync(output, destination, { recursive: true });
    rmSync(join(destination, 'background.js'));

    expect(() => establishOwnership(destination, { adopt: true, buildFiles: [] })).toThrow(
      /not a complete extension/,
    );
  });

  it('refuses to adopt content its own extension does not reference', () => {
    const destination = join(temp(), 'installed');

    cpSync(buildOutput(), destination, { recursive: true });
    writeFileSync(join(destination, 'holiday.jpg'), 'not ours');

    /*
     * The reproduced defect adopted this by filename coincidence with the new build. Ownership now
     * comes from the installed extension's own manifest and popup, so an unreferenced file is refused.
     */
    expect(() =>
      establishOwnership(destination, { adopt: true, buildFiles: ['holiday.jpg'] }),
    ).toThrow(/ownership cannot be established/);

    expect(existsSync(join(destination, 'holiday.jpg'))).toBe(true);
  });

  it('records an inventory it can recognise on the next run', () => {
    const output = buildOutput();
    const destination = join(temp(), 'installed');

    const { inventory } = firstInstall(destination, output);

    expect(Object.keys(inventory.files)).toContain('manifest.json');
    expect(existsSync(join(destination, INVENTORY_FILE))).toBe(true);

    // Second run: the inventory establishes ownership without --adopt.
    expect(() =>
      establishOwnership(destination, {
        adopt: false,
        buildFiles: listFiles(output).map((entry) => entry.path),
      }),
    ).not.toThrow();
  });
});

describe('paths that are not what they look like', () => {
  it('refuses a destination reached through a symlink instead of following it', () => {
    const root = temp();
    const real = join(root, 'real-output');
    const link = join(root, 'link');

    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'manifest.json'), '{}');
    symlinkSync(real, link);

    // The reproduced case pointed such a link at the repository's own build output and emptied it.
    expect(() => canonicalDestination(link)).toThrow(/symlink/);
  });

  it('resolves an ordinary intermediate symlink instead of refusing it', () => {
    const root = temp();

    mkdirSync(join(root, 'real/inner'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'alias'));

    /*
     * Intermediate links are everywhere — on macOS `/var` is one — so refusing them would rule out every
     * temporary directory. Resolving them is what makes the protected-tree checks meaningful, because
     * those then run against the real location.
     */
    expect(canonicalDestination(join(root, 'alias/inner'))).toBe(
      join(realpathSync(join(root, 'real')), 'inner'),
    );
  });

  it('refuses a symlink hiding inside an otherwise ordinary destination', () => {
    const root = temp();
    const destination = join(root, 'installed');

    mkdirSync(destination, { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(destination, 'manifest.json'));

    expect(() => establishOwnership(destination, { adopt: false, buildFiles: [] })).toThrow(
      /symlink/,
    );
  });

  it.each([
    ['the repository', process.cwd()],
    ['the build output', join(process.cwd(), '.output/chrome-mv3')],
    ['a directory inside the repository', join(process.cwd(), 'scratch/installed')],
    ['the home directory itself', homedir()],
  ])('refuses %s as a destination', (_label, path) => {
    expect(() => assertDestinationLocation(path)).toThrow(InstallerError);
  });

  it('refuses a destination that would contain the home directory', () => {
    expect(() => assertDestinationLocation(dirname(homedir()))).toThrow(/contains/);
  });

  it('accepts an ordinary directory under the home directory', () => {
    /*
     * The home directory *itself* is protected; everything under it is not. Applying the "nothing
     * inside" rule to it refused every real destination, including the documented
     * `~/Documents/…/AbfallRadar-extension`.
     */
    expect(() =>
      assertDestinationLocation(join(homedir(), 'Documents/Projects/unpacked-extension')),
    ).not.toThrow();
  });
});

describe('output validation', () => {
  it('accepts a complete build', () => {
    expect(validateOutput(buildOutput()).manifest_version).toBe(3);
  });

  it('refuses an extension with no background service worker', () => {
    const output = buildOutput();
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));

    delete manifest.background;
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest));

    /*
     * The reproduced defect: the old check gathered the mandatory parts into one array, dropped the
     * absent ones and asked only that something remained, so this installed. The worker owns API
     * access, storage and reminders.
     */
    expect(() => validateOutput(output)).toThrow(/background\.service_worker/);
  });

  it.each([
    ['popup', 'action'],
    ['icons', 'icons'],
  ])('refuses a build with no %s', (_label, field) => {
    const output = buildOutput();
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));

    Reflect.deleteProperty(manifest, field);
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest));

    expect(() => validateOutput(output)).toThrow(InstallerError);
  });

  it('refuses a build missing one required icon size', () => {
    const output = buildOutput();

    rmSync(join(output, 'icons/32.png'));

    expect(() => validateOutput(output)).toThrow(/32/);
  });

  it('refuses a manifest reference that escapes the output root', () => {
    const output = buildOutput({ manifest: { background: { service_worker: '../escape.js' } } });

    writeFileSync(join(output, '..', 'escape.js'), '// outside');

    expect(() => validateOutput(output)).toThrow(/escapes the build output/);
  });

  it('refuses a popup whose hashed script the build did not emit', () => {
    const output = buildOutput();

    rmSync(join(output, 'chunks/popup.js'));

    expect(() => validateOutput(output)).toThrow(/popup/);
  });
});

describe('replacement', () => {
  it('replaces the contents and removes obsolete files, keeping the directory path', () => {
    const output = buildOutput();
    const destination = join(temp(), 'installed');

    firstInstall(destination, output);

    const stale = join(destination, 'chunks/popup.js');

    expect(existsSync(stale)).toBe(true);

    // A second build with a differently hashed chunk must not leave the old one behind.
    rmSync(join(output, 'chunks/popup.js'));
    writeFileSync(join(output, 'chunks/popup-2.js'), '// popup\n');
    writeFileSync(
      join(output, 'popup.html'),
      '<!doctype html><script type="module" src="/chunks/popup-2.js"></script>',
    );

    install(destination, {
      owned: establishOwnership(destination, {
        adopt: false,
        buildFiles: listFiles(output).map((entry) => entry.path),
      }).owned,
      takeBackup: false,
      outputRoot: output,
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(destination, 'chunks/popup-2.js'))).toBe(true);
  });

  it('aborts rather than deleting a file that appeared while the build ran', () => {
    const output = buildOutput();
    const destination = join(temp(), 'installed');

    const owned = establishOwnership(destination, {
      adopt: false,
      buildFiles: listFiles(output).map((entry) => entry.path),
    }).owned;

    // Exactly the reproduced race: validated as absent, populated during the build.
    mkdirSync(join(destination, 'assets'), { recursive: true });
    writeFileSync(join(destination, 'assets/created-during-build.txt'), 'mine');

    expect(() => install(destination, { owned, takeBackup: true, outputRoot: output })).toThrow(
      /gained 1 file/,
    );

    expect(readFileSync(join(destination, 'assets/created-during-build.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(destination, 'manifest.json'))).toBe(false);
  });

  it('leaves no staging or previous directory behind on failure', () => {
    const output = buildOutput();
    const parent = temp();
    const destination = join(parent, 'installed');

    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'stranger.txt'), 'x');

    expect(() =>
      install(destination, { owned: new Set(), takeBackup: true, outputRoot: output }),
    ).toThrow();

    expect(readdirSync(parent).filter((entry) => /staging|previous/.test(entry))).toEqual([]);
  });
});

/**
 * The exit status the shell sees.
 *
 * Run as a real process, because the defect was in `main` ignoring the result rather than in any
 * function it calls. No destination is configured, so nothing is built and nothing is written.
 */

/**
 * The inventory is a file on disk, so it is untrusted input.
 *
 * Every case here was accepted by the previous implementation, which checked only that a `files`
 * property existed and never compared a single digest.
 */
describe('inventory authentication', () => {
  const withInventory = (record: unknown): string => {
    const destination = join(temp(), 'installed');

    cpSync(buildOutput(), destination, { recursive: true });
    writeFileSync(join(destination, INVENTORY_FILE), JSON.stringify(record));

    return destination;
  };

  it.each([
    [
      'an array instead of an object',
      { tool: 'abfall-radar install-local', version: 1, installedAt: 'x', files: [] },
    ],
    ['a foreign tool', { tool: 'something-else', version: 1, installedAt: 'x', files: {} }],
    [
      'a different version',
      { tool: 'abfall-radar install-local', version: 99, installedAt: 'x', files: {} },
    ],
    ['no installedAt', { tool: 'abfall-radar install-local', version: 1, files: {} }],
  ])('refuses %s', (_label, record) => {
    expect(() =>
      establishOwnership(withInventory(record), { adopt: false, buildFiles: [] }),
    ).toThrow(/not an inventory this tool wrote/);
  });

  it.each([
    ['a traversal key', '../outside'],
    ['an absolute key', '/etc/passwd'],
    ['a current-directory key', './manifest.json'],
  ])('refuses %s', (_label, key) => {
    const record = {
      tool: 'abfall-radar install-local',
      version: 1,
      installedAt: 'x',
      files: { [key]: 'a'.repeat(64) },
    };

    expect(() =>
      establishOwnership(withInventory(record), { adopt: false, buildFiles: [] }),
    ).toThrow(/unusable path/);
  });

  it('refuses an entry whose value is not a SHA-256', () => {
    const record = {
      tool: 'abfall-radar install-local',
      version: 1,
      installedAt: 'x',
      files: { 'manifest.json': 'not-a-hash' },
    };

    expect(() =>
      establishOwnership(withInventory(record), { adopt: false, buildFiles: [] }),
    ).toThrow(/no valid SHA-256/);
  });

  it('refuses an owned file whose bytes have changed since it was installed', () => {
    const output = buildOutput();
    const destination = join(temp(), 'installed');

    firstInstall(destination, output);
    writeFileSync(join(destination, 'icons/16.png'), 'replaced by something else');

    expect(() =>
      establishOwnership(destination, {
        adopt: false,
        buildFiles: listFiles(output).map((entry) => entry.path),
      }),
    ).toThrow(/have changed since/);
  });

  it('refuses a forged inventory that claims a file it never installed', () => {
    const destination = join(temp(), 'installed');

    cpSync(buildOutput(), destination, { recursive: true });
    writeFileSync(join(destination, 'personal.txt'), 'my notes');

    const files = Object.fromEntries(
      listFiles(destination)
        .filter((entry) => entry.path !== INVENTORY_FILE)
        .map((entry) => [entry.path, 'f'.repeat(64)]),
    );

    writeFileSync(
      join(destination, INVENTORY_FILE),
      JSON.stringify({
        tool: 'abfall-radar install-local',
        version: 1,
        installedAt: new Date().toISOString(),
        files,
      }),
    );

    // Shaped correctly, but the digests are invented, so nothing here is treated as owned.
    expect(() => establishOwnership(destination, { adopt: false, buildFiles: [] })).toThrow(
      /have changed since/,
    );
    expect(existsSync(join(destination, 'personal.txt'))).toBe(true);
  });
});

describe('build-output containment', () => {
  it('refuses a build-output root that is a symlink to an otherwise valid build', () => {
    const real = buildOutput();
    const link = join(temp(), 'chrome-mv3');

    symlinkSync(real, link);

    /*
     * The reproduced case. `listFiles` walks what is *inside* a directory, so the root itself was never
     * examined and a link to a complete, valid tree validated. The copy dereferences, so the target's
     * bytes would have been installed and inventoried as this build's own output.
     */
    expect(() => validateOutput(link)).toThrow(/root is a symlink/);

    // The link's target is untouched by the refusal.
    expect(existsSync(join(real, 'manifest.json'))).toBe(true);
    expect(listFiles(real)).toHaveLength(8);
  });

  it('refuses to install from a symlinked output root, leaving the destination alone', () => {
    const real = buildOutput();
    const link = join(temp(), 'chrome-mv3');
    const destination = join(temp(), 'installed');

    firstInstall(destination, buildOutput());

    const before = listFiles(destination)
      .map((entry) => `${entry.path}:${readFileSync(join(destination, entry.path), 'utf8').length}`)
      .sort();

    symlinkSync(real, link);

    expect(() => validateOutput(link)).toThrow(InstallerError);

    const after = listFiles(destination)
      .map((entry) => `${entry.path}:${readFileSync(join(destination, entry.path), 'utf8').length}`)
      .sort();

    expect(after).toEqual(before);
  });

  it('accepts an ordinary directory as the output root', () => {
    // The control: the root check must not refuse the normal case.
    expect(validateOutput(buildOutput()).manifest_version).toBe(3);
  });

  it('refuses an output root that does not exist', () => {
    expect(() => validateOutput(join(temp(), 'never-built'))).toThrow(/does not exist/);
  });

  it('refuses an output tree containing a symlink, before anything is copied', () => {
    const output = buildOutput();
    const elsewhere = join(temp(), 'elsewhere');

    mkdirSync(elsewhere, { recursive: true });

    for (const size of [16, 32, 48, 128]) {
      writeFileSync(join(elsewhere, `${size}.png`), 'external');
    }

    // The reproduced case: the icons directory replaced by a link out of the output tree.
    rmSync(join(output, 'icons'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(output, 'icons'));

    expect(() => validateOutput(output)).toThrow(/symlink/);
  });
});

describe('destinations below missing parents', () => {
  it('resolves an intermediate symlink even when several parents do not exist', () => {
    const root = temp();
    const real = join(root, 'real');

    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, 'alias'));

    /*
     * The reproduced blocker used exactly this shape — a link with a nonexistent descendant — to get a
     * lexical path past the protected-tree checks.
     */
    expect(canonicalDestination(join(root, 'alias/missing/deeper/installed'))).toBe(
      join(realpathSync(real), 'missing/deeper/installed'),
    );
  });

  it('refuses the repository reached through a symlink with missing descendants', () => {
    const root = temp();

    symlinkSync(process.cwd(), join(root, 'repo-link'));

    const resolved = canonicalDestination(join(root, 'repo-link/__missing__/installed'));

    expect(() => assertDestinationLocation(resolved)).toThrow(/inside the repository/);
  });
});

describe('recovery from an interrupted replacement', () => {
  /** Exactly what a process killed between the two renames leaves on disk. */
  const interrupted = (): { destination: string; previous: string } => {
    const destination = join(temp(), 'installed');

    firstInstall(destination, buildOutput());

    const previous = `${destination}.previous-999999`;

    renameSync(destination, previous);
    writeFileSync(
      transactionPathFor(destination),
      JSON.stringify({
        tool: 'abfall-radar install-local',
        version: 1,
        destination,
        staging: `${destination}.staging-999999`,
        previous,
        pid: 999_999,
        startedAt: new Date().toISOString(),
      }),
    );

    return { destination, previous };
  };

  it('restores the previous installation when the swap did not commit', () => {
    const { destination, previous } = interrupted();

    expect(existsSync(destination)).toBe(false);

    recoverInterruptedInstall(destination);

    expect(existsSync(join(destination, 'manifest.json'))).toBe(true);
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(transactionPathFor(destination))).toBe(false);
  });

  it('clears leftovers when the swap did commit', () => {
    const { destination, previous } = interrupted();

    // The destination is back, so the swap completed and the scratch copy is redundant.
    cpSync(previous, destination, { recursive: true });
    recoverInterruptedInstall(destination);

    expect(existsSync(join(destination, 'manifest.json'))).toBe(true);
    expect(existsSync(previous)).toBe(false);
  });

  it('refuses an ambiguous state with manual instructions rather than guessing', () => {
    const { destination, previous } = interrupted();

    rmSync(previous, { recursive: true, force: true });

    expect(() => recoverInterruptedInstall(destination)).toThrow(/Recover by hand/);
    // The record survives the refusal, so the next run reports the same thing rather than forgetting.
    expect(existsSync(transactionPathFor(destination))).toBe(true);
  });

  /**
   * A journal is evidence that something was interrupted, never authority over what to delete.
   *
   * The reviewer's reproduction supplied two unrelated directories as `staging` and `previous` in an
   * otherwise plausible record; recovery recursively destroyed both. Each case below asserts the
   * sentinels survive **and** that the record survives, so the refusal is reportable rather than
   * silently swallowed.
   */
  describe('a journal that names paths this tool would never create', () => {
    const sentinels = (): { a: string; b: string; check: () => void } => {
      const root = temp();
      const a = join(root, 'unrelated-a');
      const b = join(root, 'unrelated-b');

      mkdirSync(join(a, 'nested'), { recursive: true });
      mkdirSync(b, { recursive: true });
      writeFileSync(join(a, 'nested/keepsake.txt'), 'irreplaceable');
      writeFileSync(join(b, 'notes.md'), 'also irreplaceable');

      return {
        a,
        b,
        check: () => {
          expect(readFileSync(join(a, 'nested/keepsake.txt'), 'utf8')).toBe('irreplaceable');
          expect(readFileSync(join(b, 'notes.md'), 'utf8')).toBe('also irreplaceable');
          expect(listFiles(a).map((entry) => entry.path)).toEqual(['nested/keepsake.txt']);
          expect(listFiles(b).map((entry) => entry.path)).toEqual(['notes.md']);
        },
      };
    };

    const journal = (destination: string, record: unknown): string => {
      const path = transactionPathFor(destination);

      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(path, JSON.stringify(record));

      return path;
    };

    /** An intact destination, so recovery would take the "clear the leftovers" branch. */
    const intact = (): string => {
      const destination = join(temp(), 'installed');

      firstInstall(destination, buildOutput());

      return destination;
    };

    it('refuses unrelated staging and previous directories, and destroys neither', () => {
      const destination = intact();
      const { a, b, check } = sentinels();
      const path = journal(destination, {
        tool: 'abfall-radar install-local',
        version: 999,
        destination,
        staging: a,
        previous: b,
        pid: '1234',
        startedAt: null,
      });

      expect(() => recoverInterruptedInstall(destination)).toThrow(/Nothing was moved or removed/);

      check();
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(destination, 'manifest.json'))).toBe(true);
    });

    it('refuses a well-formed record whose scratch paths are somewhere else entirely', () => {
      const destination = intact();
      const { a, b, check } = sentinels();

      journal(destination, {
        tool: 'abfall-radar install-local',
        version: 1,
        destination,
        staging: a,
        previous: b,
        pid: 4242,
        startedAt: new Date().toISOString(),
      });

      expect(() => recoverInterruptedInstall(destination)).toThrow(/would never create/);
      check();
    });

    it.each([
      ['a foreign tool', { tool: 'something-else' }],
      ['a wrong version', { version: 999 }],
      ['a non-numeric identifier', { pid: '1234' }],
      ['a negative identifier', { pid: -1 }],
      ['no start time', { startedAt: null }],
      ['another destination', { destination: '/somewhere/else' }],
    ])('refuses %s without touching anything', (_label, override) => {
      const destination = intact();
      const derived = {
        staging: `${destination}.staging-4242`,
        previous: `${destination}.previous-4242`,
      };

      mkdirSync(derived.previous, { recursive: true });
      writeFileSync(join(derived.previous, 'manifest.json'), '{}');

      const path = journal(destination, {
        tool: 'abfall-radar install-local',
        version: 1,
        destination,
        ...derived,
        pid: 4242,
        startedAt: new Date().toISOString(),
        ...override,
      });

      expect(() => recoverInterruptedInstall(destination)).toThrow(InstallerError);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(derived.previous, 'manifest.json'))).toBe(true);
    });

    it.each([
      ['an array', []],
      ['a string', 'not a record'],
      ['null', null],
    ])('refuses %s as a record', (_label, record) => {
      const destination = intact();
      const path = journal(destination, record);

      expect(() => recoverInterruptedInstall(destination)).toThrow(InstallerError);
      expect(existsSync(path)).toBe(true);
    });

    it('refuses invalid JSON without removing the record', () => {
      const destination = intact();
      const path = transactionPathFor(destination);

      writeFileSync(path, '{ not json');

      expect(() => recoverInterruptedInstall(destination)).toThrow(/not valid JSON/);
      expect(existsSync(path)).toBe(true);
    });

    it('refuses a correctly named scratch path that is a symlink elsewhere', () => {
      const destination = intact();
      const { a, check } = sentinels();

      symlinkSync(a, `${destination}.previous-4242`);
      journal(destination, {
        tool: 'abfall-radar install-local',
        version: 1,
        destination,
        staging: `${destination}.staging-4242`,
        previous: `${destination}.previous-4242`,
        pid: 4242,
        startedAt: new Date().toISOString(),
      });

      // The name is right; the thing on disk is a redirect, so it is not an interrupted install.
      expect(() => recoverInterruptedInstall(destination)).toThrow(/symlink/);
      check();
    });
  });

  it('does nothing when there is no interrupted transaction', () => {
    expect(() => recoverInterruptedInstall(join(temp(), 'installed'))).not.toThrow();
  });
});

describe('the first backup', () => {
  it('is still owed after a failed install, and taken by the next success', () => {
    const output = buildOutput();
    const parent = temp();
    const destination = join(parent, 'installed');

    firstInstall(destination, output);

    // A fresh install has nothing to back up.
    expect(readdirSync(parent).filter((entry) => entry.includes('-backup-'))).toEqual([]);

    const owned = new Set(
      Object.keys(
        (JSON.parse(readFileSync(join(destination, INVENTORY_FILE), 'utf8')) as { files: object })
          .files,
      ),
    ).add(INVENTORY_FILE);

    // A failed install: a file appeared during the build, so the transaction aborts.
    writeFileSync(join(destination, 'appeared.txt'), 'x');

    expect(() => install(destination, { owned, takeBackup: true, outputRoot: output })).toThrow();
    expect(readdirSync(parent).filter((entry) => entry.includes('-backup-'))).toEqual([]);

    rmSync(join(destination, 'appeared.txt'));

    // The next successful install must still take that first backup.
    expect(install(destination, { owned, takeBackup: true, outputRoot: output }).backedUp).toBe(
      true,
    );

    const backups = readdirSync(parent).filter((entry) => entry.includes('-backup-'));

    expect(backups).toHaveLength(1);
    expect(existsSync(join(parent, backups[0] as string, 'manifest.json'))).toBe(true);
  });
});
describe('exit status', () => {
  /** The real entry point, run as a real process. */
  const cli = (
    args: readonly string[],
    env: NodeJS.ProcessEnv = {},
  ): { status: number | null; output: string } => {
    const script = join(import.meta.dirname, 'install-local.ts');
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });

    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  it('runs the TypeScript installer rather than a module that no longer exists', () => {
    const { output } = cli(['--dest', 'relative/path']);

    /*
     * The previous version of this test invoked `install-local.mjs`, which was deleted in the
     * TypeScript conversion, and asserted only that the call threw — so it passed on MODULE_NOT_FOUND
     * without ever executing the installer.
     */
    expect(output).not.toContain('MODULE_NOT_FOUND');
    expect(output).not.toContain('Cannot find module');
  });

  it('fails with the absolute-path diagnostic for a relative destination', () => {
    const { status, output } = cli(['--dest', 'relative/path']);

    expect(output).toContain('The destination must be an absolute path');
    expect(status).toBe(1);
  });

  it('fails with the configuration diagnostic when no destination is set', () => {
    const { status, output } = cli([], { ABFALL_RADAR_EXTENSION_INSTALL_DIR: '' });

    expect(output).toContain('No install destination configured');
    expect(status).toBe(1);
  });

  it('refuses a destination inside the repository, by its own diagnostic', () => {
    const { status, output } = cli(['--dest', join(import.meta.dirname, '..', '.output')]);

    expect(output).toContain('Refusing to install inside the repository');
    expect(status).toBe(1);
  });
});
