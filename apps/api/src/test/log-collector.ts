import { Writable } from 'node:stream';

export interface LogCollector {
  readonly stream: Writable;
  readonly lines: () => Record<string, unknown>[];
  readonly find: (
    predicate: (line: Record<string, unknown>) => boolean,
  ) => Record<string, unknown> | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Collects the API's structured log output in memory so tests can assert what was logged instead of
 * only what was returned.
 */
export const createLogCollector = (): LogCollector => {
  const lines: Record<string, unknown>[] = [];

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const raw of String(chunk).split('\n')) {
        if (raw.trim() === '') {
          continue;
        }

        const parsed: unknown = JSON.parse(raw);

        if (isRecord(parsed)) {
          lines.push(parsed);
        }
      }

      callback();
    },
  });

  return {
    stream,
    lines: () => [...lines],
    find: (predicate) => lines.find((line) => predicate(line)),
  };
};
