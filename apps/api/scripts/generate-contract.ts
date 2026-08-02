import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import {
  buildContractArtifacts,
  GENERATED_CLIENT_MODULE_PATH,
  OPENAPI_DOCUMENT_PATH,
} from '../src/contract/generate-contract';

/**
 * Writes the two committed contract artifacts.
 *
 * `apps/api` owns this because it owns the contract: one command builds the application, writes the
 * OpenAPI document, and re-emits the generated module inside `packages/api-client`. The dev-time
 * coupling therefore points from an application to a package, which the architecture allows. A script
 * inside the package reaching into `apps/api` would point the other way.
 */

const artifacts = await buildContractArtifacts();

for (const [path, contents] of [
  [OPENAPI_DOCUMENT_PATH, artifacts.openApiDocument],
  [GENERATED_CLIENT_MODULE_PATH, artifacts.generatedClientModule],
] as const) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');

  console.log(`Wrote ${relative(process.cwd(), path)}.`);
}
