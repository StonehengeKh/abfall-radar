/**
 * The source day must not depend on where the device is. This file pins the process to a zone west of Berlin, where that instant is still the previous day;
 * its sibling pins the opposite side. Both expect identical results.
 *
 * Pinned before the module under test loads, which is why the imports are dynamic.
 */
process.env.TZ = 'America/New_York';

// Marks the file as a module, so top-level `await` is allowed.
export {};

const { describe, expect, it } = await import('vitest');
const { deriveSourceToday, relativeDayLabel } = await import('@/src/schedule/source-day');
const { formatCollectionWindow } = await import('@/src/schedule/collection-window');
const { formatLongWeekday, formatWeekday, formatWeekdayCalendarDate } = await import(
  '@/src/i18n/format'
);

describe('source-local calendar days on a device pinned to America/New_York', () => {
  it('runs on the pinned device zone, so the assertions are not vacuous', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
  });

  it('derives the Berlin date, not the device date', () => {
    expect(deriveSourceToday('Europe/Berlin', new Date('2026-08-02T16:00:00Z'))).toEqual({
      ok: true,
      date: '2026-08-02',
    });
    expect(deriveSourceToday('Europe/Berlin', new Date('2026-08-02T02:00:00Z'))).toEqual({
      ok: true,
      date: '2026-08-02',
    });
  });

  it('labels an event on the source day as today, however the device zone reads that instant', () => {
    expect(relativeDayLabel('2026-08-02', '2026-08-02')).toBe('Heute');
  });

  it('formats a drop-off window in the source zone', () => {
    expect(
      formatCollectionWindow({
        kind: 'time_window',
        startsAt: '2026-11-07T10:00:00Z',
        endsAt: '2026-11-07T12:00:00Z',
        timeZone: 'Europe/Berlin',
      })?.text,
    ).toBe('11:00 UTC+01:00–13:00 UTC+01:00 (Europe/Berlin)');
  });

  it('names the weekday of the source day, not the one the device zone reads', () => {
    // 2026-09-18 is a Friday. Its UTC midnight is Thursday 20:00 in New York, so a formatter that used
    // the device zone would call this collection a Thursday.
    expect(new Date('2026-09-18T00:00:00Z').getDay()).toBe(4);
    expect(formatWeekday('en', '2026-09-18')).toBe('Fri');
    expect(formatLongWeekday('en', '2026-09-18')).toBe('Friday');
    expect(formatWeekdayCalendarDate('en', '2026-09-18')).toBe('Fri, Sep 18, 2026');
  });
});
