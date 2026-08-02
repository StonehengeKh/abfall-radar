import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the package boundary mechanically rather than by convention.
 *
 * `@abfall-radar/api-client` is resolved by the browser extension and, later, by the web and mobile
 * applications. It must stay browser-safe and transport-only: no Fastify, no `node:*` built-in, nothing
 * from `apps/api`, no `@abfall-radar/data-providers`, and deliberately no `@abfall-radar/domain` either,
 * because transport models and domain models stay separate.
 *
 * The **complete** set of bare specifiers is asserted rather than the absence of a few known-bad ones,
 * so a new dependency cannot slip in unnoticed. This walk is modelled on
 * `packages/data-providers/src/browser-boundary.test.ts`.
 *
 * This file itself reads the file system, which is why the package carries a test-only `@types/node`.
 * That makes Node globals type-visible to every file in the package, so the compiler alone would no
 * longer reject a stray `node:crypto` import in production code — and this guard is what replaces it.
 * The last assertion below therefore checks that no source file outside this one imports a Node
 * built-in at all, not only that the entry graph avoids them.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const ROOT_ENTRY = resolve(SRC_DIR, 'index.ts');

/**
 * Matches `from '…'` and bare `import '…'`.
 *
 * The specifier deliberately forbids whitespace: a module specifier never contains a space, and prose
 * does. Without that constraint, an ordinary English sentence in a doc comment — the generated module
 * really contains `… a different statement from "this source does not cover this waste type"` — is
 * indistinguishable from an import, and the guard reports a dependency nobody declared.
 */
const SPECIFIER_PATTERN = /\bfrom\s*['"]([^'"\s]+)['"]|\bimport\s*['"]([^'"\s]+)['"]/g;

/** Trimmed lines that begin a comment or continue a JSDoc block. */
const COMMENT_LINE_PATTERN = /^(?:\/\/|\/\*|\*)/;

/**
 * Drops comment lines before scanning. Together with the whitespace-free specifier above this keeps
 * documentation out of the import graph, which matters most for the generated module: its doc comments
 * are copied from the API's own descriptions and are not written with this walk in mind.
 */
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

  it('imports exactly one third-party package and nothing else', () => {
    // The whole set, not a deny-list: a dependency added anywhere under the barrel fails this test.
    expect(graph.bareSpecifiers.toSorted()).toEqual(['zod']);
  });

  it('imports no Node built-in', () => {
    const builtins = graph.bareSpecifiers.filter(
      (specifier) =>
        specifier.startsWith('node:') ||
        ['crypto', 'fs', 'path', 'stream', 'url', 'buffer'].includes(specifier),
    );

    expect(builtins).toEqual([]);
  });

  it('imports no server framework', () => {
    const serverPackages = graph.bareSpecifiers.filter(
      (specifier) => specifier === 'fastify' || specifier.startsWith('@fastify/'),
    );

    expect(serverPackages).toEqual([]);
  });

  it('imports no other workspace package, including the domain', () => {
    // Transport models and domain models stay separate: this package owns the wire shape, the domain
    // owns the business model, and mapping between them belongs to a consumer.
    expect(
      graph.bareSpecifiers.filter((specifier) => specifier.startsWith('@abfall-radar/')),
    ).toEqual([]);
  });

  it('reaches nothing outside this package', () => {
    const outside = graph.files
      .filter((file) => !file.startsWith(`${SRC_DIR}/`) && file !== ROOT_ENTRY)
      .map((file) => relative(SRC_DIR, file));

    expect(outside).toEqual([]);
  });

  it('does not mistake prose in a doc comment for an import', () => {
    // The generated module's descriptions are copied from the API's own contract text and really do
    // contain `from "…"`. Without this the guard would report a dependency nobody declared, and the
    // obvious "fix" would be to loosen the assertion that makes it useful.
    expect(
      specifiersOf(
        [
          '/**',
          ' * … a different statement from "this source does not cover this waste type".',
          ' */',
          "// from 'commented-out-package'",
          "import { real } from './real-module';",
        ].join('\n'),
      ),
    ).toEqual(['./real-module']);
  });

  it('includes the generated transport types and the hand-written validators', () => {
    // The mirror image of the assertions above: proof the walk really reaches the modules whose
    // dependencies matter, rather than passing because it stopped at the barrel.
    const reached = graph.files.map((file) => relative(SRC_DIR, file)).toSorted();

    expect(reached).toContain('generated/api.ts');
    expect(reached).toContain('contracts/collection-events.ts');
    expect(reached).toContain('contracts/problem-details.ts');
    expect(reached).toContain('client.ts');
  });
});

describe('every source file in the package', () => {
  const GUARD_FILE = 'import-graph.test.ts';

  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return sourceFiles(path);
      }

      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    });

  it('imports a Node built-in only from this guard', () => {
    // The package carries a test-only `@types/node` so this file can read sources, which means the
    // compiler no longer rejects a stray `node:*` import in production code. This is that check.
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => relative(SRC_DIR, file) !== GUARD_FILE)
      .filter((file) =>
        specifiersOf(readFileSync(file, 'utf8')).some((specifier) => specifier.startsWith('node:')),
      )
      .map((file) => relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });

  it('finds this guard itself, so the check above is really scanning files', () => {
    const scanned = sourceFiles(SRC_DIR).map((file) => relative(SRC_DIR, file));

    expect(scanned).toContain(GUARD_FILE);
    expect(
      specifiersOf(readFileSync(resolve(SRC_DIR, GUARD_FILE), 'utf8')).filter((specifier) =>
        specifier.startsWith('node:'),
      ).length,
    ).toBeGreaterThan(0);
  });
});
