import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Every shared token scale reaches Tailwind's theme, so a utility written on a shared component
 * actually emits a rule.
 *
 * Tailwind emits a utility only for a namespace it knows. `packages/ui` defined `--ar-radius-*` and used
 * `rounded-ar-md` throughout its components, but registered only colours and shadows under
 * `@theme inline` — so the radius namespace had to be declared by each application. The website declared
 * it; the extension never did. Its built stylesheet contained **no** `rounded-ar-*` rule at all, and
 * every shared card, button, field, menu and badge rendered with square corners while the identical
 * component was rounded on the website. Nothing failed: the class was simply dropped.
 *
 * This asserts the mapping lives with the values, in the shared stylesheet, rather than in any
 * application — which is what stops the two surfaces diverging again, and what makes a newly added
 * scale a test failure instead of a silently missing corner.
 *
 * The stylesheet is resolved through the package's public export, not a relative path across the
 * workspace boundary.
 */

const sharedStylesheet = readFileSync(
  createRequire(import.meta.url).resolve('@abfall-radar/ui/styles.css'),
  'utf8',
);

/** The `@theme inline { … }` block, which is what registers a namespace with Tailwind. */
const themeBlock = (): string => {
  const start = sharedStylesheet.indexOf('@theme inline');

  expect(start, 'the shared stylesheet registers a Tailwind theme').toBeGreaterThan(-1);

  return sharedStylesheet.slice(start, sharedStylesheet.indexOf('\n}', start));
};

describe('the shared stylesheet', () => {
  it.each(['sm', 'md', 'lg', 'xl'])(
    'maps the %s radius into Tailwind’s radius namespace',
    (step) => {
      expect(themeBlock()).toContain(`--radius-ar-${step}: var(--ar-radius-${step})`);
    },
  );

  it('registers every radius token it defines, so none can be added without a utility', () => {
    const defined = new Set(
      [...sharedStylesheet.matchAll(/--ar-radius-([a-z]+):/g)].map(([, step]) => step),
    );
    const registered = themeBlock();

    expect(defined.size).toBeGreaterThan(0);

    for (const step of defined) {
      expect(registered, `--ar-radius-${step} is defined but never mapped`).toContain(
        `--radius-ar-${step}:`,
      );
    }
  });

  it('keeps the colour and shadow namespaces it already published', () => {
    const registered = themeBlock();

    expect(registered).toContain('--color-ar-surface: var(--ar-color-surface)');
    expect(registered).toContain('--shadow-ar-sm: var(--ar-shadow-sm)');
  });
});
