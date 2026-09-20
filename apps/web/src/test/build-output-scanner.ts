/**
 * The emitted-artifact scanner behind Check 2.
 *
 * It finds every absolute HTTP(S) occurrence in emitted HTML, JavaScript, and CSS and classifies each one
 * against the four sanctioned categories in AR-005. Anything that matches none of them is a violation.
 *
 * Inert by construction: it parses text and inspects syntax. It never executes, imports, evaluates, or
 * constant-folds anything, and it never rewrites an asset. Ordinary tests call it on supplied strings;
 * only `build-output.verify.ts` feeds it files from `dist`.
 *
 * This is a static literal-occurrence guarantee, not proof about every URL runtime computation could
 * assemble. Same-origin request construction and the source guards keep their own enforcement.
 */

import postcss, { type ChildNode, type Root } from 'postcss';
import valueParser from 'postcss-value-parser';
import ts from 'typescript';

export type Category = 'namespace' | 'tailwind' | 'react' | 'zod';

export interface Occurrence {
  readonly file: string;
  /** Where the value was found: a character range for JavaScript and CSS, a DOM path for HTML. */
  readonly locator: string;
  /** The syntactic role the value was found in, such as `string-literal` or `css-comment`. */
  readonly context: string;
  /** The represented value that carries the URL, after contextual decoding. */
  readonly value: string;
}

export interface ScanResult {
  readonly exempt: ReadonlyArray<Occurrence & { readonly category: Category }>;
  readonly violations: readonly Occurrence[];
  /** Syntax or escapes that could not be interpreted unambiguously. Always a failure. */
  readonly unresolved: readonly Occurrence[];
}

/**
 * Exact platform-namespace and schema-dialect identifiers.
 *
 * Each entry was added only after the first fresh `apps/web` production build proved it is emitted, as
 * AR-005's namespace process requires. Each names a vocabulary rather than a place to fetch: the four
 * W3C values are XML/SVG/MathML namespace names React DOM passes to `createElementNS` and
 * `setAttributeNS`, and the three `json-schema.org` values are `$schema` dialect identifiers that
 * `zod`'s `toJSONSchema` writes into a generated document. None is ever requested.
 */
export const NAMESPACE_LITERALS: ReadonlySet<string> = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/XML/1998/namespace',
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-04/schema#',
]);

/** React DOM's production error-decoder prefix. The trailing slash is part of the exact value. */
export const REACT_DIAGNOSTIC_PREFIX = 'https://react.dev/errors/';

/** The pinned Tailwind banner, byte for byte, including the leading `!` and the space before the close. */
export const TAILWIND_BANNER = '/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */';

const ZOD_SCAFFOLD_HEAD = 'http://[';
const ZOD_SCAFFOLD_TAIL = ']';
const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Calls and assignments that would use a string as a network destination. */
const NETWORK_CALLEES = new Set([
  'fetch',
  'Request',
  'XMLHttpRequest',
  'sendBeacon',
  'importScripts',
]);
const NETWORK_ASSIGNMENT_TARGETS = new Set(['location', 'href', 'src']);

// ---------------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------------

/** Case-insensitive `http://` or `https://` in already-decoded text. */
const DECODED_SCHEME = /https?:\/\//i;

const hex = (character: string): string => character.codePointAt(0)?.toString(16) ?? '';

/**
 * One scheme character, spelled literally or as a JavaScript or CSS escape of itself.
 *
 * Used on **raw** text that has no syntax of its own to decode — a JavaScript comment, a regular
 * expression, an HTML comment — so an escaped letter, colon, or slash cannot hide a scheme there.
 */
const escapableCharacter = (character: string): string => {
  const code = hex(character);
  const variants = [
    character.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'),
    `\\\\x${code}`,
    `\\\\u0{0,2}${code}`,
    `\\\\u\\{0*${code}\\}`,
    `\\\\0{0,4}${code}\\s?`,
  ];

  if (character === '/') {
    variants.push('\\\\/');
  }

  if (/[a-z]/i.test(character)) {
    const upper = character.toUpperCase();
    const upperCode = hex(upper);
    variants.push(
      upper,
      `\\\\x${upperCode}`,
      `\\\\u0{0,2}${upperCode}`,
      `\\\\0{0,4}${upperCode}\\s?`,
    );
  }

  return `(?:${variants.join('|')})`;
};

