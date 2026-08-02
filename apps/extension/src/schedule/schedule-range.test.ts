import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  daysBetween,
  deriveLocalDate,
  deriveTargetRange,
  intersectRanges,
  isWithinRange,
  TARGET_WINDOW_DAYS,
} from './schedule-range';

const BERLIN = { timeZone: 'Europe/Berlin', validity: { from: '2026-01-01', to: '2026-12-31' } };

describe('deriveLocalDate', () => {
  it('reads the calendar date in the source zone rather than the device zone', () => {
    // 22:30 UTC on 14 August is already 15 August in Berlin.
    expect(deriveLocalDate('Europe/Berlin', new Date('2026-08-14T22:30:00Z'))).toBe('2026-08-15');
  });

  it('resolves a near-midnight instant to the source date, not the device date', () => {
    // The device is in Los Angeles, where this instant is still 14 August, and Auckland, where it is the
    // 16th. The source zone decides, so a device-zone derivation fails this test.
    const instant = new Date('2026-08-14T23:30:00Z');

    expect(deriveLocalDate('Europe/Berlin', instant)).toBe('2026-08-15');
    expect(deriveLocalDate('America/Los_Angeles', instant)).toBe('2026-08-14');
    expect(deriveLocalDate('Pacific/Auckland', instant)).toBe('2026-08-15');
  });

  it('is identical for zones on both sides of UTC because the source zone is what decides', () => {
    const instant = new Date('2026-08-14T12:00:00Z');

    expect(deriveLocalDate('Europe/Berlin', instant)).toBe('2026-08-14');
    expect(deriveLocalDate('Pacific/Kiritimati', instant)).toBe('2026-08-15');
    expect(deriveLocalDate('Pacific/Pago_Pago', instant)).toBe('2026-08-14');
  });

  it('handles a daylight-saving transition', () => {
    expect(deriveLocalDate('Europe/Berlin', new Date('2026-03-29T00:30:00Z'))).toBe('2026-03-29');
    expect(deriveLocalDate('Europe/Berlin', new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-25');
  });

  it('pads a single-digit month and day', () => {
    expect(deriveLocalDate('Europe/Berlin', new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
  });
});

describe('addCalendarDays', () => {
  it.each([
    ['2026-03-01', 90, '2026-05-30'],
    ['2026-08-14', 1, '2026-08-15'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-03-28', 2, '2026-03-30'],
  ])('adds %i days to %s', (date, days, expected) => {
    expect(addCalendarDays(date, days)).toBe(expected);
  });

  it('is unaffected by the process time zone because both ends are read as UTC midnight', () => {
    // A daylight-saving jump would shift a locally interpreted date by a day here.
    expect(addCalendarDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addCalendarDays('2026-10-24', 1)).toBe('2026-10-25');
  });
});

describe('daysBetween', () => {
  it('measures an inclusive-range span in whole days', () => {
    expect(daysBetween('2026-03-01', '2026-05-30')).toBe(90);
    expect(daysBetween('2026-03-01', '2026-03-01')).toBe(0);
  });
});

describe('deriveTargetRange', () => {
  it('requests 90 days forward from the source-local today', () => {
    const target = deriveTargetRange(BERLIN, new Date('2026-03-01T12:00:00Z'));

    expect(target).toEqual({
      kind: 'covered',
      today: '2026-03-01',
      range: { from: '2026-03-01', to: '2026-05-30' },
    });
    expect(daysBetween('2026-03-01', '2026-05-30')).toBe(TARGET_WINDOW_DAYS);
  });

  it('is identical regardless of the device zone', () => {
    // Same instant, and the source zone is the only thing that decides.
    const instant = new Date('2026-03-01T12:00:00Z');

    expect(deriveTargetRange(BERLIN, instant)).toEqual(
      deriveTargetRange({ ...BERLIN }, new Date(instant.getTime())),
    );
  });

  it('clamps the start up to the declared window', () => {
    const target = deriveTargetRange(
      { timeZone: 'Europe/Berlin', validity: { from: '2026-03-15', to: '2026-12-31' } },
      new Date('2026-03-01T12:00:00Z'),
    );

    expect(target).toEqual({
      kind: 'covered',
      today: '2026-03-01',
      range: { from: '2026-03-15', to: '2026-05-30' },
    });
  });

  it('issues no request when the window starts beyond the 90-day horizon', () => {
    // `from` would clamp up past `to`, which is an inverted clamp rather than a narrower range to guess at.
    expect(
      deriveTargetRange(
        { timeZone: 'Europe/Berlin', validity: { from: '2026-06-01', to: '2026-12-31' } },
        new Date('2026-03-01T12:00:00Z'),
      ),
    ).toEqual({ kind: 'outside_validity', today: '2026-03-01' });
  });

  it('clamps the end down to the declared window', () => {
    const target = deriveTargetRange(BERLIN, new Date('2026-11-15T12:00:00Z'));

    expect(target).toEqual({
      kind: 'covered',
      today: '2026-11-15',
      range: { from: '2026-11-15', to: '2026-12-31' },
    });
  });

  it('produces a range inside the window at the first covered day', () => {
    const target = deriveTargetRange(BERLIN, new Date('2026-01-01T12:00:00Z'));

    expect(target.kind).toBe('covered');

    if (target.kind === 'covered') {
      expect(target.range.from).toBe('2026-01-01');
      expect(target.range.to >= target.range.from).toBe(true);
      expect(target.range.to <= '2026-12-31').toBe(true);
    }
  });

  it('produces a range inside the window at the last covered day', () => {
    const target = deriveTargetRange(BERLIN, new Date('2026-12-31T12:00:00Z'));

    expect(target).toEqual({
      kind: 'covered',
      today: '2026-12-31',
      range: { from: '2026-12-31', to: '2026-12-31' },
    });
  });

  it('issues no request when the derived today is past the declared window', () => {
    // Guessing a narrower range, or retrying until something answers, is exactly the inference this
    // project keeps out of scheduling data.
    expect(deriveTargetRange(BERLIN, new Date('2027-01-01T12:00:00Z'))).toEqual({
      kind: 'outside_validity',
      today: '2027-01-01',
    });
  });

  it('issues no request when the clamp inverts', () => {
    expect(
      deriveTargetRange(
        { timeZone: 'Europe/Berlin', validity: { from: '2026-01-01', to: '2026-01-10' } },
        new Date('2026-02-01T12:00:00Z'),
      ),
    ).toEqual({ kind: 'outside_validity', today: '2026-02-01' });
  });

  it('uses the declared zone to decide which day it is at a boundary', () => {
    // 23:30 UTC on 31 December is already 1 January in Berlin, which is past this window's end.
    const target = deriveTargetRange(
      { timeZone: 'Europe/Berlin', validity: { from: '2026-01-01', to: '2026-12-31' } },
      new Date('2026-12-31T23:30:00Z'),
    );

    expect(target).toEqual({ kind: 'outside_validity', today: '2027-01-01' });
  });
});

describe('intersectRanges', () => {
  const REQUESTED = { from: '2026-03-02', to: '2026-05-31' };

  it('reports full coverage when the served range contains the requested range', () => {
    expect(intersectRanges({ from: '2026-03-01', to: '2026-06-30' }, REQUESTED)).toEqual({
      coverage: 'full',
      displayRange: REQUESTED,
    });
  });

  it('reports full coverage when the ranges are identical', () => {
    expect(intersectRanges(REQUESTED, REQUESTED)).toEqual({
      coverage: 'full',
      displayRange: REQUESTED,
    });
  });

  it('reports partial coverage when the window has advanced by exactly one day', () => {
    // The ordinary daily case, and the one a containment-only check silently gets wrong: it would render
    // the uncovered final day as "no collection scheduled".
    const served = { from: '2026-03-01', to: '2026-05-30' };

    expect(intersectRanges(served, REQUESTED)).toEqual({
      coverage: 'partial',
      displayRange: { from: '2026-03-02', to: '2026-05-30' },
    });
  });

  it('bounds the display range to the served end rather than the requested end', () => {
    const intersection = intersectRanges({ from: '2026-03-01', to: '2026-04-15' }, REQUESTED);

    expect(intersection?.displayRange.to).toBe('2026-04-15');
    expect(intersection?.coverage).toBe('partial');
  });

  it('reports partial coverage when the served range starts later than the requested range', () => {
    expect(intersectRanges({ from: '2026-04-01', to: '2026-06-30' }, REQUESTED)).toEqual({
      coverage: 'partial',
      displayRange: { from: '2026-04-01', to: '2026-05-31' },
    });
  });

  it('reports no overlap when the served range ends before the requested range starts', () => {
    expect(intersectRanges({ from: '2026-01-01', to: '2026-02-28' }, REQUESTED)).toBeUndefined();
  });

  it('reports no overlap when the served range starts after the requested range ends', () => {
    expect(intersectRanges({ from: '2026-07-01', to: '2026-08-31' }, REQUESTED)).toBeUndefined();
  });

  it('treats a single shared day as a partial overlap rather than as no overlap', () => {
    expect(intersectRanges({ from: '2026-01-01', to: '2026-03-02' }, REQUESTED)).toEqual({
      coverage: 'partial',
      displayRange: { from: '2026-03-02', to: '2026-03-02' },
    });
  });
});

describe('isWithinRange', () => {
  const RANGE = { from: '2026-03-01', to: '2026-03-31' };

  it.each(['2026-03-01', '2026-03-15', '2026-03-31'])('includes %s', (date) => {
    expect(isWithinRange(date, RANGE)).toBe(true);
  });

  it.each(['2026-02-28', '2026-04-01'])('excludes %s', (date) => {
    expect(isWithinRange(date, RANGE)).toBe(false);
  });
});
