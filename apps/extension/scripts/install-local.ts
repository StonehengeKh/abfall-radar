#!/usr/bin/env node
/**
 * Builds the extension and replaces an unpacked extension directory Chrome already loads, so the only
 * manual step left is pressing Reload on `chrome://extensions`.
 *
 * WXT 0.20.27 has no `build --watch`: `wxt build --help` lists `--config`, `--mode`, `--browser`,
 * `--filter-entrypoint`, `--mv3`, `--mv2`, `--analyze`, `--debug` and `--level`, and nothing else. `wxt
 * dev` does watch, but it drives its own browser profile and writes a development build — the opposite
 * of updating the extension the person already has. So the watching is here, and each rebuild is an
 * ordinary `wxt build`.
 *
 *   node scripts/install-local.ts                 # build once, install, exit nonzero on failure
 *   node scripts/install-local.ts --watch         # build, install, rebuild on every change
 *   node scripts/install-local.ts --dest <path>   # a different destination for this run
 *   node scripts/install-local.ts --adopt         # take ownership of an existing unmanaged directory
 *
 * The destination comes from `--dest`, else `ABFALL_RADAR_EXTENSION_INSTALL_DIR` in the environment or
 * in `apps/extension/.env.local`, which is git-ignored. **No absolute path belongs in this file**: it is
 * shared repository code and the directory is one person's local Chrome profile.
 *
 * ## Why this is more careful than a copy
 *
 * It deletes files. An earlier version decided what it was allowed to delete from a *top-level name*
 * allowlist, so a destination containing `assets/personal.txt` was accepted — `assets` is an expected
 * name — and the nested file was destroyed. It also validated once, before a build that takes seconds,
 * so anything created in the destination meanwhile was removed with no backup, and it followed the
 * destination's final symlink, which let a link into the repository's own build output be accepted and
 * then emptied.
 *
 * So deletion is now driven by an **inventory** this tool writes into the destination
 * (`.abfall-radar-install.json`): the only files it will ever remove are ones it recorded putting
 * there. A directory holding anything else is refused rather than cleaned up, ownership is re-checked
 * after the build and immediately before the swap, and the replacement is staged and swapped by rename,
 * so an interruption leaves either the old installation or the new one and never a half-copied mixture.
 *
 * Chrome keys an unpacked extension's storage to its **path**, so the path never changes and settings
 * survive a reload.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(extensionRoot, '../..');
const outputDir = join(extensionRoot, '.output/chrome-mv3');

/** The local API this workflow targets. `wxt.config.ts` still validates it and derives the manifest. */
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000';
const DEST_ENV_KEY = 'ABFALL_RADAR_EXTENSION_INSTALL_DIR';

/** The record of what this tool put in the destination. Nothing outside it is ever removed. */
export const INVENTORY_FILE = '.abfall-radar-install.json';
const INVENTORY_VERSION = 1;

/** Long enough that an editor writing several files produces one build. */
const DEBOUNCE_MS = 250;

/** How long a path this tool just wrote is ignored by the watcher, so syncing cannot loop. */
const SELF_WRITE_GRACE_MS = 1_500;

const colour = { dim: '\u001B[2m', red: '\u001B[31m', green: '\u001B[32m', reset: '\u001B[0m' };
const say = (message: string) =>
  console.log(`${colour.dim}[${new Date().toLocaleTimeString()}]${colour.reset} ${message}`);
const building = () => say('building…');
const failed = (message: string) => say(`${colour.red}failed${colour.reset} — ${message}`);
const ready = (destination: string) =>
  say(
    `${colour.green}ready${colour.reset} — installed to ${destination}. Press Reload in chrome://extensions.`,
  );

/**
 * Just the part of a spawned process this file touches.
 *
 * A documented boundary: under WXT's generated `tsconfig` the `ChildProcess` type resolves without its
 * `EventEmitter` members, so annotating with it makes `.on` and `.once` type errors. Naming the four
 * members used here keeps every call site checked rather than reaching for `any`.
 */
interface BuildProcess {
  readonly pid?: number | undefined;
  on(event: 'close' | 'error', listener: (code: number | null) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

interface InstalledEntry {
  readonly path: string;
  readonly symlink: boolean;
}

interface Inventory {
  readonly tool: string;
  readonly version: number;
  readonly installedAt: string;
  readonly files: Record<string, string>;
}

/** Only the parts this tool insists on; a build may carry more. */
interface ExtensionManifest {
  readonly manifest_version: number;
  readonly name: string;
  readonly host_permissions: string[];
  readonly background?: { readonly service_worker?: unknown };
  readonly action?: { readonly default_popup?: unknown; readonly default_icon?: unknown };
  readonly icons?: unknown;
}

/** A refusal the person can act on, as opposed to an unexpected crash. */
export class InstallerError extends Error {}

// ---------------------------------------------------------------------------------------------
// Destination resolution and safety
// ---------------------------------------------------------------------------------------------

/**
 * `.env.local` read by hand, and only for this one key.
 *
 * WXT loads env files itself, but inside the build it spawns; this process needs the destination before
 * any build starts. Deliberately not a dotenv dependency for one lookup.
 */
const destinationFromEnvFile = (): string | undefined => {
  const envFile = join(extensionRoot, '.env.local');

  if (!existsSync(envFile)) {
    return undefined;
  }

  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?ABFALL_RADAR_EXTENSION_INSTALL_DIR\s*=\s*(.*)$/.exec(line);

    if (match) {
      return (match[1] ?? '').trim().replace(/^["']|["']$/g, '');
    }
  }

  return undefined;
};

/**
 * The canonical destination: the nearest existing ancestor resolved, the missing tail validated.
 *
 * `realpathSync` was previously applied only to the **immediate** parent, so a destination two or more
 * levels below a missing directory came back lexically — and a symlink higher up the path was never
 * followed. A link pointing at this repository with a nonexistent descendant therefore passed every
 * protected-tree check, and `mkdirSync(..., { recursive: true })` would then have written through it.
 *
 * So the walk goes **up** to whatever exists, resolves that, and re-attaches only components it has
 * checked: no `..`, no `.`, nothing empty, nothing containing a separator. What comes back is a real
 * path, which is what makes the protected-tree comparisons mean anything.
 */
export const canonicalDestination = (raw: string): string => {
  const expanded = raw.replace(/^~(?=$|\/)/, homedir());

  /*
   * Checked before `resolve`, which would quietly make any relative path absolute against whatever
   * directory the process happened to start in. A destination that means something different depending
   * on where the command was run is not a destination this tool may delete files from.
   */
  if (!isAbsolute(expanded)) {
    throw new InstallerError(`The destination must be an absolute path: ${raw}`);
  }

  const requested = resolve(expanded);

  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) {
    throw new InstallerError(
      `Refusing a destination that is a symlink: ${requested}. Give the real path instead.`,
    );
  }

  const missing: string[] = [];
  let ancestor = requested;

  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);

    if (parent === ancestor) {
      throw new InstallerError(`No part of ${requested} exists, not even its filesystem root.`);
    }

    missing.unshift(basename(ancestor));
    ancestor = parent;
  }