const RAW_SCHEME = new RegExp(
  ['h', 't', 't', 'p']
    .map(escapableCharacter)
    .join('')
    .concat(
      `${escapableCharacter('s')}?`,
      escapableCharacter(':'),
      escapableCharacter('/'),
      escapableCharacter('/'),
    ),
  'gi',
);

const containsDecodedUrl = (text: string): boolean => DECODED_SCHEME.test(text);

export const rawSchemeRanges = (text: string): ReadonlyArray<readonly [number, number]> => {
  const ranges: Array<readonly [number, number]> = [];
  RAW_SCHEME.lastIndex = 0;

  for (let match = RAW_SCHEME.exec(text); match !== null; match = RAW_SCHEME.exec(text)) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  return ranges;
};

// ---------------------------------------------------------------------------------------------------
// Result accumulation
// ---------------------------------------------------------------------------------------------------

class Accumulator {
  readonly exempt: Array<Occurrence & { readonly category: Category }> = [];
  readonly violations: Occurrence[] = [];
  readonly unresolved: Occurrence[] = [];

  merge(other: ScanResult): void {
    this.exempt.push(...other.exempt);
    this.violations.push(...other.violations);
    this.unresolved.push(...other.unresolved);
  }

  result(): ScanResult {
    return { exempt: this.exempt, violations: this.violations, unresolved: this.unresolved };
  }
}

// ---------------------------------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------------------------------

/**
 * Parses JavaScript through a no-emit `Program`, so syntax errors come from the public
 * `getSyntacticDiagnostics` rather than from an internal member or a recovered AST.
 */
const parseJavaScript = (
  text: string,
  fileName: string,
):
  | { readonly sourceFile: ts.SourceFile; readonly diagnostics: readonly ts.Diagnostic[] }
  | undefined => {
  const virtualName = fileName.endsWith('.js') ? fileName : `${fileName}.js`;
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const original = host.getSourceFile.bind(host);

  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === virtualName
      ? ts.createSourceFile(name, text, languageVersion, true, ts.ScriptKind.JS)
      : original(name, languageVersion, onError, shouldCreate);
  host.fileExists = (name) => name === virtualName;
  host.readFile = (name) => (name === virtualName ? text : undefined);

  const program = ts.createProgram([virtualName], options, host);
  const sourceFile = program.getSourceFile(virtualName);

  if (sourceFile === undefined) {
    return undefined;
  }

  return { sourceFile, diagnostics: program.getSyntacticDiagnostics(sourceFile) };
};

const locatorOf = (sourceFile: ts.SourceFile, node: ts.Node): string => {
  const start = node.getStart(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);

  return `${line + 1}:${character + 1} [${start}, ${node.getEnd()})`;
};

/** Whether a literal is used as a network destination: an argument to a request API, or assigned to one. */
const isNetworkUse = (node: ts.Node): boolean => {
  const parent = node.parent;

  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const callee = parent.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;

    if (name !== undefined && (NETWORK_CALLEES.has(name) || name === 'open')) {
      return parent.arguments?.includes(node as ts.Expression) ?? false;
    }
  }

  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = parent.left;
    const name = ts.isIdentifier(target)
      ? target.text
      : ts.isPropertyAccessExpression(target)
        ? target.name.text
        : undefined;

    return name !== undefined && NETWORK_ASSIGNMENT_TARGETS.has(name) && parent.right === node;
  }

  return false;
};

/**
 * Whether a substituted template is exactly Zod's IPv6 parse-and-discard scaffold.
 *
 * Shape: `http://[${IDENTIFIER_PATH}]`, the sole argument of `new URL(…)`, which is itself the discarded
 * expression of a statement inside the `try` block of a `try … catch`. Checked on both the raw span and
 * the cooked segments, so an escaped spelling outside the raw shape does not qualify.
 */
