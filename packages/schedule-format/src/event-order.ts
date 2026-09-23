import type { CollectionEvent } from '@abfall-radar/domain';
import { compareTimestamps } from './timestamp';

/**
 * The total event order, applied before the next collection is chosen.
 *
 * 1. local event date, ascending — ISO dates compare lexically as calendar order;
 * 2. on one date, all-day curbside before timed mobile drop-off;
 * 3. timed events on one date by `startsAt` as a full-precision instant;
 * 4. event `id`, only when every earlier key is equal, by UTF-16 code unit.
 *
 * Rule 4 is a total tie-breaker only because response-wide id uniqueness is checked first. It never
 * consults a locale: `localeCompare` can call `"é"` and `"é"` equal, and a tie-break that
 * equates two distinct ids is no tie-break.
 */

const modeRank = (event: CollectionEvent): number => (event.collectionMode === 'curbside' ? 0 : 1);

/** Ascending by UTF-16 code unit on the original strings: exactly `<` and `>`. */
export const compareIds = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareEvents = (left: CollectionEvent, right: CollectionEvent): number => {
  if (left.date !== right.date) {
    return left.date < right.date ? -1 : 1;
  }

  if (modeRank(left) !== modeRank(right)) {
    return modeRank(left) - modeRank(right);
  }

  if (left.collectionMode === 'mobile_drop_off' && right.collectionMode === 'mobile_drop_off') {
    const instant = compareTimestamps(left.timing.startsAt, right.timing.startsAt);

    // Inputs are validated; an unparsable value would already have failed the response.
    if (instant.ok && instant.order !== 0) {
      return instant.order;
    }
  }

  return compareIds(left.id, right.id);
};

export const orderEvents = (events: readonly CollectionEvent[]): CollectionEvent[] =>
  [...events].sort(compareEvents);
