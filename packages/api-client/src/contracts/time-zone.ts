import { z } from 'zod';

/**
 * An IANA time-zone identifier this runtime can actually resolve.
 *
 * A nonempty string is not enough. Every date this project derives — the requested range, the reminder day,
 * the "Heute"/"Morgen" label — is computed *in the source's zone*, so an unusable identifier does not
 * degrade gracefully: `Intl.DateTimeFormat` throws a `RangeError`, and that throw happens deep inside date
 * derivation rather than at the boundary where the value arrived. A response carrying `Not/AZone` would be
 * accepted as valid, cached, and then crash whichever surface first tried to work out what day it was.
 *
 * Usability is therefore tested by construction — the same call the derivation itself will make — rather
 * than by a pattern. A regular expression can describe the shape of an identifier but cannot know which
 * zones this runtime's ICU data holds, and the shape is not the property that matters here.
 *
 * `Intl.supportedValuesOf('timeZone')` is deliberately **not** the check. It enumerates canonical zone names
 * and omits legitimate aliases: `UTC` — which the API and the ICS sources both use — is absent from it on
 * common runtimes, so a list membership test would reject a value every layer below handles perfectly.
 */

/**
 * Whether `timeZone` can be used to format a date on this runtime.
 *
 * `RangeError` is the documented failure for an unknown identifier. Any other throw would mean something
 * unrelated is wrong with `Intl` itself, and swallowing that as "invalid zone" would hide it, so only a
 * failure to construct is treated as an answer about the zone.
 */
export const isUsableTimeZone = (timeZone: string): boolean => {
  // Rejected before `Intl` sees it: some runtimes accept an empty or whitespace-only value by falling back
  // to the ambient zone, which is precisely the silent substitution this exists to prevent — a schedule
  // would then be derived in the reader's own zone while claiming the source's.
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
 * The validator every external time-zone value goes through.
 *
 * Shared rather than duplicated per contract, so a new response carrying a zone cannot pick up a weaker
 * check by accident. Its output type is still `string`, so nothing downstream changes shape and the
 * generated-contract pinning in `compatibility.ts` keeps holding.
 */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .refine(isUsableTimeZone, { message: 'The time zone is not a usable IANA identifier.' });
