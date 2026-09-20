/**
 * The production dependency guard's graph walker (Check 1b).
 *
 * It walks every edge a production build can follow — script imports, re-exports, literal dynamic
 * imports, and CSS `@import`-style loads and `url(...)` resources — from the admitted production entry,
 * and reports any resolved target inside a protected test or fixture boundary, with the full chain.
 *
 * Judgement is by **resolved absolute path**. Extraction is parser-based: the TypeScript compiler API
 * for scripts and `postcss` with `postcss-value-parser` for stylesheets. Nothing is evaluated.
 *
 * The file system is injected so rejection cases run against in-memory trees and never place a
 * forbidden file in `src/`.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import postcss, { type Root } from 'postcss';
import valueParser from 'postcss-value-parser';
import ts from 'typescript';
import { decodeCssEscapes, preprocessCss } from '@/src/test/build-output-scanner';

export interface FileSystem {
  readonly readFile: (path: string) => string | undefined;
  readonly isFile: (path: string) => boolean;
  readonly isDirectory: (path: string) => boolean;
  readonly realpath: (path: string) => string;
}

export const nodeFileSystem: FileSystem = {
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  isFile: (path) => existsSync(path) && statSync(path).isFile(),
  isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
  realpath: (path) => realpathSync(path),
};

export interface GraphOptions {
  readonly fs: FileSystem;
  /** The `apps/web` workspace root, which `@/` resolves to. */
  readonly webRoot: string;
  /** The repository root. A resolved path under `<repo>/apps/*` or `<repo>/packages/*` is first-party. */
  readonly repositoryRoot: string;
  /** Packages that may not be imported at all, whether or not they resolve. */
  readonly forbiddenPackages: ReadonlySet<string>;
}

export interface Edge {
  readonly importer: string;
  readonly specifier: string;
  readonly resolved: string | undefined;
}

export type ProblemKind =
  | 'protected-target'
  | 'unresolved'
  | 'undeclared-package'
  | 'forbidden-package'
  | 'node-built-in'
  | 'unsupported-form'
  | 'unsupported-kind'
  | 'syntax-error';

export interface Problem {
  readonly kind: ProblemKind;
  readonly detail: string;
  /** From the production entry to the failing edge. */
  readonly chain: readonly Edge[];
}

export interface GraphReport {
  readonly problems: readonly Problem[];
  readonly visitedScripts: readonly string[];
  readonly visitedStylesheets: readonly string[];
  readonly thirdParty: ReadonlyMap<string, string>;
  readonly leafResources: readonly string[];
}

// ---------------------------------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------------------------------

const SCRIPT_EXTENSIONS = ['.ts', '.tsx'];
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
const QUERY_SUFFIX = /\?(?:raw|url|worker|inline)$/;
const LEAF_RESOURCE_EXTENSIONS = new Set([
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
]);

/** Whether a resolved path lies inside AR-005's protected test and fixture boundaries. */
export const isProtected = (path: string, webRoot: string): boolean => {
  const source = join(webRoot, 'src');
  const fromSource = relative(source, path);
  const insideSource = fromSource !== '' && !fromSource.startsWith('..') && !isAbsolute(fromSource);

  if (!insideSource) {
    return false;
  }

  return fromSource === 'test' || fromSource.startsWith(`test${sep}`) || TEST_FILE.test(path);
};

const isInside = (path: string, directory: string): boolean => {
  const fromDirectory = relative(directory, path);

  return fromDirectory !== '' && !fromDirectory.startsWith('..') && !isAbsolute(fromDirectory);
};

// ---------------------------------------------------------------------------------------------------
// Package resolution under production browser conditions
// ---------------------------------------------------------------------------------------------------

/** Conditions a production browser build selects. `require`, `node`, `react-server`, and `types` are absent. */
const SCRIPT_CONDITIONS = new Set(['browser', 'import', 'module', 'production', 'default']);
const STYLE_CONDITIONS = new Set(['style', 'browser', 'import', 'module', 'production', 'default']);

