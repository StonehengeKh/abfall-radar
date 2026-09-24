import {
  demoScheduleProvider,
  type OfficialScheduleProvider,
  type ScheduleProvider,
} from '@abfall-radar/data-providers';
import type { Clock, FetchLike } from '@abfall-radar/data-providers/node';
import {
  createKoblenzScheduleProvider,
  getKoblenzHouseholdRules,
} from '@abfall-radar/data-providers/node';
import type { District, HouseholdCollectionRules } from '@abfall-radar/domain';
import type {
  City,
  Provider,
  ProviderSourceKind,
  ServiceArea,
  ServiceAreaCollectionEvents,
} from '../routes/v1/providers.schemas';

/**
 * `sourceKind` lives here rather than on the provider contracts so exposing a provider over HTTP never
 * requires changing a shared contract.
 *
 * The entry is a union rather than one shape with optional members: only an official provider can serve
 * collection events, and only it has a manifest, a validity window, and a freshness state. Making that
 * a discriminated union means a route cannot reach for a schedule the demo provider does not have.
 */
export type ProviderCatalogueEntry =
  | {
      readonly sourceKind: Extract<ProviderSourceKind, 'demo'>;
      readonly provider: ScheduleProvider;
    }
  | {
      readonly sourceKind: Extract<ProviderSourceKind, 'official_ics'>;
      readonly provider: OfficialScheduleProvider;
      /**
       * The municipal rules for the bins this provider publishes **no** calendar for, when they have
       * been transcribed for it.
       *
       * Optional by design, and absent rather than empty when nothing has been transcribed: a provider
       * with no rules must produce a `404`, not a rule set with no replacements, which a client would
       * apply as though the year had no holidays.
       */
      readonly householdRules?: () => Promise<HouseholdCollectionRules>;
    };

export type ProviderCatalogue = readonly ProviderCatalogueEntry[];

/**
 * Injected so integration tests can drive retrieval and cache ageing deterministically. Both default to
 * the real implementations, so production configures nothing and there is no test-only switch that
 * could be left enabled.
 */
export interface ProviderRuntime {
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
}

export const createProviderCatalogue = (runtime: ProviderRuntime = {}): ProviderCatalogue => [
  { sourceKind: 'demo', provider: demoScheduleProvider },
  {
    sourceKind: 'official_ics',
    provider: createKoblenzScheduleProvider({
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
      ...(runtime.clock === undefined ? {} : { clock: runtime.clock }),
    }),
    householdRules: () =>
      getKoblenzHouseholdRules({
        ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
        ...(runtime.clock === undefined ? {} : { clock: runtime.clock }),
      }),
  },
];

/**
 * The household rules of a provider, or `undefined` when none have been transcribed for it.
 *
 * The demo provider never has any: sample data has no municipality behind it, so there is no published
 * rule to transcribe and nothing that could be calculated honestly.
 */
export const findHouseholdRules = async (
  entry: ProviderCatalogueEntry,
): Promise<HouseholdCollectionRules | undefined> =>
  entry.sourceKind === 'official_ics' && entry.householdRules !== undefined
    ? entry.householdRules()
    : undefined;

export const listProviders = (catalogue: ProviderCatalogue): Provider[] =>
  catalogue.map(({ provider, sourceKind }) => ({
    id: provider.id,
    name: provider.name,
    sourceKind,
  }));

export const findProviderEntry = (
  catalogue: ProviderCatalogue,
  providerId: string,
): ProviderCatalogueEntry | undefined =>
  catalogue.find((entry) => entry.provider.id === providerId);

/**
 * Resolves what this provider publishes for one area, from the source manifest alone.
 *
 * Only an official provider has a manifest, so only it can report `available`, and the zone and window
 * come from that manifest rather than from a default: an area whose manifest cannot be resolved reports
 * `unavailable` instead of borrowing another area's values.
 */
export const toCollectionEventsCapability = (
  entry: ProviderCatalogueEntry,
  serviceAreaId: string,
): ServiceAreaCollectionEvents => {
  if (entry.sourceKind !== 'official_ics') {
    return { availability: 'unavailable' };
  }

  const manifest = entry.provider.findManifest(serviceAreaId);

  return manifest === undefined
    ? { availability: 'unavailable' }
    : {
        availability: 'available',
        timeZone: manifest.timeZone,
        validity: { from: manifest.validFrom, to: manifest.validTo },
      };
};

/**
 * `service area` is the location-neutral transport term for the domain `District`. The domain model
 * keeps its own name; renaming it is a separate contract-change task.
 *
 * The capability is a parameter rather than a member filled in afterwards, so no partially built area
 * missing its capability can escape this function.
 */
export const toServiceArea = (
  district: District,
  collectionEvents: ServiceAreaCollectionEvents,
): ServiceArea => ({
  id: district.id,
  providerId: district.providerId,
  cityId: district.cityId,
  locality: district.city,
  name: district.name,
  collectionEvents,
});

/**
 * The cities this API serves, each with the official providers behind it.
 *
 * Derived from the districts the providers themselves declare, so a city cannot be registered without
 * an area to serve and the two can never drift apart. Demo providers are excluded: generated sample
 * data is not a municipality's waste service, and the official flow must never offer it.
 *
 * Districts come from the provider's own local declaration, so this performs no retrieval.
 */
export const listCities = async (catalogue: ProviderCatalogue): Promise<City[]> => {
  const cities = new Map<string, { name: string; providers: Provider[] }>();

  for (const entry of catalogue) {
    if (entry.sourceKind !== 'official_ics') {
      continue;
    }

    const provider: Provider = {
      id: entry.provider.id,
      name: entry.provider.name,
      sourceKind: entry.sourceKind,
    };

    for (const district of await entry.provider.getDistricts()) {
      const city = cities.get(district.cityId) ?? { name: district.city, providers: [] };

      if (!city.providers.some((candidate) => candidate.id === provider.id)) {
        city.providers.push(provider);
      }

      cities.set(district.cityId, city);
    }
  }

  return [...cities.entries()]
    .map(([id, city]) => ({ id, name: city.name, providers: city.providers }))
    .sort((left, right) => left.name.localeCompare(right.name, 'de'));
};

export const listServiceAreas = async (entry: ProviderCatalogueEntry): Promise<ServiceArea[]> => {
  const districts = await entry.provider.getDistricts();

  return districts.map((district) =>
    toServiceArea(district, toCollectionEventsCapability(entry, district.id)),
  );
};
