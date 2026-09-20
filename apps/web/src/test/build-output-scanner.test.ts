/**
 * The positive and negative matrix behind Check 2.
 *
 * `build-output.verify.ts` runs the same scanners over the real `dist`, but a passing artifact only
 * shows that today's output is clean. These cases pin the classifier itself: each of the four
 * sanctioned categories is accepted in its proven shape, and each is rejected once the shape that
 * makes it safe is gone. The raw view is exercised separately from the decoded one, because an
 * occurrence that only the raw text carries — a comment inside a template substitution, a repeated
 * HTML attribute the parser discards — is exactly what a decoded-only scan misses.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type Category,
  decodeCssEscapes,
  NAMESPACE_LITERALS,
  type Occurrence,
  REACT_DIAGNOSTIC_PREFIX,
  type ScanResult,
  scanCss,
  scanHtml,
  scanJavaScript,
  TAILWIND_BANNER,
} from '@/src/test/build-output-scanner';

const FORBIDDEN = 'https://api.example.test/v1';
const DOLLAR = '$';

const contexts = (occurrences: readonly Occurrence[]): string[] =>
  occurrences.map((occurrence) => occurrence.context);

const categories = (result: ScanResult): Category[] =>
  result.exempt.map((occurrence) => occurrence.category);

const clean = (result: ScanResult): void => {
  expect(result.violations).toEqual([]);
  expect(result.unresolved).toEqual([]);
};

describe('the emitted-artifact scanner: JavaScript', () => {
  it('exempts a platform namespace literal and the React decoder prefix in their proven shapes', () => {
    const result = scanJavaScript(
      [
        'const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");',
        'const dialect = "https://json-schema.org/draft/2020-12/schema";',
        `const decoder = ${JSON.stringify(REACT_DIAGNOSTIC_PREFIX)} + code;`,
        'export { svg, dialect, decoder };',
      ].join('\n'),
      'emitted.js',
    );

    clean(result);
    expect(categories(result)).toEqual(['namespace', 'namespace', 'react']);
  });

  it('withdraws the namespace exemption once the same literal is used as a request target', () => {
    const result = scanJavaScript('await fetch("http://www.w3.org/2000/svg");', 'emitted.js');

    expect(result.exempt).toEqual([]);
    expect(contexts(result.violations)).toEqual(['string-literal']);
  });

  it('withdraws the React exemption from a tagged template carrying the same text', () => {
    const result = scanJavaScript(`const out = tag\`${REACT_DIAGNOSTIC_PREFIX}\`;`, 'emitted.js');

    expect(result.exempt).toEqual([]);
    expect(contexts(result.violations)).toEqual(['template-literal']);
  });

  it("exempts Zod's IPv6 parse-and-discard scaffold and nothing that merely resembles it", () => {
    // Written with a substituted `$` so this file contains no literal placeholder of its own.
    const substitution = (expression: string): string => `\`http://[${DOLLAR}{${expression}}]\``;
    const scaffold = `try { new URL(${substitution('input.value')}); } catch { return false; }`;

    clean(scanJavaScript(`function check(input) { ${scaffold} return true; }`, 'emitted.js'));
    expect(
      categories(scanJavaScript(`function check(input) { ${scaffold} }`, 'emitted.js')),
    ).toEqual(['zod']);

    // Same text, no `try`: the construction is no longer a parse-and-discard, so it is a violation.
    const bare = scanJavaScript(
      `function check(input) { new URL(${substitution('input')}); }`,
      'emitted.js',
    );

    expect(bare.exempt).toEqual([]);
    expect(contexts(bare.violations)).toEqual(['template-segment']);
  });

  it('reports a forbidden URL in a comment inside a template substitution', () => {
    const result = scanJavaScript(
      ['const rendered = `prefix ${', `  /* ${FORBIDDEN} */ value`, '} suffix`;'].join('\n'),
      'emitted.js',
    );

    expect(contexts(result.violations)).toEqual(['javascript-raw']);
    expect(result.violations[0]?.value).toContain(FORBIDDEN);
  });

  it('reports a forbidden URL in a plain comment, a string, and a template segment', () => {
    const result = scanJavaScript(
      [
        `// ${FORBIDDEN}`,
        `const base = "${FORBIDDEN}";`,
        `const built = \`${FORBIDDEN}/\${path}\`;`,
        'export { base, built };',
      ].join('\n'),
      'emitted.js',
    );

    expect(contexts(result.violations).toSorted()).toEqual([
      'javascript-raw',
      'string-literal',
      'template-segment',
    ]);
  });
});

