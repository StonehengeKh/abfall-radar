import type { CollectionEvent } from '@abfall-radar/domain';
import { type IsoDate, startOfSourceDay } from './source-day';

/**
 * What the source's own calendar day means for a collection: whether it is under way, and what the
 * countdown may still count.
 *
 * Two questions that used to be one. The featured card and the countdown both asked for "the next
 * collection", so on a collection day the countdown had nothing left to count and said "today" beside a
 * card that already said it. They are separated here: the card keeps today's collection, and the
 * countdown moves on to the next one.
 *
 * Nothing here reads a clock of its own. Both answers are derived from the source-local date the rest of
 * the schedule uses and, for a published window, from the instant that window names.
 */

/**
 * Whether an all-day collection's day is the source's today.
 *
 * An all-day collection publishes a **date and no time**, so the whole statement the source makes is
 * "this is the day". Once that day has arrived, a day count is zero and any hour would be invented, so
 * the honest reading is that the collection day is under way — a calendar status, not vehicle tracking.
 *
 * A published window is a different statement: a drop-off names its own start and end, and stays a timed
 * appointment for the whole of its day rather than becoming "in progress" because the date matches.
 */
export const isCollectionInProgress = (event: CollectionEvent, sourceToday: IsoDate): boolean =>
  event.timing.kind === 'all_day' && event.date === sourceToday;

export interface CountdownTarget {
  /**
   * Every event this single countdown speaks for, in schedule order: the waste types sharing one
   * all-day collection date, or the types of one published window — a single upstream appointment
   * normalizes into one event per waste type, and they are the same appointment.
   */
  readonly events: readonly [CollectionEvent, ...CollectionEvent[]];
  readonly at: Date;
  /** The source published a date and no time, so the target is the start of that day. */
  readonly dateOnly: boolean;
}

/**
 * `undeterminable` is not `no_future_collection`: a future collection exists, but its instant could not
 * be derived — a zone `Intl` refuses. Telling somebody that nothing further is published would be a
 * statement about the schedule, and the schedule does not say that.
 */
export type CountdownOutcome =
  | { readonly kind: 'counting'; readonly target: CountdownTarget }
  | { readonly kind: 'no_future_collection' }
  | { readonly kind: 'undeterminable' };

/**
 * Whether an event is still ahead, by the rule that fits how it was published.
 *
 * An all-day collection is ahead only on a **later source-local date**: today's is under way, and
 * counting to the start of a day that has already begun would be a negative or a zero dressed as a wait.
 * A timed collection is ahead while its published start is still in the future — the existing reading of
 * an explicit time, unchanged, and the reason a drop-off later today is still counted.
 */
const isAhead = (event: CollectionEvent, sourceToday: IsoDate, now: Date): boolean =>
  event.timing.kind === 'all_day'
    ? event.date > sourceToday
    : Date.parse(event.timing.startsAt) > now.getTime();

/**
 * The next collection the countdown can honestly count, and everything collected with it.
 *
 * `events` is already in the total event order — date ascending, all-day before timed within a date, and
 * timed by published start — so the first event that is still ahead is also the earliest one; no second
 * ordering is imposed here.
 */
export const nextCountdownTarget = (
  events: readonly CollectionEvent[],
  sourceToday: IsoDate,
  timeZone: string,
  now: Date,
): CountdownOutcome => {
  const next = events.find((event) => isAhead(event, sourceToday, now));

  if (next === undefined) {
    return { kind: 'no_future_collection' };
  }

  if (next.timing.kind === 'all_day') {
    const at = startOfSourceDay(next.date, timeZone);

    if (at === null) {
      return { kind: 'undeterminable' };
    }

    // Every all-day collection on that date: one date, one wait, however many bins go out on it.
    const alongside = events.filter(
      (event) =>
        event.timing.kind === 'all_day' && event.date === next.date && event.id !== next.id,
    );

    return { kind: 'counting', target: { events: [next, ...alongside], at, dateOnly: true } };
  }

  const at = new Date(next.timing.startsAt);

  if (Number.isNaN(at.getTime())) {
    return { kind: 'undeterminable' };
  }

  const { startsAt } = next.timing;
  const alongside = events.filter(
    (event) =>
      event.timing.kind === 'time_window' &&
      event.timing.startsAt === startsAt &&
      event.id !== next.id,
  );

  return { kind: 'counting', target: { events: [next, ...alongside], at, dateOnly: false } };
};
