/**
 * The source day must not depend on where the device is. This file pins the process to a zone east of Berlin, where that instant is already the next day;
 * its sibling pins the opposite side. Both expect identical results.
 *
 * Pinned before the module under test loads, which is why the imports are dynamic.
 */
process.env.TZ = 'Asia/Tokyo';

// Marks the file as a module, so top-level `await` is allowed.
export {};

const { describe, expect, it } = await import('vitest');
const { deriveSourceToday, relativeDayLabel } = await import('./source-day');
const { formatCollectionWindow } = await import('./collection-window');

describe('source-local calendar days on a device pinned to Asia/Tokyo', () => {
  it('runs on the pinned device zone, so the assertions are not vacuous', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
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
});
