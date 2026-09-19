// @vitest-environment node
/**
 * The web workspace's boundary guards, enforced mechanically rather than by convention.
 *
 * - Check 1: first-party production source hard-codes no absolute HTTP(S) URL.
 * - Check 1b: nothing a production build admits reaches a protected test or fixture file.
 * - Checks 3 and 4: the development proxy target and context are exactly the documented ones.
 * - The closed HTML source shell and closed build inputs.
 * - The adapter-only `api-client` and `fetch` rules, forbidden packages, and ambient date helpers.
 * - Tailwind content discovery: automatic discovery off, and no protected file in the effective scan.
 *
 * The emitted-output scan (Check 2) is not here: it reads `dist`, which ordinary tests never do.
 */

import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import ts from 'typescript';
import { loadConfigFromFile, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  describeProblem,
  type Edge,
  type FileSystem,
  type GraphReport,
  isProtected,
  nodeFileSystem,
  walkProductionGraph,
} from '@/src/test/dependency-graph';

const WEB_ROOT = resolve(__dirname, '..');
const REPOSITORY_ROOT = resolve(WEB_ROOT, '../..');
const SOURCE_ROOT = join(WEB_ROOT, 'src');
const UI_SOURCE_ROOT = join(REPOSITORY_ROOT, 'packages/ui/src');
const FORBIDDEN_PACKAGES = new Set(['@abfall-radar/data-providers', '@abfall-radar/extension']);
/** Colocated test modules, which content discovery must never reach. */
const TEST_SOURCE = /\.(?:test|spec)\.tsx?$/;
const ENTRY_CHAIN: readonly Edge[] = [
  {
    importer: join(WEB_ROOT, 'index.html'),
    specifier: '/src/main.tsx',
    resolved: join(SOURCE_ROOT, 'main.tsx'),
  },
];

/**
 * The closed HTML source shell, transcribed independently from AR-005. It is never generated from the
 * file under test.
 *
 * One resource link is part of the shell, added by ADR 0005 addendum 3: the favicon, referenced by its
 * path inside `src/` so Vite resolves, hashes and emits it like every other shipped output. The shell
 * stays closed — anything beyond this exact text is still a deviation.
 */
const FAVICON_SPECIFIER = '/src/assets/favicon.svg';
const EXPECTED_INDEX_HTML = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" type="image/svg+xml" href="${FAVICON_SPECIFIER}">
    <title>AbfallRadar</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const listFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      return [];
    }

    const path = join(directory, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });

const isScript = (file: string): boolean => /\.tsx?$/.test(file);

/** First-party production source: `src/**`, with tests and `src/test/**` excluded. */
const productionSources = (): string[] =>
  listFiles(SOURCE_ROOT).filter((file) => isScript(file) && !isProtected(file, WEB_ROOT));

const parse = (file: string, text = readFileSync(file, 'utf8')): ts.SourceFile =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/** The module specifiers a file names itself — imports and re-exports — not what it reaches. */
const ownSpecifiers = (sourceFile: ts.SourceFile): string[] => {
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return specifiers;
};

