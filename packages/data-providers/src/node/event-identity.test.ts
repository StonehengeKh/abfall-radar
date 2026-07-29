import { describe, expect, it } from 'vitest';
import {
  buildCanonicalIdentity,
  createEventId,
  type EventIdentity,
  IDENTITY_DIGEST_LENGTH,
  normalizeLocationName,
  toUtcInstant,
} from './event-identity';

const allDay: EventIdentity = {
  providerId: 'koblenz-servicebetrieb',
  serviceAreaId: 'koblenz-stadtmitte',
  wasteType: 'paper',
  date: '2026-08-14',
  timingKind: 'all_day',
  startsAt: null,
  endsAt: null,
  timeZone: null,
  locationName: null,
};

const timed: EventIdentity = {
  providerId: 'koblenz-servicebetrieb',
  serviceAreaId: 'koblenz-stadtmitte',
  wasteType: 'hazardous',
  date: '2026-03-21',
  timingKind: 'time_window',
  startsAt: '2026-03-21T10:00:00Z',
  endsAt: '2026-03-21T12:00:00Z',
  timeZone: 'Europe/Berlin',
  locationName: 'Rizzastraße Ecke Südallee',
};

describe('the canonical identity tuple', () => {
  it('is a JSON array of exactly nine members in the documented order', () => {
    expect(JSON.parse(buildCanonicalIdentity(timed))).toEqual([
      'koblenz-servicebetrieb',
      'koblenz-stadtmitte',
      'hazardous',
      '2026-03-21',
      'time_window',
      '2026-03-21T10:00:00Z',
      '2026-03-21T12:00:00Z',
      'Europe/Berlin',
      'Rizzastraße Ecke Südallee',
    ]);
  });

  it('carries explicit nulls in members six to nine for an all-day event', () => {
    const members = JSON.parse(buildCanonicalIdentity(allDay)) as unknown[];

    expect(members).toHaveLength(9);
    expect(members.slice(5)).toEqual([null, null, null, null]);
  });

  it('does not include collectionMode, which the timing kind already fixes', () => {
    const canonical = buildCanonicalIdentity(timed);

    expect(canonical).not.toContain('mobile_drop_off');
    expect(canonical).not.toContain('curbside');
    expect(JSON.parse(buildCanonicalIdentity(allDay))).toHaveLength(9);
  });

  it('encodes a location name containing the readable prefix delimiter unambiguously', () => {
    // A delimiter join could not distinguish these two; JSON escaping can.
    const left = buildCanonicalIdentity({ ...timed, locationName: 'A-B' });
    const right = buildCanonicalIdentity({ ...timed, locationName: 'A', timeZone: 'B' });

    expect(left).not.toBe(right);
  });
});

describe('identifiers', () => {
  it('is a readable prefix followed by a truncated hex digest', () => {
    const id = createEventId(allDay);

    expect(id.startsWith('koblenz-servicebetrieb-koblenz-stadtmitte-paper-2026-08-14-')).toBe(true);
    expect(id.slice(-IDENTITY_DIGEST_LENGTH)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is byte-identical across repeated derivations', () => {
    expect(createEventId(timed)).toBe(createEventId(timed));
  });

  it.each([
    ['a different window', { startsAt: '2026-03-21T14:00:00Z', endsAt: '2026-03-21T16:00:00Z' }],
    ['a different end only', { endsAt: '2026-03-21T13:00:00Z' }],
    // Dropping the zone from the tuple would make this pair collide.
    ['a different time zone', { timeZone: 'Europe/Paris' }],
    ['a different location', { locationName: 'Somewhere Else' }],
    ['a different waste type', { wasteType: 'small_electronics' as const }],
  ])('differs for %s', (_reason, patch) => {
    expect(createEventId({ ...timed, ...patch })).not.toBe(createEventId(timed));
  });

  it('matches for the same name supplied in NFD and in NFC', () => {
    const nfc = 'Rizzastraße Ecke Südallee'.normalize('NFC');
    const nfd = 'Rizzastraße Ecke Südallee'.normalize('NFD');

    expect(nfd).not.toBe(nfc);
    expect(createEventId({ ...timed, locationName: normalizeLocationName(nfd) })).toBe(
      createEventId({ ...timed, locationName: normalizeLocationName(nfc) }),
    );
  });

  it('accepts an injected digest, so a collision can be provoked deterministically', () => {
    const constant = (): string => 'deadbeefdeadbeef';

    expect(createEventId(allDay, constant)).toBe(
      createEventId({ ...allDay, date: '2026-08-14' }, constant),
    );
  });
});

describe('canonical value helpers', () => {
  it.each([
    ['2026-03-21T10:00:00.000Z', '2026-03-21T10:00:00Z'],
    ['2026-03-21T10:00:00.500Z', '2026-03-21T10:00:00.500Z'],
  ])('serializes %s as %s', (input, expected) => {
    expect(toUtcInstant(new Date(input))).toBe(expected);
  });

  it.each([
    ['Rizzastraße Ecke Südallee ', 'Rizzastraße Ecke Südallee'],
    ['  Rizzastraße   Ecke  Südallee  ', 'Rizzastraße Ecke Südallee'],
    ['Rizzastraße\tEcke\nSüdallee', 'Rizzastraße Ecke Südallee'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeLocationName(input)).toBe(expected);
  });
});
