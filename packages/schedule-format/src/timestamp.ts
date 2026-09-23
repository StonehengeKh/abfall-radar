/**
 * The application's single timestamp comparator.
 *
 * Both event ordering and the drop-off window-order invariant call it; there is no second algorithm.
 *
 * The accepted grammar comes from `z.iso.datetime()`: seconds are optional and fractional precision is
 * unbounded. Two tempting strategies are wrong on different inputs — lexical comparison sorts
 * `…:00.500Z` before `…:00Z`, and `Date.parse` truncates below a millisecond, so `.0001Z` and `.0002Z`
 * compare equal. This compares the whole-second instant numerically and the fractional digits as
 * equal-width strings, so nothing is truncated, rounded, or coerced to milliseconds.
 */

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

interface ParsedTimestamp {
  /** The whole-second instant in epoch seconds, with any offset already applied. */
  readonly seconds: number;
  readonly fraction: string;
}

export type TimestampComparison =
  | { readonly ok: true; readonly order: -1 | 0 | 1 }
  | { readonly ok: false };

const parse = (value: string): ParsedTimestamp | undefined => {
  const match = TIMESTAMP.exec(value);

  if (match === null) {
    return undefined;
  }

  const [, minutes, seconds = '00', fraction = '', zone] = match;
  const milliseconds = Date.parse(`${minutes}:${seconds}${zone}`);

  // The whole-second part carries no sub-second digits, so `Date.parse` loses nothing here.
  return Number.isNaN(milliseconds) ? undefined : { seconds: milliseconds / 1000, fraction };
};

const sign = (value: number): -1 | 0 | 1 => (value < 0 ? -1 : value > 0 ? 1 : 0);

/**
 * Compares two validated timestamps as complete instants.
 *
 * An unparsable input is a failure result, never a sort position: it has no `NaN` fallback and is not
 * treated as zero.
 */
export const compareTimestamps = (left: string, right: string): TimestampComparison => {
  const a = parse(left);
  const b = parse(right);

  if (a === undefined || b === undefined) {
    return { ok: false };
  }

  if (a.seconds !== b.seconds) {
    return { ok: true, order: sign(a.seconds - b.seconds) };
  }

  const width = Math.max(a.fraction.length, b.fraction.length);
  const fractionA = a.fraction.padEnd(width, '0');
  const fractionB = b.fraction.padEnd(width, '0');

  return { ok: true, order: fractionA < fractionB ? -1 : fractionA > fractionB ? 1 : 0 };
};
