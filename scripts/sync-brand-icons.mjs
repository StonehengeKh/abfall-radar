#!/usr/bin/env node
/**
 * Copies the canonical app mark to every consumer that needs its own file, and verifies it stayed there.
 *
 * The website and the extension shipped two unrelated drawings: a light-green square with three bold
 * arrows in the browser tab, and a teal gradient square with thin white arrows on the toolbar. One
 * product, two marks. The drawing now lives once, in `packages/ui/src/brand/favicon.svg`.
 *
 * It is **copied** rather than imported because each consumer's location is load-bearing and audited:
 * the website's shell references `/src/assets/favicon.svg` by that exact specifier, asserted by its
 * boundary and build-output tests, and `@wxt-dev/auto-icons` rasterises the extension's PNG sizes from a
 * path inside the extension. Moving either file to satisfy a build tool would break an audited boundary,
 * so the copies stay where they are and this keeps them honest.
 *
 *   node scripts/sync-brand-icons.mjs           # write every copy from the canonical drawing
 *   node scripts/sync-brand-icons.mjs --check    # fail if any copy has drifted (runs in `pnpm check`)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE = 'packages/ui/src/brand/favicon.svg';

/**
 * Every place the mark has to exist as a file of its own.
 *
 * Each entry records *why* it cannot simply import the source, so a future reader does not "tidy up" a
 * copy that an audited test or a build tool depends on.
 */
const COPIES = [
  {
    path: 'apps/web/src/assets/favicon.svg',
    reason: 'the website shell references this exact specifier; its boundary tests assert it',
  },
  {
    path: 'apps/extension/assets/icon.svg',
    reason: '@wxt-dev/auto-icons rasterises the PNG sizes from a path inside the extension',
  },
];

const read = (path) => readFileSync(join(repositoryRoot, path), 'utf8');

const checking = process.argv.includes('--check');
const source = read(SOURCE);
const drifted = [];

for (const copy of COPIES) {
  let current;

  try {
    current = read(copy.path);
  } catch {
    current = null;
  }

  if (current === source) {
    continue;
  }

  if (checking) {
    drifted.push(copy);

    continue;
  }

  writeFileSync(join(repositoryRoot, copy.path), source);
  console.log(`updated ${copy.path}`);
}

if (drifted.length > 0) {
  console.error(
    [
      `The app mark has drifted from ${SOURCE}:`,
      ...drifted.map((copy) => `  ${copy.path} — ${copy.reason}`),
      '',
      'Edit the canonical drawing, then run: pnpm sync:brand-icons',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  checking
    ? `app mark in sync across ${COPIES.length} consumers`
    : `app mark written to ${COPIES.length} consumers from ${relative('.', SOURCE)}`,
);