const isZodScaffold = (template: ts.TemplateExpression, sourceFile: ts.SourceFile): boolean => {
  const [span] = template.templateSpans;

  if (
    template.templateSpans.length !== 1 ||
    span === undefined ||
    template.head.text !== ZOD_SCAFFOLD_HEAD ||
    span.literal.text !== ZOD_SCAFFOLD_TAIL ||
    !IDENTIFIER_PATH.test(span.expression.getText(sourceFile))
  ) {
    return false;
  }

  const raw = template.getText(sourceFile);

  if (
    raw !== `\`${ZOD_SCAFFOLD_HEAD}\${${span.expression.getText(sourceFile)}}${ZOD_SCAFFOLD_TAIL}\``
  ) {
    return false;
  }

  const construction = template.parent;

  if (
    !ts.isNewExpression(construction) ||
    !ts.isIdentifier(construction.expression) ||
    construction.expression.text !== 'URL' ||
    construction.arguments?.length !== 1 ||
    construction.arguments[0] !== template
  ) {
    return false;
  }

  const statement = construction.parent;

  if (!ts.isExpressionStatement(statement)) {
    return false;
  }

  const block = statement.parent;

  return (
    ts.isBlock(block) &&
    ts.isTryStatement(block.parent) &&
    block.parent.tryBlock === block &&
    block.parent.catchClause !== undefined
  );
};