describe('the emitted-artifact scanner: CSS', () => {
  it('exempts the pinned Tailwind banner byte for byte', () => {
    const result = scanCss(`${TAILWIND_BANNER}\n.a { color: red; }\n`, 'emitted.css');

    clean(result);
    expect(categories(result)).toEqual(['tailwind']);
  });

  it('rejects a banner whose text differs from the pinned bytes', () => {
    const result = scanCss(`${TAILWIND_BANNER.replace('v4.3.3', 'v4.3.4')}\n`, 'emitted.css');

    expect(result.exempt).toEqual([]);
    expect(contexts(result.violations)).toContain('css-comment');
  });

  it('decodes CSS escapes before matching, so an escaped scheme is still found', () => {
    const result = scanCss(
      '.a { background: url("\\68 ttps://api.example.test/x"); }',
      'emitted.css',
    );

    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]?.value).toContain('https://api.example.test/x');
  });

  it('reports an absolute url() and a forbidden URL between nodes', () => {
    const result = scanCss(`.a { background: url("${FORBIDDEN}"); }\n`, 'emitted.css');

    expect(result.violations.length).toBeGreaterThan(0);
    expect(contexts(result.violations)).toContain('css-value');
  });
});

describe('the emitted-artifact scanner: HTML', () => {
  it('accepts the emitted shell shape, with relative asset references only', () => {
    clean(
      scanHtml(
        [
          '<!doctype html>',
          '<html lang="de"><head><link rel="stylesheet" href="/assets/index.css"></head>',
          '<body><div id="root"></div><script type="module" src="/assets/index.js"></script></body>',
          '</html>',
        ].join('\n'),
        'index.html',
      ),
    );
  });

  it('reports a repeated attribute the parser discards', () => {
    const result = scanHtml(`<a href="/" href="${FORBIDDEN}">link</a>`, 'index.html');

    expect(contexts(result.violations)).toEqual(['html-raw']);
    expect(result.violations[0]?.value).toContain(FORBIDDEN);
  });

  it('reports a forbidden URL in an attribute through both the decoded and the raw view', () => {
    const result = scanHtml(`<a href="${FORBIDDEN}">link</a>`, 'index.html');

    expect(contexts(result.violations).toSorted()).toEqual(['html-attribute', 'html-raw']);
  });

  it('leaves script and style bodies to their own scanners, keeping their exemptions', () => {
    const result = scanHtml(
      [
        `<style>${TAILWIND_BANNER}\n.a { color: red; }</style>`,
        `<script>const d = ${JSON.stringify(REACT_DIAGNOSTIC_PREFIX)};</script>`,
      ].join('\n'),
      'index.html',
    );

    clean(result);
    expect(categories(result).toSorted()).toEqual(['react', 'tailwind']);
  });

  it('still reports a forbidden URL inside a script body', () => {
    const result = scanHtml(`<script>fetch("${FORBIDDEN}");</script>`, 'index.html');

    expect(contexts(result.violations)).toEqual(['string-literal']);
  });

  it('ends a start tag at the real `>`, not at one inside a quoted attribute value', () => {
    // A quoted `>` made the rest of the start tag look like script body, which the raw pass then
    // excluded; the DOM parser had already dropped the repeated attribute, so neither view saw it.
    for (const tag of ['script', 'style']) {
      const input = `<${tag} data-x=">" data-a="/" data-a="${FORBIDDEN}"></${tag}>`;
      const result = scanHtml(input, 'index.html');

      expect(contexts(result.violations)).toEqual(['html-raw']);
      expect(result.violations[0]?.value).toContain(FORBIDDEN);
    }
  });

  it('excludes only the body that a contextual scanner actually received', () => {
    const input = [
      `<script data-x=">" data-a="${FORBIDDEN}">const d = ${JSON.stringify(
        REACT_DIAGNOSTIC_PREFIX,
      )};</script>`,
      `<style data-y="'>'">${TAILWIND_BANNER}
.a { color: red; }</style>`,
    ].join('\n');
    const result = scanHtml(input, 'index.html');

    // The attribute is reported by both views; both bodies keep their own contextual exemptions.
    expect(contexts(result.violations).toSorted()).toEqual(['html-attribute', 'html-raw']);
    expect(categories(result).toSorted()).toEqual(['react', 'tailwind']);
  });

  it('reads single quotes, comments, and unquoted values as the tokenizer does', () => {
    // Each carries a repeated attribute that only the raw view can see, behind a different lexical
    // state: a single-quoted `>`, a commented-out start tag, and an unquoted attribute value.
    const cases = [
      `<script data-x='>' data-a="/" data-a="${FORBIDDEN}"></script>`,
      `<!-- <script> --><a href="/" href="${FORBIDDEN}">x</a>`,
      `<script data-x=a>ok();</script><a href="/" href="${FORBIDDEN}">x</a>`,
    ];

    for (const input of cases) {
      const result = scanHtml(input, 'index.html');

      expect(contexts(result.violations)).toContain('html-raw');
      expect(result.unresolved).toEqual([]);
    }
  });

  it('keeps legitimate embedded content clean, including markup-like text in a script body', () => {
    clean(
      scanHtml(
        [
          '<style>.a::after { content: "x"; }</style>',
          '<script>const markup = "<b>ok</b>";</script>',
        ].join('\n'),
        'index.html',
      ),
    );
  });

  it('reports a script body that is not JavaScript as unresolved rather than passing it', () => {
    const result = scanHtml('<script type="application/json">{"a":1}</script>', 'index.html');

    // Fail-closed: the body was dispatched to the JavaScript scanner and could not be interpreted.
    expect(contexts(result.unresolved)).toEqual(['javascript-syntax']);
  });
});