  for (const part of missing) {
    if (part === '' || part === '.' || part === '..' || part.includes(sep)) {
      throw new InstallerError(`Refusing a destination with an unusable path component: ${raw}`);
    }
  }

  return join(realpathSync(ancestor), ...missing);
};

const contains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(`${parent}${sep}`);

/**
 * Trees this tool must never write into, whatever the configuration says.
 *
 * The repository is here because the destination is meant to be an *installed copy*; the home directory
 * and the filesystem root are here because a truncated or empty variable resolves to one of them.
 */
/**
 * Trees this tool must never write into, and how far that protection reaches.
 *
 * Two different kinds of protection, which an earlier version applied identically and got wrong:
 *
 * - `nothingInside` — the repository and its build output. A destination anywhere under either is
 *   refused, because the destination is meant to be an *installed copy* and deleting inside a source
 *   tree or the build's own output is exactly the accident this guards against.
 * - the home directory and the filesystem root, where only the directory **itself** is protected.
 *   Everything is under one of those, so refusing everything inside them refused every real
 *   destination — including `~/Documents/.../AbfallRadar-extension`, which is an entirely ordinary
 *   place to keep an unpacked extension.
 *
 * A destination that *contains* any of them is refused either way: installing over a directory that
 * holds your home directory or this repository would delete them.
 */
const protectedTrees = (): ReadonlyArray<{
  path: string;
  why: string;
  nothingInside: boolean;
}> => [
  { path: repositoryRoot, why: 'the repository', nothingInside: true },
  { path: outputDir, why: "the build's own output", nothingInside: true },
  { path: homedir(), why: 'your home directory itself', nothingInside: false },
  { path: parse(repositoryRoot).root, why: 'the filesystem root', nothingInside: false },
];

