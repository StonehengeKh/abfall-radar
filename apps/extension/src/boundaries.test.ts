import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the extension's two hard boundaries mechanically rather than by convention.
 *
 * 1. **All HTTP lives in the background worker.** The popup reaches data through the validated message
 *    contract, so `@abfall-radar/api-client` must be unreachable from the popup entry. A popup that
 *    constructed its own request would scatter the timeout, cache, and error policy into components that
 *    are destroyed when the window closes.
 * 2. **The extension is a pure API client.** No module may import `@abfall-radar/data-providers`, because
 *    the AbfallRadar API is the extension's only data boundary and demo schedules are no longer a product
 *    surface concern.
 */

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const POPUP_ENTRY = resolve(EXTENSION_ROOT, 'entrypoints/popup/main.tsx');

const BACKGROUND_ENTRY = resolve(EXTENSION_ROOT, 'entrypoints/background.ts');

const API_CLIENT = '@abfall-radar/api-client';

const DATA_PROVIDERS = '@abfall-radar/data-providers';

/**
 * The specifier forbids whitespace and comment lines are dropped, so prose in a doc comment — this file
 * names both packages in its own header — cannot be mistaken for an import.
 */
const SPECIFIER_PATTERN = /\bfrom\s*['"]([^'"\s]+)['"]|\bimport\s*['"]([^'"\s]+)['"]/g;

const COMMENT_LINE_PATTERN = /^(?:\/\/|\/\*|\*)/;

const withoutCommentLines = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !COMMENT_LINE_PATTERN.test(line.trimStart()))
    .join('\n');

const specifiersOf = (source: string): string[] => {
  const found: string[] = [];

  for (const match of withoutCommentLines(source).matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2];

    if (specifier !== undefined) {
      found.push(specifier);
    }
  }

  return found;
};

/** Resolves a relative import and the `@/` alias the extension uses for its own root. */
const resolveLocal = (importer: string, specifier: string): string | undefined => {
  const base = specifier.startsWith('@/')
    ? resolve(EXTENSION_ROOT, specifier.slice(2))
    : resolve(dirname(importer), specifier);

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ]) {
    try {
      readFileSync(candidate, 'utf8');

      return candidate;
    } catch {
      // Try the next candidate extension.
    }
  }

  return undefined;
};

const isLocal = (specifier: string): boolean =>
  specifier.startsWith('.') || specifier.startsWith('@/');

interface Graph {
  readonly files: string[];
  readonly bareSpecifiers: string[];
}

const walkFrom = (entry: string): Graph => {
  const visited = new Set<string>();
  const bare = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop();

    if (file === undefined || visited.has(file)) {
      continue;
    }

    visited.add(file);

    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (!isLocal(specifier)) {
        bare.add(specifier);
        continue;
      }

      const resolved = resolveLocal(file, specifier);

      if (resolved === undefined) {
        throw new Error(`Unresolvable import ${specifier} from ${file}`);
      }

      pending.push(resolved);
    }
  }

  return { files: [...visited], bareSpecifiers: [...bare] };
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      return [];
    }

    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