export const scanJavaScript = (text: string, file: string): ScanResult => {
  const result = new Accumulator();
  const parsed = parseJavaScript(text, file);

  if (parsed === undefined) {
    result.unresolved.push({ file, locator: '0', context: 'javascript', value: 'unparsable' });
    return result.result();
  }

  const { sourceFile, diagnostics } = parsed;

  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      result.unresolved.push({
        file,
        locator: String(diagnostic.start ?? 0),
        context: 'javascript-syntax',
        value: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      });
    }

    return result.result();
  }

  /** Every literal token's span, so raw occurrences can be associated with their decoded view. */
  const literalSpans: Array<readonly [number, number]> = [];

  const report = (node: ts.Node, context: string, value: string, category?: Category): void => {
    const occurrence = { file, locator: locatorOf(sourceFile, node), context, value };

    if (category === undefined) {
      result.violations.push(occurrence);
    } else {
      result.exempt.push({ ...occurrence, category });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literalSpans.push([node.getStart(sourceFile), node.getEnd()]);

      if (containsDecodedUrl(node.text)) {
        const tagged = ts.isTaggedTemplateExpression(node.parent);
        const context = ts.isStringLiteral(node) ? 'string-literal' : 'template-literal';

        if (!tagged && node.text === REACT_DIAGNOSTIC_PREFIX) {
          report(node, context, node.text, 'react');
        } else if (!tagged && NAMESPACE_LITERALS.has(node.text) && !isNetworkUse(node)) {
          report(node, context, node.text, 'namespace');
        } else {
          report(node, context, node.text);
        }
      }
    } else if (ts.isTemplateExpression(node)) {
      const segments = [node.head, ...node.templateSpans.map((span) => span.literal)];

      // Only the quasis are literal text. Claiming the whole template expression let a raw occurrence
      // inside a substitution — `${/* https://api.example.test */ x}` — count as already classified,
      // so it produced no violation at all. The substitutions are visited as children instead, and
      // their own literals register their own spans.
      for (const segment of segments) {
        literalSpans.push([segment.getStart(sourceFile), segment.getEnd()]);
      }

      const carriesUrl = segments.some((segment) => containsDecodedUrl(segment.text));

      if (carriesUrl) {
        if (isZodScaffold(node, sourceFile)) {
          report(node, 'zod-scaffold', node.getText(sourceFile), 'zod');
        } else {
          // A segment never qualifies for the React or namespace exemption on its own.
          for (const segment of segments) {
            if (containsDecodedUrl(segment.text)) {
              report(segment, 'template-segment', segment.text);
            }
          }
        }
      }
    } else if (ts.isRegularExpressionLiteral(node) || ts.isJsxText(node)) {
      literalSpans.push([node.getStart(sourceFile), node.getEnd()]);

      if (rawSchemeRanges(node.getText(sourceFile)).length > 0) {
        report(
          node,
          ts.isJsxText(node) ? 'jsx-text' : 'regular-expression',
          node.getText(sourceFile),
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  // Raw view: an occurrence outside every literal token — a comment, for instance — has no represented
  // value to classify, and no category exempts JavaScript comment text.
  for (const [start, end] of rawSchemeRanges(text)) {
    const insideLiteral = literalSpans.some(([from, to]) => start >= from && end <= to);

    if (!insideLiteral) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      result.violations.push({
        file,
        locator: `${line + 1}:${character + 1} [${start}, ${end})`,
        context: 'javascript-raw',
        value: text.slice(start, Math.min(text.length, end + 40)),
      });
    }
  }

  return result.result();
};

// ---------------------------------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------------------------------

/**
 * CSS Syntax §3.3 input preprocessing, applied before any escape is interpreted.
 *
 * A stylesheet is normalized before tokenization: a CRLF pair, a lone CR, and a form feed each become
 * one LF, and a NULL becomes U+FFFD. Skipping this step made the set of characters that can terminate
 * a hex escape look smaller than it is — `\75` followed by CR, FF, or CRLF names the same identifier a
 * following space or tab would — so a guard that only understood one spelling could be walked around.
 */
export const preprocessCss = (text: string): string =>
  text.replace(/\r\n|\r|\f/g, '\n').replace(/\0/g, '�');

/**
 * Decodes CSS escapes per CSS Syntax: one to six hex digits with one optional terminating whitespace,
 * an escaped non-hex character standing for itself, and an escaped newline as a string continuation.
 *
 * The input is preprocessed first, so every documented whitespace terminator is interpreted, and the
 * decoding itself stays a single pass over the original bytes.
 *
 * Returns `undefined` for an escape that cannot be interpreted — a trailing lone backslash.
 */
export const decodeCssEscapes = (raw: string): string | undefined => {
  const text = preprocessCss(raw);
  let output = '';
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (character !== '\\') {
      output += character;
      index += 1;
      continue;
    }

    const next = text[index + 1];

    if (next === undefined) {
      return undefined;
    }

    if (next === '\n') {
      index += 2;
      continue;
    }

    const hexMatch = /^[0-9a-fA-F]{1,6}/.exec(text.slice(index + 1));

    if (hexMatch !== null) {
      const codePoint = Number.parseInt(hexMatch[0], 16);
      const valid =
        codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
      output += valid ? String.fromCodePoint(codePoint) : '�';
      index += 1 + hexMatch[0].length;

      if (text[index] === ' ' || text[index] === '\t' || text[index] === '\n') {
        index += 1;
      }

      continue;
    }

    output += next;
    index += 2;
  }

  return output;
};

const cssLocator = (node: ChildNode | Root): string => {
  const start = node.source?.start;

  return start === undefined ? '?' : `${start.line}:${start.column} [${start.offset ?? '?'}]`;
};

export const scanCss = (text: string, file: string): ScanResult => {
  const result = new Accumulator();
  let root: Root;

  try {
    root = postcss.parse(text, { from: file });
  } catch (error) {
    result.unresolved.push({
      file,
      locator: '0',
      context: 'css-syntax',
      value: error instanceof Error ? error.message : 'unparsable',
    });
    return result.result();
  }

  /** The exact character range of the sanctioned banner, which alone is excluded from detection. */
  const exemptRanges: Array<readonly [number, number]> = [];
  /** Ranges whose decoded view was inspected, so a raw hit inside one is already classified. */
  const inspectedRanges: Array<readonly [number, number]> = [];

  const inspect = (node: ChildNode, context: string, raw: string): void => {
    const from = node.source?.start?.offset;
    const to = node.source?.end?.offset;

    // PostCSS 8.5 reports `source.end.offset` as exclusive, verified against the pinned build.
    if (from !== undefined && to !== undefined) {
      inspectedRanges.push([from, to]);
    }

    const decoded = decodeCssEscapes(raw);

    if (decoded === undefined) {
      result.unresolved.push({ file, locator: cssLocator(node), context, value: raw });
      return;
    }

    if (containsDecodedUrl(decoded)) {
      result.violations.push({ file, locator: cssLocator(node), context, value: decoded });
    }
  };

  const inspectValue = (node: ChildNode, context: string, value: string): void => {
    inspect(node, context, value);

    valueParser(value).walk((part) => {
      if (part.type === 'string' || part.type === 'word') {
        inspect(node, `${context}-${part.type}`, part.value);
      } else if (part.type === 'function' && part.value === 'url') {
        inspect(node, `${context}-url`, valueParser.stringify(part.nodes));
      }
    });
  };

  root.walk((node) => {
    if (node.type === 'comment') {
      const start = node.source?.start?.offset;
      const end = node.source?.end?.offset;

      if (start !== undefined && end !== undefined) {
        const rawComment = text.slice(start, end);

        if (rawComment === TAILWIND_BANNER) {
          exemptRanges.push([start, end]);
          result.exempt.push({
            file,
            locator: cssLocator(node),
            context: 'css-comment',
            value: rawComment,
            category: 'tailwind',
          });
          return;
        }
      }

      inspect(node, 'css-comment', node.text);
    } else if (node.type === 'decl') {
      inspect(node, 'css-property', node.prop);
      inspectValue(node, 'css-value', node.value);
    } else if (node.type === 'atrule') {
      inspect(node, 'css-at-rule-name', node.name);
      inspectValue(node, 'css-at-rule-params', node.params);
    } else if (node.type === 'rule') {
      inspect(node, 'css-selector', node.selector);
    }
  });

  // Raw view over the whole asset, so nothing the node walk missed can carry a URL. A raw hit inside the
  // matched banner is exempt; one inside an inspected node was already classified by its decoded view;
  // anything else — text between nodes that the walk never reached — is a violation of its own.
  for (const [start, end] of rawSchemeRanges(text)) {
    const within = (ranges: ReadonlyArray<readonly [number, number]>): boolean =>
      ranges.some(([from, to]) => start >= from && end <= to);

    if (!within(exemptRanges) && !within(inspectedRanges)) {
      result.violations.push({
        file,
        locator: `[${start}, ${end})`,
        context: 'css-raw',
        value: text.slice(start, Math.min(text.length, end + 40)),
      });
    }
  }

  return result.result();
};

// ---------------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------------

const domPath = (element: Element): string => {
  const parts: string[] = [];

  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (child) => child.tagName === current?.tagName,
        )
      : [];
    const position = siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : '';
    parts.unshift(`${current.tagName.toLowerCase()}${position}`);
  }

  return parts.join(' > ');
};