export const assertDestinationLocation = (destination: string): void => {
  for (const { path, why, nothingInside } of protectedTrees()) {
    if (destination === path) {
      throw new InstallerError(`Refusing to install over ${why}: ${destination}`);
    }

    if (nothingInside && contains(path, destination)) {
      throw new InstallerError(`Refusing to install inside ${why}: ${destination}`);
    }

    if (contains(destination, path)) {
      throw new InstallerError(
        `Refusing to install over a directory that contains ${why}: ${destination}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------------------------

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/** Every file under `root`, as paths relative to it. Symlinks are reported, never followed. */
export const listFiles = (root: string, prefix = ''): InstalledEntry[] => {
  const found: InstalledEntry[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isSymbolicLink()) {
      found.push({ path: relativePath, symlink: true });
    } else if (entry.isDirectory()) {
      found.push(...listFiles(root, relativePath));
    } else {
      found.push({ path: relativePath, symlink: false });
    }
  }

  return found;
};

const TOOL_IDENTITY = 'abfall-radar install-local';
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * A relative path that is safe to join onto the destination.
 *
 * An inventory is a file on disk that anyone can edit, so its keys are treated as untrusted input:
 * absolute paths, `..` segments, Windows separators and empty components are all refused. A forged
 * inventory naming `../outside` previously authorised deleting outside the destination.
 */
const isSafeRelativePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !/(^|\/)\.\.?(\/|$)/.test(value) &&
  !value.includes('//');

/**
 * The inventory, parsed strictly or not at all.
 *
 * Previously any JSON object with a `files` property was accepted — including `files: []`, entries with
 * no digest, and keys pointing outside the destination. It is this tool's own record, but it lives in a
 * directory the tool is about to delete from, so it is validated like anything else read from disk.
 */
const readInventory = (destination: string): Inventory | null => {
  const path = join(destination, INVENTORY_FILE);

  if (!existsSync(path)) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new InstallerError(
      `${path} is not valid JSON. Remove it to re-adopt the directory deliberately.`,
    );
  }

  const record = parsed as Partial<Inventory> | null;

  if (
    record === null ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    record.tool !== TOOL_IDENTITY ||
    record.version !== INVENTORY_VERSION ||
    typeof record.installedAt !== 'string' ||
    record.files === undefined ||
    typeof record.files !== 'object' ||
    Array.isArray(record.files)
  ) {
    throw new InstallerError(
      `${path} is not an inventory this tool wrote. Remove it to re-adopt the directory deliberately.`,
    );
  }

  for (const [key, digest] of Object.entries(record.files)) {
    if (!isSafeRelativePath(key)) {
      throw new InstallerError(`${path} names an unusable path: ${key}`);
    }

    if (typeof digest !== 'string' || !SHA256.test(digest)) {
      throw new InstallerError(`${path} has no valid SHA-256 for ${key}`);
    }
  }

  return record as Inventory;
};

/**
 * What this tool is allowed to remove from the destination, or a refusal.
 *
 * **Ownership is evidence, not naming.** Two things can establish it:
 *
 * - an inventory this tool wrote, whose every recorded file is still present *and still has the
 *   recorded digest*. A changed file means something else has been managing this directory, so it is
 *   refused rather than overwritten;
 * - `--adopt`, which reads the directory as a **complete extension in its own right** and owns exactly
 *   what that extension's own manifest and popup reference. That is reviewable evidence from the prior
 *   build, and it is what lets a hand-installed older build — whose content-hashed `popup-old.js` the
 *   new build has no name for — be adopted and upgraded.
 *
 * Failing to establish ownership is a refusal. Nothing is deleted on a guess, and an inventory this
 * tool wrote is not treated as proof of where the *bytes* came from — only the digests are.
 */
export const establishOwnership = (
  destination: string,
  { adopt, buildFiles }: { readonly adopt: boolean; readonly buildFiles: readonly string[] },
): { owned: Set<string>; existing: string[] } => {
  if (!existsSync(destination)) {
    return { owned: new Set(), existing: [] };
  }

  if (lstatSync(destination).isSymbolicLink()) {
    throw new InstallerError(`Refusing a destination that is a symlink: ${destination}`);
  }

  const entries = listFiles(destination);
  const links = entries.filter((entry) => entry.symlink);

  if (links.length > 0) {
    throw new InstallerError(
      `Refusing ${destination}: it contains symlinks (${links.map((link) => link.path).join(', ')}).`,
    );
  }

  const present = entries.map((entry) => entry.path);

  if (present.length === 0) {
    return { owned: new Set(), existing: present };
  }

  const inventory = readInventory(destination);

  if (inventory !== null) {
    const recorded = Object.keys(inventory.files);
    const owned = new Set([...recorded, INVENTORY_FILE]);
    const strangers = present.filter((path) => !owned.has(path));

    if (strangers.length > 0) {
      throw new InstallerError(
        [
          `Refusing ${destination}: it holds ${strangers.length} file(s) this tool did not install:`,
          ...strangers.slice(0, 10).map((path) => `  ${path}`),
          strangers.length > 10 ? `  …and ${strangers.length - 10} more` : '',
          'Move them elsewhere, or point --dest at a directory this tool owns.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    // The digests are the point of recording them: an owned file whose bytes changed is not ours.
    const altered = recorded.filter((path) => {
      const full = join(destination, path);

      return !existsSync(full) || sha256(full) !== inventory.files[path];
    });

    if (altered.length > 0) {
      throw new InstallerError(
        [
          `Refusing ${destination}: ${altered.length} file(s) it recorded have changed since:`,
          ...altered.slice(0, 10).map((path) => `  ${path}`),
          'Something else is managing this directory. Move it aside and install again.',
        ].join('\n'),
      );
    }

    return { owned, existing: present };
  }

  if (!adopt) {
    throw new InstallerError(
      [
        `Refusing ${destination}: it has contents but no ${INVENTORY_FILE}, so this tool cannot tell`,
        'which files are its own and will not delete anything.',
        '',
        'If this is an extension directory you installed by hand, adopt it once:',
        '  pnpm --filter @abfall-radar/extension install:local -- --adopt',
        '',
        'Adoption reads the directory as a complete extension and owns exactly what its own manifest',
        'and popup reference. Anything else there is refused.',
      ].join('\n'),
    );
  }

  return { owned: adoptExistingExtension(destination, present, buildFiles), existing: present };
};

/**
 * Ownership derived from the directory's **own** extension graph.
 *
 * Previously adoption asked whether each existing filename also appeared in the *new* build. That is
 * filename coincidence, not provenance: it accepted `icons/16.png` after its bytes had been replaced
 * with something unrelated, and it refused a perfectly ordinary older build whose hashed
 * `chunks/popup-old.js` the new build simply has no name for — which is precisely the upgrade case
 * adoption exists to serve.
 *
 * So the directory is validated as an extension in its own right, and what it references is what is
 * owned. `buildFiles` is used only to explain a refusal, never to authorise one.
 */
const adoptExistingExtension = (
  destination: string,
  present: readonly string[],
  buildFiles: readonly string[],
): Set<string> => {
  let manifest: ExtensionManifest;

  try {
    manifest = validateOutput(destination);
  } catch (error) {
    throw new InstallerError(
      [
        `Refusing to adopt ${destination}: it is not a complete extension.`,
        `  ${error instanceof Error ? error.message : String(error)}`,
        '',
        'Adoption needs a directory it can read as an extension, so ownership rests on that artifact',
        'rather than on filenames happening to match the new build.',
      ].join('\n'),
    );
  }

  const referenced = new Set<string>(['manifest.json']);
  const add = (value: unknown) => {
    if (typeof value === 'string' && value !== '') {
      referenced.add(value.replace(/^\.?\//, ''));
    }
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);

  for (const map of [manifest.icons, manifest.action?.default_icon]) {
    if (map !== undefined && map !== null && typeof map === 'object') {
      for (const value of Object.values(map as Record<string, unknown>)) {
        add(value);
      }
    }
  }

  const popup = manifest.action?.default_popup;

  if (typeof popup === 'string') {
    for (const [, reference] of readFileSync(join(destination, popup), 'utf8').matchAll(
      /(?:src|href)="\/([^"]+)"/g,
    )) {
      add(reference);
    }
  }

  const unexplained = present.filter((path) => path !== INVENTORY_FILE && !referenced.has(path));

  if (unexplained.length > 0) {
    throw new InstallerError(
      [
        `Refusing to adopt ${destination}: ${unexplained.length} file(s) are not part of the extension`,
        'it contains, so their ownership cannot be established:',
        ...unexplained.slice(0, 10).map((path) => `  ${path}`),
        unexplained.length > 10 ? `  …and ${unexplained.length - 10} more` : '',
        '',
        `The build this tool would install has ${buildFiles.length} files; that is not what decides`,
        'ownership here, and no file above is removed.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  say(
    `adopting ${destination}: ${present.length} file(s), all reachable from its own manifest and popup`,
  );

  return new Set([...present, INVENTORY_FILE]);
};

// ---------------------------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------------------------

const REQUIRED_ICON_SIZES = [16, 32, 48, 128];

/** Resolves a manifest-relative reference and refuses anything that escapes the output root. */
/**
 * Every entry in the build output, refused if any of them is a symlink.
 *
 * The copy into the destination runs with `dereference: true`, so a link anywhere in the tree would be
 * followed and its target's bytes installed and inventoried as if the build had produced them. A
 * fixture whose `icons` directory was a link to an external folder passed the old per-reference check,
 * because that check `lstat`ed only the final file and never canonicalised the directories above it.
 */
const assertNoSymlinksInOutput = (outputRoot: string): void => {
  /*
   * The root, before anything below it is enumerated.
   *
   * `listFiles` walks the entries *inside* a directory, so it never saw the root itself — and a symlink
   * pointing at an otherwise valid extension tree passed every check. The copy runs with
   * `dereference: true`, so that link's target would have been installed and inventoried as though this
   * build had produced it.
   */
  if (!existsSync(outputRoot)) {
    throw new InstallerError(`the build output does not exist: ${outputRoot}`);
  }

  if (lstatSync(outputRoot).isSymbolicLink()) {
    throw new InstallerError(
      `the build output root is a symlink, which will not be installed: ${outputRoot}`,
    );
  }

  if (!lstatSync(outputRoot).isDirectory()) {
    throw new InstallerError(`the build output is not a directory: ${outputRoot}`);
  }

  const links = listFiles(outputRoot)
    .filter((entry) => entry.symlink)
    .map((entry) => entry.path);

  if (links.length > 0) {
    throw new InstallerError(
      `the build output contains symlinks, which will not be installed: ${links.join(', ')}`,
    );
  }
};

const insideOutput = (outputRoot: string, reference: unknown, what: string): string => {
  if (typeof reference !== 'string' || reference === '') {
    throw new InstallerError(`${what} is missing or not a string`);
  }

  const resolved = resolve(outputRoot, reference);

  if (!contains(outputRoot, resolved) || resolved === outputRoot) {
    throw new InstallerError(`${what} escapes the build output: ${reference}`);
  }

  if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
    throw new InstallerError(`${what} names ${reference}, which the build did not emit as a file`);
  }

  /*
   * Canonical containment, not lexical. `resolve` cleans a string; it does not notice that
   * `icons/16.png` reached its bytes through a directory that is a link to somewhere else entirely.
   */
  if (!contains(realpathSync(outputRoot), realpathSync(resolved))) {
    throw new InstallerError(`${what} resolves outside the build output: ${reference}`);
  }

  return resolved;
};

/**
 * Whether a finished build is a complete, installable extension.
 *
 * Every mandatory part is required **independently**. The previous version collected the parts into one
 * array, dropped the absent ones, and asked only that something remained — so a manifest with a popup
 * and icons but *no background service worker* validated and installed. The worker owns API access,
 * storage and reminders; an extension without one is not this product.
 */
export const validateOutput = (outputRoot: string = outputDir): ExtensionManifest => {
  // The root is checked first, so nothing below a link is ever read, canonicalised or copied.
  assertNoSymlinksInOutput(outputRoot);

  const manifestPath = join(outputRoot, 'manifest.json');

  if (!existsSync(manifestPath)) {
    throw new InstallerError('the build produced no manifest.json');
  }

  let manifest: ExtensionManifest;

  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new InstallerError(
      `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (manifest.manifest_version !== 3) {
    throw new InstallerError(
      `manifest_version is ${JSON.stringify(manifest.manifest_version)}, expected 3`,
    );
  }

  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new InstallerError('manifest has no name');
  }

  insideOutput(outputRoot, manifest.background?.service_worker, 'background.service_worker');

  const popupPath = insideOutput(
    outputRoot,
    manifest.action?.default_popup,
    'action.default_popup',
  );

  for (const key of ['icons', 'action.default_icon']) {
    const icons = (key === 'icons' ? manifest.icons : manifest.action?.default_icon) as
      | Record<string, unknown>
      | undefined;

    if (icons === undefined || typeof icons !== 'object') {
      throw new InstallerError(`${key} is missing`);
    }

    for (const size of REQUIRED_ICON_SIZES) {
      insideOutput(outputRoot, icons?.[String(size)], `${key}[${size}]`);
    }
  }

  if (!Array.isArray(manifest.host_permissions) || manifest.host_permissions.length === 0) {
    throw new InstallerError('manifest requests no host permission');
  }

  // The popup's script and stylesheet are content-hashed, so they are read out of the built HTML.
  const popup = readFileSync(popupPath, 'utf8');

  for (const [, reference] of popup.matchAll(/(?:src|href)="\/([^"]+)"/g)) {
    insideOutput(outputRoot, reference, `the popup's ${reference}`);
  }

  return manifest;
};

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

/**
 * The live build, so shutdown can end it.
 *
 * Spawned into its **own process group** (`detached`), because `wxt build` is itself spawned by `pnpm`:
 * signalling the direct child alone left the real compiler running, which is exactly what the review's
 * shutdown probe observed. `process.kill(-pid, …)` signals the whole group.
 */
let activeBuild: BuildProcess | null = null;
let shuttingDown = false;

const run = (command: string, args: readonly string[], options: SpawnOptions): Promise<boolean> =>
  new Promise<boolean>((resolveRun) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
      ...options,
    });

    // The one place the boundary above is crossed; every use of `child` below is checked against it.
    const build = child as unknown as BuildProcess;

    activeBuild = build;

    const finish = (ok: boolean): void => {
      if (activeBuild === build) {
        activeBuild = null;
      }

      resolveRun(ok);
    };

    build.on('close', (code: number | null) => finish(code === 0));
    build.on('error', () => finish(false));
  });

