import { describe, expect, it } from 'vitest';
import { CollectionEventSchema } from './waste';

const curbsideBase = {
  id: 'curbside-1',
  districtId: 'area',
  type: 'paper',
  date: '2026-08-14',
  title: 'Altpapier',
  source: 'municipal_ics',
} as const;

const mobileBase = {
  id: 'mobile-1',
  districtId: 'area',
  type: 'hazardous',
  date: '2026-03-21',
  title: 'Schadstoffe / Elektrokleinteile',
  source: 'municipal_ics',
} as const;

const validWindow = {
  kind: 'time_window',
  startsAt: '2026-03-21T10:00:00Z',
  endsAt: '2026-03-21T12:00:00Z',
  timeZone: 'Europe/Berlin',
} as const;

const parse = (value: unknown) => CollectionEventSchema.safeParse(value);

describe('CollectionEventSchema accepted variants', () => {
  it('accepts an all-day curbside collection', () => {
    const result = parse({
      ...curbsideBase,
      collectionMode: 'curbside',
      timing: { kind: 'all_day' },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a timed mobile drop-off with a full window and a location', () => {
    const result = parse({
      ...mobileBase,
      collectionMode: 'mobile_drop_off',
      timing: validWindow,
      location: { name: 'Rizzastraße Ecke Südallee' },
    });

    expect(result.success).toBe(true);
  });

  // The domain draws the line at "endsAt must not precede startsAt". A provider adapter may be
  // stricter: the official ICS adapter rejects a zero-length window, because the calendar parser
  // synthesizes one when the source attests no end at all.
  it('accepts a zero-length window, because an instant-precise window is still representable', () => {
    const result = parse({
      ...mobileBase,
      collectionMode: 'mobile_drop_off',
      timing: { ...validWindow, endsAt: validWindow.startsAt },
      location: { name: 'Rizzastraße Ecke Südallee' },
    });

    expect(result.success).toBe(true);
  });
});

describe('CollectionEventSchema rejected combinations', () => {
  it('rejects a mobile drop-off carrying an all-day timing', () => {
    expect(
      parse({
        ...mobileBase,
        collectionMode: 'mobile_drop_off',
        timing: { kind: 'all_day' },
        location: { name: 'Rizzastraße Ecke Südallee' },
      }).success,
    ).toBe(false);
  });

  it('rejects a mobile drop-off without a location', () => {
    expect(
      parse({ ...mobileBase, collectionMode: 'mobile_drop_off', timing: validWindow }).success,
    ).toBe(false);
  });

  it.each([
    ['an empty name', ''],
    ['a whitespace-only name', '   '],
    ['a name with a trailing space', 'Rizzastraße Ecke Südallee '],
    ['a name with a leading space', ' Rizzastraße Ecke Südallee'],
  ])('rejects a mobile drop-off with %s', (_reason, name) => {
    expect(
      parse({
        ...mobileBase,
        collectionMode: 'mobile_drop_off',
        timing: validWindow,
        location: { name },
      }).success,
    ).toBe(false);
  });

  it.each(['startsAt', 'endsAt', 'timeZone'] as const)(
    'rejects a mobile drop-off whose window is missing %s',
    (member) => {
      const timing: Record<string, unknown> = { ...validWindow };

      delete timing[member];

      expect(
        parse({
          ...mobileBase,
          collectionMode: 'mobile_drop_off',
          timing,
          location: { name: 'Rizzastraße Ecke Südallee' },
        }).success,
      ).toBe(false);
    },
  );

  it('rejects a window whose endsAt precedes its startsAt', () => {
    expect(
      parse({
        ...mobileBase,
        collectionMode: 'mobile_drop_off',
        timing: { ...validWindow, endsAt: '2026-03-21T09:00:00Z' },
        location: { name: 'Rizzastraße Ecke Südallee' },
      }).success,
    ).toBe(false);
  });

  it('rejects a curbside collection carrying a time window', () => {
    expect(
      parse({ ...curbsideBase, collectionMode: 'curbside', timing: validWindow }).success,
    ).toBe(false);
  });

  it('rejects a curbside collection carrying a location', () => {
    expect(
      parse({
        ...curbsideBase,
        collectionMode: 'curbside',
        timing: { kind: 'all_day' },
        location: { name: 'Rizzastraße Ecke Südallee' },
      }).success,
    ).toBe(false);
  });

  it('rejects an all-day timing that smuggles window members alongside its kind', () => {
    expect(
      parse({
        ...curbsideBase,
        collectionMode: 'curbside',
        timing: { kind: 'all_day', startsAt: '2026-08-14T10:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['an unknown collection mode', 'kerbside_pickup'],
    ['a missing collection mode', undefined],
  ])('rejects %s', (_reason, collectionMode) => {
    expect(parse({ ...curbsideBase, collectionMode, timing: { kind: 'all_day' } }).success).toBe(
      false,
    );
  });

  it('still rejects an impossible calendar date on either variant', () => {
    expect(
      parse({
        ...curbsideBase,
        date: '2026-02-30',
        collectionMode: 'curbside',
        timing: { kind: 'all_day' },
      }).success,
    ).toBe(false);
  });
});
