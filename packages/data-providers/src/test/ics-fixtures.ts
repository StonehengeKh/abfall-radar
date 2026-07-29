/**
 * Small synthetic calendars written for this repository.
 *
 * No municipal calendar file, excerpt, or downloaded fixture is ever committed: the published file has
 * no recorded reuse terms, it would age into being wrong, and a committed snapshot looks official while
 * nothing refreshes it. These fixtures exist to exercise structure, not to stand in for real data.
 */

const CRLF = '\r\n';

export const BERLIN_ZONE_LINE = 'X-WR-TIMEZONE:Europe/Berlin';

export interface AllDayEventOptions {
  readonly uid?: string;
  readonly summary: string;
  /** Raw `VALUE=DATE` form, for example `20260107`. */
  readonly date: string;
  readonly endDate?: string;
  readonly location?: string;
}

export const allDayEvent = ({
  uid = 'all-day',
  summary,
  date,
  endDate,
  location,
}: AllDayEventOptions): string =>
  [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    `DTSTART;VALUE=DATE:${date}`,
    ...(endDate === undefined ? [] : [`DTEND;VALUE=DATE:${endDate}`]),
    ...(location === undefined ? [] : [`LOCATION:${location}`]),
    `SUMMARY:${summary}`,
    'END:VEVENT',
  ].join(CRLF);

export interface TimedEventOptions {
  readonly uid?: string;
  readonly summary: string;
  /** Raw UTC date-time form, for example `20260321T100000Z`. */
  readonly start: string;
  readonly end?: string;
  readonly location?: string;
}

export const timedEvent = ({
  uid = 'timed',
  summary,
  start,
  end,
  location,
}: TimedEventOptions): string =>
  [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    `DTSTART:${start}`,
    ...(end === undefined ? [] : [`DTEND:${end}`]),
    ...(location === undefined ? [] : [`LOCATION:${location}`]),
    `SUMMARY:${summary}`,
    'END:VEVENT',
  ].join(CRLF);

export interface CalendarFixtureOptions {
  /**
   * The zone declaration lines verbatim, so a fixture can express "none", "two", or a malformed one.
   * Defaults to exactly one `Europe/Berlin` declaration.
   */
  readonly zoneLines?: readonly string[];
  readonly events?: readonly string[];
  /** Prepends a literal byte-order mark. */
  readonly bom?: boolean;
  readonly extraLines?: readonly string[];
}

export const buildCalendar = ({
  zoneLines = [BERLIN_ZONE_LINE],
  events = [],
  bom = false,
  extraLines = [],
}: CalendarFixtureOptions = {}): string => {
  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AbfallRadar test fixture//EN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:2',
    ...zoneLines,
    ...extraLines,
    ...events,
    'END:VCALENDAR',
    '',
  ].join(CRLF);

  return bom ? `﻿${body}` : body;
};
