import {
  demoScheduleProvider,
  type OfficialScheduleProvider,
  type ScheduleProvider,
} from '@abfall-radar/data-providers';
import { createKoblenzScheduleProvider } from '@abfall-radar/data-providers/node';
import type { Clock, FetchLike } from '@abfall-radar/data-providers/node';
import type { District } from '@abfall-radar/domain';
import type { Provider, ProviderSourceKind, ServiceArea } from '../routes/v1/providers.schemas';

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
  },
];

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
 * `service area` is the location-neutral transport term for the domain `District`. The domain model
 * keeps its own name; renaming it is a separate contract-change task.
 */
export const toServiceArea = (district: District): ServiceArea => ({
  id: district.id,
  providerId: district.providerId,
  locality: district.city,
  name: district.name,
});

export const listServiceAreas = async (entry: ProviderCatalogueEntry): Promise<ServiceArea[]> => {
  const districts = await entry.provider.getDistricts();

  return districts.map(toServiceArea);
};