const callsFetch = (sourceFile: ts.SourceFile): boolean => {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;

      if (name === 'fetch') {
        found = true;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return found;
};

const inAdapters = (file: string): boolean =>
  relative(join(SOURCE_ROOT, 'adapters'), file).split(sep)[0] !== '..';

const walkReal = (): GraphReport =>
  walkProductionGraph(
    join(SOURCE_ROOT, 'main.tsx'),
    {
      fs: nodeFileSystem,
      webRoot: WEB_ROOT,
      repositoryRoot: REPOSITORY_ROOT,
      forbiddenPackages: FORBIDDEN_PACKAGES,
    },
    ENTRY_CHAIN,
  );

/** The real file system with in-memory files layered over it, so rejection cases write nothing. */
const overlay = (files: Readonly<Record<string, string>>): FileSystem => {
  const absolute = new Map(
    Object.entries(files).map(([path, text]) => [resolve(WEB_ROOT, path), text]),
  );

  return {
    readFile: (path) => absolute.get(path) ?? nodeFileSystem.readFile(path),
    isFile: (path) => absolute.has(path) || nodeFileSystem.isFile(path),
    isDirectory: (path) => nodeFileSystem.isDirectory(path),
    realpath: (path) => (absolute.has(path) ? path : nodeFileSystem.realpath(path)),
  };
};

/** Walks an in-memory entry at `src/main.tsx` with the given overlay. */
const walkVirtual = (files: Readonly<Record<string, string>>): GraphReport =>
  walkProductionGraph(
    join(SOURCE_ROOT, 'main.tsx'),
    {
      fs: overlay(files),
      webRoot: WEB_ROOT,
      repositoryRoot: REPOSITORY_ROOT,
      forbiddenPackages: FORBIDDEN_PACKAGES,
    },
    ENTRY_CHAIN,
  );

const kinds = (report: GraphReport): string[] => report.problems.map((problem) => problem.kind);

describe('the closed HTML source shell and build inputs', () => {
  it('matches the documented template, allowing only CRLF and the final line feed to differ', () => {
    const actual = readFileSync(join(WEB_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
    const normalize = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

    expect(normalize(actual)).toBe(EXPECTED_INDEX_HTML);
  });

  it('builds with `vite build` and no CLI entry or config override', () => {
    const manifest = JSON.parse(readFileSync(join(WEB_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.build).toBe('vite build');
  });

  it('resolves the root, no public directory, no library mode, and only the default HTML entry', async () => {
    const config = await resolveConfig(
      { configFile: join(WEB_ROOT, 'vite.config.ts') },
      'build',
      'production',
      'production',
    );

    expect(config.root).toBe(WEB_ROOT);
    // Vite represents `publicDir: false` as an empty string once resolved.
    expect(config.publicDir).toBe('');
    expect(config.build.lib).toBe(false);
    expect(config.build.rollupOptions.input).toBeUndefined();
  });

  it('declares only the React and Tailwind integrations', async () => {
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      join(WEB_ROOT, 'vite.config.ts'),
    );
    // Flattened by hand: `Array#flat(Infinity)` over Vite's recursive plugin option type exhausts the
    // checker's instantiation depth.
    const flatten = (value: unknown): unknown[] =>
      Array.isArray(value) ? value.flatMap(flatten) : [value];
    const names = flatten(loaded?.config.plugins ?? []).map((plugin) =>
      plugin !== null && typeof plugin === 'object' && 'name' in plugin ? String(plugin.name) : '',
    );

    expect(
      names.every((name) => name.startsWith('vite:react') || name.startsWith('@tailwindcss/vite')),
    ).toBe(true);
    expect(names.some((name) => name.startsWith('vite:react'))).toBe(true);
    expect(names.some((name) => name.startsWith('@tailwindcss/vite'))).toBe(true);
  });

  it('rejects a further resource link as a deviation from the shell', () => {
    for (const extra of [
      '<link rel="stylesheet" href="/src/app/styles.css">',
      '<link rel="icon" sizes="32x32" href="/src/assets/favicon.svg">',
      '<link rel="apple-touch-icon" href="/src/assets/favicon.svg">',
    ]) {
      expect(EXPECTED_INDEX_HTML.replace('<title>', `${extra}\n    <title>`)).not.toBe(
        EXPECTED_INDEX_HTML,
      );
    }
  });

  describe('the shell favicon', () => {
    const head = (): string => readFileSync(join(WEB_ROOT, 'index.html'), 'utf8');

    it('declares exactly one icon link, typed, and no other', () => {
      const links = [...head().matchAll(/<link\b[^>]*>/g)].map(([tag]) => tag);
      const icons = links.filter((tag) => /rel="(?:[^"]*\s)?icon(?:\s[^"]*)?"/.test(tag));

      expect(links).toHaveLength(1);
      expect(icons).toHaveLength(1);
      expect(icons[0]).toContain('type="image/svg+xml"');
      expect(icons[0]).toContain(`href="${FAVICON_SPECIFIER}"`);
      // No second declaration anywhere else in the shell, whatever its spelling.
      expect(head()).not.toMatch(/apple-touch-icon|shortcut icon|manifest/i);
    });

    it('resolves to an audited source file, not a verbatim copy', () => {
      const source = join(WEB_ROOT, FAVICON_SPECIFIER.replace(/^\//, ''));

      // Inside `src/`, so Vite resolves it through the module graph and the emitted asset is hashed.
      expect(existsSync(source)).toBe(true);
      expect(relative(SOURCE_ROOT, source).startsWith('..')).toBe(false);
      // Not a protected test file, and not reachable through a public directory that does not exist.
      expect(isProtected(source, WEB_ROOT)).toBe(false);
      expect(existsSync(join(WEB_ROOT, 'public'))).toBe(false);
      expect(FAVICON_SPECIFIER.startsWith('/src/')).toBe(true);
    });

    it('is self-contained: no script, no stylesheet, no external resource', () => {
      const svg = readFileSync(join(WEB_ROOT, FAVICON_SPECIFIER.replace(/^\//, '')), 'utf8');

      expect(svg).not.toMatch(/<script|<style|@import|<image\b|xlink:href|url\(/i);
      // The only absolute URL is the SVG namespace name, which names a vocabulary, not a place to fetch.
      expect([...svg.matchAll(/https?:\/\/[^"'\s>]+/g)].map(([url]) => url)).toEqual([
        'http://www.w3.org/2000/svg',
      ]);
    });
  });
});

describe('checks 3 and 4: the development proxy', () => {
  it('targets exactly the documented loopback API under the segment-aware context', async () => {
    const config = await resolveConfig(
      { configFile: join(WEB_ROOT, 'vite.config.ts') },
      'serve',
      'development',
      'development',
    );

    expect(Object.keys(config.server.proxy ?? {})).toEqual(['^/api(?:/|$)']);
    expect(config.server.proxy?.['^/api(?:/|$)']).toMatchObject({
      target: 'http://127.0.0.1:3000',
    });
  });

  it('matches the API paths and none of the near misses a prefix key would capture', async () => {
    const config = await resolveConfig(
      { configFile: join(WEB_ROOT, 'vite.config.ts') },
      'serve',
      'development',
      'development',
    );
    const [key] = Object.keys(config.server.proxy ?? {});
    // Built from the resolved configuration, so this exercises the context Vite actually uses.
    const context = new RegExp(key ?? '(?!)');

    for (const path of ['/api', '/api/', '/api/v1/providers']) {
      expect(context.test(path), path).toBe(true);
    }

    for (const path of ['/apiary', '/api-old', '/apis', '/application']) {
      expect(context.test(path), path).toBe(false);
    }
  });
});

describe('check 1: first-party production source hard-codes no absolute URL', () => {
  /** Literal text as JavaScript represents it, and JSX text and attributes as HTML represents them. */
  const representedTexts = (sourceFile: ts.SourceFile): string[] => {
    const texts: string[] = [];
    const decodeHtml = (value: string): string => new DOMParserShim().decode(value);

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent)) {
        texts.push(decodeHtml(node.getText(sourceFile).slice(1, -1)));
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        texts.push(node.text);
      } else if (ts.isTemplateExpression(node)) {
        texts.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
      } else if (ts.isJsxText(node)) {
        texts.push(decodeHtml(node.getText(sourceFile)));
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return texts;
  };

  it('scans a meaningful number of production files', () => {
    expect(productionSources().length).toBeGreaterThanOrEqual(6);
  });

  it('finds no absolute HTTP(S) URL in any represented literal, JSX text, or JSX attribute', () => {
    const offenders = productionSources().flatMap((file) =>
      representedTexts(parse(file))
        .filter((text) => /https?:\/\//i.test(text))
        .map((text) => `${relative(WEB_ROOT, file)}: ${text}`),
    );

    expect(offenders).toEqual([]);
  });

  it('decodes an HTML character reference in a JSX attribute before matching', () => {
    const source = parse(
      join(SOURCE_ROOT, 'virtual.tsx'),
      'export const Link = () => <a href="https&#58;&#47;&#47;react.dev/errors/">x</a>;',
    );

    expect(representedTexts(source).some((text) => /https?:\/\//i.test(text))).toBe(true);
  });
});

/** HTML character-reference decoding for JSX text, without a DOM: TypeScript leaves it undecoded. */
class DOMParserShim {
  decode(value: string): string {
    return value
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
        String.fromCodePoint(Number.parseInt(code, 16)),
      )
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
      .replace(/&colon;/g, ':')
      .replace(/&sol;/g, '/')
      .replace(/&amp;/g, '&');
  }
}

describe('check 1b: the production dependency guard', () => {
  it('reaches no protected file from the real production entry', () => {
    const report = walkReal();

    expect(report.problems.map((problem) => describeProblem(problem, REPOSITORY_ROOT))).toEqual([]);
  });

  it('walks the whole first-party graph, including the workspace packages and both stylesheets', () => {
    const report = walkReal();
    const relativeScripts = report.visitedScripts.map((file) => relative(REPOSITORY_ROOT, file));

    expect(report.visitedScripts.length).toBeGreaterThanOrEqual(20);
    expect(relativeScripts).toContain('apps/web/src/main.tsx');
    expect(relativeScripts).toContain('packages/api-client/src/index.ts');
    expect(relativeScripts).toContain('packages/domain/src/index.ts');
    expect(relativeScripts).toContain('packages/ui/src/index.ts');
    expect(report.visitedStylesheets.map((file) => relative(REPOSITORY_ROOT, file))).toEqual([
      'apps/web/src/app/styles.css',
      'packages/ui/src/styles.css',
    ]);
  });

  it('stops at third-party packages after checking their identity', () => {
    const report = walkReal();

    expect([...report.thirdParty.keys()]).toEqual(
      expect.arrayContaining([
        'react@19.2.8',
        'react-dom@19.2.8',
        'zod@4.4.3',
        'tailwindcss@4.3.3',
      ]),
    );
    expect(report.visitedScripts.some((file) => file.includes(`${sep}node_modules${sep}`))).toBe(
      false,
    );
  });

  describe('rejects forbidden reachability', () => {
    const FIXTURE = 'src/test/build-output-fixtures/react.ts';
    const REACT_FIXTURE = {
      [FIXTURE]: "export const REACT_DIAGNOSTIC_PREFIX = 'https://react.dev/errors/';\n",
    };

    const rejects = (files: Record<string, string>, kind: string): GraphReport => {
      const report = walkVirtual(files);

      expect(kinds(report)).toContain(kind);

      return report;
    };

    it('a direct aliased import of a fixture exporting a sanctioned value, with the full chain', () => {
      const report = rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx':
            "import { REACT_DIAGNOSTIC_PREFIX } from '@/src/test/build-output-fixtures/react';\n",
        },
        'protected-target',
      );
      const [problem] = report.problems;

      expect(problem?.chain.map((edge) => edge.specifier)).toEqual([
        '/src/main.tsx',
        '@/src/test/build-output-fixtures/react',
      ]);
    });

    it('an indirect chain through a production-looking module', () => {
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx': "import { value } from './adapters/wrapper';\n",
          'src/adapters/wrapper.ts':
            "export { REACT_DIAGNOSTIC_PREFIX as value } from '../test/build-output-fixtures/react';\n",
        },
        'protected-target',
      );
    });

    it('a barrel re-export, a side-effect import, and a query-suffixed import', () => {
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx': "export * from '@/src/test/build-output-fixtures/react';\n",
        },
        'protected-target',
      );
      rejects(
        { ...REACT_FIXTURE, 'src/main.tsx': "import '@/src/test/build-output-fixtures/react';\n" },
        'protected-target',
      );
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx': "import raw from '@/src/test/build-output-fixtures/react?raw';\n",
        },
        'protected-target',
      );
    });

    it('a literal and a no-substitution-template dynamic import', () => {
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx': "void import('@/src/test/build-output-fixtures/react');\n",
        },
        'protected-target',
      );
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx': 'void import(`@/src/test/build-output-fixtures/react`);\n',
        },
        'protected-target',
      );
    });

    it('imports beside comments, which are trivia rather than line markers', () => {
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx': "/* c */ import '@/src/test/build-output-fixtures/react';\n",
        },
        'protected-target',
      );
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx': "/*\n multiline\n */ import '@/src/test/build-output-fixtures/react';\n",
        },
        'protected-target',
      );
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx': "void import(/* why */ '@/src/test/build-output-fixtures/react');\n",
        },
        'protected-target',
      );
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx':
            "/* a */ export { REACT_DIAGNOSTIC_PREFIX } from '@/src/test/build-output-fixtures/react'; /* b */\n",
        },
        'protected-target',
      );
    });

    it('a colocated test module reached from production', () => {
      rejects(
        { 'src/main.tsx': "import './app/app.test';\n", 'src/app/app.test.tsx': 'export {};\n' },
        'protected-target',
      );
    });

    it('a workspace re-export chain reaching a protected fixture', () => {
      rejects(
        {
          ...REACT_FIXTURE,
          'src/main.tsx': "import '@abfall-radar/ui';\n",
          '../../packages/ui/src/index.ts':
            "export * from '../../../apps/web/src/test/build-output-fixtures/react';\n",
        },
        'protected-target',
      );
    });

    it('stylesheets: the reported URL-free @import chain, an extra hop, variants, and a url() resource', () => {
      const banner = { 'src/test/build-output-fixtures/banner.css': '.banner { color: red; }\n' };

      rejects(
        {
          ...banner,
          'src/main.tsx': "import './app/virtual.css';\n",
          'src/app/virtual.css': '@import "../test/build-output-fixtures/banner.css";\n',
        },
        'protected-target',
      );
      rejects(
        {
          ...banner,
          'src/main.tsx': "import './app/virtual.css';\n",
          'src/app/virtual.css': '@import "./hop.css";\n',
          'src/app/hop.css':
            '@import url("../test/build-output-fixtures/banner.css") layer(base);\n',
        },
        'protected-target',
      );
      rejects(
        {
          ...banner,
          'src/main.tsx': "import './app/virtual.css';\n",
          'src/app/virtual.css':
            '@import "@/src/test/build-output-fixtures/banner.css" supports(display: grid);\n',
        },
        'protected-target',
      );
      rejects(
        {
          'src/test/build-output-fixtures/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
          'src/main.tsx': "import './app/virtual.css';\n",
          'src/app/virtual.css':
            '.logo { background: url(../test/build-output-fixtures/logo.svg); }\n',
        },
        'protected-target',
      );
    });

    it('stylesheets: `image-set()` string candidates, in every supported spelling (review R4)', () => {
      const svg = {
        'src/test/build-output-fixtures/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      };
      const target = '../test/build-output-fixtures/logo.svg';

      // A real Vite 8 production build resolves a string candidate exactly like `url()` and inlined a
      // protected SVG as a `data:` URL while this guard reported nothing. Every spelling of the
      // function, and an escaped string, must now reach the same protected-target check.
      const spellings = [
        `image-set("${target}" 1x)`,
        `image-set('${target}' 1x, "./other.svg" 2x)`,
        `image-set("./other.svg" 1x, "${target}" 2x)`,
        `IMAGE-SET("${target}" 1x)`,
        `-webkit-image-set("${target}" 1x)`,
        `\\69 mage-set("${target}" 1x)`,
        `image-set("../te\\73 t/build-output-fixtures/logo.svg" 1x)`,
        `image-set("${target}" type("image/svg+xml"))`,
        `cross-fade(image-set("${target}" 1x), url("./other.svg"))`,
      ];

      // The bytes are asserted, so no host-language escape silently turns into a different spelling:
      // a CSS identifier escape for "i", and a CSS string escape for "s".
      expect(spellings[5]?.startsWith('\\69 mage-set(')).toBe(true);
      expect(spellings[6]).toContain('te\\73 t/');

      for (const spelling of spellings) {
        const report = rejects(
          {
            ...svg,
            'src/app/other.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
            'src/main.tsx': "import './app/virtual.css';\n",
            'src/app/virtual.css': `.logo { background-image: ${spelling}; }\n`,
          },
          'protected-target',
        );

        // The chain names the stylesheet and the specifier as written.
        expect(
          report.problems.find((problem) => problem.kind === 'protected-target')?.chain.at(-1),
        ).toMatchObject({ importer: join(WEB_ROOT, 'src', 'app', 'virtual.css') });
      }
    });

    it('stylesheets: an `image-set()` metadata string is not a resource, and an unknown prefix is refused', () => {
      // `type("image/avif")` is a MIME type, not a file: following it would report a missing resource.
      const metadata = walkVirtual({
        'src/main.tsx': "import './app/a.css';\n",
        'src/app/a.css':
          '.a { background-image: image-set("./logo.svg" type("image/svg+xml") 1x, url("./logo.svg") 2x); }\n',
        'src/app/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      });

      expect(metadata.problems).toEqual([]);
      expect(metadata.leafResources.map((file) => relative(WEB_ROOT, file))).toEqual([
        join('src', 'app', 'logo.svg'),
        join('src', 'app', 'logo.svg'),
      ]);

      // Remote and inline candidates load nothing from the repository.
      expect(
        walkVirtual({
          'src/main.tsx': "import './app/b.css';\n",
          'src/app/b.css':
            '.b { background-image: image-set("data:image/svg+xml,%3Csvg/%3E" 1x, "https://example.test/x.png" 2x); }\n',
        }).problems,
      ).toEqual([]);

      // A vendor spelling the guard does not model is rejected rather than trusted.
      rejects(
        {
          'src/main.tsx': "import './app/c.css';\n",
          'src/app/c.css': '.c { background-image: -moz-image-set("./logo.svg" 1x); }\n',
          'src/app/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
        },
        'unsupported-form',
      );
    });

    it('stylesheets: an `image()` string source, in every spelling (review R4 follow-up)', () => {
      const svg = {
        'src/test/build-output-fixtures/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      };
      const target = '../test/build-output-fixtures/logo.svg';

      // `image( [ltr|rtl]? [<url>|<string>]? , <color>? )`: the string source is a URL like `url()`.
      const spellings = [
        `image("${target}")`,
        `image('${target}')`,
        `image(ltr "${target}")`,
        `image(RTL "${target}", red)`,
        `IMAGE("${target}")`,
        `\\69 mage("${target}")`,
        `image("../te\\73 t/build-output-fixtures/logo.svg")`,
        `image(url("${target}"), red)`,
        `cross-fade(image("${target}"), red 50%)`,
      ];

      expect(spellings[5]?.startsWith('\\69 mage(')).toBe(true);
      expect(spellings[6]).toContain('te\\73 t/');

      for (const spelling of spellings) {
        const report = rejects(
          {
            ...svg,
            'src/main.tsx': "import './app/virtual.css';\n",
            'src/app/virtual.css': `.logo { background-image: ${spelling}; }\n`,
          },
          'protected-target',
        );

        expect(
          report.problems.find((problem) => problem.kind === 'protected-target')?.chain.at(-1),
        ).toMatchObject({ importer: join(WEB_ROOT, 'src', 'app', 'virtual.css') });
      }
    });

    it('stylesheets: `image()` colours and inline sources load nothing; malformed and unmodelled forms are refused', () => {
      const accepted = walkVirtual({
        'src/main.tsx': "import './app/a.css';\n",
        'src/app/a.css': [
          '.a { background-image: image("./logo.svg"); }',
          '.b { background-image: image(ltr "./logo.svg", red); }',
          '.c { background-image: image(red); }',
          '.d { background-image: image(rgb(0 0 255 / 50%)); }',
          '.e { background-image: image("data:image/svg+xml,%3Csvg/%3E"); }',
          '.f { font-family: local("Fixture"); }',
        ].join('\n'),
        'src/app/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      });

      expect(accepted.problems).toEqual([]);
      expect(accepted.leafResources.map((file) => relative(WEB_ROOT, file))).toEqual([
        join('src', 'app', 'logo.svg'),
        join('src', 'app', 'logo.svg'),
      ]);

      const refused = (css: string): void => {
        rejects(
          {
            'src/main.tsx': "import './app/r.css';\n",
            'src/app/r.css': css,
            'src/app/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
          },
          'unsupported-form',
        );
      };

      // A string after the colour separator, and a second separator, are not valid `image()` syntax.
      refused('.r { background-image: image(red, "./logo.svg"); }\n');
      refused('.r { background-image: image("./logo.svg", red, blue); }\n');
      // `src()` can hide its target in a `var()`, so it is refused rather than trusted.
      refused('.r { background-image: src("./logo.svg"); }\n');
      refused('.r { --logo: "./logo.svg"; background-image: src(var(--logo)); }\n');
      // Vendor spellings of any resource-bearing function the guard does not model.
      for (const name of [
        '-webkit-image',
        '-moz-image',
        '-moz-image-set',
        '-o-url',
        '-webkit-src',
      ]) {
        refused(`.r { background-image: ${name}("./logo.svg"); }\n`);
      }
    });

    it('stylesheets: `url()` in any case and with identifier escapes, in a property and in @import', () => {
      const svg = {
        'src/test/build-output-fixtures/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      };
      const target = '../test/build-output-fixtures/logo.svg';

      // A separate build with Vite and Tailwind installed inlines the SVG behind `URL(...)` and behind
      // the tab-terminated escape into the emitted CSS as a `data:` URL, so a spelling the guard
      // misses is a real origin bypass. Every whitespace a hex escape may end with is exercised,
      // including the two forms input preprocessing folds to a newline.
      const spellings = [
        `URL("${target}")`,
        `Url(${target})`,
        `\\75 rl("${target}")`,
        `\\55 RL("${target}")`,
        `\\75\trl("${target}")`,
        `\\75\nrl("${target}")`,
        `\\75\rrl("${target}")`,
        `\\75\frl("${target}")`,
        `\\75\r\nrl("${target}")`,
        `\\0075rl("${target}")`,
        `\\75 \\72 l("${target}")`,
        `\\75\t\\72\nl("${target}")`,
      ];

      // The bytes are asserted, so no host-language escape silently turns into a different spelling.
      expect(spellings[4]).toContain('\u0009');
      expect(spellings[8]).toContain('\u000d\u000a');

      for (const spelling of spellings) {
        rejects(
          {
            ...svg,
            'src/main.tsx': "import './app/virtual.css';\n",
            'src/app/virtual.css': `.logo { background: ${spelling}; }\n`,
          },
          'protected-target',
        );
      }

      // The resolved target decides, not the spelling: the same escape naming an unprotected file is
      // followed and kept as a legitimate leaf resource.
      const legitimate = walkVirtual({
        'src/main.tsx': "import './app/virtual.css';\n",
        'src/app/virtual.css': '.logo { background: \\75\trl("./logo.svg"); }\n',
        'src/app/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      });

      expect(legitimate.problems).toEqual([]);
      expect(legitimate.leafResources.map((file) => relative(WEB_ROOT, file))).toEqual([
        join('src', 'app', 'logo.svg'),
      ]);

      // Two whitespace characters are not one terminator: `u` followed by `rl(` is a different
      // function, so inventing a dependency there would be wrong.
      expect(
        walkVirtual({
          ...svg,
          'src/main.tsx': "import './app/virtual.css';\n",
          'src/app/virtual.css': `.logo { background: \\75  rl("${target}"); }\n`,
        }).problems,
      ).toEqual([]);

      // An escaped space is a literal space, so `u\ rl` names the identifier `u rl` and is not a
      // `url()` at all. Joining it anyway would invent a dependency the bundler never follows.
      expect(
        walkVirtual({
          ...svg,
          'src/main.tsx': "import './app/virtual.css';\n",
          'src/app/virtual.css': `.logo { background: u\\ rl("${target}"); }\n`,
        }).problems,
      ).toEqual([]);

      rejects(
        {
          'src/test/build-output-fixtures/banner.css': '.banner { color: red; }\n',
          'src/main.tsx': "import './app/virtual.css';\n",
          'src/app/virtual.css': '@import URL("../test/build-output-fixtures/banner.css");\n',
        },
        'protected-target',
      );
    });

    it('unsupported dependency-producing forms', () => {
      const unsupported = [
        'const a = new URL("../test/build-output-fixtures/logo.svg", import.meta.url);',
        'new Worker(new URL("../test/build-output-fixtures/worker.ts", import.meta.url), { type: "module" });',
        'new SharedWorker(new URL("./shared.ts", import.meta.url));',
        'new Worker(new URL("./sync-worker.ts", import.meta.url));',
        'const b = new URL(/* asset */ `./b.svg`, /* base */ (import.meta.url as string));',
        'const c = new URL(assetName, import.meta!.url);',
        'const d = new (URL)("./d.svg", import.meta.url);',
        'void import(moduleName);',
        'const e = import.meta.glob("./*.ts");',
        'const f = require("./x");',
      ];

      for (const line of unsupported) {
        expect(
          kinds(
            walkVirtual({
              'src/main.tsx': `declare const assetName: string; declare const moduleName: string; declare const require: (id: string) => unknown;\n${line}\n`,
            }),
          ),
          line,
        ).toContain('unsupported-form');
      }
    });

    it('missing, undeclared, forbidden, Node built-in, unknown kinds, and malformed syntax', () => {
      expect(kinds(walkVirtual({ 'src/main.tsx': "import './does-not-exist';\n" }))).toContain(
        'unresolved',
      );
      expect(kinds(walkVirtual({ 'src/main.tsx': "import 'left-pad';\n" }))).toContain(
        'undeclared-package',
      );
      expect(
        kinds(walkVirtual({ 'src/main.tsx': "import '@abfall-radar/data-providers';\n" })),
      ).toContain('forbidden-package');
      expect(
        kinds(walkVirtual({ 'src/main.tsx': "import { readFileSync } from 'node:fs';\n" })),
      ).toContain('node-built-in');
      expect(
        kinds(walkVirtual({ 'src/main.tsx': "import './data.json';\n", 'src/data.json': '{}' })),
      ).toContain('unsupported-kind');
      expect(kinds(walkVirtual({ 'src/main.tsx': 'const = ;\n' }))).toContain('syntax-error');
      expect(
        kinds(
          walkVirtual({
            'src/main.tsx': "import './app/virtual.css';\n",
            'src/app/virtual.css': '@import "./missing.css";\n',
          }),
        ),
      ).toContain('unresolved');
    });
  });

  describe('allows legitimate graphs', () => {
    it('import-like text only in comments and strings creates no dependency', () => {
      const report = walkVirtual({
        'src/main.tsx': [
          "// import '@/src/test/build-output-fixtures/react';",
          "/* export * from '@/src/test/build-output-fixtures/react'; */",
          'const text = "import \'@/src/test/build-output-fixtures/react\'";',
          'const worker = "new Worker(new URL(\'./w.ts\', import.meta.url))";',
          'const parsed = new URL("https://example.test/x");',
          'declare const path: string; declare const base: string;',
          'const relativeParse = new URL(path, base);',
          'export { text, worker, parsed, relativeParse };',
        ].join('\n'),
      });

      expect(report.problems).toEqual([]);
    });

    it('follows an unprotected resource through any `url()` spelling and reads no other function as one', () => {
      const report = walkVirtual({
        'src/main.tsx': "import './app/a.css';\n",
        'src/app/a.css': [
          '.a { background: URL("./logo.svg"); }',
          '.b { background: image-set(url("./logo.svg") 1x); }',
          '.c { color: rgb(0 0 0); font-family: local("Fixture"); }',
          '.d { background: red url("./logo.svg"); }',
          '.e { background: url("data:image/svg+xml,%3Csvg/%3E"); }',
        ].join('\n'),
        'src/app/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      });

      expect(report.problems).toEqual([]);
      expect(report.leafResources.map((file) => relative(WEB_ROOT, file))).toEqual([
        join('src', 'app', 'logo.svg'),
        join('src', 'app', 'logo.svg'),
        join('src', 'app', 'logo.svg'),
      ]);
    });

    it('a comment-only @import in CSS creates no dependency, and cycles terminate', () => {
      const report = walkVirtual({
        'src/main.tsx': "import './app/a.css';\n",
        'src/app/a.css':
          '/* @import "../test/build-output-fixtures/banner.css"; */ @import "./b.css";\n',
        'src/app/b.css': '@import "./a.css";\n@import "./a.css";\n',
      });

      expect(report.problems).toEqual([]);
      expect(report.visitedStylesheets).toHaveLength(2);
    });
  });
});

describe('the adapter-only api-client rule and the data layer', () => {
  it('imports or re-exports @abfall-radar/api-client only inside src/adapters/', () => {
    const offenders = productionSources()
      .filter((file) => !inAdapters(file))
      .filter((file) =>
        ownSpecifiers(parse(file)).some(
          (specifier) =>
            specifier === '@abfall-radar/api-client' ||
            specifier.startsWith('@abfall-radar/api-client/'),
        ),
      )
      .map((file) => relative(WEB_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('has at least one adapter naming the package, so the positive path is exercised', () => {
    const adapters = productionSources().filter(
      (file) => inAdapters(file) && ownSpecifiers(parse(file)).includes('@abfall-radar/api-client'),
    );

    expect(adapters.length).toBeGreaterThan(0);
  });

  it('rejects a direct import and a re-export bypass outside the adapter boundary', () => {
    const outside = (text: string): boolean =>
      ownSpecifiers(parse(join(SOURCE_ROOT, 'features/virtual.ts'), text)).includes(
        '@abfall-radar/api-client',
      );

    expect(outside("import { createApiClient } from '@abfall-radar/api-client';")).toBe(true);
    expect(outside("export * from '@abfall-radar/api-client';")).toBe(true);
  });

  it('calls fetch only inside src/adapters/', () => {
    const offenders = productionSources()
      .filter((file) => !inAdapters(file) && callsFetch(parse(file)))
      .map((file) => relative(WEB_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('imports nothing from apps/extension or data-providers, and no ambient-date domain helper', () => {
    const offenders: string[] = [];

    for (const file of productionSources()) {
      const sourceFile = parse(file);

      for (const specifier of ownSpecifiers(sourceFile)) {
        if (
          specifier.includes('apps/extension') ||
          specifier.startsWith('@abfall-radar/data-providers')
        ) {
          offenders.push(`${relative(WEB_ROOT, file)}: ${specifier}`);
        }
      }

      const visit = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === '@abfall-radar/domain'
        ) {
          const named = node.importClause?.namedBindings;

          if (named !== undefined && ts.isNamedImports(named)) {
            for (const element of named.elements) {
              const imported = (element.propertyName ?? element.name).text;

              if (imported === 'getUpcomingEvents' || imported === 'getRelativeDateLabel') {
                offenders.push(`${relative(WEB_ROOT, file)}: ${imported}`);
              }
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    const manifest = readFileSync(join(WEB_ROOT, 'package.json'), 'utf8');

    expect(offenders).toEqual([]);
    expect(manifest).not.toContain('@abfall-radar/data-providers');
  });

  it('keeps packages/ui free of fetching, api-client, and transport mapping', () => {
    const files = listFiles(UI_SOURCE_ROOT).filter(isScript);
    const offenders = files.filter((file) => {
      const sourceFile = parse(file);
      const text = sourceFile.getFullText();

      return (
        callsFetch(sourceFile) ||
        ownSpecifiers(sourceFile).includes('@abfall-radar/api-client') ||
        /serviceAreaId|wasteType/.test(text)
      );
    });

    expect(files.length).toBeGreaterThan(0);
    expect(offenders.map((file) => relative(REPOSITORY_ROOT, file))).toEqual([]);
  });
});

describe('Tailwind content discovery', () => {
  const STYLESHEET = join(SOURCE_ROOT, 'app/styles.css');

  interface Directive {
    readonly negated: boolean;
    readonly path: string;
    readonly stylesheet: string;
  }

  const stringArgument = (params: string): string | undefined => {
    const node = valueParser(params).nodes.find((part) => part.type === 'string');

    return node?.value;
  };

  /** Every `@source` directive in the canonical stylesheet and every stylesheet it imports. */
  const collect = (): {
    readonly directives: Directive[];
    readonly importedProblems: string[];
    readonly entryImportsNone: boolean;
  } => {
    const directives: Directive[] = [];
    const importedProblems: string[] = [];
    let entryImportsNone = false;
    const stylesheets = walkReal().visitedStylesheets;

    for (const stylesheet of stylesheets) {
      const isEntry = stylesheet === STYLESHEET;

      postcss.parse(readFileSync(stylesheet, 'utf8')).walkAtRules((rule) => {
        if (rule.name === 'source') {
          const negated = rule.params.trimStart().startsWith('not ');
          const path = stringArgument(negated ? rule.params.trimStart().slice(4) : rule.params);

          if (!isEntry && !negated) {
            importedProblems.push(
              `${relative(REPOSITORY_ROOT, stylesheet)} adds @source ${rule.params}`,
            );
          }

          if (path !== undefined) {
            directives.push({ negated, path: resolve(dirname(stylesheet), path), stylesheet });
          }
        } else if (rule.name === 'import') {
          const target = stringArgument(rule.params);

          if (target === 'tailwindcss') {
            if (isEntry) {
              entryImportsNone = /\bsource\(\s*none\s*\)/.test(rule.params);
            } else {
              importedProblems.push(`${relative(REPOSITORY_ROOT, stylesheet)} imports tailwindcss`);
            }
          } else if (!isEntry && /\bsource\(/.test(rule.params)) {
            importedProblems.push(`${relative(REPOSITORY_ROOT, stylesheet)} sets source()`);
          }
        }
      });
    }

    return { directives, importedProblems, entryImportsNone };
  };

  const effectiveFiles = (directives: readonly Directive[]): string[] => {
    const included = new Set<string>();

    for (const directive of directives.filter((entry) => !entry.negated)) {
      const pattern = directive.path;
      const matches = globSync(
        isScript(pattern) || pattern.endsWith('.html') ? pattern : join(pattern, '**/*'),
        {
          exclude: (name) => name === 'node_modules',
        },
      );

      for (const match of matches) {
        if (!listFilesSafe(match)) {
          included.add(resolve(match));
        }
      }
    }

    for (const directive of directives.filter((entry) => entry.negated)) {
      for (const match of globSync(directive.path)) {
        const absolute = resolve(match);

        for (const file of [...included]) {
          if (file === absolute || file.startsWith(`${absolute}${sep}`)) {
            included.delete(file);
          }
        }
      }
    }

    return [...included];
  };

  const listFilesSafe = (path: string): boolean => {
    try {
      readdirSync(path);
      return true;
    } catch {
      return false;
    }
  };

  it('turns automatic discovery off and registers exactly the three documented sources', () => {
    const { directives, entryImportsNone } = collect();

    expect(entryImportsNone).toBe(true);
    expect(
      directives
        .filter((directive) => !directive.negated)
        .map((directive) => relative(REPOSITORY_ROOT, directive.path))
        .sort(),
    ).toEqual(['apps/web/index.html', 'apps/web/src', 'packages/ui/src']);
  });

  it('lets no imported workspace stylesheet widen or re-enable discovery', () => {
    expect(collect().importedProblems).toEqual([]);
  });

  it('scans no protected file, judged on the effective files rather than a glob base', () => {
    const files = effectiveFiles(collect().directives);
    const protectedFiles = files.filter(
      (file) =>
        isProtected(file, WEB_ROOT) ||
        (file.startsWith(UI_SOURCE_ROOT) && /\.(?:test|spec)\.tsx?$/.test(file)),
    );

    expect(files.length).toBeGreaterThan(10);
    expect(protectedFiles.map((file) => relative(REPOSITORY_ROOT, file))).toEqual([]);
  });

  /**
   * Mutation regressions: each removal or addition must turn the corresponding assertion red.
   *
   * The directive list is mutated in memory — the canonical stylesheet is never rewritten — and the
   * same effective-set computation the passing tests use is applied to it.
   */
  it('detects a removed `source(none)`, a removed exclusion, and an added positive registration', () => {
    const { directives } = collect();
    const protectedFiles = (entries: readonly Directive[]): string[] =>
      effectiveFiles(entries).filter(
        (file) => isProtected(file, WEB_ROOT) || TEST_SOURCE.test(file),
      );

    // Baseline: the real configuration exposes nothing protected.
    expect(protectedFiles(directives)).toEqual([]);

    // Removing the `../test` exclusion exposes the protected tree, naming the exposed files.
    const withoutExclusion = directives.filter(
      (entry) => !(entry.negated && entry.path === join(SOURCE_ROOT, 'test')),
    );

    expect(withoutExclusion.length).toBe(directives.length - 1);
    expect(protectedFiles(withoutExclusion).length).toBeGreaterThan(0);

    // Adding a positive registration for the protected tree breaks the exact-registration assertion
    // immediately. On its own it does not change the effective set, because the exclusion still wins —
    // stated here rather than overclaimed — but combined with the removal above it exposes the tree.
    const registration: Directive = {
      negated: false,
      path: join(SOURCE_ROOT, 'test'),
      stylesheet: STYLESHEET,
    };
    const added: Directive[] = [...directives, registration];

    expect(added.filter((entry) => !entry.negated).length).toBe(4);
    expect(protectedFiles(added)).toEqual([]);
    expect(protectedFiles([...withoutExclusion, registration]).length).toBeGreaterThan(0);

    // `source(none)` is read from the import's own parameters, so dropping it is detected.
    const detectsNone = (params: string): boolean => /\bsource\(\s*none\s*\)/.test(params);

    expect(detectsNone('"tailwindcss" source(none)')).toBe(true);
    expect(detectsNone('"tailwindcss"')).toBe(false);
  });

  it('keeps both planted candidates out of every allowed source and the production candidates where documented', () => {
    const files = effectiveFiles(collect().directives);
    // A whole class token: `--shadow-ar-brand`, the theme variable that defines the utility, is not a use.
    const containing = (candidate: string): string[] => {
      const token = new RegExp(
        `(?<![\\w-])${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`,
      );

      return files
        .filter((file) => token.test(readFileSync(file, 'utf8')))
        .map((file) => relative(REPOSITORY_ROOT, file));
    };

    expect(containing('tracking-[0.1337em]')).toEqual([]);
    expect(containing('tracking-[0.4242em]')).toEqual([]);
    expect(containing('shadow-ar-brand')).toEqual(['packages/ui/src/brand-mark.tsx']);
    expect(containing('min-h-dvh')).toEqual(['apps/web/src/app/app.tsx']);
  });
});