/**
 * Contextual decoding: the represented value decides, in each language's own terms.
 *
 * Every fixture below is the literal text handed to the scanner, built with raw strings so no host
 * escape is consumed first, and the bytes that matter are asserted before the result is checked.
 */
describe('contextual decoding', () => {
  /**
   * A single backslash, so no fixture in this file contains a literal escape sequence of its own.
   *
   * The bytes are then asserted before each result is checked, which is what keeps a host-language
   * layer from quietly cooking a fixture into the very shape it was meant to test.
   */
  const BS = '\\';

  const rejects = (result: ScanResult, value = 'api.example.test'): void => {
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.map((violation) => violation.value).join(' ')).toContain(value);
  };

  it('cooks JavaScript escapes in every literal form before matching', () => {
    const escaped = `https${BS}u003a${BS}u002f${BS}u002fapi.example.test`;
    const hex = `${BS}x68ttps${BS}x3a${BS}x2f${BS}x2fapi.example.test`;
    const whole = `${BS}u0068${BS}u0074${BS}u0074${BS}u0070${BS}u0073${BS}u003a${BS}u002f${BS}u002fapi.example.test`;
    const codePoint = `${BS}u{68}ttps${BS}u{3a}${BS}u{2f}${BS}u{2f}api.example.test`;

    expect(escaped).toBe(`https${BS}u003a${BS}u002f${BS}u002fapi.example.test`);
    expect(escaped.includes('://')).toBe(false);
    expect(codePoint).toContain(`${BS}u{3a}`);

    for (const body of [escaped, hex, whole, codePoint]) {
      rejects(scanJavaScript(`const a = "${body}";`, 'emitted.js'));
      rejects(scanJavaScript(`const a = '${body}';`, 'emitted.js'));
      rejects(scanJavaScript(`const a = \`${body}\`;`, 'emitted.js'));
    }

    // Mixed case and mixed forms, with no URL normalization.
    rejects(scanJavaScript(`const a = "HTTPS${BS}u003A//api.example.test";`, 'emitted.js'));
    rejects(scanJavaScript(`const a = "${BS}x68ttps${BS}u003a//api.example.test";`, 'emitted.js'));
  });

  it('cooks a line continuation inside a string', () => {
    const source = `const a = "http${BS}\ns://api.example.test";`;

    expect(source).toContain(`${BS}\n`);
    rejects(scanJavaScript(source, 'emitted.js'));
  });

  it('reports a substituted template and an absolute literal inside its expression', () => {
    const body = `https${BS}u003a${BS}u002f${BS}u002fapi.example.test`;

    rejects(scanJavaScript(`const a = \`${body}\${x}\`;`, 'emitted.js'));
    rejects(scanJavaScript(`const a = \`x${DOLLAR}{"https://api.example.test"}\`;`, 'emitted.js'));
  });

  it('reports a tagged template whose raw or cooked segment is absolute', () => {
    const body = `https${BS}u003a${BS}u002f${BS}u002fapi.example.test`;

    rejects(scanJavaScript('const a = tag`https://api.example.test`;', 'emitted.js'));
    rejects(scanJavaScript(`const a = tag\`${body}\${x}\`;`, 'emitted.js'));
  });

  it('decodes once: a literal backslash sequence is not a URL', () => {
    const source = `const a = "https${BS}${BS}u003a${BS}${BS}u002f${BS}${BS}u002fapi.example.test";`;

    expect(source).toContain(`${BS}${BS}u003a`);
    clean(scanJavaScript(source, 'emitted.js'));
  });

  it('decodes CSS escapes in a url(), a string, and an @import target', () => {
    const body = `https${BS}3a ${BS}2f ${BS}2f api.example.test`;

    expect(body).toContain(`${BS}3a `);
    rejects(scanCss(`.a { background: url("${body}"); }`, 'a.css'));
    rejects(scanCss(`.a { content: "${body}"; }`, 'a.css'));
    rejects(scanCss(`@import "${body}";`, 'a.css'));

    // A genuine comment keeps its context, so the banner match is unaffected by the decoding above.
    clean(scanCss(`${TAILWIND_BANNER}\n.a { color: red; }`, 'a.css'));
  });

  it('decodes HTML character references once, in named, decimal, and hex forms', () => {
    for (const reference of [
      'https&#58;&#47;&#47;api.example.test',
      'https&#x3a;&#x2f;&#x2f;api.example.test',
      'https&colon;&sol;&sol;api.example.test',
    ]) {
      rejects(scanHtml(`<a href="${reference}">x</a>`, 'index.html'));
    }
  });

  it('descends into style attributes, event attributes, and nested srcdoc', () => {
    const css = `https${BS}3a ${BS}2f ${BS}2f api.example.test`;
    const js = `https${BS}u003a${BS}u002f${BS}u002fapi.example.test`;

    rejects(scanHtml(`<div style="background: url('${css}')"></div>`, 'index.html'));
    rejects(scanHtml(`<button onclick="load('${js}')"></button>`, 'index.html'));
    rejects(
      scanHtml(
        '<iframe srcdoc="&lt;a href=&quot;https://api.example.test&quot;&gt;x&lt;/a&gt;"></iframe>',
        'index.html',
      ),
    );
  });

  it('executes nothing and requests nothing while scanning', () => {
    const marker = '__ar005_scanner_marker';
    const fetchSpy = vi.fn();

    vi.stubGlobal('fetch', fetchSpy);
    Reflect.deleteProperty(globalThis, marker);

    const result = scanHtml(
      [
        `<script>globalThis.${marker} = true;</script>`,
        '<img src="https://api.example.test/pixel.png">',
        '<link rel="stylesheet" href="https://api.example.test/x.css">',
      ].join('\n'),
      'index.html',
    );

    expect(Reflect.has(globalThis, marker)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The forbidden references are still reported; inertness is not silence.
    expect(result.violations.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('reports a syntax or decoding failure as unresolved rather than as a pass', () => {
    expect(contexts(scanJavaScript('const a = ;', 'emitted.js').unresolved)).toEqual([
      'javascript-syntax',
    ]);
    expect(contexts(scanCss('.a { color: red;', 'a.css').unresolved)).toEqual(['css-syntax']);
    // An escape that cannot be interpreted returns no value at all, which callers report as unresolved.
    expect(decodeCssEscapes(`x${BS}`)).toBeUndefined();
  });

  it('passes ordinary division, regular expressions, and non-URL Unicode escapes', () => {
    clean(
      scanJavaScript(
        [
          'const ratio = total / count / 2;',
          'const token = /ab+c/gi.exec(text);',
          String.raw`const label = "überfall \u{1f600}";`,
          'export { ratio, token, label };',
        ].join('\n'),
        'emitted.js',
      ),
    );
  });
});

describe('the platform-namespace exemption', () => {
  it('exempts only the exact allowlisted literals', () => {
    for (const literal of NAMESPACE_LITERALS) {
      const result = scanJavaScript(`const a = ${JSON.stringify(literal)};`, 'emitted.js');

      clean(result);
      expect(categories(result)).toEqual(['namespace']);
    }
  });

  it('rejects a near match and another URL on the same host', () => {
    for (const literal of [
      'http://www.w3.org/2000/svg2',
      'http://www.w3.org/2000/',
      'http://www.w3.org/2000/svg/',
      'https://www.w3.org/2000/svg',
      'http://www.w3.org/TR/SVG2/',
      'https://json-schema.org/draft/2020-12/schema/x',
    ]) {
      const result = scanJavaScript(`const a = ${JSON.stringify(literal)};`, 'emitted.js');

      expect(result.exempt).toEqual([]);
      expect(result.violations.map((violation) => violation.value)).toEqual([literal]);
    }
  });

  it('keeps scanning the rest of an asset that holds an exempt literal', () => {
    const result = scanJavaScript(
      [
        'const ns = "http://www.w3.org/2000/svg";',
        `const api = "${FORBIDDEN}";`,
        'export { ns, api };',
      ].join('\n'),
      'emitted.js',
    );

    expect(categories(result)).toEqual(['namespace']);
    expect(result.violations.map((violation) => violation.value)).toEqual([FORBIDDEN]);
  });
});

describe('the Tailwind license-comment exemption', () => {
  const TAILWIND_HOST = 'https://tailwindcss.com';

  it('exempts the exact verified banner and nothing else on that host', () => {
    clean(scanCss(`${TAILWIND_BANNER}\n.a { color: red; }`, 'emitted.css'));

    for (const source of [
      `${TAILWIND_BANNER}\n.a { background: url("${TAILWIND_HOST}/logo.svg"); }`,
      `${TAILWIND_BANNER}\n@import "${TAILWIND_HOST}/base.css";`,
      `.a { content: "${TAILWIND_BANNER}"; }`,
      `${TAILWIND_BANNER}\n.a { background: url("${FORBIDDEN}"); }`,
      `/*! tailwindcss v4.3.3 | MIT License | ${TAILWIND_HOST} | ${FORBIDDEN} */`,
      `.a { color: red; } /* see ${TAILWIND_HOST}/docs */`,
    ]) {
      expect(scanCss(source, 'emitted.css').violations.length).toBeGreaterThan(0);
    }
  });

  it('does not extend the comment exemption to other languages', () => {
    expect(scanJavaScript(`const a = "${TAILWIND_HOST}";`, 'emitted.js').exempt).toEqual([]);
    expect(scanJavaScript(`const a = \`${TAILWIND_BANNER}\`;`, 'emitted.js').exempt).toEqual([]);
    expect(
      scanJavaScript(`const a = "${TAILWIND_BANNER}";`, 'emitted.js').violations.length,
    ).toBeGreaterThan(0);
    expect(
      scanHtml(`<a href="${TAILWIND_HOST}">x</a>`, 'index.html').violations.length,
    ).toBeGreaterThan(0);
  });

  it('excludes only the matched comment range, not the rest of the line', () => {
    const result = scanCss(`${TAILWIND_BANNER} .a { background: url("${FORBIDDEN}"); }`, 'a.css');

    expect(categories(result)).toEqual(['tailwind']);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});

describe('the React diagnostic-literal exemption', () => {
  const PREFIX = REACT_DIAGNOSTIC_PREFIX;

  it('exempts the value in each permitted whole-literal form', () => {
    const sources = [
      `const a = "${PREFIX}";`,
      `const a = '${PREFIX}';`,
      // The pinned formatter's actual bundled shape.
      `var t=\`${PREFIX}\`+e;`,
    ];

    for (const source of sources) {
      const result = scanJavaScript(source, 'emitted.js');

      clean(result);
      expect(categories(result)).toEqual(['react']);
    }
  });

  it('exempts an escaped spelling of the same complete value after one cooking pass', () => {
    const BS = '\\';
    const escaped = `https${BS}u003a${BS}u002f${BS}u002freact.dev${BS}u002ferrors${BS}u002f`;

    expect(escaped.includes('://')).toBe(false);

    const result = scanJavaScript(`const a = "${escaped}";`, 'emitted.js');

    clean(result);
    expect(categories(result)).toEqual(['react']);
  });

  it('rejects every near match and every non-literal form', () => {
    for (const source of [
      `const a = \`${PREFIX}${DOLLAR}{code}\`;`,
      `const a = \`${PREFIX}123\`;`,
      `const a = "${PREFIX}123";`,
      'const a = "https://react.dev";',
      'const a = "https://react.dev/other";',
      `const a = "see ${PREFIX} for details";`,
      'const a = "https://react.dev.example.test/errors/";',
      `const a = tag\`${PREFIX}\`;`,
    ]) {
      const result = scanJavaScript(source, 'emitted.js');

      expect(result.exempt).toEqual([]);
      expect(result.violations.length).toBeGreaterThan(0);
    }

    expect(scanHtml(`<a href="${PREFIX}">x</a>`, 'index.html').violations.length).toBeGreaterThan(
      0,
    );
    expect(
      scanCss(`.a { background: url("${PREFIX}"); }`, 'a.css').violations.length,
    ).toBeGreaterThan(0);
  });

  it('keeps scanning the asset around an exempt React value', () => {
    const result = scanJavaScript(
      [`var t=\`${PREFIX}\`+e;`, `const api = "${FORBIDDEN}";`, 'export { t, api };'].join('\n'),
      'emitted.js',
    );

    expect(categories(result)).toEqual(['react']);
    expect(result.violations.map((violation) => violation.value)).toEqual([FORBIDDEN]);
  });

  it('passes a clean multi-asset set and fails it once one origin is added', () => {
    const js = [
      `var t=\`${PREFIX}\`+e;`,
      'const ns = "http://www.w3.org/2000/svg";',
      'export { t, ns };',
    ].join('\n');

    clean(scanJavaScript(js, 'emitted.js'));
    clean(scanCss(`${TAILWIND_BANNER}\n.a { color: red; }`, 'emitted.css'));
    expect(
      scanJavaScript(`${js}\nconst extra = "${FORBIDDEN}";`, 'emitted.js').violations.length,
    ).toBeGreaterThan(0);
  });
});

describe('the Zod IPv6 URL-parsing-scaffold exemption', () => {
  const scaffold = (expression: string): string => `new URL(\`http://[${DOLLAR}{${expression}}]\`)`;
  const inTry = (body: string): string =>
    `function f(n,e){try{${body}}catch{return false}return true}`;

  it('exempts the observed ipv6 and cidrv6 shapes', () => {
    for (const body of [scaffold('n.value'), `if(!e)throw Error();${scaffold('e')}`]) {
      const result = scanJavaScript(inTry(body), 'emitted.js');

      clean(result);
      expect(categories(result)).toEqual(['zod']);
    }
  });

  it('survives minifier renaming of the interpolated identifier path', () => {
    for (const identifier of ['a', 'x9', '$t.value', 'q.r.s']) {
      const result = scanJavaScript(
        `function f(a,x9,$t,q){try{${scaffold(identifier)}}catch{return false}}`,
        'emitted.js',
      );

      clean(result);
      expect(categories(result)).toEqual(['zod']);
    }
  });

  it('rejects a changed static segment', () => {
    const changed = [
      `new URL(\`https://[${DOLLAR}{e}]\`)`,
      `new URL(\`http://x[${DOLLAR}{e}]\`)`,
      `new URL(\`http://[${DOLLAR}{e}]/p\`)`,
      `new URL(\`http://[${DOLLAR}{e}]?q\`)`,
      `new URL(\`http://[${DOLLAR}{e}]#f\`)`,
      `new URL(\`http://[${DOLLAR}{e}]:80\`)`,
    ];

    for (const body of changed) {
      const result = scanJavaScript(inTry(body), 'emitted.js');

      expect(result.exempt).toEqual([]);
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it('rejects zero, two, and partial substitutions', () => {
    for (const body of [
      'new URL(`http://[::1]`)',
      `new URL(\`http://[${DOLLAR}{a}${DOLLAR}{b}]\`)`,
      `new URL(\`http://[${DOLLAR}{a}::1]\`)`,
    ]) {
      const result = scanJavaScript(
        `function f(a,b){try{${body}}catch{return false}}`,
        'emitted.js',
      );

      expect(result.exempt).toEqual([]);
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it('rejects a non-identifier interpolation', () => {
    for (const expression of ['f()', 'a+b', 'a[0]', 'a?b:c', '`x`']) {
      const result = scanJavaScript(
        `function g(a,b,c,f){try{${scaffold(expression)}}catch{return false}}`,
        'emitted.js',
      );

      expect(result.exempt).toEqual([]);
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it('rejects the same template outside a try/catch window', () => {
    for (const source of [
      `function f(e){${scaffold('e')}}`,
      `function f(e){try{${scaffold('e')}}finally{g()}}`,
    ]) {
      const result = scanJavaScript(source, 'emitted.js');

      expect(result.exempt).toEqual([]);
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it('rejects a result that is used rather than discarded', () => {
    for (const body of [
      `const u = ${scaffold('e')};`,
      `return ${scaffold('e')};`,
      `await ${scaffold('e')};`,
      `${scaffold('e')}.href;`,
    ]) {
      const result = scanJavaScript(
        `async function f(e){try{${body}}catch{return false}}`,
        'emitted.js',
      );

      expect(result.exempt).toEqual([]);
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it('rejects the same template handed to a network operation', () => {
    const template = `\`http://[${DOLLAR}{e}]\``;

    for (const body of [
      `fetch(${template});`,
      `new Request(${template});`,
      `x.open("GET", ${template});`,
      `navigator.sendBeacon(${template});`,
      `importScripts(${template});`,
      `location = ${template};`,
      `img.src = ${template};`,
    ]) {
      const result = scanJavaScript(
        `function f(e,x,img,navigator){try{${body}}catch{return false}}`,
        'emitted.js',
      );

      expect(result.exempt).toEqual([]);
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it('rejects lookalike text in a legal comment or a string literal', () => {
    for (const source of [
      `/*! see http://[${DOLLAR}{e}] */\nconst a = 1;`,
      `const a = "http://[${DOLLAR}{e}]";`,
      `const a = 'try{new URL(\`http://[x]\`)}catch{}';`,
    ]) {
      const result = scanJavaScript(source, 'emitted.js');

      expect(result.exempt).toEqual([]);
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it('reports only the forbidden neighbour when one sits beside an exempt scaffold', () => {
    const result = scanJavaScript(
      `function f(e){try{${scaffold('e')};const api="${FORBIDDEN}";}catch{return false}}`,
      'emitted.js',
    );

    expect(categories(result)).toEqual(['zod']);
    expect(result.violations.map((violation) => violation.value)).toEqual([FORBIDDEN]);
  });

  it('reports an asset with syntactic diagnostics as unresolved rather than exempt', () => {
    const result = scanJavaScript(
      `function f(e){try{${scaffold('e')}}catch{return false}`,
      'emitted.js',
    );

    expect(result.exempt).toEqual([]);
    expect(result.unresolved.length).toBeGreaterThan(0);
  });

  it('passes valid division and regular-expression syntax beside a permitted scaffold', () => {
    const result = scanJavaScript(
      [
        `function f(e,a,b){try{${scaffold('e')}}catch{return false}`,
        'const ratio = a / b / 2;',
        'const re = /ab+c/g;',
        'return ratio + re.source.length}',
      ].join('\n'),
      'emitted.js',
    );

    clean(result);
    expect(categories(result)).toEqual(['zod']);
  });
});
