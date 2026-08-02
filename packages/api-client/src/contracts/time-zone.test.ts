import { describe, expect, it } from 'vitest';
import { CollectionEventListResponseSchema } from './collection-events';
import { ServiceAreaListResponseSchema } from './service-areas';
import { isUsableTimeZone, TimeZoneSchema } from './time-zone';
import {
  COLLECTION_EVENTS_BODY,
  mutableCopy,
  SERVICE_AREA_LIST_BODY,
} from '../test/response-fixtures';

/**
 * A time zone is validated for **usability**, not for being a nonempty string.
 *
 * Every date this project derives is computed in the source's zone, and `Intl.DateTimeFormat` throws a
 * `RangeError` on an identifier it cannot resolve. That throw would happen inside date derivation, one layer
 * below the boundary that accepted the value — so the check belongs where the value arrives.
 */

const REJECTED: readonly [string, string][] = [
  ['a zone no runtime knows', 'Not/AZone'],
  ['an empty string', ''],
  ['a single space', ' '],
  ['only whitespace', '   '],
  ['a leading space before a real zone', ' Europe/Berlin'],
  ['a trailing space after a real zone', 'Europe/Berlin '],
  ['a bare region with no location', 'Europe/'],
  ['a plain word', 'Berlin'],
  ['a path-like value', '../../etc/passwd'],
];

describe('isUsableTimeZone', () => {
  it('accepts a canonical regional identifier', () => {
    expect(isUsableTimeZone('Europe/Berlin')).toBe(true);
  });

  it('accepts UTC, which a supported-values list would wrongly reject', () => {
    // `Intl.supportedValuesOf('timeZone')` omits this alias on common runtimes, so using that list as the
    // validator would refuse a value the API and the ICS sources both use and every layer below handles.
    expect(isUsableTimeZone('UTC')).toBe(true);
    expect(Intl.supportedValuesOf('timeZone')).not.toContain('UTC');
  });

  it('accepts a fixed-offset identifier, which resolves and derives dates correctly', () => {
    // ECMA-402 accepts an offset zone, and it yields a deterministic calendar date — so it is usable, and
    // refusing it would reject a value that works. "Usable" is the property being tested, not "regional".
    expect(isUsableTimeZone('+02:00')).toBe(true);
  });

  it.each(REJECTED)('rejects %s', (_reason, value) => {
    expect(isUsableTimeZone(value)).toBe(false);
  });

  it('is consistent with what Intl actually accepts', () => {
    // The property that matters: usable means the very call the derivation will make does not throw.
    for (const [, value] of REJECTED) {
      let threw = false;

      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
      } catch {
        threw = true;
      }

      // Either Intl refused it, or this validator refused it first for being padded or empty — never the
      // reverse, which would be a value accepted here and fatal downstream.
      expect(threw || value.trim() !== value || value.length === 0).toBe(true);
    }
  });
});

describe('TimeZoneSchema', () => {
  it('accepts a usable identifier and returns it unchanged', () => {
    expect(TimeZoneSchema.parse('Europe/Berlin')).toBe('Europe/Berlin');
    expect(TimeZoneSchema.parse('UTC')).toBe('UTC');
  });

  it.each(REJECTED)('refuses %s', (_reason, value) => {
    expect(TimeZoneSchema.safeParse(value).success).toBe(false);
  });
});

describe('the service-area capability', () => {
  const bodyWithZone = (timeZone: unknown): Record<string, unknown> => {
    const body = mutableCopy(SERVICE_AREA_LIST_BODY);
    const area = mutableCopy(SERVICE_AREA_LIST_BODY.data[0]);

    area.collectionEvents = {
      availability: 'available',
      timeZone,
      validity: { from: '2026-01-01', to: '2026-12-31' },
    };
    body.data = [area];

    return body;
  };

  it('accepts a usable zone', () => {
    expect(ServiceAreaListResponseSchema.safeParse(bodyWithZone('Europe/Berlin')).success).toBe(
      true,
    );
  });

  it('accepts UTC', () => {
    expect(ServiceAreaListResponseSchema.safeParse(bodyWithZone('UTC')).success).toBe(true);
  });

  it.each(REJECTED)('refuses a capability carrying %s', (_reason, value) => {
    // This is the zone the requested range is derived in, so an unusable one has no safe interpretation.
    expect(ServiceAreaListResponseSchema.safeParse(bodyWithZone(value)).success).toBe(false);
  });
});

describe('the collection-events provenance zone', () => {
  const bodyWithSourceZone = (timeZone: unknown): Record<string, unknown> => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);
    const meta = mutableCopy(COLLECTION_EVENTS_BODY.meta);

    meta.source = { ...mutableCopy(COLLECTION_EVENTS_BODY.meta.source), timeZone };
    body.meta = meta;

    return body;
  };

  it('accepts a usable zone', () => {
    expect(
      CollectionEventListResponseSchema.safeParse(bodyWithSourceZone('Europe/Berlin')).success,
    ).toBe(true);
  });

  it('accepts UTC', () => {
    expect(CollectionEventListResponseSchema.safeParse(bodyWithSourceZone('UTC')).success).toBe(
      true,
    );
  });

  it.each(REJECTED)('refuses provenance carrying %s', (_reason, value) => {
    // The reminder day is computed in this zone, and a reminder is unprompted: a throw here would surface in
    // the background worker where nobody sees it.
    expect(CollectionEventListResponseSchema.safeParse(bodyWithSourceZone(value)).success).toBe(
      false,
    );
  });
});

describe('a mobile drop-off window zone', () => {
  const bodyWithWindowZone = (timeZone: unknown): Record<string, unknown> => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);
    const dropOff = mutableCopy(COLLECTION_EVENTS_BODY.data[1]);

    dropOff.timing = { ...mutableCopy(COLLECTION_EVENTS_BODY.data[1].timing), timeZone };
    body.data = [dropOff];

    return body;
  };

  it('accepts a usable zone', () => {
    expect(
      CollectionEventListResponseSchema.safeParse(bodyWithWindowZone('Europe/Berlin')).success,
    ).toBe(true);
  });

  it.each(REJECTED)('refuses a window carrying %s', (_reason, value) => {
    // The window is formatted in this zone, so an unusable one throws while rendering the one detail that
    // makes a drop-off actionable.
    expect(CollectionEventListResponseSchema.safeParse(bodyWithWindowZone(value)).success).toBe(
      false,
    );
  });
});
