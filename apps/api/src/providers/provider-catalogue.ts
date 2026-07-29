import { demoScheduleProvider, type ScheduleProvider } from '@abfall-radar/data-providers';
import type { District } from '@abfall-radar/domain';
import type { Provider, ProviderSourceKind, ServiceArea } from '../routes/v1/providers.schemas';

export interface ProviderCatalogueEntry {
  readonly provider: ScheduleProvider;
  readonly sourceKind: ProviderSourceKind;
}

/**
 * `sourceKind` lives here rather than on `ScheduleProvider` so exposing a provider over HTTP never
 * requires changing the shared provider contract.
 */
const catalogue: readonly ProviderCatalogueEntry[] = [
  { provider: demoScheduleProvider, sourceKind: 'demo' },
];

export const listProviders = (): Provider[] =>
  catalogue.map(({ provider, sourceKind }) => ({
    id: provider.id,
    name: provider.name,
    sourceKind,
  }));

export const findProviderEntry = (providerId: string): ProviderCatalogueEntry | undefined =>
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