/**
 * The canonical mark is copied to both consumers *before* compiling.
 *
 * Editing `packages/ui/src/brand/favicon.svg` used to trigger a rebuild that rasterised the extension's
 * **old** `assets/icon.svg`, so the installed extension kept the previous mark and the website's copy
 * stayed stale too. Synchronising here makes one edit reach both consumers and the generated PNGs
 * through the ordinary build, which is what the README documents.
 */
const syncBrandIcons = () => run('node', ['scripts/sync-brand-icons.mjs'], { cwd: repositoryRoot });

const runBuild = () =>
  run('pnpm', ['exec', 'wxt', 'build'], {
    cwd: extensionRoot,
    env: {
      ...process.env,
      // WXT_RELEASE is never set here, so wxt.config.ts's release-origin assertions keep guarding the
      // packaging path and this stays a development build.
      WXT_API_BASE_URL: process.env.WXT_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    },
  });

// ---------------------------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------------------------

const timestamp = (): string => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');

/**
 * Replaces the destination's contents, transactionally.
 *
 * The complete replacement is staged beside the destination and validated first, then swapped by two
 * renames. An interruption therefore leaves either the previous installation or the new one — never a
 * directory half-emptied by a copy that stopped. Only files the inventory records are ever removed, and
 * the destination is re-examined immediately before the swap, so anything that appeared during the
 * build aborts the install instead of being deleted.
 */
