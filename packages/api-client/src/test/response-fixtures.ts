/**
 * Valid response bodies for this package's boundary tests.
 *
 * Shaped exactly like what `apps/api` really returns — `apps/api/src/contract/client-contract.test.ts`
 * parses real injected responses through the same validators, so these fixtures cannot quietly diverge
 * from the running contract. No test in this package performs network access.
 */

export const PROVIDER_LIST_BODY = {
  data: [
    { id: 'demo', name: 'Demo provider', sourceKind: 'demo' },
    {
      id: 'koblenz-servicebetrieb',
      name: 'Kommunaler Servicebetrieb',
      sourceKind: 'official_ics',
    },
  ],
} as const;

export const AVAILABLE_CAPABILITY = {
  availability: 'available',
  timeZone: 'Europe/Berlin',
  validity: { from: '2026-01-01', to: '2026-12-31' },
} as const;

export const UNAVAILABLE_CAPABILITY = { availability: 'unavailable' } as const;

export const SERVICE_AREA_LIST_BODY = {
  data: [
    {
      id: 'koblenz-stadtmitte',
      providerId: 'koblenz-servicebetrieb',
      locality: 'Koblenz',
      name: 'Stadtmitte',
      collectionEvents: AVAILABLE_CAPABILITY,
    },
  ],
} as const;

export const CURBSIDE_EVENT = {
  id: 'koblenz-servicebetrieb-koblenz-stadtmitte-paper-2026-08-14-9f2c1d7ab3e45608',
  serviceAreaId: 'koblenz-stadtmitte',
  wasteType: 'paper',
  date: '2026-08-14',
  title: 'Altpapier',
  source: 'municipal_ics',
  collectionMode: 'curbside',
  timing: { kind: 'all_day' },
} as const;

export const MOBILE_DROP_OFF_EVENT = {
  id: 'koblenz-servicebetrieb-koblenz-stadtmitte-hazardous-2026-03-21-4b81e0c6f2a97d35',
  serviceAreaId: 'koblenz-stadtmitte',
  wasteType: 'hazardous',
  date: '2026-03-21',
  title: 'Schadstoffe / Elektrokleinteile',
  source: 'municipal_ics',
  collectionMode: 'mobile_drop_off',
  timing: {
    kind: 'time_window',
    startsAt: '2026-03-21T10:00:00Z',
    endsAt: '2026-03-21T12:00:00Z',
    timeZone: 'Europe/Berlin',
  },
  location: { name: 'Rizzastraße Ecke Südallee' },
} as const;

export const COLLECTION_EVENTS_META = {
  provider: {
    id: 'koblenz-servicebetrieb',
    name: 'Kommunaler Servicebetrieb',
    sourceKind: 'official_ics',
  },
  serviceArea: { id: 'koblenz-stadtmitte', locality: 'Koblenz', name: 'Stadtmitte' },
  source: {
    name: 'Kommunaler Servicebetrieb',
    landingPageUrl:
      'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
    attribution: 'Kommunaler Servicebetrieb, Koblenz',
    timeZone: 'Europe/Berlin',
  },
  retrievedAt: '2026-07-29T08:14:02.000Z',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  freshness: 'fresh',
  coverage: {
    wasteTypes: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  /**
   * Wide enough to contain both example events above, and equal to the range the published OpenAPI example
   * declares. It previously read `2026-03-01`..`2026-03-31` while carrying an event dated `2026-08-14`, so the
   * fixture described a response the API could not have produced — a filtered range that did not contain what
   * it returned.
   */
  range: { from: '2026-01-01', to: '2026-12-31' },
} as const;

export const COLLECTION_EVENTS_BODY = {
  data: [CURBSIDE_EVENT, MOBILE_DROP_OFF_EVENT],
  meta: COLLECTION_EVENTS_META,
} as const;

export const PROBLEM_BODY = {
  type: 'urn:abfall-radar:problem:schedule-range-not-covered',
  title: 'Requested range not covered',
  status: 422,
  detail: 'The requested date range is not covered by the validity window the source declares.',
  instance:
    '/api/v1/providers/koblenz-servicebetrieb/service-areas/koblenz-stadtmitte/collection-events?from=2025-01-01&to=2025-12-31',
  code: 'SCHEDULE_RANGE_NOT_COVERED',
  requestId: 'req-1',
} as const;

/**
 * Deep-clones a fixture into a mutable plain object, so a test can add or remove a member without the
 * readonly fixture types getting in the way and without one test mutating another's input.
 */
export const mutableCopy = (value: unknown): Record<string, unknown> => {
  const copy: unknown = JSON.parse(JSON.stringify(value));

  if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) {
    throw new Error('A fixture copy is expected to be a plain object.');
  }

  return { ...copy };
};