interface RawTextBody {
  readonly tag: 'script' | 'style';
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const ASCII_ALPHA = /[a-zA-Z]/;
const HTML_WHITESPACE = new Set(['\t', '\n', '\f', '\r', ' ']);

/**
 * Locates the raw-text bodies of `<script>` and `<style>` elements by walking the HTML tokenizer's
 * states rather than by matching tag shapes.
 *
 * A regular expression cannot decide where a start tag ends, because `>` is an ordinary character
 * inside a quoted attribute value. `<script data-x=">" data-a="/" data-a="https://api.example.test">`
 * ended its "tag" at the first quoted `>`, so the rest of the start tag — including a repeated
 * attribute the DOM parser then discarded — was mistaken for script body and excluded from the raw
 * pass, and the forbidden URL was reported by neither view.
 *
 * The states implemented are the ones that decide those boundaries: data, markup declarations and
 * comments, tag and attribute names, single-quoted, double-quoted, and unquoted attribute values, and
 * the raw-text end-tag search, which per the HTML syntax ends at the first `</name` followed by
 * whitespace, `/`, or `>`. Nothing is decoded here and no tree is built: this reports source offsets.
 */
const rawTextBodies = (text: string): RawTextBody[] => {
  const bodies: RawTextBody[] = [];
  let index = 0;

  /** Consumes a start or end tag from `<`, returning the offset just past it and its name. */
  const consumeTag = (
    from: number,
  ): { readonly next: number; readonly name: string; readonly closing: boolean } => {
    let cursor = from + 1;
    const closing = text[cursor] === '/';

    if (closing) {
      cursor += 1;
    }

    const nameStart = cursor;

    while (cursor < text.length) {
      const character = text[cursor] ?? '';

      if (HTML_WHITESPACE.has(character) || character === '/' || character === '>') {
        break;
      }

      cursor += 1;
    }

    const name = text.slice(nameStart, cursor).toLowerCase();

    // Attribute soup: only quoting decides where the tag ends.
    let quote: string | undefined;

    while (cursor < text.length) {
      const character = text[cursor] ?? '';

      if (quote !== undefined) {
        if (character === quote) {
          quote = undefined;
        }
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        cursor += 1;
        break;
      }

      cursor += 1;
    }

    return { next: cursor, name, closing };
  };

  while (index < text.length) {
    const open = text.indexOf('<', index);

    if (open === -1) {
      break;
    }

    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);

      index = close === -1 ? text.length : close + 3;
      continue;
    }

