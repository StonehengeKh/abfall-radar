import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  deriveSourceToday,
  isUpcoming,
  relativeDayLabel,
  startOfSourceDay,
} from './source-day';

const at = (iso: string): Date => new Date(iso);

describe('deriveSourceToday', () => {
  it('derives three genuinely different dates at one instant from the source zone alone', () => {
    const instant = at('2026-08-02T10:30:00Z');

    expect(deriveSourceToday('Pacific/Kiritimati', instant)).toEqual({
      ok: true,
      date: '2026-08-03',
    });
    expect(deriveSourceToday('Europe/Berlin', instant)).toEqual({ ok: true, date: '2026-08-02' });
    expect(deriveSourceToday('Pacific/Pago_Pago', instant)).toEqual({
      ok: true,
      date: '2026-08-01',
    });
  });

  it('handles realistic east and west boundaries as two separate instants', () => {
    expect(deriveSourceToday('Europe/Berlin', at('2026-08-02T02:00:00Z'))).toEqual({
      ok: true,
      date: '2026-08-02',
    });
    expect(deriveSourceToday('America/New_York', at('2026-08-02T02:00:00Z'))).toEqual({
      ok: true,
      date: '2026-08-01',
    });
    expect(deriveSourceToday('Europe/Berlin', at('2026-08-02T16:00:00Z'))).toEqual({
      ok: true,
      date: '2026-08-02',
    });
    expect(deriveSourceToday('Asia/Tokyo', at('2026-08-02T16:00:00Z'))).toEqual({
      ok: true,
      date: '2026-08-03',
    });
  });

  it('returns a typed failure for a zone Intl refuses, never a device-zone or UTC fallback', () => {
    expect(deriveSourceToday('Mars/Olympus', at('2026-08-02T10:30:00Z'))).toEqual({
      ok: false,
      timeZone: 'Mars/Olympus',
    });
  });

  it('returns a typed failure for an invalid instant', () => {
    expect(deriveSourceToday('Europe/Berlin', new Date(Number.NaN)).ok).toBe(false);
  });
});

describe('calendar-day helpers', () => {
  it('compares ISO dates as strings', () => {
    expect(isUpcoming('2026-08-02', '2026-08-02')).toBe(true);
    expect(isUpcoming('2026-08-01', '2026-08-02')).toBe(false);
  });

  it('labels the source day, tomorrow, and two to six days ahead relatively', () => {
    expect(relativeDayLabel('2026-08-02', '2026-08-02')).toBe('Heute');
    expect(relativeDayLabel('2026-08-03', '2026-08-02')).toBe('Morgen');
    expect(relativeDayLabel('2026-08-04', '2026-08-02')).toBe('In 2 Tagen');
    expect(relativeDayLabel('2026-08-08', '2026-08-02')).toBe('In 6 Tagen');
  });

  it('falls back to the absolute date from seven days on', () => {
    expect(relativeDayLabel('2026-08-09', '2026-08-02')).toBe('So., 9. Aug.');
  });

  it('adds calendar days across a month and a year boundary', () => {
    expect(addCalendarDays('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('startOfSourceDay', () => {
  /**
   * The instant a published calendar day begins at the municipality.
   *
   * Every expectation is written as a UTC instant, because that is the only spelling the device zone
   * cannot change. `new Date('2026-08-14')` would answer midnight UTC, which is a different moment and,
   * west of Greenwich, a different day.
   */
  const startsAt = (date: string, timeZone: string): string | null =>
    startOfSourceDay(date, timeZone)?.toISOString() ?? null;

  it('answers Berlin midnight in winter and in summer, one hour apart from UTC and then two', () => {
    expect(startsAt('2026-01-15', 'Europe/Berlin')).toBe('2026-01-14T23:00:00.000Z');
    expect(startsAt('2026-08-14', 'Europe/Berlin')).toBe('2026-08-13T22:00:00.000Z');
  });

  it('uses the offset in force on the day itself across both daylight-saving transitions', () => {
    // 2026-03-29 is 23 hours long and begins in winter time; 2026-10-25 is 25 hours long and begins in
    // summer time. Assuming either day's own offset from the other is wrong by an hour.
    expect(startsAt('2026-03-29', 'Europe/Berlin')).toBe('2026-03-28T23:00:00.000Z');
    expect(startsAt('2026-10-25', 'Europe/Berlin')).toBe('2026-10-24T22:00:00.000Z');
  });

  it('steps forward to the first minute that exists when a zone skips its midnight', () => {
    // Chile moves to summer time at 24:00, so 2026-09-06 has no 00:00 at all: it begins at 01:00 −03:00.
    expect(startsAt('2026-09-06', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z');
  });

  it('handles a zone whose offset is not a whole number of hours', () => {
    expect(startsAt('2026-10-04', 'Australia/Lord_Howe')).toBe('2026-10-03T13:30:00.000Z');
    expect(startsAt('2026-08-14', 'Pacific/Kiritimati')).toBe('2026-08-13T10:00:00.000Z');
  });

  it('returns null rather than a guess for a malformed date or a zone Intl refuses', () => {
    expect(startOfSourceDay('14.08.2026', 'Europe/Berlin')).toBeNull();
    expect(startOfSourceDay('2026-08', 'Europe/Berlin')).toBeNull();
    expect(startOfSourceDay('2026-08-14', 'Mars/Olympus')).toBeNull();
  });

  it('agrees with deriveSourceToday: the instant it returns is already that source day', () => {
    for (const [date, timeZone] of [
      ['2026-03-29', 'Europe/Berlin'],
      ['2026-10-25', 'Europe/Berlin'],
      ['2026-09-06', 'America/Santiago'],
      ['2026-10-04', 'Australia/Lord_Howe'],
    ] as const) {
      const instant = startOfSourceDay(date, timeZone);

      expect(instant).not.toBeNull();
      expect(deriveSourceToday(timeZone, instant as Date)).toEqual({ ok: true, date });
      // And a minute earlier is still the day before, so this really is the boundary.
      expect(
        deriveSourceToday(timeZone, new Date((instant as Date).getTime() - 60_000)),
      ).not.toEqual({ ok: true, date });
    }
  });
});
