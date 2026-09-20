import type { MobileDropOffCollectionEvent } from '@abfall-radar/domain';

/**
 * How a mobile drop-off window is written: one formatter for every surface that shows one.
 *
 * Each endpoint is formatted **independently in the source zone**, with its own UTC offset. A clock time
 * plus a zone name is ambiguous during a daylight-saving overlap — in Berlin, `00:30Z` and `01:30Z` both
 * read `02:30` on 2026-10-25 — so the offset is part of each end. When the two ends fall on different
 * source-local dates, both dates are shown; `23:30–01:00` would otherwise read as inverted.
 */

export type CollectionWindow = MobileDropOffCollectionEvent['timing'];

export interface FormattedWindow {
  /** The visible window, including both offsets and the IANA zone. */
  readonly text: string;
  /** An unambiguous spoken form stating both offsets, and both dates when they differ. */
  readonly accessibleLabel: string;
}

interface Endpoint {
  readonly date: string;
  readonly time: string;
  readonly offset: string;
}

const readEndpoint = (instant: Date, timeZone: string): Endpoint | null => {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;

  const [day, month, year, hour, minute, zoneName] = [
    read('day'),
    read('month'),
    read('year'),
    read('hour'),
    read('minute'),
    read('timeZoneName'),
  ];

  if ([day, month, year, hour, minute, zoneName].some((value) => value === undefined)) {
    return null;
  }

  // `de-DE` serializes the long offset as `GMT+02:00`, and a zero offset as bare `GMT`.
  const offset = zoneName === 'GMT' ? 'UTC+00:00' : `UTC${zoneName?.replace(/^GMT/, '')}`;

  return { date: `${day}.${month}.${year}`, time: `${hour}:${minute}`, offset };
};

/**
 * Formats a validated window, or returns `null` when `Intl` cannot — a defect outcome that the caller
 * treats as a failure rather than rendering a window with a missing field.
 */
export interface WindowLabels {
  readonly from: string;
  readonly to: string;
  /** German says "10:00 Uhr"; most languages say nothing here, so an empty label adds nothing. */
  readonly oClock: string;
  readonly timeZone: string;
}

/** German by default, so a caller that has no locale in hand still produces the verified wording. */
const GERMAN_LABELS: WindowLabels = {
  from: 'Von',
  to: 'bis',
  oClock: 'Uhr',
  timeZone: 'Zeitzone',
};

export const formatCollectionWindow = (
  timing: CollectionWindow,
  labels: WindowLabels = GERMAN_LABELS,
): FormattedWindow | null => {
  try {
    const startsAt = new Date(timing.startsAt);
    const endsAt = new Date(timing.endsAt);

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return null;
    }

    const start = readEndpoint(startsAt, timing.timeZone);
    const end = readEndpoint(endsAt, timing.timeZone);

    if (start === null || end === null) {
      return null;
    }

    const zone = `(${timing.timeZone})`;
    // A trailing unit only where the language has one, so no locale gets a stray separator.
    const clock = (time: string): string =>
      labels.oClock === '' ? time : `${time} ${labels.oClock}`;

    if (start.date === end.date) {
      return {
        text: `${start.time} ${start.offset}–${end.time} ${end.offset} ${zone}`,
        accessibleLabel: `${labels.from} ${clock(start.time)}, ${start.offset}, ${labels.to} ${clock(end.time)}, ${end.offset}, ${labels.timeZone} ${timing.timeZone}`,
      };
    }

    return {
      text: `${start.date}, ${start.time} ${start.offset}–${end.date}, ${end.time} ${end.offset} ${zone}`,
      accessibleLabel: `${labels.from} ${start.date}, ${clock(start.time)}, ${start.offset}, ${labels.to} ${end.date}, ${clock(end.time)}, ${end.offset}, ${labels.timeZone} ${timing.timeZone}`,
    };
  } catch {
    return null;
  }
};