/** Stable, destination-bound, and beside the destination so a later process can find it. */
export const transactionPathFor = (destination: string): string =>
  `${destination}.transaction.json`;

interface TransactionRecord {
  readonly tool: string;
  readonly version: number;
  readonly destination: string;
  readonly staging: string;
  readonly previous: string;
  readonly pid: number;
  readonly startedAt: string;
}

/**
 * Finishes, or undoes, a swap that a previous run did not complete.
 *
 * A caught exception rolls back in the `finally` below, and that already worked. A **killed** process
 * has no `finally`: the review's `SIGKILL` between the two renames left the destination absent, the
 * whole old installation under a PID-named scratch directory, and the next run — which derives its own
 * scratch names from its own PID — unable to see any of it. Chrome's configured path simply stayed
 * missing.
 *
 * So the swap now writes a record first, under a name derived from the destination rather than the
 * process, and this runs at startup. Which side committed is decided by what is on disk, never guessed:
 *
 * - destination present, scratch left over → the swap committed; the leftovers are removed;
 * - destination absent, `previous` present → it did not commit; `previous` is moved back;
 * - destination absent, only `staging` present → the new build was complete and the old one is gone;
 *   staging is moved in, because that is the only installation that still exists;
 * - destination absent and neither present → refused, with instructions, rather than invented.
 */
/** The transaction identifier: a plain PID, and nothing that could be a path. */
const isTransactionId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * The only two scratch directories a record may ever name.
 *
 * Derived here, from the validated destination and the identifier — never read from the record. The
 * record's own `staging` and `previous` are compared against these and must match exactly, so a journal
 * cannot nominate a path for recursive deletion.
 */
const scratchPathsFor = (destination: string, id: number) => ({
  staging: `${destination}.staging-${id}`,
  previous: `${destination}.previous-${id}`,
});

/**
 * A scratch directory that is safe to move or remove.
 *
 * Even a correctly derived name is checked on disk before it is touched: it must be a real directory
 * rather than a symlink redirecting somewhere else, it must sit beside the destination, and it must not
 * overlap a protected tree.
 */
const assertRemovableScratch = (path: string, destination: string): boolean => {
  if (!existsSync(path)) {
    return false;
  }

  if (lstatSync(path).isSymbolicLink()) {
    throw new InstallerError(
      `${path} is a symlink, not an interrupted install. Nothing was moved or removed.`,
    );
  }

  if (!lstatSync(path).isDirectory()) {
    throw new InstallerError(
      `${path} is not a directory, so it is not an interrupted install. Nothing was moved or removed.`,
    );
  }

  if (dirname(path) !== dirname(destination)) {
    throw new InstallerError(`${path} is not beside ${destination}. Nothing was moved or removed.`);
  }

  assertDestinationLocation(path);

  return true;
};

