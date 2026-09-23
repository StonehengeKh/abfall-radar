import { describe, expect, it } from 'vitest';
import type { AreaCatalogueState, CityCatalogueState } from '@/src/hooks/use-catalogue';
import {
  AVAILABLE_AREA,
  CITY_CATALOGUE,
  OFFICIAL_AREA_ID,
  OFFICIAL_CITY_ID,
  OFFICIAL_PROVIDER,
  OFFICIAL_PROVIDER_ID,
} from '@/src/test/fixtures';
import { resolveSelectionCity } from './selection-city';

/**
 * Resolving a saved `{ providerId, serviceAreaId }` to its city, and what may contradict it.
 *
 * The selection never names its city, so every case here states the two successful reads the answer is
 * derived from — the provider's districts and the city catalogue — or states that one of them is missing.
 */

const SELECTION = { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID } as const;

const citiesLoaded: CityCatalogueState = { kind: 'loaded', cities: CITY_CATALOGUE };
const areasLoaded: AreaCatalogueState = {
  kind: 'loaded',
  providerId: OFFICIAL_PROVIDER_ID,
  areas: [AVAILABLE_AREA],
};
const unreachable = { kind: 'network', operation: 'listCities' } as const;

describe('resolveSelectionCity', () => {
  it("resolves the city through the district's own identifier", () => {
    const resolution = resolveSelectionCity(SELECTION, citiesLoaded, areasLoaded);

    expect(resolution.kind).toBe('resolved');
    expect(resolution.kind === 'resolved' && resolution.city.id).toBe(OFFICIAL_CITY_ID);
    expect(resolution.kind === 'resolved' && resolution.area.id).toBe(OFFICIAL_AREA_ID);
  });

  it('is pending, and changes nothing, while the city catalogue cannot be read', () => {
    expect(
      resolveSelectionCity(SELECTION, { kind: 'failed', failure: unreachable }, areasLoaded),
    ).toEqual({ kind: 'pending' });
    expect(resolveSelectionCity(SELECTION, { kind: 'loading' }, areasLoaded)).toEqual({
      kind: 'pending',
    });
  });

  it("is pending while the provider's districts are unread or belong to someone else", () => {
    expect(resolveSelectionCity(SELECTION, citiesLoaded, { kind: 'idle' })).toEqual({
      kind: 'pending',
    });
    expect(
      resolveSelectionCity(SELECTION, citiesLoaded, {
        kind: 'loaded',
        providerId: 'someone-else',
        areas: [AVAILABLE_AREA],
      }),
    ).toEqual({ kind: 'pending' });
  });

  it('leaves a missing district to the schedule, which already withdraws it', () => {
    expect(resolveSelectionCity(SELECTION, citiesLoaded, { ...areasLoaded, areas: [] })).toEqual({
      kind: 'pending',
    });
  });

  it("is contradicted when a successful catalogue no longer lists the district's city", () => {
    expect(resolveSelectionCity(SELECTION, { kind: 'loaded', cities: [] }, areasLoaded)).toEqual({
      kind: 'contradicted',
      reason: 'city_absent',
    });
  });

  it('is contradicted when the city no longer lists the saved provider', () => {
    const otherProviderOnly: CityCatalogueState = {
      kind: 'loaded',
      cities: [
        {
          id: OFFICIAL_CITY_ID,
          name: 'Koblenz',
          providers: [{ ...OFFICIAL_PROVIDER, id: 'another-operator' }],
        },
      ],
    };

    expect(resolveSelectionCity(SELECTION, otherProviderOnly, areasLoaded)).toEqual({
      kind: 'contradicted',
      reason: 'provider_not_in_city',
    });
  });

  it('never resolves by name: a same-named city with another identifier is not the city', () => {
    const renamed: CityCatalogueState = {
      kind: 'loaded',
      cities: [{ id: 'koblenz-neu', name: 'Koblenz', providers: [OFFICIAL_PROVIDER] }],
    };

    expect(resolveSelectionCity(SELECTION, renamed, areasLoaded)).toEqual({
      kind: 'contradicted',
      reason: 'city_absent',
    });
  });
});
