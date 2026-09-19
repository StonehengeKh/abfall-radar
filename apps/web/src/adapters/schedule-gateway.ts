import type {
  ApiClient,
  ApiResult,
  CityListResponse,
  CollectionEventListResponse,
  ProviderListResponse,
  ScheduleRange,
  ServiceAreaListResponse,
} from '@abfall-radar/api-client';

export type {
  ApiFailure,
  ApiResult,
  City,
  CityListResponse,
  CollectionEventListResponse,
  CollectionEventMeta,
  CollectionEventTransport,
  InvalidResponseFailure,
  Operation,
  ProblemFailure,
  Provider,
  ProviderListResponse,
  ScheduleRange,
  ServiceArea,
  ServiceAreaListResponse,
  ServiceAreaValidity,
} from '@abfall-radar/api-client';

/**
 * The four reads the product needs, and nothing else.
 *
 * Results pass through unchanged: no product retry, no persisted cache, and no second validation of
 * what the client already validated. Web-owned cross-request invariants belong to the schedule
 * lifecycle, which holds the state they need. Every Retry, reconciliation, and recovery path reuses
 * this same gateway, so the `no-store` wrapper applies to all of them.
 */
export interface ScheduleGateway {
  /** The city catalogue: which official services can be chosen at all. */
  listCities(signal: AbortSignal): Promise<ApiResult<CityListResponse>>;
  listProviders(signal: AbortSignal): Promise<ApiResult<ProviderListResponse>>;
  listServiceAreas(
    providerId: string,
    signal: AbortSignal,
  ): Promise<ApiResult<ServiceAreaListResponse>>;
  listCollectionEvents(
    query: {
      readonly providerId: string;
      readonly serviceAreaId: string;
      readonly range: ScheduleRange;
    },
    signal: AbortSignal,
  ): Promise<ApiResult<CollectionEventListResponse>>;
}

export const createScheduleGateway = (client: ApiClient): ScheduleGateway => ({
  listCities: (signal) => client.listCities({ signal }),
  listProviders: (signal) => client.listProviders({ signal }),
  listServiceAreas: (providerId, signal) => client.listServiceAreas(providerId, { signal }),
  listCollectionEvents: (query, signal) => client.listCollectionEvents({ ...query, signal }),
});