/**
 * Finishes, or undoes, a swap that a previous run did not complete.
 *
 * A caught exception rolls back in the `finally` of `install`, which uses its **own** locally derived
 * paths and never consults a record. A *killed* process has no `finally`, so this runs at startup and
 * reads the record left beside the destination.
 *
 * **The record is evidence that something was interrupted, never authority over what to delete.** It
 * used to be cast straight from `JSON.parse` with only `tool` and `destination` checked, and its
 * `staging`/`previous` strings were then passed to `rmSync(..., { recursive: true })`. A stale or
 * malformed journal could therefore make an ordinary start recursively remove any accessible directory
 * it named — reproduced by the reviewer with two unrelated sentinel directories, both destroyed.
 *
 * So every field is parsed from `unknown` against an exact schema, the two scratch locations are
 * *derived* from the validated destination and identifier rather than read, and anything that does not
 * match leaves the record and every path it mentions untouched.
 */
export const recoverInterruptedInstall = (destination: string): void => {
  const recordPath = transactionPathFor(destination);

  if (!existsSync(recordPath)) {
    return;
  }

  const refuse: (why: string) => never = (why) => {
    throw new InstallerError(
      [
        `${recordPath} ${why}`,
        'Nothing was moved or removed.',
        '',
        'Inspect it by hand, then either delete it to continue:',
        `  rm ${recordPath}`,
        'or restore a backup if the installation is missing:',
        `  ls -d ${destination}-backup-*`,
      ].join('\n'),
    );
  };

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    refuse('records an interrupted install but is not valid JSON.');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuse('is not an interrupted-install record.');
  }

  const record = parsed as Record<string, unknown>;

  if (record.tool !== TOOL_IDENTITY || record.version !== INVENTORY_VERSION) {
    refuse(`belongs to something else (${String(record.tool)} v${String(record.version)}).`);
  }

  if (record.destination !== destination) {
    refuse(`names a different destination (${String(record.destination)}).`);
  }

  if (!isTransactionId(record.pid)) {
    refuse(`has no usable transaction identifier (${JSON.stringify(record.pid)}).`);
  }

  if (typeof record.startedAt !== 'string' || record.startedAt === '') {
    refuse('has no start time.');
  }

  const derived = scratchPathsFor(destination, record.pid);

  if (record.staging !== derived.staging || record.previous !== derived.previous) {
    refuse(
      `names scratch paths this tool would never create (${String(record.staging)}, ${String(
        record.previous,
      )}).`,
    );
  }

  const hasDestination = existsSync(destination);
  const hasPrevious = assertRemovableScratch(derived.previous, destination);
  const hasStaging = assertRemovableScratch(derived.staging, destination);

  if (hasDestination) {
    say(
      `clearing leftovers from an interrupted install (pid ${record.pid}); the installation is intact`,
    );
  } else if (hasPrevious) {
    renameSync(derived.previous, destination);
    say(`recovered the previous installation after an interrupted install (pid ${record.pid})`);
  } else if (hasStaging) {
    renameSync(derived.staging, destination);
    say(`completed an interrupted install (pid ${record.pid}); the new build was already staged`);
  } else {
    throw new InstallerError(
      [
        `An install was interrupted (pid ${record.pid}, ${record.startedAt}) and ${destination} is gone.`,
        'Neither side of the swap is on disk, so this tool will not guess which one to restore.',
        '',
        'Recover by hand:',
        `  1. look for a backup beside it:  ls -d ${destination}-backup-*`,
        `  2. copy the newest one into place:  cp -a <backup> ${destination}`,
        `  3. delete the record:  rm ${recordPath}`,
        '',
        'Or just run this command again to build and install a fresh copy.',
      ].join('\n'),
    );
  }

  // Only the derived, on-disk-checked paths are ever removed.
  rmSync(derived.staging, { recursive: true, force: true });
  rmSync(derived.previous, { recursive: true, force: true });
  rmSync(recordPath, { force: true });
};

export const install = (
  destination: string,
  {
    owned,
    takeBackup,
    outputRoot = outputDir,
  }: {
    readonly owned: ReadonlySet<string>;
    readonly takeBackup: boolean;
    readonly outputRoot?: string;
  },
): { readonly inventory: Inventory; readonly backedUp: boolean } => {
  mkdirSync(dirname(destination), { recursive: true });

  const { staging, previous } = scratchPathsFor(destination, process.pid);
  const recordPath = transactionPathFor(destination);

  rmSync(staging, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });

  let backedUp = false;

  try {
    cpSync(outputRoot, staging, { recursive: true, dereference: true });

    const files = listFiles(staging).map((entry) => entry.path);
    const inventory: Inventory = {
      tool: TOOL_IDENTITY,
      version: INVENTORY_VERSION,
      installedAt: new Date().toISOString(),
      files: Object.fromEntries(files.map((path) => [path, sha256(join(staging, path))])),
    };

    writeFileSync(join(staging, INVENTORY_FILE), `${JSON.stringify(inventory, null, 2)}\n`);

    /*
     * The last look before anything is touched. A file created in the destination while the build ran
     * is not ours to delete, so its presence ends the install with the previous build still in place.
     */
    if (existsSync(destination)) {
      const appeared = listFiles(destination)
        .map((entry) => entry.path)
        .filter((path) => !owned.has(path));

      if (appeared.length > 0) {
        throw new InstallerError(
          `${destination} gained ${appeared.length} file(s) during the build (${appeared
            .slice(0, 5)
            .join(', ')}); nothing was replaced.`,
        );
      }

      if (takeBackup) {
        const backup = `${destination}-backup-${timestamp()}`;

        cpSync(destination, backup, { recursive: true });
        backedUp = true;
        say(`backed up the previous installation to ${backup}`);
      }
    }

    /*
     * Written **before** the first rename, so a process killed between the two renames leaves something
     * the next run can find. Deleting it is the last thing the swap does.
     */
    const record: TransactionRecord = {
      tool: TOOL_IDENTITY,
      version: INVENTORY_VERSION,
      destination,
      staging,
      previous,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };

    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    if (existsSync(destination)) {
      renameSync(destination, previous);
    }

    try {
      renameSync(staging, destination);
    } catch (error) {
      if (existsSync(previous)) {
        renameSync(previous, destination);
      }

      throw error;
    }

    return { inventory, backedUp };
  } finally {
    // Whatever happened, the destination must exist and no scratch directory may be left behind.
    if (!existsSync(destination) && existsSync(previous)) {
      renameSync(previous, destination);
    }

    rmSync(staging, { recursive: true, force: true });
    rmSync(previous, { recursive: true, force: true });
    rmSync(recordPath, { force: true });
  }
};

