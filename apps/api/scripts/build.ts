import { rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { build, type Metafile } from 'esbuild';

/**
 * Third-party runtime packages declared directly by `apps/api`. Only these may stay external:
 * pnpm guarantees they are resolvable from `apps/api/node_modules` at runtime. Everything else,
 * including `@abfall-radar/*` workspace packages and their implementation dependencies, is bundled
 * so the artifact never depends on a package this workspace does not declare.
 */
const EXTERNAL = [
  '@fastify/swagger',
  '@fastify/swagger-ui',
  '@fastify/type-provider-zod',
  'fastify',
  'zod',
];

const OUT_DIR = 'dist';
const OUT_FILE = `${OUT_DIR}/server.js`;

const nodeBuiltins = new Set(builtinModules);

const isNodeBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') || nodeBuiltins.has(specifier);

const isAllowedExternalPackage = (specifier: string): boolean =>
  EXTERNAL.some((name) => specifier === name || specifier.startsWith(`${name}/`));

interface BoundaryViolation {
  readonly importer: string;
  readonly specifier: string;
}

const findBoundaryViolations = (metafile: Metafile): BoundaryViolation[] => {
  const violations: BoundaryViolation[] = [];

  for (const [importer, input] of Object.entries(metafile.inputs)) {
    for (const imported of input.imports) {
      if (!imported.external) {
        continue;
      }

      if (isNodeBuiltin(imported.path) || isAllowedExternalPackage(imported.path)) {
        continue;
      }

      violations.push({ importer, specifier: imported.path });
    }
  }

  return violations;
};

const assertExternalBoundary = (metafile: Metafile): void => {
  const violations = findBoundaryViolations(metafile);

  if (violations.length === 0) {
    return;
  }

  const details = violations
    .map(({ importer, specifier }) => `  - ${specifier} (imported by ${importer})`)
    .join('\n');

  throw new Error(
    `The production bundle left undeclared packages external:\n${details}\n` +
      `Only Node built-ins and these declared packages may be external: ${EXTERNAL.join(', ')}.`,
  );
};

await rm(OUT_DIR, { force: true, recursive: true });

const result = await build({
  bundle: true,
  entryPoints: ['src/server.ts'],
  external: EXTERNAL,
  format: 'esm',
  logLevel: 'info',
  metafile: true,
  minify: false,
  outfile: OUT_FILE,
  platform: 'node',
  sourcemap: true,
  target: 'node24',
});

assertExternalBoundary(result.metafile);

console.log(`Verified external boundary for ${OUT_FILE}.`);
