import { wasteLabels } from '@abfall-radar/domain';
import type { MessagingClient } from '@/src/messaging/client';
import type {
  ServiceAreaCapability,
  ServiceAreaCapabilityEvidence,
} from '@/src/schedule/capability';
import type {
  CollectionEventPayload,
  ProviderSummary,
  RestoredSchedulePayload,
  SchedulePayload,
  ServiceAreaSummary,
} from '@/src/messaging/contract';

/**
 * Fixtures for the extension's deterministic tests.
 *
 * Written for this repository. Nothing here is derived from the demo provider, and nothing here is wired
 * into a product surface.
 *
 * Two fixtures carry the weight of rules that cannot be checked against the live API:
 *
 * - `CATALOGUE_WITH_DEMO` **contains** a demo provider, so the test that the selection surface excludes one
 *   cannot pass because no demo provider existed to exclude.
 * - `MIXED_AREAS` belongs to an **offered, non-demo** provider and contains one `available` and one
 *   `unavailable` area. Every unavailable-area rule is verified against it, because the live API currently
 *   offers no unavailable area under a non-demo provider — and exposing the demo provider to manufacture
 *   one would break the very rule being verified.
 */

export const OFFICIAL_PROVIDER_ID = 'koblenz-servicebetrieb';

export const OFFICIAL_AREA_ID = 'koblenz-stadtmitte';

/** An area of the same offered provider for which no calendar is published. */
export const UNAVAILABLE_AREA_ID = 'koblenz-oberwerth';

export const OFFICIAL_PROVIDER: ProviderSummary = {
  id: OFFICIAL_PROVIDER_ID,
  name: 'Kommunaler Servicebetrieb',
  sourceKind: 'official_ics',
};

export const DEMO_PROVIDER: ProviderSummary = {
  id: 'demo',
  name: 'Demo provider',
  sourceKind: 'demo',
};

export const CATALOGUE_WITH_DEMO: ProviderSummary[] = [DEMO_PROVIDER, OFFICIAL_PROVIDER];

export const AVAILABLE_CAPABILITY = {
  availability: 'available',
  timeZone: 'Europe/Berlin',
  validity: { from: '2026-01-01', to: '2026-12-31' },
} as const;

export const UNAVAILABLE_CAPABILITY = { availability: 'unavailable' } as const;

export const AVAILABLE_AREA: ServiceAreaSummary = {
  id: OFFICIAL_AREA_ID,
  providerId: OFFICIAL_PROVIDER_ID,
  locality: 'Koblenz',
  name: 'Stadtmitte',
  collectionEvents: AVAILABLE_CAPABILITY,
};

export const UNAVAILABLE_AREA: ServiceAreaSummary = {
  id: UNAVAILABLE_AREA_ID,
  providerId: OFFICIAL_PROVIDER_ID,
  locality: 'Koblenz',
  name: 'Oberwerth',
  collectionEvents: UNAVAILABLE_CAPABILITY,
};

/** An offered non-demo provider whose list mixes both capabilities. */
export const MIXED_AREAS: ServiceAreaSummary[] = [AVAILABLE_AREA, UNAVAILABLE_AREA];

/**
 * Availability evidence naming the area it was read for.
 *
 * Every write of a new or changed selection requires evidence carrying that identity, so these build the two
 * halves together. A fixture that let them drift apart would have tests asserting mismatches they never actually
 * constructed — and passing ones that were only accidentally matched.
 */
export const evidenceFor = (
  area: { readonly providerId: string; readonly serviceAreaId: string },
  collectionEvents: ServiceAreaCapability = AVAILABLE_CAPABILITY,
): ServiceAreaCapabilityEvidence => ({
  providerId: area.providerId,
  serviceAreaId: area.serviceAreaId,
  collectionEvents,
});

/** The same, from a service-area summary, whose own identity is `providerId` and `id`. */
export const evidenceForArea = (area: ServiceAreaSummary): ServiceAreaCapabilityEvidence =>
  evidenceFor({ providerId: area.providerId, serviceAreaId: area.id }, area.collectionEvents);

export const AVAILABLE_EVIDENCE = evidenceForArea(AVAILABLE_AREA);

export const UNAVAILABLE_EVIDENCE = evidenceForArea(UNAVAILABLE_AREA);

/** Narrowed to their own branch, so a test can spread one and override a member. */
type CurbsideEvent = Extract<CollectionEventPayload, { collectionMode: 'curbside' }>;

type MobileDropOffEvent = Extract<CollectionEventPayload, { collectionMode: 'mobile_drop_off' }>;

/**
 * `wasteType` is typed as the whole vocabulary rather than inferred from its default.
 *
 * `= 'paper' as const` narrowed the parameter to the literal `'paper'`, so the one argument this helper takes
 * could only ever be passed the value it already defaults to.
 */