    if (text.startsWith('<!', open) || text.startsWith('<?', open)) {
      const close = text.indexOf('>', open + 2);

      index = close === -1 ? text.length : close + 1;
      continue;
    }

    const afterBracket = text[open + 1] ?? '';

    if (
      !ASCII_ALPHA.test(afterBracket) &&
      !(afterBracket === '/' && ASCII_ALPHA.test(text[open + 2] ?? ''))
    ) {
      index = open + 1;
      continue;
    }

    const tag = consumeTag(open);

    index = tag.next;

    if (tag.closing || (tag.name !== 'script' && tag.name !== 'style')) {
      continue;
    }

    // Raw text: scan for the matching end tag, which is the only thing that can close it.
    const bodyStart = index;
    let cursor = index;
    let bodyEnd = text.length;

    while (cursor < text.length) {
      const candidate = text.toLowerCase().indexOf(`</${tag.name}`, cursor);

      if (candidate === -1) {
        break;
      }

      const following = text[candidate + tag.name.length + 2] ?? '';

      if (
        following === '' ||
        HTML_WHITESPACE.has(following) ||
        following === '/' ||
        following === '>'
      ) {
        bodyEnd = candidate;
        break;
      }

      cursor = candidate + 1;
    }

    bodies.push({
      tag: tag.name,
      start: bodyStart,
      end: bodyEnd,
      text: text.slice(bodyStart, bodyEnd),
    });
    index = bodyEnd;
  }

  return bodies;
};

/**
 * Scans HTML through the inert `DOMParser` of Vitest's jsdom environment, configured so parsed scripts
 * never run and subresources never load. Attribute values and text are inspected **after** HTML
 * decoding; embedded JavaScript and CSS go to their own scanners; `srcdoc` is parsed as a further HTML
 * layer. No emitted HTML category exists, so every occurrence here is a violation.
 */