type ExportsValue =
  | string
  | null
  | readonly ExportsValue[]
  | { readonly [key: string]: ExportsValue };

/** Follows Node's algorithm: an object's keys are tried in their own order against the active set. */
const selectTarget = (value: ExportsValue, conditions: ReadonlySet<string>): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = selectTarget(candidate, conditions);

      if (selected !== undefined) {
        return selected;
      }
    }

    return undefined;
  }

  for (const [key, candidate] of Object.entries(value as Record<string, ExportsValue>)) {
    if (conditions.has(key)) {
      const selected = selectTarget(candidate, conditions);

      if (selected !== undefined) {
        return selected;
      }
    }
  }

  return undefined;
};

const splitPackageSpecifier = (
  specifier: string,
): { readonly name: string; readonly subpath: string } => {
  const parts = specifier.split('/');
  const nameLength = specifier.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, nameLength).join('/');
  const rest = parts.slice(nameLength).join('/');

  return { name, subpath: rest === '' ? '.' : `./${rest}` };
};

interface PackageResolution {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly firstParty: boolean;
}

const resolveExports = (
  exportsField: ExportsValue,
  subpath: string,
  conditions: ReadonlySet<string>,
): string | undefined => {
  const isConditionObject =
    typeof exportsField === 'object' &&
    exportsField !== null &&
    !Array.isArray(exportsField) &&
    !Object.keys(exportsField).some((key) => key.startsWith('.'));

  if (typeof exportsField === 'string' || Array.isArray(exportsField) || isConditionObject) {
    return subpath === '.' ? selectTarget(exportsField, conditions) : undefined;
  }

  const map = exportsField as Record<string, ExportsValue>;
  const exact = map[subpath];

  if (exact !== undefined) {
    return selectTarget(exact, conditions);
  }

  for (const [pattern, target] of Object.entries(map)) {
    const star = pattern.indexOf('*');

    if (star === -1) {
      continue;
    }

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);

    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= pattern.length - 1
    ) {
      const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
      const selected = selectTarget(target, conditions);

      return selected?.replaceAll('*', captured);
    }
  }

  return undefined;
};

const declaredDependencies = (manifest: Record<string, unknown>): Set<string> => {
  const names = new Set<string>();

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const block = manifest[field];

    if (typeof block === 'object' && block !== null) {
      for (const name of Object.keys(block)) {
        names.add(name);
      }
    }
  }

  return names;
};

// ---------------------------------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------------------------------

/** At-rules that load another file and are therefore traversed. */
const LOADING_AT_RULES = new Set(['import', 'reference', 'plugin', 'config']);

/** At-rules known to load nothing. Any at-rule in neither set fails the check as unsupported. */
const NON_LOADING_AT_RULES = new Set([
  'source',
  'theme',
  'utility',
  'apply',
  'layer',
  'media',
  'supports',
  'keyframes',
  'font-face',
  'custom-variant',
  'variant',
  'tailwind',
  'container',
  'property',
  'charset',
  'namespace',
  'page',
]);

const IMPORT_META_GLOBS = new Set(['glob', 'globEager']);

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }

  return current;
};

const isImportMeta = (expression: ts.Expression): boolean => {
  const unwrapped = unwrapExpression(expression);

  return (
    ts.isMetaProperty(unwrapped) &&
    unwrapped.keywordToken === ts.SyntaxKind.ImportKeyword &&
    unwrapped.name.text === 'meta'
  );
};

const isImportMetaUrl = (expression: ts.Expression): boolean => {
  const unwrapped = unwrapExpression(expression);

  return (
    ts.isPropertyAccessExpression(unwrapped) &&
    unwrapped.name.text === 'url' &&
    isImportMeta(unwrapped.expression)
  );
};

