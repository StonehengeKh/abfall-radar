/**
 * Outer meta-verifier for `@abfall-radar/web#test:build-output`.
 *
 * The inner task inspects emitted artifacts; it cannot also prove Turbo ran it rather than replaying a
 * cached pass, because that would mean invoking Turbo from inside a Turbo task and observing itself.
 * This script sits outside the Turbo graph and proves that behaviour from structured Turbo output:
 *
 * 1. a dry run shows the inner task, its same-workspace build dependency, and `cache: false`;
 * 2. two real runs, as two child processes, each report `cache.status === "MISS"` and an `execution`
 *    block with `exitCode === 0` in their own run summary.
 *
 * Replayed stdout is never evidence: a cache hit reprints the original logs verbatim.
 *
 * Deliberately plain Node 24 ESM, so it runs with no build step. It is not typechecked — no workspace
 * `tsconfig` includes `scripts/` — so every parsed structure is validated at runtime before a field is
 * read, and anything missing or ambiguous fails closed. It must never be invoked from a Turbo task.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const INNER_TASK = '@abfall-radar/web#test:build-output';
const BUILD_TASK = '@abfall-radar/web#build';
const RUNS_DIRECTORY = join('.turbo', 'runs');
const TURBO_ARGUMENTS = ['exec', 'turbo', 'run', 'test:build-output', '--filter=@abfall-radar/web'];

class VerificationError extends Error {}

const fail = (message) => {
  throw new VerificationError(message);
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const runPnpm = (extraArguments, { capture }) => {
  const result = spawnSync('pnpm', [...TURBO_ARGUMENTS, ...extraArguments], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error !== undefined) {
    fail(`Could not start Turbo: ${result.error.message}`);
  }

  return result;
};

/** Returns the single inner-task entry from a parsed `tasks[]` array, failing on zero or several. */
const findInnerTask = (document, source) => {
  if (!isRecord(document) || !Array.isArray(document.tasks)) {
    fail(`${source} has no tasks array.`);
  }

  const matches = document.tasks.filter((task) => isRecord(task) && task.taskId === INNER_TASK);

  if (matches.length !== 1) {
    fail(`${source} must contain exactly one ${INNER_TASK} entry; found ${matches.length}.`);
  }

  return matches[0];
};

const verifyDryRun = () => {
  const result = runPnpm(['--dry-run=json'], { capture: true });

  if (result.status !== 0) {
    fail(`The dry run exited with ${result.status}.\n${result.stderr}`);
  }

  let document;

  try {
    document = JSON.parse(result.stdout);
  } catch {
    fail('The dry run did not print parsable JSON.');
  }

  const task = findInnerTask(document, 'The dry run');

  if (!Array.isArray(task.dependencies) || !task.dependencies.includes(BUILD_TASK)) {
    fail(`${INNER_TASK} does not depend on ${BUILD_TASK}.`);
  }

  if (!isRecord(task.resolvedTaskDefinition) || task.resolvedTaskDefinition.cache !== false) {
    fail(`${INNER_TASK} must resolve to cache: false.`);
  }
};

const summaryFiles = () => {
  try {
    return new Set(readdirSync(RUNS_DIRECTORY).map((name) => join(RUNS_DIRECTORY, name)));
  } catch {
    return new Set();
  }
};

/** One real run. Identifies its own summary by diffing `.turbo/runs` around the call. */
const verifyRealRun = (label) => {
  const before = summaryFiles();
  const result = runPnpm(['--summarize'], { capture: false });
  const produced = [...summaryFiles()].filter((file) => !before.has(file));

  try {
    if (result.status !== 0) {
      fail(`${label} exited with ${result.status}.`);
    }

    if (produced.length !== 1) {
      fail(`${label} must produce exactly one run summary; found ${produced.length}.`);
    }

    let document;

    try {
      document = JSON.parse(readFileSync(produced[0], 'utf8'));
    } catch {
      fail(`${label} wrote an unparsable summary.`);
    }

    const task = findInnerTask(document, `${label}'s summary`);

    if (!isRecord(task.cache) || task.cache.status !== 'MISS') {
      fail(`${label}: ${INNER_TASK} was not executed uncached (cache.status is not "MISS").`);
    }

    if (!isRecord(task.execution) || task.execution.exitCode !== 0) {
      fail(`${label}: ${INNER_TASK} has no successful execution block.`);
    }
  } finally {
    // Remove only the summaries this script produced.
    for (const file of produced) {
      rmSync(file, { force: true });
    }
  }
};

try {
  verifyDryRun();
  verifyRealRun('First run');
  verifyRealRun('Second run');
  process.stdout.write(
    `${INNER_TASK}: dependency, cache: false, and two uncached executions verified.\n`,
  );
} catch (error) {
  const message = error instanceof VerificationError ? error.message : String(error);
  process.stderr.write(`verify-web-build-output-task failed: ${message}\n`);
  process.exitCode = 1;
}
