import { describe, expect, it } from 'vitest';
import { createFakeFetch, createMutableClock } from '../../test/fake-fetch';
import { allDayEvent, buildCalendar, timedEvent } from '../../test/ics-fixtures';
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

  it('returns every official area the operator publishes, with official naming', async () => {
    const { provider } = createProvider();
    const districts = await provider.getDistricts();

    // The operator's published list, transcribed from the source on 2026-09-16. Written out rather
    // than derived from the manifest under test, so dropping an area fails here.
    const expected = [
      'Altstadt',
      'Arenberg',
      'Arzheim',
      'Asterstein',
      'Bubenheim',
      'Ehrenbreitstein',
      'Goldgrube',
      'Güls 1',
      'Güls 2',
      'Horchheim',
      'Horchheimer Höhe',
      'Immendorf',
      'Industriegebiet Rheinhafen',
      'Karthause 1',
      'Karthause 2',
      'Karthause 3',
      'Kesselheim',
      'Lay',
      'Lützel',
      'Metternich 1',
      'Metternich 2',
      'Moselweiss',
      'Neuendorf',
      'Niederberg',
      'Oberwerth',
      'Pfaffendorf',
      'Pfaffendorfer Höhe',
      'Rauental',
      'Rübenach 1',
      'Rübenach 2',
      'Stadtmitte',
      'Stolzenfels',
      'Vorstadt',
      'Wallersheim',
    ];

    expect(districts.map((district) => district.name)).toEqual(expected);
    // The numbered subdivisions are distinct areas, not one area with a suffix.
    expect(districts.filter((district) => district.name.startsWith('Karthause'))).toHaveLength(3);
  });

  it('gives every area a stable, unique identity under one city', async () => {
    const { provider } = createProvider();
    const districts = await provider.getDistricts();
    const ids = districts.map((district) => district.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(districts.map((district) => district.cityId))).toEqual(new Set(['koblenz']));
    expect(new Set(districts.map((district) => district.providerId))).toEqual(
      new Set(['koblenz-servicebetrieb']),
    );
    // Identity is derived from the city and the operator's own slug, never from the display name.
    expect(ids.every((id) => /^koblenz-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))).toBe(true);
    expect(ids).toContain('koblenz-neuendorf');
    expect(ids).toContain('koblenz-stadtmitte');
  });

  it('keeps an official area without a published calendar visible and without a manifest', async () => {
    const { provider } = createProvider();
    const districts = await provider.getDistricts();
    const withoutCalendar = districts.find((district) => district.name === 'Horchheimer Höhe');

    // Present in the catalogue — hiding it would imply the municipality does not serve it — but with
    // no manifest, which is what makes the API report it as unavailable.
    expect(withoutCalendar).toBeDefined();
    expect(provider.findManifest(withoutCalendar?.id ?? '')).toBeUndefined();
  });

  it('resolves a distinct verified manifest for every area that has one', async () => {
    const { provider } = createProvider();
    const districts = await provider.getDistricts();
    const manifests = districts
      .map((district) => provider.findManifest(district.id))
      .filter((manifest) => manifest !== undefined);

    expect(manifests).toHaveLength(33);
    // No two areas share a calendar URL, so no area can serve another area's collection days.
    expect(new Set(manifests.map((manifest) => manifest.calendarUrl)).size).toBe(manifests.length);

    const neuendorf = provider.findManifest('koblenz-neuendorf');
    const stadtmitte = provider.findManifest('koblenz-stadtmitte');

    expect(neuendorf?.calendarUrl).toBe(
      'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/entsorgungstermine-2026-digital/ics-neuendorf.ics',
    );
    expect(neuendorf?.calendarUrl).not.toBe(stadtmitte?.calendarUrl);
    expect(neuendorf?.areaName).toBe('Neuendorf');
  });

  it('records coverage per area rather than copying one area across the catalogue', () => {
    const { provider } = createProvider();
    const rheinhafen = provider.findManifest('koblenz-industriegebiet-rheinhafen');
    const neuendorf = provider.findManifest('koblenz-neuendorf');

    // Verified against each area's own published calendar: the industrial estate publishes neither a
    // hazardous collection nor a Christmas-tree collection, and declaring one would overstate it.
    expect(rheinhafen?.coverage).toEqual(['paper', 'yellow_bag', 'green_waste']);
    expect(neuendorf?.coverage).toEqual([
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ]);
  });

  it.each([
    ['the verified area', AREA, true],
    ['an area the operator lists without a calendar', 'koblenz-horchheimer-hoehe', false],
    ['an area this operator does not serve', 'trier-mitte', false],
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
