/**
 * The emitted-artifact verifier — the only module that reads `apps/web/dist`.
 *
 * It must run through Turbo (`turbo run test:build-output --filter=@abfall-radar/web`), whose declared
 * dependency builds the web workspace first. It inspects artifacts and builds nothing, and it fails when
 * an expected artifact is absent or empty rather than passing over a missing or stale `dist`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import {
  decodeCssEscapes,
  type Occurrence,
  REQUIRED_VIEWPORT,
  readDocumentFoundation,
  type ScanResult,
  scanCss,
  scanHtml,
  scanJavaScript,
} from '@/src/test/build-output-scanner';

// `__dirname` rather than `import.meta.url`: under the jsdom environment the latter is not a `file:` URL.
const DIST = resolve(__dirname, '../../dist');

const listFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });

const readNonEmpty = (path: string): string => {
  expect(existsSync(path), `expected emitted file ${relative(DIST, path)}`).toBe(true);
  const text = readFileSync(path, 'utf8');
  expect(text.length, `emitted file ${relative(DIST, path)} is empty`).toBeGreaterThan(0);

  return text;
};

const describeOccurrence = (occurrence: Occurrence): string =>
  `${occurrence.file} ${occurrence.locator} (${occurrence.context}): ${occurrence.value}`;

/** Generated selectors, decoded, so an escaped arbitrary-value class compares as written in source. */
const generatedSelectors = (css: string): Set<string> => {
  const selectors = new Set<string>();

  postcss.parse(css).walkRules((rule) => {
    const decoded = decodeCssEscapes(rule.selector);

    if (decoded !== undefined) {
      selectors.add(decoded);
    }
  });

  return selectors;
};

const hasClass = (selectors: ReadonlySet<string>, className: string): boolean =>
  [...selectors].some((selector) =>
    selector.split(/[\s,>+~]+/).some((part) => part.startsWith(`.${className}`)),
  );