type ScriptFinding =
  | { readonly type: 'edge'; readonly specifier: string }
  | { readonly type: 'unsupported'; readonly detail: string };

/**
 * Extracts every dependency-producing construct from one parsed script, over the original AST.
 *
 * Collects `ImportDeclaration`, `ExportDeclaration` with a module specifier, and `import()` with a
 * literal argument. Rejects computed `import()`, `import.meta.glob`, `require`, and
 * `new URL(…, import.meta.url)` — including through syntax-only wrappers and inside `Worker` and
 * `SharedWorker` constructors, because the visit reaches every nested `NewExpression`.
 */
export const extractScriptFindings = (sourceFile: ts.SourceFile): ScriptFinding[] => {
  const findings: ScriptFinding[] = [];

  const location = (node: ts.Node): string => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

    return `${line + 1}:${character + 1}`;
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        findings.push({ type: 'edge', specifier: node.moduleSpecifier.text });
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments;

        if (
          argument !== undefined &&
          (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          findings.push({ type: 'edge', specifier: argument.text });
        } else {
          findings.push({
            type: 'unsupported',
            detail: `computed import() at ${location(node)}: ${node.getText(sourceFile)}`,
          });
        }
      } else {
        const callee = unwrapExpression(node.expression);

        if (ts.isIdentifier(callee) && callee.text === 'require') {
          findings.push({
            type: 'unsupported',
            detail: `require() at ${location(node)}: ${node.getText(sourceFile)}`,
          });
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          IMPORT_META_GLOBS.has(callee.name.text) &&
          isImportMeta(callee.expression)
        ) {
          findings.push({
            type: 'unsupported',
            detail: `import.meta.${callee.name.text} at ${location(node)}: ${node.getText(sourceFile)}`,
          });
        }
      }
    } else if (ts.isNewExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const [, base] = node.arguments ?? [];

      if (
        ts.isIdentifier(callee) &&
        callee.text === 'URL' &&
        base !== undefined &&
        isImportMetaUrl(base)
      ) {
        findings.push({
          type: 'unsupported',
          detail: `new URL(…, import.meta.url) at ${location(node)}: ${node.getText(sourceFile)}`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return findings;
};

interface CssFinding {
  readonly specifier: string;
  readonly kind: 'load' | 'resource';
}

/**
 * How a word ends, judged by scanning its escapes forward so no backslash is miscounted.
 *
 * `hex` — the word ends inside a hex escape that still wants its optional whitespace terminator, so
 * the identifier continues into the next value node. `dangling` — the word ends with a lone
 * backslash, which no interpretation can complete.
 */
const trailingEscape = (word: string): 'hex' | 'dangling' | 'none' => {
  let index = 0;
  let ending: 'hex' | 'dangling' | 'none' = 'none';

  while (index < word.length) {
    if (word[index] !== '\\') {
      index += 1;
      ending = 'none';
      continue;
    }

    const hex = /^[0-9a-fA-F]{1,6}/.exec(word.slice(index + 1));

    if (hex !== null) {
      index += 1 + hex[0].length;
      ending = index === word.length ? 'hex' : 'none';
      continue;
    }

    if (index + 1 >= word.length) {
      return 'dangling';
    }

    index += 2;
    ending = 'none';
  }

  return ending;
};

/** One preprocessed whitespace code point: exactly what terminates a hex escape and nothing more. */
const isEscapeTerminator = (separator: valueParser.Node | undefined): boolean => {
  if (separator?.type !== 'space') {
    return false;
  }

  const preprocessed = preprocessCss(separator.value);

  return preprocessed === ' ' || preprocessed === '\t' || preprocessed === '\n';
};

/**
 * The identifier a CSS function node actually names, decoded and case-folded.
 *
 * Comparing `node.value === 'url'` was wrong three times over. Function names are ASCII
 * case-insensitive, so `URL("../x.svg")` loads exactly what `url("../x.svg")` loads. Names may carry
 * identifier escapes, and a hex escape is terminated by **any** whitespace — space, tab, or newline,
 * with CR, FF, and CRLF folded to newline by input preprocessing — which `postcss-value-parser`
 * reports as a value separator: `\75<TAB>rl(…)` arrives as the word `\75`, a space node holding the
 * tab, and a function named `rl`. Matching only a literal space left the tab, CR, FF, and LF
 * spellings unrecognised; a separate Vite and Tailwind build proved the bundler follows exactly that
 * reference and inlines the target. The split parts are rejoined with their original separator, whose
 * preprocessing the decoder performs, so the reconstruction stays one decoding pass.
 *
 * Two or more whitespace characters are not a terminator, because only the first belongs to the
 * escape: `\75  rl(` really is the value `u` followed by a different function, and joining it would
 * invent a dependency. A word ending in a lone backslash cannot be interpreted at all and returns
 * `undefined`, which the caller reports as unsupported rather than ignoring.
 */
const cssFunctionName = (
  node: valueParser.FunctionNode,
  index: number,
  nodes: readonly valueParser.Node[],
): string | undefined => {
  let raw = node.value;
  let cursor = index - 1;

  for (;;) {
    const separator = nodes[cursor];
    const previous = nodes[cursor - 1];

    if (!isEscapeTerminator(separator) || previous?.type !== 'word') {
      break;
    }

    const ending = trailingEscape(previous.value);

    if (ending === 'dangling') {
      return undefined;
    }

    if (ending !== 'hex') {
      break;
    }

    raw = `${previous.value}${separator?.value ?? ''}${raw}`;
    cursor -= 2;
  }

  return decodeCssEscapes(raw)?.toLowerCase();
};

/**
 * The `image-set()` spellings whose string candidates load resources: the standard name and the one
 * prefixed form browsers and bundlers actually implement.
 */
const IMAGE_SET_FUNCTIONS: ReadonlySet<string> = new Set(['image-set', '-webkit-image-set']);

/**
 * Every CSS function that can name a resource, and therefore every base name a vendor prefix could be
 * put in front of. `url()`, `image-set()` and `image()` are followed; `src()` is refused (see below).
 * A function outside this list carries no resource the guard needs to see — `local("…")` in `@font-face`
 * names an installed font, and `cross-fade()` takes images rather than strings, whose own `url()`,
 * `image()` and `image-set()` are found where they are nested.
 */
const RESOURCE_FUNCTION_BASES: ReadonlySet<string> = new Set(['url', 'src', 'image', 'image-set']);

/**
 * A vendor spelling of a resource-bearing function the guard does not model, such as `-moz-image()`.
 * `-webkit-image-set()` is the one prefixed form browsers and bundlers implement, and it is followed.
 */
const isUnmodelledVendorSpelling = (name: string): boolean => {
  const match = /^-[a-z0-9]+-(.+)$/.exec(name);

  return (
    match?.[1] !== undefined &&
    RESOURCE_FUNCTION_BASES.has(match[1]) &&
    !IMAGE_SET_FUNCTIONS.has(name)
  );
};

const urlTarget = (node: valueParser.FunctionNode): string | undefined =>
  decodeCssEscapes(
    valueParser
      .stringify(node.nodes)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2'),
  );

/** Extracts file-loading at-rules and local `url(...)` resources from one parsed stylesheet. */
export const extractCssFindings = (
  root: Root,
): { readonly findings: CssFinding[]; readonly unsupported: string[] } => {
  const findings: CssFinding[] = [];
  const unsupported: string[] = [];

  const firstTarget = (params: string): string | undefined => {
    const nodes = valueParser(params).nodes;

    for (const [index, node] of nodes.entries()) {
      if (node.type === 'string') {
        return decodeCssEscapes(node.value);
      }

      if (node.type === 'function' && cssFunctionName(node, index, nodes) === 'url') {
        return urlTarget(node);
      }
    }

    return undefined;
  };

  const pushResource = (target: string): void => {
    if (target !== '' && !/^(?:data:|https?:|#|\/\/)/i.test(target)) {
      findings.push({ specifier: target, kind: 'resource' });
    }
  };

  /**
   * The resource candidates of one `image-set()`.
   *
   * `image-set( <option># )`, where each option is `[ <image> | <string> ] [ <resolution> || type() ]?`.
   * A **string** in the first position of an option is a URL exactly as `url()` would be — bundlers
   * resolve and inline it — so it is followed and boundary-checked the same way. Strings anywhere else
   * are metadata: the MIME type inside `type("image/avif")` is nested in its own function and is never
   * reached here, and a string later in an option is not valid syntax, so it is reported rather than
   * guessed at. An `<image>` in first position (`url()`, a gradient) needs nothing extra: the walk below
   * visits nested functions, and `url()` is handled where it is found.
   */
  const collectImageSet = (node: valueParser.FunctionNode, value: string): void => {
    let position = 0;

    for (const child of node.nodes) {
      if (child.type === 'div' && child.value === ',') {
        position = 0;
        continue;
      }

      if (child.type === 'space' || child.type === 'comment') {
        continue;
      }

      if (child.type === 'string') {
        if (position !== 0) {
          unsupported.push(`string outside an image-set() candidate position: ${value}`);
        } else {
          const target = decodeCssEscapes(child.value);

          if (target === undefined) {
            unsupported.push(`undecodable image-set() string: ${value}`);
          } else {
            pushResource(target);
          }
        }
      }

      position += 1;
    }
  };

  /**
   * The resource of one `image()`.
   *
   * `image( [ ltr | rtl ]? [ <url> | <string> ]? , <color>? )` — at least one of source and colour. A
   * **string** in the source position, after an optional direction tag and before the separating comma,
   * is a URL exactly as `url()` would be, so it is followed and boundary-checked the same way. A `url()`
   * there needs nothing extra: the walk visits it where it is nested. Anything else before the comma is
   * the colour. A string in any other position is not valid syntax, and neither is a second separator;
   * both are reported rather than guessed at.
   */
  const collectImage = (node: valueParser.FunctionNode, value: string): void => {
    let beforeSeparator = true;
    let position = 0;

    for (const child of node.nodes) {
      if (child.type === 'space' || child.type === 'comment') {
        continue;
      }

      if (child.type === 'div' && child.value === ',') {
        if (!beforeSeparator) {
          unsupported.push(`more than one separator in image(): ${value}`);
        }

        beforeSeparator = false;
        continue;
      }

      const tag = child.type === 'word' ? decodeCssEscapes(child.value)?.toLowerCase() : undefined;

      if (beforeSeparator && position === 0 && (tag === 'ltr' || tag === 'rtl')) {
        continue;
      }

      if (child.type === 'string') {
        if (!beforeSeparator || position !== 0) {
          unsupported.push(`string outside the image() source position: ${value}`);
        } else {
          const target = decodeCssEscapes(child.value);

          if (target === undefined) {
            unsupported.push(`undecodable image() string: ${value}`);
          } else {
            pushResource(target);
          }
        }
      }

      position += 1;
    }
  };

  const collectUrls = (value: string): void => {
    valueParser(value).walk((node, index, nodes) => {
      if (node.type !== 'function') {
        return;
      }

      const name = cssFunctionName(node, index, nodes);

      if (name === undefined) {
        unsupported.push(`undecodable function name: ${value}`);
        return;
      }

      if (IMAGE_SET_FUNCTIONS.has(name)) {
        collectImageSet(node, value);
        return;
      }

      if (name === 'image') {
        collectImage(node, value);
        return;
      }

      /*
       * `src()` is the string-accepting twin of `url()`, and its argument may be a `var()` whose value
       * no static walk can know. Nothing here can prove what it loads, so it is refused outright
       * instead of being passed as harmless.
       */
      if (name === 'src') {
        unsupported.push(`unsupported src() function, whose target cannot be validated: ${value}`);
        return;
      }

      // Any vendor spelling of a resource-bearing function the guard does not model is refused for the
      // same reason, rather than let an unrecognised resource pass unexamined.
      if (isUnmodelledVendorSpelling(name)) {
        unsupported.push(`unsupported vendor-prefixed resource function ${name}(): ${value}`);
        return;
      }

      if (name !== 'url') {
        return;
      }

      const target = urlTarget(node);

      if (target === undefined) {
        unsupported.push(`undecodable url(): ${value}`);
      } else {
        pushResource(target);
      }
    });
  };

  root.walk((node) => {
    if (node.type === 'atrule') {
      const name = decodeCssEscapes(node.name)?.toLowerCase();

      if (name === undefined) {
        unsupported.push(`undecodable at-rule name: @${node.name}`);
      } else if (LOADING_AT_RULES.has(name)) {
        const target = firstTarget(node.params);

        if (target === undefined) {
          unsupported.push(`@${name} without a literal target: ${node.params}`);
        } else {
          findings.push({ specifier: target, kind: 'load' });
        }
      } else if (!NON_LOADING_AT_RULES.has(name)) {
        unsupported.push(`unsupported at-rule @${name}`);
      }
    } else if (node.type === 'decl') {
      collectUrls(node.value);
    }
  });

  return { findings, unsupported };
};

export const walkProductionGraph = (
  entry: string,
  options: GraphOptions,
  initialChain: readonly Edge[] = [],
): GraphReport => {
  const { fs, webRoot, repositoryRoot, forbiddenPackages } = options;
  const problems: Problem[] = [];
  const visited = new Set<string>();
  const visitedScripts: string[] = [];
  const visitedStylesheets: string[] = [];
  const thirdParty = new Map<string, string>();
  const leafResources: string[] = [];
  const builtins = new Set(builtinModules);

  const realpathOf = (path: string): string => {
    try {
      return fs.realpath(path);
    } catch {
      return path;
    }
  };

  /** The nearest enclosing `package.json`, which declares what a file may import. */
  const owningManifest = (file: string): Record<string, unknown> | undefined => {
    for (let directory = dirname(file); ; directory = dirname(directory)) {
      const text = fs.readFile(join(directory, 'package.json'));

      if (text !== undefined) {
        return JSON.parse(text) as Record<string, unknown>;
      }

      if (dirname(directory) === directory) {
        return undefined;
      }
    }
  };

  const resolveFile = (base: string): string | undefined => {
    const candidates = [
      base,
      ...SCRIPT_EXTENSIONS.map((extension) => `${base}${extension}`),
      ...SCRIPT_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
    ];

    const found = candidates.find((candidate) => fs.isFile(candidate));

    return found === undefined ? undefined : realpathOf(found);
  };

  const resolvePackage = (
    importer: string,
    specifier: string,
    conditions: ReadonlySet<string>,
  ): PackageResolution | undefined => {
    const { name, subpath } = splitPackageSpecifier(specifier);

    for (let directory = dirname(importer); ; directory = dirname(directory)) {
      const packageDirectory = join(directory, 'node_modules', name);
      const manifestText = fs.readFile(join(packageDirectory, 'package.json'));

      if (manifestText !== undefined) {
        const manifest = JSON.parse(manifestText) as Record<string, ExportsValue>;
        const realDirectory = realpathOf(packageDirectory);
        let target: string | undefined;

        if (manifest.exports !== undefined) {
          target = resolveExports(manifest.exports, subpath, conditions);
        } else if (subpath === '.') {
          const legacy = [manifest.module, manifest.browser, manifest.main].find(
            (field): field is string => typeof field === 'string',
          );
          target = legacy ?? 'index.js';
        } else {
          target = subpath;
        }

        if (target === undefined) {
          return undefined;
        }

        const path = resolveFile(resolve(realDirectory, target));

        if (path === undefined) {
          return undefined;
        }

        const firstParty =
          (isInside(path, join(repositoryRoot, 'apps')) ||
            isInside(path, join(repositoryRoot, 'packages'))) &&
          !path.split(sep).includes('node_modules');

        return {
          path,
          name,
          version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
          firstParty,
        };
      }

      if (dirname(directory) === directory) {
        return undefined;
      }
    }
  };

  const walk = (file: string, chain: readonly Edge[]): void => {
    if (visited.has(file)) {
      return;
    }

    visited.add(file);
    const extension = extname(file);
    const text = fs.readFile(file);

    if (text === undefined) {
      problems.push({ kind: 'unresolved', detail: `unreadable file ${file}`, chain });
      return;
    }

    if (SCRIPT_EXTENSIONS.includes(extension)) {
      visitedScripts.push(file);
      walkScript(file, text, chain);
    } else if (extension === '.css') {
      visitedStylesheets.push(file);
      walkStylesheet(file, text, chain);
    } else {
      problems.push({ kind: 'unsupported-kind', detail: `unsupported file kind ${file}`, chain });
    }
  };

  const follow = (
    importer: string,
    specifier: string,
    chain: readonly Edge[],
    style: boolean,
  ): void => {
    const cleaned = specifier.replace(QUERY_SUFFIX, '');
    const record = (resolved: string | undefined): Edge[] => [
      ...chain,
      { importer, specifier, resolved },
    ];

    if (/\?/.test(cleaned)) {
      problems.push({
        kind: 'unsupported-form',
        detail: `unsupported query suffix in ${specifier}`,
        chain: record(undefined),
      });
      return;
    }

    if (cleaned.startsWith('node:') || builtins.has(cleaned.split('/')[0] ?? '')) {
      problems.push({
        kind: 'node-built-in',
        detail: `Node built-in ${specifier}`,
        chain: record(undefined),
      });
      return;
    }

    const local = cleaned.startsWith('.') || cleaned.startsWith('/') || cleaned.startsWith('@/');
    let resolved: string | undefined;

    if (local) {
      const base = cleaned.startsWith('@/')
        ? resolve(webRoot, cleaned.slice(2))
        : cleaned.startsWith('/')
          ? resolve(webRoot, cleaned.slice(1))
          : resolve(dirname(importer), cleaned);
      resolved = resolveFile(base);
    } else {
      const { name } = splitPackageSpecifier(cleaned);

      if (forbiddenPackages.has(name)) {
        problems.push({
          kind: 'forbidden-package',
          detail: `forbidden package ${name}`,
          chain: record(undefined),
        });
        return;
      }

      const manifest = owningManifest(importer);

      if (manifest === undefined || !declaredDependencies(manifest).has(name)) {
        problems.push({
          kind: 'undeclared-package',
          detail: `${name} is not declared by the package that owns ${importer}`,
          chain: record(undefined),
        });
        return;
      }

      const resolution = resolvePackage(
        importer,
        cleaned,
        style ? STYLE_CONDITIONS : SCRIPT_CONDITIONS,
      );

      if (resolution === undefined) {
        problems.push({
          kind: 'unresolved',
          detail: `cannot resolve package ${specifier}`,
          chain: record(undefined),
        });
        return;
      }

      if (!resolution.firstParty) {
        if (isProtected(resolution.path, webRoot)) {
          problems.push({
            kind: 'protected-target',
            detail: resolution.path,
            chain: record(resolution.path),
          });
        } else {
          // Trust boundary: identity-checked, never parsed.
          thirdParty.set(`${resolution.name}@${resolution.version}`, resolution.path);
        }

        return;
      }

      resolved = resolution.path;
    }

    const edgeChain = record(resolved);

    if (resolved === undefined) {
      problems.push({
        kind: 'unresolved',
        detail: `cannot resolve ${specifier} from ${importer}`,
        chain: edgeChain,
      });
      return;
    }

    if (isProtected(resolved, webRoot)) {
      problems.push({ kind: 'protected-target', detail: resolved, chain: edgeChain });
      return;
    }

    walk(resolved, edgeChain);
  };

  const walkScript = (file: string, text: string, chain: readonly Edge[]): void => {
    const scriptKind = extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const compilerOptions: ts.CompilerOptions = {
      noEmit: true,
      noResolve: true,
      noLib: true,
      types: [],
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.Latest,
    };
    const host = ts.createCompilerHost(compilerOptions, true);
    host.getSourceFile = (name, languageVersion) =>
      name === file
        ? ts.createSourceFile(name, text, languageVersion, true, scriptKind)
        : undefined;
    host.fileExists = (name) => name === file;
    host.readFile = (name) => (name === file ? text : undefined);

    const program = ts.createProgram([file], compilerOptions, host);
    const sourceFile = program.getSourceFile(file);

    if (sourceFile === undefined) {
      problems.push({ kind: 'unresolved', detail: `no source file for ${file}`, chain });
      return;
    }

    const diagnostics = program.getSyntacticDiagnostics(sourceFile);

    if (diagnostics.length > 0) {
      problems.push({
        kind: 'syntax-error',
        detail: `${file}: ${diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('; ')}`,
        chain,
      });
      return;
    }

    for (const finding of extractScriptFindings(sourceFile)) {
      if (finding.type === 'unsupported') {
        problems.push({ kind: 'unsupported-form', detail: `${file} ${finding.detail}`, chain });
      } else {
        follow(file, finding.specifier, chain, false);
      }
    }
  };

  const walkStylesheet = (file: string, text: string, chain: readonly Edge[]): void => {
    let root: Root;

    try {
      root = postcss.parse(text, { from: file });
    } catch (error) {
      problems.push({
        kind: 'syntax-error',
        detail: `${file}: ${error instanceof Error ? error.message : 'unparsable'}`,
        chain,
      });
      return;
    }

    const { findings, unsupported } = extractCssFindings(root);

    for (const detail of unsupported) {
      problems.push({ kind: 'unsupported-form', detail: `${file} ${detail}`, chain });
    }

    for (const finding of findings) {
      if (finding.kind === 'load') {
        follow(file, finding.specifier, chain, true);
        continue;
      }

      // A leaf resource is boundary-checked before traversal stops at it.
      const target = finding.specifier.startsWith('@/')
        ? resolve(webRoot, finding.specifier.slice(2))
        : resolve(dirname(file), finding.specifier);
      const edge = [...chain, { importer: file, specifier: finding.specifier, resolved: target }];

      if (!fs.isFile(target)) {
        problems.push({
          kind: 'unresolved',
          detail: `missing resource ${finding.specifier}`,
          chain: edge,
        });
      } else if (isProtected(realpathOf(target), webRoot)) {
        problems.push({ kind: 'protected-target', detail: target, chain: edge });
      } else if (!LEAF_RESOURCE_EXTENSIONS.has(extname(target))) {
        problems.push({
          kind: 'unsupported-kind',
          detail: `unsupported resource ${target}`,
          chain: edge,
        });
      } else {
        leafResources.push(realpathOf(target));
      }
    }
  };

  walk(realpathOf(entry), initialChain);

  return { problems, visitedScripts, visitedStylesheets, thirdParty, leafResources };
};

export const describeProblem = (problem: Problem, root: string): string => {
  const steps = problem.chain.map(
    (edge) =>
      `${relative(root, edge.importer)} → ${edge.specifier} → ${edge.resolved === undefined ? '∅' : relative(root, edge.resolved)}`,
  );

  return [`${problem.kind}: ${problem.detail}`, ...steps.map((step) => `  ${step}`)].join('\n');
};
