import { describe, expect, it } from 'vitest';
import { allDayEvent, buildCalendar, timedEvent } from '../../test/ics-fixtures';
import { createFakeFetch, createMutableClock } from '../../test/fake-fetch';
import { FRESH_TTL_MS } from '../source-cache';
import { koblenzStadtmitteManifest } from './manifest';
import { createKoblenzScheduleProvider } from './provider';

const AREA = 'koblenz-stadtmitte';

const START = new Date('2026-07-29T08:14:02.000Z');

const calendarBody = buildCalendar({
  events: [
    allDayEvent({ uid: 'paper', summary: 'Altpapier', date: '20260814', endDate: '20260815' }),
    timedEvent({
      uid: 'combined',
      summary: 'Schadstoffe / Elektrokleinteile',
      start: '20260321T100000Z',
      end: '20260321T120000Z',
      location: 'Rizzastraße Ecke  Südallee ',
    }),
  ],
});

const createProvider = (body = calendarBody) => {
  const fake = createFakeFetch([{ body }]);
  const clock = createMutableClock(START);

  return {
    provider: createKoblenzScheduleProvider({ fetch: fake.fetch, clock }),
    fake,
    clock,
  };
};

describe('the Koblenz provider surface', () => {
  it('identifies itself with the verified provider identifier and operator name', () => {
    const { provider } = createProvider();

    expect(provider.id).toBe('koblenz-servicebetrieb');
    expect(provider.name).toBe('Kommunaler Servicebetrieb');
  });

  it('returns the verified area with official naming', async () => {
    const { provider } = createProvider();

    expect(await provider.getDistricts()).toEqual([
      {
        id: AREA,
        city: 'Koblenz',
        name: 'Stadtmitte',
        providerId: 'koblenz-servicebetrieb',
      },
    ]);
  });

  it.each([
    ['the verified area', AREA, true],
    ['an unserved area', 'koblenz-metternich-1', false],
  ])('resolves a manifest for %s', (_reason, serviceAreaId, expected) => {
    const { provider } = createProvider();

    expect(provider.findManifest(serviceAreaId) !== undefined).toBe(expected);
  });
});

describe('retrieving a schedule', () => {
  it('returns normalized events with full provenance from the manifest', async () => {
    const { provider } = createProvider();
    const result = await provider.getCollectionSchedule(AREA);

    expect(result.freshness).toBe('fresh');
    expect(result.retrievedAt).toBe(START.toISOString());
    expect(result.validFrom).toBe('2026-01-01');
    expect(result.validTo).toBe('2026-12-31');
    expect(result.provenance).toEqual({
      name: 'Kommunaler Servicebetrieb',
      landingPageUrl:
        'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
      attribution: 'Kommunaler Servicebetrieb, Koblenz',
      timeZone: 'Europe/Berlin',
    });
    expect(result.coverage.wasteTypes).toEqual(koblenzStadtmitteManifest.coverage);
    expect(result.staleWarning).toBeUndefined();
  });

  it('expands the combined entry, so two upstream entries yield three events', async () => {
    const { provider } = createProvider();
    const { events } = await provider.getCollectionSchedule(AREA);

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.type).toSorted()).toEqual([
      'hazardous',
      'paper',
      'small_electronics',
    ]);
  });

  it('never exposes the calendar download URL in its provenance', async () => {
    const { provider } = createProvider();
    const result = await provider.getCollectionSchedule(AREA);

    expect(JSON.stringify(result)).not.toContain('ics-stadtmitte.ics');
    expect(result.provenance.landingPageUrl).not.toContain('.ics');
  });

  it('declares coverage from the manifest rather than from the events it returned', async () => {
    const { provider } = createProvider(
      buildCalendar({ events: [allDayEvent({ summary: 'Altpapier', date: '20260814' })] }),
    );
    const result = await provider.getCollectionSchedule(AREA);

    expect(result.events).toHaveLength(1);
    // Only paper came back, but the source still covers six waste types.
    expect(result.coverage.wasteTypes).toHaveLength(6);
  });

  it('serves a second request inside the TTL without another upstream request', async () => {
    const { provider, fake, clock } = createProvider();

    const first = await provider.getCollectionSchedule(AREA);

    clock.advance(FRESH_TTL_MS - 1);

    const second = await provider.getCollectionSchedule(AREA);

    expect(fake.callCount()).toBe(1);
    // The identical retrieval timestamp is the observable proof the cache served it.
    expect(second.retrievedAt).toBe(first.retrievedAt);
  });

  it('propagates an upstream failure when nothing has ever been retrieved', async () => {
    const fake = createFakeFetch([{ status: 503 }]);
    const provider = createKoblenzScheduleProvider({
      fetch: fake.fetch,
      clock: createMutableClock(START),
    });

    await expect(provider.getCollectionSchedule(AREA)).rejects.toMatchObject({
      kind: 'unavailable',
      reason: 'status-rejected',
    });
  });

  it('propagates a content failure as invalid rather than unavailable', async () => {
    const fake = createFakeFetch([{ body: buildCalendar({ zoneLines: [] }) }]);
    const provider = createKoblenzScheduleProvider({
      fetch: fake.fetch,
      clock: createMutableClock(START),
    });

    await expect(provider.getCollectionSchedule(AREA)).rejects.toMatchObject({
      kind: 'invalid',
      reason: 'zone-missing',
    });
  });
});