describe('emitted production artifacts', () => {
  expect(existsSync(DIST) && statSync(DIST).isDirectory(), 'apps/web/dist must exist').toBe(true);

  const files = listFiles(DIST);
  const html = files.filter((file) => extname(file) === '.html');
  const javascript = files.filter((file) => ['.js', '.mjs', '.cjs'].includes(extname(file)));
  const css = files.filter((file) => extname(file) === '.css');
  const svg = files.filter((file) => extname(file) === '.svg');

  it('emits the HTML entry, at least one script, and at least one stylesheet', () => {
    expect(html.map((file) => relative(DIST, file))).toContain('index.html');
    expect(javascript.length).toBeGreaterThan(0);
    expect(css.length).toBeGreaterThan(0);
  });

  /**
   * The favicon is a shipped output like any other: emitted from `src/` through the module graph,
   * hashed, referenced by the emitted HTML, and scanned by the same audit. A copy served verbatim from
   * a public directory would appear here unhashed and unreferenced, which is what these assertions
   * would report.
   */
  describe('the emitted favicon', () => {
    const iconHrefs = (): string[] =>
      [...readNonEmpty(join(DIST, 'index.html')).matchAll(/<link\b[^>]*>/g)]
        .map(([tag]) => tag)
        .filter((tag) => /rel="(?:[^"]*\s)?icon(?:\s[^"]*)?"/.test(tag))
        .map((tag) => /href="([^"]+)"/.exec(tag)?.[1] ?? '');

    it('is referenced exactly once by the emitted HTML, as a hashed asset', () => {
      const hrefs = iconHrefs();

      expect(hrefs).toHaveLength(1);
      // Vite rewrote the source path, so this is the emitted artifact rather than a copied file.
      expect(hrefs[0]).toMatch(/^\/assets\/favicon-[A-Za-z0-9_-]+\.svg$/);
      expect(hrefs[0]).not.toBe('/src/assets/favicon.svg');
    });

    it('resolves to an emitted file that exists and is not empty', () => {
      const [href = ''] = iconHrefs();
      const emitted = join(DIST, href.replace(/^\//, ''));

      expect(svg.map((file) => relative(DIST, file))).toContain(relative(DIST, emitted));
      expect(readNonEmpty(emitted).length).toBeGreaterThan(0);
    });

    /*
     * Audited here rather than through `scanHtml`: AR-005 defines the four-category scan over the
     * emitted HTML, JavaScript and CSS, and a standalone SVG has to declare its namespace to render at
     * all. So the asset is held to an exact allow-list instead — the namespace name and nothing else —
     * which is stricter than the general scan rather than an exemption from it.
     */
    it('ships the brand mark, with the namespace name as its only absolute URL', () => {
      const [href = ''] = iconHrefs();
      const emitted = readNonEmpty(join(DIST, href.replace(/^\//, '')));

      expect(emitted).toContain('#b7ef79');
      expect(emitted).toContain('#0c1110');
      expect(emitted).not.toMatch(/<script|<style|@import|<image\b|xlink:href|url\(/i);
      expect([...emitted.matchAll(/https?:\/\/[^"'\s>]+/g)].map(([url]) => url)).toEqual([
        'http://www.w3.org/2000/svg',
      ]);
    });

    it('emits no unreferenced or unhashed image beside it', () => {
      const [href = ''] = iconHrefs();

      // Exactly one SVG in the build, and it is the one the HTML names: nothing was copied verbatim.
      expect(svg.map((file) => `/${relative(DIST, file)}`)).toEqual([href]);
    });
  });

  it('contains no absolute HTTP(S) occurrence outside the four sanctioned categories', () => {
    const results: ScanResult[] = [
      ...html.map((file) => scanHtml(readNonEmpty(file), relative(DIST, file))),
      ...javascript.map((file) => scanJavaScript(readNonEmpty(file), relative(DIST, file))),
      ...css.map((file) => scanCss(readNonEmpty(file), relative(DIST, file))),
    ];

    expect(results.flatMap((result) => result.unresolved).map(describeOccurrence)).toEqual([]);
    expect(results.flatMap((result) => result.violations).map(describeOccurrence)).toEqual([]);
  });

  it('keeps the German document language and exactly one unrestricted mobile viewport', () => {
    const foundation = readDocumentFoundation(readNonEmpty(join(DIST, 'index.html')));

    expect(foundation.lang).toBe('de');
    expect(foundation.viewportContents).toEqual([REQUIRED_VIEWPORT]);
  });

  describe('Tailwind content discovery', () => {
    const selectors = (): Set<string> => {
      const all = new Set<string>();

      for (const file of css) {
        for (const selector of generatedSelectors(readNonEmpty(file))) {
          all.add(selector);
        }
      }

      return all;
    };

    it('generates no utility that exists only in protected test sources', () => {
      const generated = selectors();

      expect(hasClass(generated, 'tracking-[0.1337em]')).toBe(false);
      expect(hasClass(generated, 'tracking-[0.4242em]')).toBe(false);
    });

    it('still generates utilities from production web and shared-UI sources', () => {
      const generated = selectors();

      // `min-h-dvh` is used only by the web application shell; `shadow-ar-brand` only by
      // `packages/ui`'s `BrandMark`. `boundaries.test.ts` asserts both source locations.
      expect(hasClass(generated, 'min-h-dvh')).toBe(true);
      expect(hasClass(generated, 'shadow-ar-brand')).toBe(true);
    });
  });

  describe('keyboard focus and sticky layers', () => {
    it('reserves the pinned header and the confirmation bar when focus scrolls a control into view', () => {
      const text = css.map((file) => readNonEmpty(file)).join('\n');
      const root = postcss.parse(text);
      const declarations = new Map<string, string>();

      root.walkRules((rule) => {
        if (rule.selector.trim() === 'html') {
          rule.walkDecls((declaration) => {
            declarations.set(declaration.prop, declaration.value.replace(/\s+/g, ''));
          });
        }
      });

      // Measured in Chrome: without these, Tab and Shift+Tab scrolled whole district cards underneath
      // the sticky bar and header. Each layer publishes its height only while it covers the viewport.
      expect(declarations.get('scroll-padding-top')).toBe('var(--ar-sticky-header,0px)');
      expect(declarations.get('scroll-padding-bottom')).toBe('var(--ar-action-bar,0px)');
    });
  });

  describe('the emitted appearance palettes', () => {
    const stylesheet = (): string => css.map((file) => readNonEmpty(file)).join('\n');

    it('ships both dark paths and keeps the light palette unconditional', () => {
      const text = stylesheet();

      // Three declarations of the dark palette, as the stylesheet intends: the system path guarded so
      // an explicit light choice still wins, and the explicit dark choice. A build shipping only the
      // media query would leave the toggle inert in a light system.
      expect(text).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
      expect(text).toContain('data-theme=light');
      expect(text).toContain('data-theme=dark');

      // The light palette is defined outside every conditional, so it is always the complete fallback.
      const root = text.indexOf(':root');
      const firstConditional = text.indexOf('@media');

      expect(root).toBeGreaterThanOrEqual(0);
      expect(root).toBeLessThan(firstConditional);
      expect(text).toContain('--ar-color-canvas');
    });
  });
});
