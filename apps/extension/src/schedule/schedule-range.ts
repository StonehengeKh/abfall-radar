import type { SourceCalendar, SourceWindow } from './capability';

/**
 * Derives the date range to request, in the zone the source publishes in.
 *
 * "Today" for a collection schedule is today in the municipality's zone, not on the device. Deriving it
 * from the browser zone would shift the whole window for anyone whose device is set elsewhere — a
 * traveller would be shown the wrong day's collection — which is the same class of error the server
 * already guards against when it decides a timed event's local date.
 *
 * Everything here is pure: the clock is a parameter, so a test pins it rather than waiting.
 */

/** A product choice, not a contract constraint. */
export const TARGET_WINDOW_DAYS = 90;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Reads the calendar date in a named zone from `formatToParts`, never by parsing a formatted string.
 *
 * The calendar is pinned to `gregory` and the numbering system to `latn`, so a runtime whose locale
 * defaults differ cannot return Buddhist years or non-ASCII digits and silently produce a date the API
 * would reject.
 */
export const deriveLocalDate = (timeZone: string, now: Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type);

    if (part === undefined) {
      throw new Error(`The formatted date is missing its ${type} part for zone ${timeZone}.`);
    }

    return part.value;
  };

  return `${read('year').padStart(4, '0')}-${read('month')}-${read('day')}`;
};

/**
 * Calendar arithmetic on a derived date.
 *
 * Both ends are read as UTC midnight, so no ambient zone can shift the span by a day. The result is a
 * calendar date rather than an instant, which is what the API's range parameters are.
 */
export const addCalendarDays = (date: string, days: number): string => {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * MILLISECONDS_PER_DAY);

  return shifted.toISOString().slice(0, 10);
};

export const daysBetween = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MILLISECONDS_PER_DAY;

export type TargetRange =
  | { readonly kind: 'covered'; readonly range: SourceWindow; readonly today: string }
  /**
   * The source publishes no calendar for the current period. Not an error and not an empty schedule:
   * guessing a narrower range, or retrying until something answers, is exactly the inference this
   * project keeps out of scheduling data.
   */
  | { readonly kind: 'outside_validity'; readonly today: string }
  /**
   * The zone could not be resolved, so no date could be derived and no range exists.
   *
   * Every boundary that accepts a zone now validates that this runtime can resolve it, so reaching this is
   * a defect rather than an expected input — but it is *stated* rather than thrown, because a throw from
   * here escapes into whichever effect called it. In the popup that meant an unhandled rejection and a
   * refresh that never settled: the phase stayed pending and the spinner never stopped. A named outcome
   * cannot be forgotten, and no schedule request is issued for it.
   *
   * Deliberately carries no `today`: there is none. Inventing one from the device zone is exactly the
   * silent substitution that would put another zone's calendar date on an official schedule.
   */
  | { readonly kind: 'unusable_zone' };

/**
 * The 90-day window forward from the source-local today, clamped into the declared validity window.
 *
 * `from` is the later of today and `validity.from`; `to` is the earlier of today plus 90 days and
 * `validity.to`. When the derived today is past the window's end, or the clamp inverts, there is no
 * range to request. ISO dates sort lexicographically, so the comparisons need no parsing.
 */
export const deriveTargetRange = (calendar: SourceCalendar, now: Date): TargetRange => {
  let today: string;

  try {
    today = deriveLocalDate(calendar.timeZone, now);
  } catch {
    // `Intl` refused the zone, or the formatted date was missing a part. Either way no date exists, so this
    // reports that rather than letting the throw escape into the caller's effect.
    return { kind: 'unusable_zone' };
  }

  const from = today > calendar.validity.from ? today : calendar.validity.from;
  const desiredTo = addCalendarDays(today, TARGET_WINDOW_DAYS);
  const to = desiredTo < calendar.validity.to ? desiredTo : calendar.validity.to;

  if (today > calendar.validity.to || from > to) {
    return { kind: 'outside_validity', today };
  }

  return { kind: 'covered', range: { from, to }, today };
};

export type RangeCoverage = 'full' | 'partial';

export interface RangeIntersection {
  readonly coverage: RangeCoverage;
  /**
   * The intersection, never the requested range. Every event shown and every statement about what is
   * absent is bounded by this.
   */
  readonly displayRange: SourceWindow;
}

/**
 * Intersects the range an entry was served for with the range now being requested.
 *
 * This is the load-bearing rule for a restored cache. The requested window moves forward every day, so a
 * cache served for yesterday's window does not answer today's question. Without the intersection, a
 * cache served through the end of one 90-day window and restored against a window extending one day
 * further would render the uncovered tail as "no collection scheduled" — a confident statement about a
 * period the extension holds no data for.
 *
 * `undefined` means the ranges do not overlap, so no cached event may be shown at all.
 */
export const intersectRanges = (
  served: SourceWindow,
  requested: SourceWindow,
): RangeIntersection | undefined => {
  const from = served.from > requested.from ? served.from : requested.from;
  const to = served.to < requested.to ? served.to : requested.to;

  if (from > to) {
    return undefined;
  }

  const isFull = served.from <= requested.from && served.to >= requested.to;

  return { coverage: isFull ? 'full' : 'partial', displayRange: { from, to } };
};

/** Whether a calendar date falls inside a range, inclusive at both ends. */
export const isWithinRange = (date: string, range: SourceWindow): boolean =>
  date >= range.from && date <= range.to;