export const scanHtml = (text: string, file: string, depth = 0): ScanResult => {
  const result = new Accumulator();
  /** Every raw-text body actually handed to a contextual scanner, in document order. */
  const dispatched: Array<{ readonly tag: 'script' | 'style'; readonly text: string }> = [];

  if (depth > 4) {
    result.unresolved.push({
      file,
      locator: 'srcdoc',
      context: 'html-depth',
      value: 'nesting limit reached',
    });
    return result.result();
  }

  const document = new DOMParser().parseFromString(text, 'text/html');

  const visitNode = (node: Node, owner: string): void => {
    if (node.nodeType === Node.COMMENT_NODE) {
      if (
        rawSchemeRanges(node.textContent ?? '').length > 0 ||
        containsDecodedUrl(node.textContent ?? '')
      ) {
        result.violations.push({
          file,
          locator: owner,
          context: 'html-comment',
          value: node.textContent ?? '',
        });
      }
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? '';
      const parentTag = node.parentElement?.tagName.toLowerCase();

      if (parentTag === 'script') {
        dispatched.push({ tag: 'script', text: value });
        result.merge(scanJavaScript(value, `${file} ${owner} <script>`));
      } else if (parentTag === 'style') {
        dispatched.push({ tag: 'style', text: value });
        result.merge(scanCss(value, `${file} ${owner} <style>`));
      } else if (containsDecodedUrl(value)) {
        result.violations.push({ file, locator: owner, context: 'html-text', value });
      }
      return;
    }

    if (!(node instanceof Element)) {
      for (const child of Array.from(node.childNodes)) {
        visitNode(child, owner);
      }
      return;
    }

    const path = domPath(node);

    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const locator = `${path} @${name}`;

      if (name === 'srcdoc') {
        result.merge(scanHtml(attribute.value, `${file} ${locator}`, depth + 1));
      } else if (name.startsWith('on')) {
        result.merge(
          scanJavaScript(`function handler(event) {\n${attribute.value}\n}`, `${file} ${locator}`),
        );
      } else if (name === 'style') {
        result.merge(scanCss(`x{${attribute.value}}`, `${file} ${locator}`));
      } else if (containsDecodedUrl(attribute.value)) {
        result.violations.push({
          file,
          locator,
          context: 'html-attribute',
          value: attribute.value,
        });
      }
    }

    if (node instanceof HTMLTemplateElement) {
      for (const child of Array.from(node.content.childNodes)) {
        visitNode(child, `${path} #content`);
      }
    }

    for (const child of Array.from(node.childNodes)) {
      visitNode(child, path);
    }
  };

  for (const child of Array.from(document.childNodes)) {
    visitNode(child, '#document');
  }

  // Raw view over the original markup. The parser normalises: a repeated attribute
  // (`<a href="/" href="https://api.example.test">`) keeps only the first, so the second never reaches
  // the node walk and left `violations` empty. Anything the raw text carries is reported here with its
  // offsets, whether or not the decoded view already named it.
  //
  // The only exclusions are raw-text bodies that were **actually** passed to `scanJavaScript` or
  // `scanCss`, matched by tag and exact body text. A body the parser never delivered — dropped, or
  // never a body in the first place because the range was misread — is therefore still raw-scanned
  // instead of being excused by a range nobody inspected.
  const undispatched = [...dispatched];
  const excluded: Array<readonly [number, number]> = [];

  for (const body of rawTextBodies(text)) {
    const match = undispatched.findIndex(
      (entry) => entry.tag === body.tag && entry.text === body.text,
    );

    if (match !== -1) {
      undispatched.splice(match, 1);
      excluded.push([body.start, body.end]);
    }
  }

  for (const [start, end] of rawSchemeRanges(text)) {
    if (!excluded.some(([from, to]) => start >= from && end <= to)) {
      result.violations.push({
        file,
        locator: `[${start}, ${end})`,
        context: 'html-raw',
        value: text.slice(start, Math.min(text.length, end + 40)),
      });
    }
  }

  return result.result();
};

// ---------------------------------------------------------------------------------------------------
// Emitted document foundation
// ---------------------------------------------------------------------------------------------------

export const REQUIRED_VIEWPORT = 'width=device-width, initial-scale=1';

export interface DocumentFoundation {
  readonly lang: string | null;
  readonly viewportContents: readonly string[];
}

/** Reads the `lang` attribute and every viewport declaration from an HTML document. */
export const readDocumentFoundation = (text: string): DocumentFoundation => {
  const document = new DOMParser().parseFromString(text, 'text/html');

  return {
    lang: document.documentElement.getAttribute('lang'),
    viewportContents: Array.from(document.querySelectorAll('meta[name="viewport"]')).map(
      (meta) => meta.getAttribute('content') ?? '',
    ),
  };
};
