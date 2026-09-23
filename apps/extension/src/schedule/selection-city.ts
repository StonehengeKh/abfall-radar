import type { AreaCatalogueState, CityCatalogueState } from '@/src/hooks/use-catalogue';
import type { CitySummary, ServiceAreaSummary } from '@/src/messaging/contract';
import type { ServiceAreaSelection } from '@/src/storage/settings';

/**
 * Which city a saved selection belongs to, and whether that is still true.
 *
 * A saved selection is `{ providerId, serviceAreaId }` and nothing else — version 3 kept that shape — so its
 * city is **derived**, never stored and never inferred:
 *
 * 1. the district is looked up by its identifier in its provider's own successful district list, where a
 *    district identifier is unique;
 * 2. that district names its city by `cityId`, as the API states it;
 * 3. the city is looked up by that identifier in a successful city catalogue, and it must list the saved
 *    provider.
 *
 * No step reads a display name, so two districts called "Mitte" in two cities can never be confused, and no
 * city is ever chosen because it is the only one offered.
 *
 * Only a **successful** read can contradict a selection. While either list is loading or has failed — an
 * unreachable API included — the answer is `pending`, which changes nothing: the selection is kept and the
 * surface offers Retry. A district missing from its provider's successful list is also `pending` here,
 * because that conclusion is already drawn — and withdrawn — by the schedule's own authoritative check, and
 * drawing it twice would start the same withdrawal from two places.
 */
export type SelectionCityResolution =
  | { readonly kind: 'pending' }
  | { readonly kind: 'resolved'; readonly city: CitySummary; readonly area: ServiceAreaSummary }
  /**
   * A complete, successful city catalogue says the saved selection is not what it was: the district's city is
   * no longer listed, or it no longer lists the saved provider. Withdrawn through the existing recovery path.
   */
  | { readonly kind: 'contradicted'; readonly reason: 'city_absent' | 'provider_not_in_city' };

export const resolveSelectionCity = (
  selection: ServiceAreaSelection,
  cities: CityCatalogueState,
  areaState: AreaCatalogueState,
): SelectionCityResolution => {
  if (
    cities.kind !== 'loaded' ||
    areaState.kind !== 'loaded' ||
    areaState.providerId !== selection.providerId
  ) {
    return { kind: 'pending' };
  }

  const area = areaState.areas.find((candidate) => candidate.id === selection.serviceAreaId);

  if (area === undefined || area.providerId !== selection.providerId) {
    return { kind: 'pending' };
  }

  const city = cities.cities.find((candidate) => candidate.id === area.cityId);

  if (city === undefined) {
    return { kind: 'contradicted', reason: 'city_absent' };
  }

  if (!city.providers.some((provider) => provider.id === selection.providerId)) {
    return { kind: 'contradicted', reason: 'provider_not_in_city' };
  }

  return { kind: 'resolved', city, area };
};