describe('the popup entry', () => {
  const graph = walkFrom(POPUP_ENTRY);

  it('reaches more than the entry file, so the walk is actually following imports', () => {
    expect(graph.files.length).toBeGreaterThan(1);
  });

  it('cannot reach the transport client', () => {
    expect(graph.bareSpecifiers).not.toContain(API_CLIENT);
    expect(
      graph.bareSpecifiers.filter((specifier) => specifier.startsWith(`${API_CLIENT}/`)),
    ).toEqual([]);
  });

  it('reaches the messaging contract instead, which is how it gets data', () => {
    // The mirror image: proof the walk really covers the popup's data path rather than stopping early.
    const reached = graph.files.map((file) => relative(EXTENSION_ROOT, file));

    expect(reached).toContain('src/messaging/client.ts');
    expect(reached).toContain('src/messaging/contract.ts');
    expect(reached).toContain('src/hooks/use-schedule.ts');
  });

  it('imports no municipal provider', () => {
    expect(graph.bareSpecifiers).not.toContain(DATA_PROVIDERS);
  });

  it('cannot reach the schedule-cache storage module', () => {
    // The cache is owned by the worker. A UI surface that read or wrote that storage item would put the
    // range-intersection policy in two places, and the popup would be able to present a cached schedule the
    // worker had already decided was unusable.
    const reached = graph.files.map((file) => relative(EXTENSION_ROOT, file));

    expect(reached).not.toContain('src/storage/schedule-cache.ts');
  });

  it('cannot reach the settings repository, which is the only settings writer', () => {
    /**
     * The settings item is owned by the worker outright.
     *
     * This is the boundary that a module-local mutation queue could never enforce: the popup and the Manifest V3
     * worker are separate module instances, so a queue in a module variable serializes each context against
     * itself and neither against the other — two contexts read-modify-writing one key that way lose whichever
     * write landed first. Exactly one context can own the queue, so the popup must not be able to reach the
     * writer at all, and every read and write it performs is a message to the owner.
     */
    const reached = graph.files.map((file) => relative(EXTENSION_ROOT, file));

    expect(reached).not.toContain('src/storage/settings-repository.ts');
  });

  it('reaches the settings schemas but not the storage API, so a shape is shared and a writer is not', () => {
    // The mirror image: the popup legitimately needs the settings *types and defaults*, which touch no storage.
    // Proof the assertion above is about the writer rather than about settings in general.
    const reached = graph.files.map((file) => relative(EXTENSION_ROOT, file));

    expect(reached).toContain('src/storage/settings.ts');
  });
});

