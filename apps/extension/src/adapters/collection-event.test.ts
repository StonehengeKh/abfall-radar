import {
  CollectionEventSchema,
  getRelativeDateLabel,
  getUpcomingEvents,
} from '@abfall-radar/domain';
import { CollectionEventSchema as TransportCollectionEventSchema } from '@abfall-radar/api-client';
import { describe, expect, it } from 'vitest';
import type { CollectionEventPayload } from '@/src/messaging/contract';
import { curbsideEvent, mobileDropOffEvent } from '@/src/test/fixtures';
import {
  CollectionEventAdapterError,
  toDomainCollectionEvent,
  toDomainCollectionEvents,
} from './collection-event';

describe('toDomainCollectionEvent', () => {
  it('renames the transport members onto the domain model for a curbside event', () => {
    const event = toDomainCollectionEvent(curbsideEvent('2026-03-10'));

    expect(event).toEqual({
      id: 'koblenz-servicebetrieb-koblenz-stadtmitte-paper-2026-03-10',
      districtId: 'koblenz-stadtmitte',
      type: 'paper',
      date: '2026-03-10',
      title: 'Altpapier',
      source: 'municipal_ics',
      collectionMode: 'curbside',
      timing: { kind: 'all_day' },
    });
  });

  it('renames the transport members onto the domain model for a mobile drop-off', () => {
    const event = toDomainCollectionEvent(mobileDropOffEvent('2026-03-21'));

    expect(event.districtId).toBe('koblenz-stadtmitte');
    expect(event.type).toBe('hazardous');
    expect(event.collectionMode).toBe('mobile_drop_off');
    expect(event).toMatchObject({
      timing: {
        kind: 'time_window',
        startsAt: '2026-03-21T10:00:00Z',
        endsAt: '2026-03-21T12:00:00Z',
        timeZone: 'Europe/Berlin',
      },
      location: { name: 'Rizzastraße Ecke Südallee' },
    });
  });

  it('carries no transport-only member into the domain model', () => {
    const event = toDomainCollectionEvent(curbsideEvent('2026-03-10'));

    expect(Object.keys(event)).not.toContain('serviceAreaId');
    expect(Object.keys(event)).not.toContain('wasteType');
  });

  it.each([
    ['a curbside event', curbsideEvent('2026-03-10')],
    ['a mobile drop-off', mobileDropOffEvent('2026-03-21')],
  ])('round-trips %s through the domain schema', (_kind, payload) => {
    // Validated rather than asserted: the result has to satisfy the domain contract, not merely look like it.
    expect(CollectionEventSchema.safeParse(toDomainCollectionEvent(payload)).success).toBe(true);
  });

  it('keeps the existing domain helpers working unchanged', () => {
    const referenceDate = new Date('2026-03-09T10:00:00Z');
    const events = toDomainCollectionEvents([
      mobileDropOffEvent('2026-03-21'),
      curbsideEvent('2026-03-10'),
    ]);

    const upcoming = getUpcomingEvents(events, referenceDate);

    expect(upcoming.map((event) => event.date)).toEqual(['2026-03-10', '2026-03-21']);
    expect(getRelativeDateLabel(upcoming[0]?.date ?? '', referenceDate)).toBe('Morgen');
  });

  it('rejects an event the domain model cannot represent rather than dropping it', () => {
    // A partial schedule is indistinguishable from a complete one to the person reading it, so a bad event
    // fails loudly instead of quietly disappearing.
    const untrimmedLocation: CollectionEventPayload = {
      ...mobileDropOffEvent('2026-03-21'),
      location: { name: ' Rizzastraße ' },
    };

    expect(() => toDomainCollectionEvent(untrimmedLocation)).toThrow(CollectionEventAdapterError);
  });

  it('rejects a drop-off whose window ends before it starts', () => {
    const inverted: CollectionEventPayload = {
      ...mobileDropOffEvent('2026-03-21'),
      timing: {
        kind: 'time_window',
        startsAt: '2026-03-21T12:00:00Z',
        endsAt: '2026-03-21T10:00:00Z',
        timeZone: 'Europe/Berlin',
      },
    };

    expect(() => toDomainCollectionEvent(inverted)).toThrow(CollectionEventAdapterError);
  });

  it('carries no server-supplied detail in its error', () => {
    const invalid: CollectionEventPayload = {
      ...mobileDropOffEvent('2026-03-21'),
      location: { name: ' leaked ' },
    };

    try {
      toDomainCollectionEvent(invalid);
      expect.unreachable('The adapter was expected to reject this event.');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionEventAdapterError);
      expect((error as Error).message).not.toContain('leaked');
    }
  });
});

