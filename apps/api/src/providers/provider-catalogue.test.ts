import { demoDistricts } from '@abfall-radar/data-providers';
import { describe, expect, it } from 'vitest';
import {
  createProviderCatalogue,
  findProviderEntry,
  listProviders,
  listServiceAreas,
  toServiceArea,
} from './provider-catalogue';

// No fetch is injected because nothing exercised here retrieves a schedule: listing providers and
// service areas reads the catalogue and the source manifests only.
const catalogue = createProviderCatalogue();

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

describe('toServiceArea', () => {
  it('maps the domain district onto the location-neutral transport model', () => {
    expect(
      toServiceArea({
        id: 'koblenz-stadtmitte',
        city: 'Koblenz',
        name: 'Stadtmitte',
        providerId: 'demo',
      }),
    ).toEqual({
      id: 'koblenz-stadtmitte',
      providerId: 'demo',
      locality: 'Koblenz',
      name: 'Stadtmitte',
    });
  });

  it('does not carry any field the transport model does not document', () => {
    const serviceArea = toServiceArea({
      id: 'koblenz-karthause-2',
      city: 'Koblenz',
      name: 'Karthause 2',
      providerId: 'demo',
    });

    expect(Object.keys(serviceArea).toSorted()).toEqual(['id', 'locality', 'name', 'providerId']);
  });
});

describe('listServiceAreas', () => {
  it('adapts every demo district the provider returns', async () => {
    const entry = findProviderEntry(catalogue, 'demo');

    expect(entry).toBeDefined();

    if (entry === undefined) {
      return;
    }

    expect(await listServiceAreas(entry)).toEqual(demoDistricts.map(toServiceArea));
  });

  it('returns the verified official area with official naming', async () => {
    const entry = findProviderEntry(catalogue, 'koblenz-servicebetrieb');

    expect(entry).toBeDefined();

    if (entry === undefined) {
      return;
    }

    expect(await listServiceAreas(entry)).toEqual([
      {
        id: 'koblenz-stadtmitte',
        providerId: 'koblenz-servicebetrieb',
        locality: 'Koblenz',
        name: 'Stadtmitte',
      },
    ]);
  });

  it('namespaces the coinciding Stadtmitte identifier by provider', async () => {
    // The official area really is called Stadtmitte, so the same slug follows from it. The two entries
    // never collide because a service area is only ever resolved within one provider.
    const demo = findProviderEntry(catalogue, 'demo');
    const official = findProviderEntry(catalogue, 'koblenz-servicebetrieb');
    const areaOf = async (entry: typeof demo) =>
      entry === undefined
        ? []
        : (await listServiceAreas(entry)).filter((area) => area.id === 'koblenz-stadtmitte');

    expect((await areaOf(demo))[0]?.providerId).toBe('demo');
    expect((await areaOf(official))[0]?.providerId).toBe('koblenz-servicebetrieb');
  });
});
