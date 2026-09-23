import { describe, expect, it } from 'vitest';
import { formatCollectionWindow } from './collection-window';

const window = (startsAt: string, endsAt: string) => ({
  kind: 'time_window' as const,
  startsAt,
  endsAt,
  timeZone: 'Europe/Berlin',
});

describe('formatCollectionWindow', () => {
  it.each([
    [
      'summer',
      '2026-07-01T10:00:00Z',
      '2026-07-01T12:00:00Z',
      '12:00 UTC+02:00–14:00 UTC+02:00 (Europe/Berlin)',
    ],
    [
      'winter',
      '2026-11-07T10:00:00Z',
      '2026-11-07T12:00:00Z',
      '11:00 UTC+01:00–13:00 UTC+01:00 (Europe/Berlin)',
    ],
    [
      'the DST overlap',
      '2026-10-25T00:30:00Z',
      '2026-10-25T01:30:00Z',
      '02:30 UTC+02:00–02:30 UTC+01:00 (Europe/Berlin)',
    ],
    [
      'a cross-midnight window',
      '2026-03-21T22:30:00Z',
      '2026-03-22T00:00:00Z',
      '21.03.2026, 23:30 UTC+01:00–22.03.2026, 01:00 UTC+01:00 (Europe/Berlin)',
    ],
    [
      'a cross-midnight window with an offset change',
      '2026-03-28T22:30:00Z',
      '2026-03-29T01:30:00Z',
      '28.03.2026, 23:30 UTC+01:00–29.03.2026, 03:30 UTC+02:00 (Europe/Berlin)',
    ],
  ])('formats %s with each endpoint in the source zone', (_, startsAt, endsAt, expected) => {
    expect(formatCollectionWindow(window(startsAt, endsAt))?.text).toBe(expected);
  });

  it('states both offsets in the accessible label, and both dates when they differ', () => {
    const overlap = formatCollectionWindow(window('2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'));
    const crossDate = formatCollectionWindow(
      window('2026-03-21T22:30:00Z', '2026-03-22T00:00:00Z'),
    );

    expect(overlap?.accessibleLabel).toContain('UTC+02:00');
    expect(overlap?.accessibleLabel).toContain('UTC+01:00');
    expect(crossDate?.accessibleLabel).toContain('21.03.2026');
    expect(crossDate?.accessibleLabel).toContain('22.03.2026');
  });

  it('returns null for a zone Intl refuses rather than throwing', () => {
    expect(
      formatCollectionWindow({
        ...window('2026-07-01T10:00:00Z', '2026-07-01T12:00:00Z'),
        timeZone: 'Mars/Olympus',
      }),
    ).toBeNull();
  });
});