describe('toDomainCollectionEvents', () => {
  it('maps an empty list to an empty list', () => {
    expect(toDomainCollectionEvents([])).toEqual([]);
  });

  it('preserves order', () => {
    const events = toDomainCollectionEvents([
      curbsideEvent('2026-03-10'),
      mobileDropOffEvent('2026-03-21'),
      curbsideEvent('2026-04-01'),
    ]);

    expect(events.map((event) => event.date)).toEqual(['2026-03-10', '2026-03-21', '2026-04-01']);
  });
});

/**
 * The canonical-location rule, asserted where both definitions are visible at once.
 *
 * `@abfall-radar/api-client` deliberately does not depend on `@abfall-radar/domain` — it owns the wire shape and the
 * domain owns the business model — so the same refinement is written in both. Nothing inside either package can
 * notice them drifting. This is the only place that imports both, which makes it the only place that can.
 */
describe('the canonical-location rule across both boundaries', () => {
  const withName = (name: string) => ({
    ...mobileDropOffEvent('2026-03-21'),
    location: { name },
  });

  /**
   * The same event in the **domain's** shape.
   *
   * Both schemas are strict and their identity members differ — the transport says `serviceAreaId` and
   * `wasteType`, the domain says `districtId` and `type` — so handing one shape to the other schema is rejected
   * for the wrong reason, and a comparison built that way would agree about everything including things it never
   * tested. This translates the shape and nothing else, leaving the location exactly as it was.
   */
  const asDomainShape = (event: ReturnType<typeof withName>): unknown => ({
    id: event.id,
    districtId: event.serviceAreaId,
    type: event.wasteType,
    date: event.date,
    title: event.title,
    source: event.source,
    collectionMode: event.collectionMode,
    timing: event.timing,
    location: event.location,
  });

  it('agrees on a canonical name, so the comparison below is not vacuous', () => {
    // Proves both schemas accept the translated shape at all. Without this, every "both reject" case could be
    // passing because the shape itself was wrong rather than because the name was.
    const event = withName('Rizzastraße Ecke Südallee');

    expect(TransportCollectionEventSchema.safeParse(event).success).toBe(true);
    expect(CollectionEventSchema.safeParse(asDomainShape(event)).success).toBe(true);
  });

  it.each([
    ['leading whitespace', ' Rizzastraße'],
    ['trailing whitespace', 'Rizzastraße '],
    ['whitespace at both ends', ' Rizzastraße '],
    ['nothing but whitespace', '   '],
    ['nothing at all', ''],
  ])('is refused by the transport and the domain alike for %s', (_reason, name) => {
    const event = withName(name);

    expect(TransportCollectionEventSchema.safeParse(event).success).toBe(false);
    expect(CollectionEventSchema.safeParse(asDomainShape(event)).success).toBe(false);
  });

  it.each([
    ['internal spaces', 'Rizzastraße Ecke Südallee'],
    ['German characters', 'Löhrstraße/Görgenstraße'],
    ['punctuation and digits', 'Parkplatz P+R, Tor 2'],
  ])('is accepted by the transport and the domain alike for %s', (_reason, name) => {
    const event = withName(name);

    expect(TransportCollectionEventSchema.safeParse(event).success).toBe(true);
    expect(CollectionEventSchema.safeParse(asDomainShape(event)).success).toBe(true);
  });

  it('maps a canonical event all the way through, unchanged', () => {
    // The end-to-end counterweight: the rule refuses non-canonical names without standing in the way of real ones.
    const mapped = toDomainCollectionEvent(withName('Rizzastraße Ecke Südallee'));

    expect(mapped.collectionMode === 'mobile_drop_off' && mapped.location).toEqual({
      name: 'Rizzastraße Ecke Südallee',
    });
  });
});
