import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the browser-safe package root.
 *
 * `@abfall-radar/data-providers` is resolved by the browser extension. Official ingestion lives behind
 * the `./node` subpath and reaches Node built-ins and a calendar parser, none of which may enter a
 * browser bundle. A stray `export * from './node/...'` in the root barrel would do exactly that
 * without any other test noticing, so the import graph itself is asserted.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const ROOT_ENTRY = resolve(SRC_DIR, 'index.ts');

const NODE_AREA = resolve(SRC_DIR, 'node');

/** Matches `from '…'` and bare `import '…'`, which is every static specifier form used here. */
const SPECIFIER_PATTERN = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

const specifiersOf = (source: string): string[] => {
  const found: string[] = [];

  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2];

    if (specifier !== undefined) {
      found.push(specifier);
    }
  }

  return found;
};

const resolveRelative = (importer: string, specifier: string): string => {
  const base = resolve(dirname(importer), specifier);

  for (const candidate of [base, `${base}.ts`, resolve(base, 'index.ts')]) {
    try {
      readFileSync(candidate, 'utf8');

      return candidate;
    } catch {
      // Try the next candidate extension.
    }
  }

  throw new Error(`Unresolvable import ${specifier} from ${importer}`);
};

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
      if (specifier.startsWith('.')) {
        pending.push(resolveRelative(file, specifier));
        continue;
      }

      bare.add(specifier);
    }
  }

  return { files: [...visited], bareSpecifiers: [...bare] };
};

describe('the package root export', () => {
  const graph = walkFrom(ROOT_ENTRY);

  it('reaches more than the entry file, so the walk is actually following imports', () => {
    expect(graph.files.length).toBeGreaterThan(1);
  });

  it('reaches no module under the Node-only area', () => {
    const leaked = graph.files
      .filter((file) => file.startsWith(`${NODE_AREA}/`) || file === NODE_AREA)
      .map((file) => relative(SRC_DIR, file));

    expect(leaked).toEqual([]);
  });

  it('imports no Node built-in', () => {
    const builtins = graph.bareSpecifiers.filter(
      (specifier) => specifier.startsWith('node:') || specifier === 'crypto' || specifier === 'fs',
    );

    expect(builtins).toEqual([]);
  });

  it('imports no calendar parser', () => {
    const parsers = graph.bareSpecifiers.filter(
      (specifier) => specifier === 'node-ical' || specifier.startsWith('node-ical/'),
    );

    expect(parsers).toEqual([]);
  });

  it('imports only browser-safe workspace and third-party packages', () => {
    expect(graph.bareSpecifiers.toSorted()).toEqual(['@abfall-radar/domain', 'date-fns']);
  });
});

describe('the Node-only subpath', () => {
  const graph = walkFrom(resolve(NODE_AREA, 'index.ts'));

  it('is where the calendar parser and node:crypto actually live', () => {
    // The mirror image of the assertions above: proof the guard would catch a leak rather than passing
    // because nothing anywhere imports these.
    expect(graph.bareSpecifiers).toContain('node-ical');
    expect(graph.bareSpecifiers).toContain('node:crypto');
  });
});
