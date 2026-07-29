import { demoDistricts } from '@abfall-radar/data-providers';
import { describe, expect, it } from 'vitest';
import {
  findProviderEntry,
  listProviders,
  listServiceAreas,
  toServiceArea,
} from './provider-catalogue';

describe('listProviders', () => {
  it('exposes the demo provider labelled as demo data', () => {
    expect(listProviders()).toEqual([{ id: 'demo', name: 'Demo provider', sourceKind: 'demo' }]);
  });
});

describe('findProviderEntry', () => {
  it('finds the demo provider', () => {
    expect(findProviderEntry('demo')?.provider.id).toBe('demo');
  });

  it.each(['unknown', 'DEMO', '', 'demo-2'])('returns undefined for %s', (providerId) => {
    expect(findProviderEntry(providerId)).toBeUndefined();
  });
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
  it('adapts every district the provider returns', async () => {
    const entry = findProviderEntry('demo');

    expect(entry).toBeDefined();

    if (entry === undefined) {
      return;
    }

    expect(await listServiceAreas(entry)).toEqual(demoDistricts.map(toServiceArea));
  });
});
