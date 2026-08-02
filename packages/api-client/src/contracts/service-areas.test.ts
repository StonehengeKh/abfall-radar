import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_CAPABILITY,
  mutableCopy,
  SERVICE_AREA_LIST_BODY,
  UNAVAILABLE_CAPABILITY,
} from '../test/response-fixtures';
import {
  ServiceAreaCollectionEventsSchema,
  ServiceAreaListResponseSchema,
  ServiceAreaSchema,
} from './service-areas';

const areaWithCapability = (collectionEvents: unknown) => ({
  id: 'koblenz-stadtmitte',
  providerId: 'koblenz-servicebetrieb',
  locality: 'Koblenz',
  name: 'Stadtmitte',
  collectionEvents,
});

describe('ServiceAreaCollectionEventsSchema', () => {
  it('parses the available branch with the source zone and declared window', () => {
    expect(ServiceAreaCollectionEventsSchema.parse(AVAILABLE_CAPABILITY)).toEqual(
      AVAILABLE_CAPABILITY,
    );
  });

  it('parses the unavailable branch', () => {
    expect(ServiceAreaCollectionEventsSchema.parse(UNAVAILABLE_CAPABILITY)).toEqual(
      UNAVAILABLE_CAPABILITY,
    );
  });

  it.each([
    ['an unknown availability value', { availability: 'maybe' }],
    ['a missing availability', { timeZone: 'Europe/Berlin' }],
    ['a null availability', { availability: null }],
  ])('rejects %s rather than guessing a branch', (_reason, capability) => {
    expect(ServiceAreaCollectionEventsSchema.safeParse(capability).success).toBe(false);
  });

  it.each([
    [
      'a missing zone',
      { availability: 'available', validity: { from: '2026-01-01', to: '2026-12-31' } },
    ],
    ['a missing window', { availability: 'available', timeZone: 'Europe/Berlin' }],
    [
      'a wrong-typed window bound',
      {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: 2026, to: '2026-12-31' },
      },
    ],
    [
      'a window bound that is not a calendar date',
      {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: '01.01.2026', to: '2026-12-31' },
      },
    ],
  ])('rejects an available branch with %s', (_reason, capability) => {
    expect(ServiceAreaCollectionEventsSchema.safeParse(capability).success).toBe(false);
  });

  it.each([
    ['a zone', { availability: 'unavailable', timeZone: 'Europe/Berlin' }],
    [
      'a window',
      { availability: 'unavailable', validity: { from: '2026-01-01', to: '2026-12-31' } },
    ],
    [
      'both',
      {
        availability: 'unavailable',
        timeZone: 'Europe/Berlin',
        validity: { from: '2026-01-01', to: '2026-12-31' },
      },
    ],
  ])('rejects an unavailable branch carrying %s', (_reason, capability) => {
    // A window alongside "no calendar is published" describes a period that does not exist. That is a
    // contradiction rather than an additive field, so it is refused instead of stripped.
    expect(ServiceAreaCollectionEventsSchema.safeParse(capability).success).toBe(false);
  });

  it('still strips an unrelated unknown member from the unavailable branch', () => {
    const parsed = ServiceAreaCollectionEventsSchema.parse({
      availability: 'unavailable',
      addedLater: 'ignored',
    });

    expect(Object.keys(parsed)).toEqual(['availability']);
  });

  it('strips an unknown member from the available branch', () => {
    const parsed = ServiceAreaCollectionEventsSchema.parse({
      ...mutableCopy(AVAILABLE_CAPABILITY),
      addedLater: 'ignored',
    });

    expect(Object.keys(parsed).toSorted()).toEqual(['availability', 'timeZone', 'validity']);
  });
});

describe('ServiceAreaListResponseSchema', () => {
  it('parses the service-area list the API returns', () => {
    expect(ServiceAreaListResponseSchema.parse(SERVICE_AREA_LIST_BODY)).toEqual(
      SERVICE_AREA_LIST_BODY,
    );
  });

  it('parses a list mixing an available and an unavailable area', () => {
    const parsed = ServiceAreaListResponseSchema.parse({
      data: [
        areaWithCapability(AVAILABLE_CAPABILITY),
        { ...areaWithCapability(UNAVAILABLE_CAPABILITY), id: 'koblenz-metternich-1' },
      ],
    });

    expect(parsed.data.map((area) => area.collectionEvents.availability)).toEqual([
      'available',
      'unavailable',
    ]);
  });

  it('accepts an unknown property and strips it', () => {
    const parsed = ServiceAreaListResponseSchema.parse({
      data: [{ ...areaWithCapability(AVAILABLE_CAPABILITY), population: 1 }],
      addedLater: true,
    });

    expect(Object.keys(parsed)).toEqual(['data']);
    expect(Object.keys(parsed.data[0] ?? {}).toSorted()).toEqual([
      'collectionEvents',
      'id',
      'locality',
      'name',
      'providerId',
    ]);
  });

  it.each([
    ['a missing capability', { id: 'a', providerId: 'p', locality: 'l', name: 'n' }],
    [
      'a missing locality',
      { id: 'a', providerId: 'p', name: 'n', collectionEvents: UNAVAILABLE_CAPABILITY },
    ],
    [
      'a wrong-typed name',
      {
        id: 'a',
        providerId: 'p',
        locality: 'l',
        name: 4,
        collectionEvents: UNAVAILABLE_CAPABILITY,
      },
    ],
  ])('rejects an area with %s', (_reason, area) => {
    expect(ServiceAreaSchema.safeParse(area).success).toBe(false);
    expect(ServiceAreaListResponseSchema.safeParse({ data: [area] }).success).toBe(false);
  });
});
