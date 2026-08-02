import { demoDistricts } from '@abfall-radar/data-providers';
import { describe, expect, it } from 'vitest';
import {
  createProviderCatalogue,
  findProviderEntry,
  listProviders,
  listServiceAreas,
  toCollectionEventsCapability,
  toServiceArea,
} from './provider-catalogue';

// No fetch is injected because nothing exercised here retrieves a schedule: listing providers and
// service areas reads the catalogue and the source manifests only.
const catalogue = createProviderCatalogue();

const UNAVAILABLE = { availability: 'unavailable' } as const;

const OFFICIAL_CAPABILITY = {
  availability: 'available',
  timeZone: 'Europe/Berlin',
  validity: { from: '2026-01-01', to: '2026-12-31' },
} as const;

const entryOf = (providerId: string) => {
  const entry = findProviderEntry(catalogue, providerId);

  if (entry === undefined) {
    throw new Error(`The catalogue is expected to contain ${providerId}.`);
  }

  return entry;
};

describe('listProviders', () => {
  it('labels the demo provider as demo data and the official provider as an official calendar', () => {
    expect(listProviders(catalogue)).toEqual([
      { id: 'demo', name: 'Demo provider', sourceKind: 'demo' },
      {
        id: 'koblenz-servicebetrieb',
        name: 'Kommunaler Servicebetrieb',
        sourceKind: 'official_ics',
      },
    ]);
  });
});

describe('findProviderEntry', () => {
  it.each([
    ['demo', 'demo'],
    ['koblenz-servicebetrieb', 'official_ics'],
  ])('finds %s', (providerId, sourceKind) => {
    const entry = findProviderEntry(catalogue, providerId);

    expect(entry?.provider.id).toBe(providerId);
    expect(entry?.sourceKind).toBe(sourceKind);
  });

  it.each(['unknown', 'DEMO', '', 'demo-2', 'koblenz'])(
    'returns undefined for %s',
    (providerId) => {
      expect(findProviderEntry(catalogue, providerId)).toBeUndefined();
    },
  );
});

describe('toCollectionEventsCapability', () => {
  it('reports the official area as available with the manifest zone and window', () => {
    expect(
      toCollectionEventsCapability(entryOf('koblenz-servicebetrieb'), 'koblenz-stadtmitte'),
    ).toEqual(OFFICIAL_CAPABILITY);
  });

  it.each(demoDistricts.map((district) => district.id))(
    'reports the demo area %s as unavailable',
    (serviceAreaId) => {
      expect(toCollectionEventsCapability(entryOf('demo'), serviceAreaId)).toEqual(UNAVAILABLE);
    },
  );

  it('reports an area the official provider does not serve as unavailable rather than borrowing another area’s window', () => {
    expect(toCollectionEventsCapability(entryOf('koblenz-servicebetrieb'), 'unknown-area')).toEqual(
      UNAVAILABLE,
    );
  });

  it.each([
    ['demo', 'koblenz-stadtmitte'],
    ['koblenz-servicebetrieb', 'unknown-area'],
  ])('carries no other member on the unavailable branch for %s/%s', (providerId, serviceAreaId) => {
    expect(Object.keys(toCollectionEventsCapability(entryOf(providerId), serviceAreaId))).toEqual([
      'availability',
    ]);
  });
});

describe('toServiceArea', () => {
  it('maps the domain district onto the location-neutral transport model with its capability', () => {
    expect(
      toServiceArea(
        {
          id: 'koblenz-stadtmitte',
          city: 'Koblenz',
          name: 'Stadtmitte',
          providerId: 'demo',
        },
        UNAVAILABLE,
      ),
    ).toEqual({
      id: 'koblenz-stadtmitte',
      providerId: 'demo',
      locality: 'Koblenz',
      name: 'Stadtmitte',
      collectionEvents: UNAVAILABLE,
    });
  });

  it('does not carry any field the transport model does not document', () => {
    const serviceArea = toServiceArea(
      {
        id: 'koblenz-karthause-2',
        city: 'Koblenz',
        name: 'Karthause 2',
        providerId: 'demo',
      },
      UNAVAILABLE,
    );

    expect(Object.keys(serviceArea).toSorted()).toEqual([
      'collectionEvents',
      'id',
      'locality',
      'name',
      'providerId',
    ]);
  });
});

describe('listServiceAreas', () => {
  it('adapts every demo district the provider returns, each publishing no calendar', async () => {
    expect(await listServiceAreas(entryOf('demo'))).toEqual(
      demoDistricts.map((district) => toServiceArea(district, UNAVAILABLE)),
    );
  });

  it('returns the verified official area with official naming and its declared window', async () => {
    expect(await listServiceAreas(entryOf('koblenz-servicebetrieb'))).toEqual([
      {
        id: 'koblenz-stadtmitte',
        providerId: 'koblenz-servicebetrieb',
        locality: 'Koblenz',
        name: 'Stadtmitte',
        collectionEvents: OFFICIAL_CAPABILITY,
      },
    ]);
  });

  it('namespaces the coinciding Stadtmitte identifier by provider, and only the official one publishes a calendar', async () => {
    // The official area really is called Stadtmitte, so the same slug follows from it. The two entries
    // never collide because a service area is only ever resolved within one provider.
    const areaOf = async (providerId: string) =>
      (await listServiceAreas(entryOf(providerId))).find(
        (area) => area.id === 'koblenz-stadtmitte',
      );

    const demoArea = await areaOf('demo');
    const officialArea = await areaOf('koblenz-servicebetrieb');

    expect(demoArea?.providerId).toBe('demo');
    expect(demoArea?.collectionEvents).toEqual(UNAVAILABLE);
    expect(officialArea?.providerId).toBe('koblenz-servicebetrieb');
    expect(officialArea?.collectionEvents).toEqual(OFFICIAL_CAPABILITY);
  });
});
