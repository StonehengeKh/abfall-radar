/**
 * Deterministic fixtures for the web tests.
 *
 * Written for this repository rather than derived from the demo provider, and never wired into a
 * product surface. Every body is parsed through `@abfall-radar/api-client`'s own response validator, so
 * a fixture cannot describe a response the client would reject. The source landing page uses a reserved
 * `*.example.test` host; it is payload data, not an API origin.
 */

import {
  type CityListResponse,
  CityListResponseSchema,
  type CollectionEventListResponse,
  CollectionEventListResponseSchema,
  type CollectionEventTransport,
  type ProblemFailure,
  type ProviderListResponse,
  ProviderListResponseSchema,
  type ServiceAreaListResponse,
  ServiceAreaListResponseSchema,
} from '@abfall-radar/api-client';

export const PROVIDER_ID = 'koblenz-servicebetrieb';
export const AREA_ID = 'koblenz-stadtmitte';
export const SECOND_PROVIDER_ID = 'musterstadt-entsorgung';

export const OFFICIAL_PROVIDER = {
  id: PROVIDER_ID,
  name: 'Kommunaler Servicebetrieb',
  sourceKind: 'official_ics',
} as const;
export const SECOND_PROVIDER = {
  id: SECOND_PROVIDER_ID,
  name: 'Entsorgung Musterstadt',
  sourceKind: 'official_ics',
} as const;
export const DEMO_PROVIDER = { id: 'demo', name: 'Demo provider', sourceKind: 'demo' } as const;

export const CITY_ID = 'koblenz';

export const KOBLENZ_CITY = {
  id: CITY_ID,
  name: 'Koblenz',
  providers: [OFFICIAL_PROVIDER],
} as const;

/** A city served by two official providers, so switching and supersession are reachable in tests. */
export const TWO_PROVIDER_CITY = {
  id: CITY_ID,
  name: 'Koblenz',
  providers: [OFFICIAL_PROVIDER, SECOND_PROVIDER],
} as const;

export const cities = (...entries: ReadonlyArray<Record<string, unknown>>): CityListResponse =>
  CityListResponseSchema.parse({ data: entries });

export const providers = (
  ...entries: ReadonlyArray<Record<string, unknown>>
): ProviderListResponse => ProviderListResponseSchema.parse({ data: entries });

/** The one official provider a single-provider city offers, beside the demo entry the UI never shows. */
export const CATALOGUE_SINGLE: ProviderListResponse = ProviderListResponseSchema.parse({
  data: [DEMO_PROVIDER, OFFICIAL_PROVIDER],
});

export const AVAILABLE = {
  availability: 'available',
  timeZone: 'Europe/Berlin',
  validity: { from: '2026-01-01', to: '2026-12-31' },
} as const;

export const area = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: AREA_ID,
  providerId: PROVIDER_ID,
  cityId: CITY_ID,
  locality: 'Koblenz',
  name: 'Stadtmitte',
  collectionEvents: AVAILABLE,
  ...overrides,
});

export const areas = (
  ...entries: ReadonlyArray<Record<string, unknown>>
): ServiceAreaListResponse => ServiceAreaListResponseSchema.parse({ data: entries });

export const curbside = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'paper-2026-08-14',
  serviceAreaId: AREA_ID,
  wasteType: 'paper',
  date: '2026-08-14',
  title: 'Altpapier',
  source: 'municipal_ics',
  collectionMode: 'curbside',
  timing: { kind: 'all_day' },
  ...overrides,
});

export const dropOff = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'hazardous-2026-11-07',
  serviceAreaId: AREA_ID,
  wasteType: 'hazardous',
  date: '2026-11-07',
  title: 'Schadstoffe / Elektrokleinteile',
  source: 'municipal_ics',
  collectionMode: 'mobile_drop_off',
  timing: {
    kind: 'time_window',
    startsAt: '2026-11-07T10:00:00Z',
    endsAt: '2026-11-07T12:00:00Z',
    timeZone: 'Europe/Berlin',
  },
  location: { name: 'Rizzastraße Ecke Südallee' },
  ...overrides,
});

export const meta = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: OFFICIAL_PROVIDER,
  serviceArea: { id: AREA_ID, locality: 'Koblenz', name: 'Stadtmitte' },
  source: {
    name: 'Kommunaler Servicebetrieb',
    landingPageUrl: 'https://servicebetrieb.example.test/entsorgungstermine/',
    attribution: 'Kommunaler Servicebetrieb, Koblenz',
    timeZone: 'Europe/Berlin',
  },
  retrievedAt: '2026-07-29T08:14:02.000Z',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  freshness: 'fresh',
  coverage: {
    wasteTypes: ['paper', 'yellow_bag', 'green_waste', 'hazardous', 'small_electronics'],
  },
  range: { from: '2026-08-02', to: '2026-10-31' },
  ...overrides,
});

export const events = (
  data: ReadonlyArray<Record<string, unknown>>,
  metaOverrides: Record<string, unknown> = {},
): CollectionEventListResponse =>
  CollectionEventListResponseSchema.parse({ data, meta: meta(metaOverrides) });

export const transportEvents = (
  response: CollectionEventListResponse,
): readonly CollectionEventTransport[] => response.data;

export const rangeProblem = (requestId = 'req-range-1'): ProblemFailure => ({
  kind: 'problem',
  operation: 'listCollectionEvents',
  status: 422,
  code: 'SCHEDULE_RANGE_NOT_COVERED',
  requestId,
});
