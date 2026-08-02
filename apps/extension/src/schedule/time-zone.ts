import { z } from 'zod';

/**
 * An IANA time-zone identifier this runtime can actually resolve.
 *
 * Declared here rather than imported from `@abfall-radar/api-client` for the same reason the capability
 * shapes are: this validator is used by the worker message contract and the schedule cache, both reachable
 * from the popup, and the popup must never reach the transport client. The transport package validates the
 * zones arriving over HTTP; this validates the zones crossing the extension's own boundaries, including
 * values persisted by an **older build** that had no such check.
 *
 * A nonempty string is not enough. Every date the extension derives — the requested range, the reminder day,
 * the "Heute"/"Morgen" label — is computed in the source's zone, so an unusable identifier does not degrade
 * gracefully: `Intl.DateTimeFormat` throws a `RangeError` deep inside date derivation rather than at the
 * boundary that accepted the value.
 *
 * `Intl.supportedValuesOf('timeZone')` is deliberately not the check: it omits legitimate aliases such as
 * `UTC`, which both the API and the ICS sources use, so a list membership test would reject a value every
 * layer below handles correctly.
 */

/**
 * Whether `timeZone` can be used to format a date on this runtime.
 *
 * Only a failure to construct is treated as an answer about the zone; `RangeError` is the documented failure
 * for an unknown identifier.
 */
export const isUsableTimeZone = (timeZone: string): boolean => {
  // Rejected before `Intl` sees it: some runtimes accept an empty or whitespace-only value by falling back to
  // the ambient zone, which is the silent substitution this exists to prevent — a schedule would then be
  // derived in the reader's own zone while claiming the source's.
  if (timeZone.trim() !== timeZone || timeZone.length === 0) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone });

    return true;
  } catch {
    return false;
  }
};

/**
 * The validator every time-zone value crossing an internal boundary goes through.
 *
 * Its output is still `string`, so no consumer changes shape: what changes is that an unusable value is now
 * refused where it arrives instead of throwing where it is used.
 */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .refine(isUsableTimeZone, { message: 'The time zone is not a usable IANA identifier.' });
