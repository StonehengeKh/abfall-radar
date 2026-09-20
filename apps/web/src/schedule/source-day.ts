/**
 * Calendar days in the zone a municipal source publishes in.
 *
 * "Today" for a collection schedule is today at the municipality, not on the device. Every helper here
 * takes its instant or its source date explicitly: none reads the clock, none defaults a parameter to
 * `new Date()`, and none builds a local-midnight `Date` from a `YYYY-MM-DD` string — the two ways a
 * calendar day silently becomes a device day.
 */

/** A source-local calendar date, `YYYY-MM-DD`. Lexicographic order is calendar order. */
export type IsoDate = string;

export type SourceTodayResult =
  | { readonly ok: true; readonly date: IsoDate }
  | { readonly ok: false; readonly timeZone: string };

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Derives today's date in `timeZone` from `now`.
 *
 * Reads `year`, `month`, and `day` from `formatToParts` — a formatted string is never parsed — with the
 * calendar pinned to `gregory` and digits to `latn`, so a runtime whose locale defaults differ cannot
 * yield Buddhist years or non-ASCII digits. A zone `Intl` refuses is a typed failure: this never falls
 * back to the device zone, never substitutes UTC, and never throws into rendering.
 */
export const deriveSourceToday = (timeZone: string, now: Date): SourceTodayResult => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);

    const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((part) => part.type === type)?.value;

    const year = read('year');
    const month = read('month');
    const day = read('day');

    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      Number.isNaN(now.getTime())
    ) {
      return { ok: false, timeZone };
    }

    return { ok: true, date: `${year.padStart(4, '0')}-${month}-${day}` };
  } catch {
    return { ok: false, timeZone };
  }
};

/**
 * The offset `timeZone` is at `instant`, in milliseconds east of UTC.
 *
 * Read by formatting the instant in the zone and comparing that wall-clock reading against the same
 * fields read as UTC. Derived per instant rather than per zone, because an offset is a property of a
 * moment: `Europe/Berlin` is +01:00 in January and +02:00 in July, and a fixed offset would move a
 * collection by an hour across every daylight-saving boundary.
 */
const zoneOffsetMs = (instant: Date, timeZone: string): number | null => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number | undefined => {
    const value = parts.find((part) => part.type === type)?.value;

    return value === undefined ? undefined : Number(value);
  };

  const fields = [
    read('year'),
    read('month'),
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  ];

  if (fields.some((field) => field === undefined || Number.isNaN(field))) {
    return null;
  }

  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = fields as number[];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  return asUtc - instant.getTime() + (instant.getTime() % 1000);
};

/**
 * The instant a source-local calendar day begins.
 *
 * A date-only collection has no published time, so "when does it start" can only mean the beginning of
 * that day **at the municipality**. Building a `Date` from the `YYYY-MM-DD` string would answer in the
 * device's zone instead, which is wrong by hours and by a whole day either side of midnight.
 *
 * Solved by iteration rather than by assuming an offset: a first guess is corrected with the offset in
 * force **at that guess**, which is what makes a day starting on either side of a daylight-saving change
 * land correctly. The result is verified by formatting it back; a day whose midnight does not exist —
 * a zone that springs forward at 00:00 — yields the first instant that does.
 */
export const startOfSourceDay = (date: IsoDate, timeZone: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);

  if (match === null) {
    return null;
  }

  const [, year = '', month = '', day = ''] = match;
  const wallClock = Date.UTC(Number(year), Number(month) - 1, Number(day));

  try {
    let instant = new Date(wallClock);

    for (let pass = 0; pass < 2; pass += 1) {
      const offset = zoneOffsetMs(instant, timeZone);

      if (offset === null) {
        return null;
      }

      instant = new Date(wallClock - offset);
    }

    const landed = deriveSourceToday(timeZone, instant);

    if (!landed.ok) {
      return null;
    }

    /*
     * A skipped midnight lands on the previous day; stepping forward to the first minute that exists
     * is the honest answer, and never later than the hour a transition can remove.
     */
    if (landed.date !== date) {
      for (let minutes = 1; minutes <= 180; minutes += 1) {
        const stepped = new Date(instant.getTime() + minutes * 60 * 1000);
        const check = deriveSourceToday(timeZone, stepped);

        if (check.ok && check.date === date) {
          return stepped;
        }
      }

      return null;
    }

    return instant;
  } catch {
    return null;
  }
};

/** Both dates read as UTC midnight, so no ambient zone can shift the difference by a day. */
export const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MILLISECONDS_PER_DAY,
  );

export const addCalendarDays = (date: IsoDate, days: number): IsoDate =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * MILLISECONDS_PER_DAY)
    .toISOString()
    .slice(0, 10);

/** Calendar comparison of two ISO dates as strings: no instant and no zone is involved. */
export const isUpcoming = (eventDate: IsoDate, sourceToday: IsoDate): boolean =>
  eventDate >= sourceToday;

/** The absolute fallback is formatted in UTC, because the ISO date is already the source-local day. */
const absoluteDateFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** Days within which a relative label is used; from here on the absolute date is clearer. */
export const RELATIVE_LABEL_WINDOW_DAYS = 7;

/** `Heute`, `Morgen`, `In N Tagen`, or the absolute German date — from two ISO dates alone. */
export const relativeDayLabel = (eventDate: IsoDate, sourceToday: IsoDate): string => {
  const difference = daysBetween(sourceToday, eventDate);

  if (difference === 0) {
    return 'Heute';
  }

  if (difference === 1) {
    return 'Morgen';
  }

  if (difference > 1 && difference < RELATIVE_LABEL_WINDOW_DAYS) {
    return `In ${difference} Tagen`;
  }

  return absoluteDateFormatter.format(new Date(`${eventDate}T00:00:00Z`));
};