describe('popup-side source files', () => {
  const POPUP_OWNED = ['src/features', 'src/hooks', 'entrypoints/popup'];

  it('never import the settings repository', () => {
    /**
     * Asserted across the whole popup-owned tree rather than only the entry graph, so a module that is not
     * imported yet cannot smuggle a second settings writer in ahead of a future wiring change.
     *
     * A direct call would reintroduce the exact defect this ownership change fixes — a mutation serialized only
     * against other mutations in the same context.
     */
    const offenders = sourceFiles(EXTENSION_ROOT)
      .map((file) => relative(EXTENSION_ROOT, file))
      .filter((file) => POPUP_OWNED.some((area) => file.startsWith(area)))
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter((file) =>
        specifiersOf(readFileSync(resolve(EXTENSION_ROOT, file), 'utf8')).some((specifier) =>
          specifier.includes('storage/settings-repository'),
        ),
      );

    expect(offenders).toEqual([]);
  });

  it('never write the raw settings storage key', () => {
    // The key itself is the repository's alone. A surface naming it would be writing the item whatever it called
    // the function it wrapped it in.
    const offenders = sourceFiles(EXTENSION_ROOT)
      .map((file) => relative(EXTENSION_ROOT, file))
      .filter((file) => POPUP_OWNED.some((area) => file.startsWith(area)))
      .filter((file) =>
        readFileSync(resolve(EXTENSION_ROOT, file), 'utf8').includes('local:settings'),
      );

    expect(offenders).toEqual([]);
  });

  it('never reach the worker-side settings broadcast either', () => {
    /**
     * The popup *subscribes* to settings announcements, which is a message boundary and correct. Sending one is
     * the worker's act: a popup that could announce a settings change could make every other popup re-read on the
     * strength of nothing having happened.
     */
    const offenders = sourceFiles(EXTENSION_ROOT)
      .map((file) => relative(EXTENSION_ROOT, file))
      .filter((file) => POPUP_OWNED.some((area) => file.startsWith(area)))
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter((file) =>
        specifiersOf(readFileSync(resolve(EXTENSION_ROOT, file), 'utf8')).some((specifier) =>
          specifier.includes('background/settings-broadcast'),
        ),
      );

    expect(offenders).toEqual([]);
  });

  it('never reach the worker-side tombstone store', () => {
    // The invalidation state is enforced inside the worker's restore, so a popup that could read or write it could
    // decide for itself whether a withdrawn schedule is presentable.
    const offenders = sourceFiles(EXTENSION_ROOT)
      .map((file) => relative(EXTENSION_ROOT, file))
      .filter((file) => POPUP_OWNED.some((area) => file.startsWith(area)))
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter((file) =>
        specifiersOf(readFileSync(resolve(EXTENSION_ROOT, file), 'utf8')).some((specifier) =>
          specifier.includes('storage/schedule-tombstone'),
        ),
      );

    expect(offenders).toEqual([]);
  });

  it('never reach the extension storage API at all', () => {
    // Neither `wxt/utils/storage` nor `browser.storage`: every persisted item this extension owns belongs to the
    // worker, and a popup that could reach the API could bypass whichever owner it liked.
    const offenders = sourceFiles(EXTENSION_ROOT)
      .map((file) => relative(EXTENSION_ROOT, file))
      .filter((file) => POPUP_OWNED.some((area) => file.startsWith(area)))
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter((file) => {
        const source = readFileSync(resolve(EXTENSION_ROOT, file), 'utf8');

        return (
          specifiersOf(source).includes('wxt/utils/storage') ||
          withoutCommentLines(source).includes('browser.storage')
        );
      });

    expect(offenders).toEqual([]);
  });

  it('never import the schedule-cache storage module', () => {
    // Asserted across the whole popup-owned tree, not only the entry graph, so a module that is not imported
    // yet cannot smuggle direct cache access in ahead of a future wiring change.
    const offenders = sourceFiles(EXTENSION_ROOT)
      .map((file) => relative(EXTENSION_ROOT, file))
      .filter((file) => POPUP_OWNED.some((area) => file.startsWith(area)))
      .filter((file) =>
        specifiersOf(readFileSync(resolve(EXTENSION_ROOT, file), 'utf8')).some((specifier) =>
          specifier.includes('storage/schedule-cache'),
        ),
      );

    expect(offenders).toEqual([]);
  });

  it('covers a meaningful number of popup-owned files, so the check is not vacuous', () => {
    const covered = sourceFiles(EXTENSION_ROOT)
      .map((file) => relative(EXTENSION_ROOT, file))
      .filter((file) => POPUP_OWNED.some((area) => file.startsWith(area)));

    expect(covered.length).toBeGreaterThan(8);
  });
});

describe('the background entry', () => {
  const graph = walkFrom(BACKGROUND_ENTRY);

  it('is where the transport client really lives', () => {
    // The counterpart to the popup assertion: the boundary exists because the worker owns it, not because
    // nothing anywhere imports the client.
    expect(graph.bareSpecifiers).toContain(API_CLIENT);
  });

  it('imports no municipal provider either', () => {
    expect(graph.bareSpecifiers).not.toContain(DATA_PROVIDERS);
  });
});

describe('every extension source file', () => {
  const files = sourceFiles(EXTENSION_ROOT);

  it('imports no municipal provider anywhere, including tests and fixtures', () => {
    const offenders = files
      .filter((file) => specifiersOf(readFileSync(file, 'utf8')).includes(DATA_PROVIDERS))
      .map((file) => relative(EXTENSION_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('declares no dependency on the municipal provider package', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(resolve(EXTENSION_ROOT, 'package.json'), 'utf8'),
    );
    const serialized = JSON.stringify(manifest);

    expect(serialized).not.toContain(DATA_PROVIDERS);
    expect(serialized).toContain(API_CLIENT);
  });

  it('scans a meaningful number of files, so the checks above are not vacuous', () => {
    expect(files.length).toBeGreaterThan(20);
  });
});
