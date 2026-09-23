import type { CollectionEvent } from '@abfall-radar/domain';
import { type IsoDate, isUpcoming } from './source-day';

/**
 * Which collection a schedule surface features, and which ones its list still shows.
 *
 * One rule for every surface, so the website and the extension can never disagree about what is next or
 * show it twice. Both read the same ordered array and neither reorders it.
 */

/**
 * The next collection: the first event on or after the source's today.
 *
 * Derived from the same source-local date every row uses, so the highlight can never disagree with the
 * list under it. `null` when nothing is upcoming, which is what keeps a surface from inventing a count.
 */
export const featuredCollection = (
  events: readonly CollectionEvent[],
  sourceToday: IsoDate,
): CollectionEvent | null => events.find((event) => isUpcoming(event.date, sourceToday)) ?? null;

/**
 * Everything the featured card is not showing.
 *
 * Filtered by the featured event's own identifier, so another collection on the same day or of the same
 * type keeps its row, and the order of what remains is the order the schedule already had. The schedule
 * itself is untouched — this is a second reading of the same array, which is what keeps the countdown,
 * the counts and the source metadata working from the original.
 */
export const listedCollections = (
  events: readonly CollectionEvent[],
  featured: CollectionEvent | null,
): readonly CollectionEvent[] =>
  featured === null ? events : events.filter((event) => event.id !== featured.id);