// ---------------------------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------------------------

/**
 * Everything a build reads.
 *
 * Source **and** the metadata and configuration that decide how it is compiled: the shared packages'
 * `package.json` (their exports and dependencies), the extension's WXT config, tsconfig and env files,
 * the mark's sync script, and the workspace definition. The previous list watched only `src`
 * directories, so editing `packages/ui/package.json` or the API origin in `.env.local` produced no
 * rebuild at all.
 *
 * Output, installed copies and backups are never watched, so a build cannot retrigger itself.
 */
/**
 * Every env filename WXT's `loadEnv` consults for this production Chrome build.
 *
 * `wxt.config.ts` resolves its manifest *after* `loadEnv(mode, browser)`, which reads `.env`, then the
 * mode file, then the browser file, then the mode/browser combination, each with an optional `.local`
 * companion. Any of them changes the API origin the manifest and the compiled worker agree on, so any
 * of them is a build input.
 *
 * They are watched through the extension directory rather than by path, because a path that does not
 * exist cannot be watched — and the reviewer's case was exactly a `.env.production` **created** after
 * startup, which the old per-path list skipped forever.
 */
const WXT_ENV_FILES = new Set(
  ['.env', '.env.production', '.env.chrome', '.env.production.chrome'].flatMap((name) => [
    name,
    `${name}.local`,
  ]),
);

const WATCH_PATHS = [
  'apps/extension/entrypoints',
  'apps/extension/src',
  'apps/extension/assets',
  'apps/extension/wxt.config.ts',
  'apps/extension/tsconfig.json',
  'apps/extension/package.json',
  'packages/ui/src',
  'packages/ui/package.json',
  'packages/schedule-format/src',
  'packages/schedule-format/package.json',
  'packages/domain/src',
  'packages/domain/package.json',
  'packages/api-client/src',
  'packages/api-client/package.json',
  'scripts/sync-brand-icons.mjs',
  'pnpm-workspace.yaml',
  'tsconfig.json',
];

const IGNORED = /(^|[/\\])(node_modules|\.output|\.wxt|dist|\.turbo|coverage|\.git)([/\\]|$)/;