export const curbsideEvent = (
  date: string,
  wasteType: CurbsideEvent['wasteType'] = 'paper',
  serviceAreaId: string = OFFICIAL_AREA_ID,
): CurbsideEvent => ({
  id: `${OFFICIAL_PROVIDER_ID}-${serviceAreaId}-${wasteType}-${date}`,
  serviceAreaId,
  wasteType,
  date,
  title: wasteLabels[wasteType],
  source: 'municipal_ics',
  collectionMode: 'curbside',
  timing: { kind: 'all_day' },
});

export const mobileDropOffEvent = (
  date: string,
  serviceAreaId: string = OFFICIAL_AREA_ID,
): MobileDropOffEvent => ({
  id: `${OFFICIAL_PROVIDER_ID}-${serviceAreaId}-hazardous-${date}`,
  serviceAreaId,
  wasteType: 'hazardous',
  date,
  title: 'Schadstoffe / Elektrokleinteile',
  source: 'municipal_ics',
  collectionMode: 'mobile_drop_off',
  timing: {
    kind: 'time_window',
    startsAt: `${date}T10:00:00Z`,
    endsAt: `${date}T12:00:00Z`,
    timeZone: 'Europe/Berlin',
  },
  location: { name: 'Rizzastraße Ecke Südallee' },
});

export const PROVENANCE: SchedulePayload['provenance'] = {
  providerName: 'Kommunaler Servicebetrieb',
  sourceName: 'Kommunaler Servicebetrieb',
  landingPageUrl: 'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
  attribution: 'Kommunaler Servicebetrieb, Koblenz',
  timeZone: 'Europe/Berlin',
  locality: 'Koblenz',
  areaName: 'Stadtmitte',
  retrievedAt: '2026-03-01T08:14:02.000Z',
  freshness: 'fresh',
  coverage: [
    'paper',
    'yellow_bag',
    'green_waste',
    'christmas_tree',
    'hazardous',
    'small_electronics',
  ],
  validity: { from: '2026-01-01', to: '2026-12-31' },
};

export interface ScheduleFixtureOptions {
  readonly events?: CollectionEventPayload[];
  readonly servedRange?: { from: string; to: string };
  readonly retrievedAt?: string;
  readonly freshness?: 'fresh' | 'stale';
  readonly coverage?: SchedulePayload['provenance']['coverage'];
  /**
   * The area every default event belongs to.
   *
   * A cached entry is only usable when its events name the area it is filed under, so a fixture for *another*
   * area has to produce that area's events rather than borrowing this one's. Passing the id here is what makes
   * a consistent other-area schedule expressible at all.
   */
  readonly serviceAreaId?: string;
}

export const schedule = ({
  servedRange = { from: '2026-03-01', to: '2026-05-30' },
  retrievedAt = PROVENANCE.retrievedAt,
  freshness = 'fresh',
  coverage = PROVENANCE.coverage,
  serviceAreaId = OFFICIAL_AREA_ID,
  events = [
    curbsideEvent('2026-03-10', 'paper', serviceAreaId),
    mobileDropOffEvent('2026-03-21', serviceAreaId),
  ],
}: ScheduleFixtureOptions = {}): SchedulePayload => ({
  events,
  provenance: { ...PROVENANCE, retrievedAt, freshness, coverage: [...coverage] },
  servedRange,
});

export interface RestoredFixtureOptions extends ScheduleFixtureOptions {
  readonly coverage?: SchedulePayload['provenance']['coverage'];
  readonly rangeCoverage?: 'full' | 'partial';
  readonly displayRange?: { from: string; to: string };
  readonly requestedRange?: { from: string; to: string };
  readonly storedAt?: string;
}

export const restoredSchedule = ({
  rangeCoverage = 'full',
  displayRange = { from: '2026-03-01', to: '2026-05-30' },
  requestedRange = { from: '2026-03-01', to: '2026-05-30' },
  storedAt = '2026-03-01T08:20:00.000Z',
  ...scheduleOptions
}: RestoredFixtureOptions = {}): RestoredSchedulePayload => ({
  schedule: schedule(scheduleOptions),
  coverage: rangeCoverage,
  displayRange,
  requestedRange,
  storedAt,
});

/**
 * The settings operations a schedule or catalogue stub must never perform.
 *
 * Thrown rather than stubbed silently, so a hook that started reaching for settings fails a test instead of
 * quietly widening its responsibilities. Settings belong to the worker, and these hooks talk to it about
 * providers, areas, and schedules only.
 */
export const settingsOperationsRefused = {
  async readSettings(): Promise<never> {
    throw new Error('This stub is not expected to read settings.');
  },
  async selectServiceArea(): Promise<never> {
    throw new Error('This stub is not expected to write a selection.');
  },
  async saveSettings(): Promise<never> {
    throw new Error('This stub is not expected to write settings.');
  },
  async invalidateSelectionIfMatches(): Promise<never> {
    throw new Error('This stub is not expected to invalidate a selection.');
  },
} satisfies Pick<
  MessagingClient,
  'readSettings' | 'selectServiceArea' | 'saveSettings' | 'invalidateSelectionIfMatches'
>;