// ---------------------------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const watching = argv.includes('--watch');
  const adopt = argv.includes('--adopt');
  const destFlag = argv.indexOf('--dest');
  const rawDestination =
    (destFlag !== -1 ? argv[destFlag + 1] : undefined) ??
    process.env[DEST_ENV_KEY] ??
    destinationFromEnvFile();

  if (rawDestination === undefined || rawDestination === '') {
    throw new InstallerError(
      [
        'No install destination configured.',
        '',
        'Set it once, in apps/extension/.env.local (untracked):',
        `  ${DEST_ENV_KEY}=/absolute/path/to/your/unpacked/extension`,
        '',
        'or pass it per run:',
        '  pnpm --filter @abfall-radar/extension install:local -- --dest /absolute/path',
      ].join('\n'),
    );
  }

  const destination = canonicalDestination(rawDestination);

  assertDestinationLocation(destination);

  // Before anything else: finish or undo a swap a previous run was killed in the middle of.
  recoverInterruptedInstall(destination);

  /**
   * The watcher starts **before** the first build, not after it.
   *
   * Registering it afterwards left the whole initial build — seconds — unobserved, so an edit made in
   * that window was silently lost. Every event bumps a generation counter; a build records the
   * generation it started from and queues a rebuild if it has moved on by the time the build finishes.
   */
  let generation = 0;
  const watchers: FSWatcher[] = [];
  const selfWrites = new Map<string, number>();

  const noteSelfWrite = (absolutePath: string) => selfWrites.set(absolutePath, Date.now());

  const isSelfWrite = (absolutePath: string): boolean => {
    const at = selfWrites.get(absolutePath);

    if (at === undefined) {
      return false;
    }

    if (Date.now() - at > SELF_WRITE_GRACE_MS) {
      selfWrites.delete(absolutePath);

      return false;
    }

    return true;
  };

  let running = false;
  let queued = false;
  let timer: NodeJS.Timeout | undefined;
  let lastResult = false;

  const onChange = () => {
    generation += 1;

    if (!watching) {
      return;
    }

    if (running) {
      queued = true;

      return;
    }

    clearTimeout(timer);
    timer = setTimeout(() => {
      void cycle();
    }, DEBOUNCE_MS);
  };

  if (watching) {
    /*
     * The extension directory itself, non-recursively, filtered to WXT's env filenames.
     *
     * A path that does not exist cannot be watched, so the old per-path list skipped an absent
     * `.env.production` permanently — and creating one after startup changed the build's API origin
     * with no rebuild. Watching the parent sees creation, deletion and modification alike; everything
     * else in this directory (including `.output`) is filtered out by name.
     */
    try {
      watchers.push(
        watch(extensionRoot, { recursive: false }, (_event, filename) => {
          if (filename !== null && WXT_ENV_FILES.has(filename)) {
            onChange();
          }
        }),
      );
    } catch {
      // Not watchable here is not a reason to refuse to build.
    }

    for (const relativePath of WATCH_PATHS) {
      const target = join(repositoryRoot, relativePath);

      if (!existsSync(target)) {
        continue;
      }

      try {
        watchers.push(
          watch(target, { recursive: lstatSync(target).isDirectory() }, (_event, filename) => {
            if (filename && IGNORED.test(filename)) {
              return;
            }

            if (filename && isSelfWrite(join(target, filename))) {
              return;
            }

            onChange();
          }),
        );
      } catch {
        // A path that cannot be watched is not a reason to refuse to build.
      }
    }
  }

  const buildAndInstall = async (): Promise<boolean> => {
    if (shuttingDown) {
      return false;
    }

    building();

    // The consumer copies are refreshed from the canonical mark first, so one edit reaches the PNGs.
    noteSelfWrite(join(repositoryRoot, 'apps/extension/assets/icon.svg'));

    if (!(await syncBrandIcons())) {
      failed('the app mark could not be synchronised; the installed build is unchanged');

      return false;
    }

    if (shuttingDown) {
      failed('interrupted; the installed build is unchanged');

      return false;
    }

    if (!(await runBuild())) {
      failed(
        shuttingDown
          ? 'interrupted; the installed build is unchanged'
          : 'compilation failed; the installed build is unchanged',
      );

      return false;
    }

    try {
      const manifest = validateOutput();

      if (shuttingDown) {
        failed('interrupted before installing; the installed build is unchanged');

        return false;
      }

      /*
       * Resolved again, from scratch, immediately before staging. A parent directory replaced by a
       * symlink while the build ran would otherwise redirect the whole transaction, and the check that
       * ran minutes earlier would have been describing a path that no longer exists.
       */
      const current = canonicalDestination(destination);

      assertDestinationLocation(current);

      if (current !== destination) {
        throw new InstallerError(
          `${destination} now resolves to ${current}; nothing was replaced. Run the command again.`,
        );
      }

      const buildFiles = listFiles(outputDir).map((entry) => entry.path);
      const { owned } = establishOwnership(current, { adopt, buildFiles });
      const hadPreviousInstallation = existsSync(current) && listFiles(current).length > 0;
      const { inventory, backedUp } = install(current, { owned, takeBackup });

      // Cleared only once a backup has actually been taken, or there was nothing there to back up.
      if (backedUp || !hadPreviousInstallation) {
        takeBackup = false;
      }

      ready(destination);
      say(
        `${colour.dim}manifest v${manifest.manifest_version}, host ${manifest.host_permissions.join(
          ', ',
        )}, ${Object.keys(inventory.files).length} files${colour.reset}`,
      );

      return true;
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error));

      return false;
    }
  };

  /**
   * Whether the first applicable backup is still owed.
   *
   * Cleared by a successful installation that took one, never merely by a cycle having happened. It
   * used to be set false after **every** cycle, so a watch run whose first build failed to compile
   * spent its only backup opportunity on a build that never touched the destination — and the
   * replacement that followed had none.
   */
  let takeBackup = true;

  const cycle = async (): Promise<void> => {
    running = true;

    try {
      const startedAt = generation;

      lastResult = await buildAndInstall();

      if (generation !== startedAt) {
        // Inputs moved while this build ran, including during the very first one.
        queued = true;
      }
    } finally {
      running = false;
    }

    if (queued && !shuttingDown) {
      queued = false;
      await cycle();
    }
  };

  /**
   * Shutdown owns the build it started, from the **first** build onwards.
   *
   * Registering these handlers after the initial build left that whole interval — seconds — running
   * under Node's default SIGTERM behaviour, so a signal there killed the installer outright and orphaned
   * the compiler it had spawned. That is precisely the window the review's shutdown probe used.
   *
   * Watchers and the debounce timer close first so nothing new begins, `shuttingDown` blocks an install
   * that has not started, and the build's whole process group is signalled and awaited — the direct
   * child is `pnpm`, and signalling it alone left the real compiler running.
   */
  const shutdown = new Promise<void>((resolveShutdown) => {
    const stop = (signal: string): void => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      say(`received ${signal}; stopping…`);
      clearTimeout(timer);

      for (const watcher of watchers) {
        watcher.close();
      }

      const child = activeBuild;
      const pid = child?.pid;

      if (child === null || pid === undefined) {
        resolveShutdown();

        return;
      }

      say('waiting for the build to stop…');

      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolveShutdown();
        }
      };

      child.once('close', done);

      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          done();
        }
      }

      // A build that ignores SIGTERM must not hold shutdown open indefinitely.
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }

        done();
      }, 4_000).unref();
    };

    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });

  await cycle();

  if (!watching) {
    // A one-shot run reports what happened: a failed build, validation or install is a failed command.
    process.exitCode = lastResult ? 0 : 1;

    return;
  }

  if (!shuttingDown) {
    say(`watching ${watchers.length} paths. Press Ctrl+C to stop.`);
  }

  await shutdown;

  /*
   * Watch mode recovers from a failed build and keeps going, so its exit status describes the state it
   * stopped in: 0 when the last build was installed, 1 when the last build had failed or was
   * interrupted before it could be installed.
   */
  process.exitCode = lastResult ? 0 : 1;
  say(`stopped (last build ${lastResult ? 'installed' : 'failed'}).`);
};

const executedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (executedDirectly) {
  main().catch((error) => {
    console.error(
      `${colour.red}${
        error instanceof InstallerError ? error.message : (error.stack ?? error.message)
      }${colour.reset}`,
    );
    process.exit(1);
  });
}
