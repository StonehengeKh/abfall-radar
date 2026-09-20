// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { RANGE_RECOVERY_INTERVAL_MS } from '@/src/schedule/range-recovery-coordinator';
import type { FailureContext } from '@/src/schedule/view-state';
import { SOURCE_DATE_WATCH_INTERVAL_MS } from '@/src/schedule/source-date-watchdog';
import {
  AREA_ID,
  area,
  cities,
  CITY_ID,
  areas,
  curbside,
  DEMO_PROVIDER,
  dropOff,
  events,
  KOBLENZ_CITY,
  OFFICIAL_PROVIDER,
  PROVIDER_ID,
  providers,
  rangeProblem,
  SECOND_PROVIDER,
  TWO_PROVIDER_CITY,
} from '@/src/test/fixtures';
import { createHarness, fail, type Harness, ok } from '@/src/test/harness';

const CATALOGUE = providers(DEMO_PROVIDER, OFFICIAL_PROVIDER);
const AREAS = areas(area());
const SCHEDULE = events([
  curbside(),
  dropOff({
    id: 'drop-2026-09-12',
    date: '2026-09-12',
    timing: {
      kind: 'time_window',
      startsAt: '2026-09-12T10:00:00Z',
      endsAt: '2026-09-12T12:00:00Z',
      timeZone: 'Europe/Berlin',
    },
  }),
]);
const NETWORK = { kind: 'network', operation: 'listProviders' } as const;

/**
 * Bootstraps, chooses the city, its available area, and confirms.
 *
 * The city offers a single official provider, so choosing the city selects that provider and opens the
 * area step; nothing here selects a provider explicitly.
 */
const reachSchedule = async (harness: Harness): Promise<void> => {
  harness.controller.start();
  await harness.flush();
  harness.controller.selectCity(CITY_ID);
  await harness.flush();
  harness.controller.selectArea(AREA_ID);
  harness.controller.confirm();
  await harness.flush();
};

/** Bootstraps and chooses the city, stopping on whatever step the city opens. */
const reachAreaStep = async (harness: Harness): Promise<void> => {
  harness.controller.start();
  await harness.flush();
  harness.controller.selectCity(CITY_ID);
  await harness.flush();
};

describe('bootstrap and request gating', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
  });

  it('performs exactly one city request and nothing further before a choice', async () => {
    harness.controller.start();
    await harness.flush();

    // The city catalogue is the only read before a choice: providers belong to a chosen city.
    expect(harness.gateway.calls).toEqual(['listCities']);
    expect(harness.gateway.countOf('listProviders')).toBe(0);
    expect(harness.gateway.countOf('listServiceAreas')).toBe(0);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });

  it('offers the single supported city and preselects none', async () => {
    harness.controller.start();
    await harness.flush();
    const view = harness.view();

    expect(view.kind === 'needs_selection' && view.selection.step).toBe('city');
    expect(
      view.kind === 'needs_selection' && view.selection.step === 'city' && view.selection.cities,
    ).toEqual([KOBLENZ_CITY]);
    expect(view.kind === 'needs_selection' && view.draftCityId).toBeNull();
  });

  it('resolves the city’s single official provider and excludes the demo provider', async () => {
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    const view = harness.view();

    // One official provider means no provider screen, but its identity is held in state and used by
    // every later request. The demo provider is never part of this flow.
    expect(view.kind === 'needs_selection' && view.selection.step).toBe('area');
    expect(view.kind === 'needs_selection' && view.draftProviderId).toBe(PROVIDER_ID);
    expect(harness.gateway.areasCalls).toEqual([PROVIDER_ID]);
  });

  it('requests nothing for a city the catalogue does not offer', async () => {
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity('never-offered');
    await harness.flush();

    expect(harness.gateway.countOf('listProviders')).toBe(0);
    expect(harness.gateway.countOf('listServiceAreas')).toBe(0);

    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    expect(harness.gateway.areasCalls).toEqual([PROVIDER_ID]);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });

  it('auto-selects no area and fetches no events until confirmation', async () => {
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    const view = harness.view();

    expect(
      view.kind === 'needs_selection' &&
        view.selection.step === 'area' &&
        view.selection.draftAreaId,
    ).toBeNull();

    harness.controller.selectArea(AREA_ID);
    await harness.flush();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });

  it('runs the authoritative pipeline on confirmation and accepts the schedule', async () => {
    await reachSchedule(harness);

    expect(harness.gateway.calls).toEqual([
      'listCities',
      'listProviders',
      'listServiceAreas',
      'listProviders',
      'listServiceAreas',
      'listCollectionEvents',
    ]);
    expect(harness.gateway.eventsCalls[0]?.range).toEqual({ from: '2026-08-02', to: '2026-10-31' });
    expect(harness.view().kind).toBe('live');
  });
});

describe('successful empty and unavailable catalogues', () => {
  it('renders no_official_providers for an empty or demo-only catalogue and issues nothing further', async () => {
    for (const catalogue of [providers(), providers(DEMO_PROVIDER)]) {
      const harness = createHarness();
      harness.gateway.queueProviders(ok(catalogue));
      harness.controller.start();
      await harness.flush();
      harness.controller.selectCity(CITY_ID);
      await harness.flush();

      expect(harness.view().kind).toBe('no_official_providers');
      expect(harness.gateway.calls).toEqual(['listCities', 'listProviders']);
    }
  });

  it('renders no_service_areas for a successful empty area list and issues no events request', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(areas()));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    expect(harness.view().kind).toBe('no_service_areas');
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });

  it('keeps an all-unavailable list in needs_selection, with no confirmable area', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(areas(area({ collectionEvents: { availability: 'unavailable' } }))));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    const view = harness.view();

    expect(view.kind).toBe('needs_selection');
    expect(
      view.kind === 'needs_selection' && view.selection.step === 'area' && view.selection.areas,
    ).toHaveLength(1);

    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    expect(harness.view().kind).toBe('needs_selection');
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });

  it('rejects duplicate ids in each list before anything downstream runs', async () => {
    const duplicateProviders = createHarness();
    duplicateProviders.gateway.queueProviders(
      ok(providers(OFFICIAL_PROVIDER, { ...DEMO_PROVIDER, id: PROVIDER_ID })),
    );
    duplicateProviders.controller.start();
    await duplicateProviders.flush();
    duplicateProviders.controller.selectCity(CITY_ID);
    await duplicateProviders.flush();
    const providersView = duplicateProviders.view();

    expect(providersView.kind === 'error' && providersView.context.failure).toEqual({
      kind: 'invalid_response',
      operation: 'listProviders',
      status: 0,
    });
    expect(duplicateProviders.gateway.countOf('listServiceAreas')).toBe(0);

    const duplicateAreas = createHarness();
    duplicateAreas.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(areas(area(), area({ locality: 'Anders' }))));
    duplicateAreas.controller.start();
    await duplicateAreas.flush();
    duplicateAreas.controller.selectCity(CITY_ID);
    await duplicateAreas.flush();
    const areasView = duplicateAreas.view();

    expect(areasView.kind === 'error' && areasView.context.failure).toEqual({
      kind: 'invalid_response',
      operation: 'listServiceAreas',
      status: 0,
    });
  });
});

describe('selection navigation', () => {
  it('keeps selection loading inside needs_selection and exposes Zurück on the area step', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).defer('listServiceAreas');
    harness.controller.start();
    await harness.flush();

    expect(harness.view().kind).toBe('needs_selection');

    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    const loadingView = harness.view();

    expect(loadingView.kind).toBe('needs_selection');
    expect(
      loadingView.kind === 'needs_selection' &&
        loadingView.selection.step === 'area' &&
        loadingView.selection.areas,
    ).toBe('loading');

    harness.gateway.release();
    await harness.flush();
  });

  it('discards a late area completion after Zurück and repaints nothing', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).defer('listServiceAreas');
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.back();
    const afterBack = harness.view();

    harness.gateway.release();
    await harness.flush();

    expect(harness.view()).toEqual(afterBack);
    expect(
      harness.view().kind === 'needs_selection' && harness.view().kind === 'needs_selection',
    ).toBe(true);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });

  it('changing the provider clears the draft area', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(providers(OFFICIAL_PROVIDER, SECOND_PROVIDER)))
      .queueAreas(ok(AREAS), ok(areas(area({ id: 'other', providerId: SECOND_PROVIDER.id }))));
    harness.gateway.queueCities(ok(cities(TWO_PROVIDER_CITY)));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectProvider(PROVIDER_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.selectProvider(SECOND_PROVIDER.id);
    await harness.flush();
    const view = harness.view();

    expect(
      view.kind === 'needs_selection' &&
        view.selection.step === 'area' &&
        view.selection.draftAreaId,
    ).toBeNull();
  });
});

describe('an invalidated draft provider is recovered, not retried', () => {
  const providerNotFound = fail<never>({
    kind: 'problem',
    operation: 'listServiceAreas',
    status: 404,
    code: 'PROVIDER_NOT_FOUND',
    requestId: 'req-404',
  });

  it('clears the draft, refreshes the catalogue once, and selects nothing', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE), ok(providers(OFFICIAL_PROVIDER)))
      .queueAreas(providerNotFound);
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    expect(harness.gateway.calls).toEqual([
      'listCities',
      'listProviders',
      'listServiceAreas',
      'listProviders',
    ]);
    const view = harness.view();

    expect(view.kind).toBe('needs_selection');
    expect(view.kind === 'needs_selection' && view.selection.step).toBe('provider');
    expect(view.kind === 'needs_selection' && view.draftProviderId).toBeNull();
    expect(harness.snapshot().announcement.identity).toBe(
      'needs_selection:provider:provider_invalidated',
    );
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });

  it('requests areas again only after an explicit choice, so there is no loop', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE), ok(providers(OFFICIAL_PROVIDER)))
      .queueAreas(providerNotFound, ok(AREAS));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    expect(harness.gateway.countOf('listServiceAreas')).toBe(1);

    harness.controller.selectProvider(PROVIDER_ID);
    await harness.flush();

    expect(harness.gateway.countOf('listServiceAreas')).toBe(2);
  });

  it('uses no_official_providers when the refresh is empty, and stays retryable when it fails', async () => {
    const empty = createHarness();
    empty.gateway.queueProviders(ok(CATALOGUE), ok(providers())).queueAreas(providerNotFound);
    empty.controller.start();
    await empty.flush();
    empty.controller.selectCity(CITY_ID);
    await empty.flush();

    expect(empty.view().kind).toBe('no_official_providers');

    const failed = createHarness();
    failed.gateway.queueProviders(ok(CATALOGUE), fail(NETWORK)).queueAreas(providerNotFound);
    failed.controller.start();
    await failed.flush();
    failed.controller.selectCity(CITY_ID);
    await failed.flush();
    const view = failed.view();

    expect(view.kind === 'error' && view.context.phase).toBe('selection_providers');
    // The refresh keeps its own real operation for diagnostics.
    expect(
      view.kind === 'error' &&
        view.context.phase === 'selection_providers' &&
        view.context.failure.operation,
    ).toBe('listProviders');
  });

  it('keeps an ordinary 404 without that code on the area step', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(
      fail({
        kind: 'problem',
        operation: 'listServiceAreas',
        status: 404,
        code: 'ROUTE_NOT_FOUND',
        requestId: 'req-x',
      }),
    );
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    const view = harness.view();

    expect(view.kind === 'error' && view.context.phase).toBe('selection_areas');
    expect(harness.gateway.countOf('listProviders')).toBe(1);
  });
});

describe('the accepted schedule and its watchdog', () => {
  it('installs exactly one watchdog and no coordinator', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: true, coordinator: false });
    expect(harness.timers.countWithDelay(SOURCE_DATE_WATCH_INTERVAL_MS)).toBe(1);
  });

  it('orders the accepted events and keeps both events of one appointment', async () => {
    const harness = createHarness();
    const paired = events([
      dropOff({
        id: 'b-electronics',
        date: '2026-09-12',
        wasteType: 'small_electronics',
        timing: {
          kind: 'time_window',
          startsAt: '2026-09-12T10:00:00Z',
          endsAt: '2026-09-12T12:00:00Z',
          timeZone: 'Europe/Berlin',
        },
      }),
      dropOff({
        id: 'a-hazardous',
        date: '2026-09-12',
        timing: {
          kind: 'time_window',
          startsAt: '2026-09-12T10:00:00Z',
          endsAt: '2026-09-12T12:00:00Z',
          timeZone: 'Europe/Berlin',
        },
      }),
      curbside(),
    ]);
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(paired));
    await reachSchedule(harness);
    const view = harness.view();

    expect(view.kind === 'live' && view.schedule.events.map((event) => event.id)).toEqual([
      'paper-2026-08-14',
      'a-hazardous',
      'b-electronics',
    ]);
  });

  it('renders a successful empty response as its own state', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(ok(events([])));
    await reachSchedule(harness);

    expect(harness.view().kind).toBe('empty');
  });

  it('reads upstream staleness from the response metadata', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(ok(events([curbside()], { freshness: 'stale' })));
    await reachSchedule(harness);
    const view = harness.view();

    expect(view.kind === 'live' && view.freshness).toBe('upstream_stale');
  });

  it('rearms on the same source date and observes the next midnight without another lifecycle event', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    expect(harness.timers.countWithDelay(SOURCE_DATE_WATCH_INTERVAL_MS)).toBe(1);

    harness.lifecycle.hide();

    expect(harness.timers.countWithDelay(SOURCE_DATE_WATCH_INTERVAL_MS)).toBe(0);

    harness.lifecycle.show();
    await harness.flush();

    expect(harness.timers.countWithDelay(SOURCE_DATE_WATCH_INTERVAL_MS)).toBe(1);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);

    // No further focus or visibility event: only the rearmed timer observes the next source day.
    harness.clock.set('2026-08-03T10:30:00Z');
    harness.timers.fire(SOURCE_DATE_WATCH_INTERVAL_MS);
    await harness.flush();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(2);
  });

  it('derives the source date once for a burst of signals on an unchanged day', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    harness.clock.reads = 0;

    harness.lifecycle.emit('visible');
    harness.lifecycle.emit('pageshow');
    harness.lifecycle.emit('focus');
    await harness.flush();

    // One return to the page is one clock read and one derivation, not one per delivered event.
    expect(harness.clock.reads).toBe(1);
    expect(harness.timers.countWithDelay(SOURCE_DATE_WATCH_INTERVAL_MS)).toBe(1);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
  });

  it('restarts once for a burst of signals that spans a changed source day', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE), ok(CATALOGUE))
      .queueAreas(ok(AREAS), ok(AREAS))
      .queueEvents(ok(SCHEDULE), ok(SCHEDULE));
    await reachSchedule(harness);
    harness.clock.set('2026-08-03T10:30:00Z');
    harness.clock.reads = 0;

    harness.lifecycle.emit('visible');
    harness.lifecycle.emit('pageshow');
    harness.lifecycle.emit('focus');
    await harness.flush();

    // Three reads, all accounted for: the burst derives the date once and detects the change, then the
    // restarted pipeline reads the clock for its range and once more for the final source-date gate.
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(2);
    expect(harness.clock.reads).toBe(3);
    expect(harness.timers.countWithDelay(SOURCE_DATE_WATCH_INTERVAL_MS)).toBe(1);
  });

  it('arms nothing for a disposed owner', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    harness.controller.dispose();

    expect(harness.timers.countWithDelay(SOURCE_DATE_WATCH_INTERVAL_MS)).toBe(0);
    expect(harness.lifecycle.listenerCount).toBe(0);
  });

  it('withdraws the schedule and stops the watchdog when a check cannot derive the date', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    harness.clock.set('invalid');
    harness.timers.fire(SOURCE_DATE_WATCH_INTERVAL_MS);
    await harness.flush();
    const view = harness.view();

    expect(view.kind === 'error' && view.context.failure).toEqual({
      kind: 'source_date_unavailable',
      timeZone: 'Europe/Berlin',
    });
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
  });
});

describe('the final source-date gate', () => {
  it('discards a candidate whose source day moved and restarts once', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(ok(SCHEDULE))
      .defer('listCollectionEvents');
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();

    // Every published snapshot is recorded: a correct final screen must not hide a stale acceptance.
    const published: Array<{ kind: string; sourceToday?: string }> = [];
    harness.controller.subscribe(() => {
      const view = harness.view();
      published.push({
        kind: view.kind,
        ...(view.kind === 'live' || view.kind === 'empty'
          ? { sourceToday: view.schedule.sourceToday }
          : {}),
      });
    });
    await harness.flush();

    // The request crosses source midnight while it is in flight.
    harness.clock.set('2026-08-03T10:30:00Z');
    harness.gateway.release();
    await harness.flush();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(2);
    expect(harness.gateway.eventsCalls[1]?.range).toEqual({ from: '2026-08-03', to: '2026-11-01' });
    expect(harness.view().kind).toBe('live');
    // The obsolete candidate was never published, not even briefly.
    expect(published.filter((entry) => entry.sourceToday === '2026-08-02')).toEqual([]);
    expect(published.some((entry) => entry.sourceToday === '2026-08-03')).toBe(true);
  });

  it('takes the local error when derivation fails at the gate, installing no lifecycle owner', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(ok(SCHEDULE))
      .defer('listCollectionEvents');
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    harness.clock.set('invalid');
    harness.gateway.release();
    await harness.flush();
    const view = harness.view();

    expect(view.kind === 'error' && view.context.failure).toEqual({
      kind: 'source_date_unavailable',
      timeZone: 'Europe/Berlin',
    });
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
    // The events request had already completed; only no further one is issued.
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
  });

  it('fails the preflight before any events request when the zone is unusable', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(
        ok(
          areas(
            area({
              collectionEvents: {
                availability: 'available',
                timeZone: 'Europe/Berlin',
                validity: { from: '2026-01-01', to: '2026-12-31' },
              },
            }),
          ),
        ),
      )
      .queueEvents(ok(SCHEDULE));
    harness.clock.set('invalid');
    await reachSchedule(harness);
    const view = harness.view();

    expect(view.kind === 'error' && view.context.failure).toEqual({
      kind: 'source_date_unavailable',
      timeZone: 'Europe/Berlin',
    });
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });
});

describe('bounded reconciliation', () => {
  it('reconciles once on the first exact 422 and accepts the retry', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(fail(rangeProblem()), ok(SCHEDULE));
    await reachSchedule(harness);

    // After the city read and its area read, the pipeline and its one reconciliation run in full.
    expect(harness.gateway.calls.slice(3)).toEqual([
      'listProviders',
      'listServiceAreas',
      'listCollectionEvents',
      'listProviders',
      'listServiceAreas',
      'listCollectionEvents',
    ]);
    expect(harness.view().kind).toBe('live');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: true, coordinator: false });
  });

  it('enters range_not_covered with the terminal problem when the retry returns it again', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(fail(rangeProblem('first')), fail(rangeProblem('second')));
    await reachSchedule(harness);
    const view = harness.view();

    expect(view.kind).toBe('range_not_covered');
    expect(view.kind === 'range_not_covered' && view.triggeringRangeProblem?.requestId).toBe(
      'second',
    );
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: true });
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(2);
    // Entry reuses the reconciled attempt's fresh reads: nothing follows its events call, so the
    // observation window is the whole call log.
    expect(harness.gateway.calls).toEqual([
      'listCities',
      'listProviders',
      'listServiceAreas',
      'listProviders',
      'listServiceAreas',
      'listCollectionEvents',
      'listProviders',
      'listServiceAreas',
      'listCollectionEvents',
    ]);
  });

  it('ends a mismatch after an exhausted budget in a local invalid_response with no lifecycle timer', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(fail(rangeProblem()), ok(events([curbside()], { validFrom: '2026-02-01' })));
    await reachSchedule(harness);
    const view = harness.view();

    expect(view.kind === 'error' && view.context.failure).toEqual({
      kind: 'invalid_response',
      operation: 'listCollectionEvents',
      status: 0,
    });
    expect(
      view.kind === 'error' && view.context.phase === 'schedule_pipeline' && view.context.stage,
    ).toBe('reconciliation');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
  });

  it('ends a first mismatch followed by the exact problem in range_not_covered', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(
        ok(events([curbside()], { validFrom: '2026-02-01' })),
        fail(rangeProblem('terminal')),
      );
    await reachSchedule(harness);
    const view = harness.view();

    expect(view.kind).toBe('range_not_covered');
    expect(view.kind === 'range_not_covered' && view.triggeringRangeProblem?.requestId).toBe(
      'terminal',
    );
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(2);
  });

  it('carries no triggering problem when the refreshed capability yields no requestable range', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(
        ok(AREAS),
        ok(AREAS),
        ok(
          areas(
            area({
              collectionEvents: {
                availability: 'available',
                timeZone: 'Europe/Berlin',
                validity: { from: '2020-01-01', to: '2020-12-31' },
              },
            }),
          ),
        ),
      )
      .queueEvents(fail(rangeProblem()));
    await reachSchedule(harness);
    const view = harness.view();

    expect(view.kind).toBe('range_not_covered');
    expect(view.kind === 'range_not_covered' && view.triggeringRangeProblem).toBeUndefined();
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
  });

  it('invalidates the selection when the provider disappears during reconciliation', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE), ok(CATALOGUE), ok(providers(SECOND_PROVIDER)))
      .queueAreas(ok(AREAS))
      .queueEvents(fail(rangeProblem()));
    await reachSchedule(harness);
    const view = harness.view();

    // Koblenz's only provider is gone, so the usable outcome is the city's "no official provider"
    // state with its Retry — never the city spinner that used to have no request behind it.
    expect(view.kind).toBe('no_official_providers');
    expect(view.kind === 'no_official_providers' && view.draftCityId).toBe(CITY_ID);
    expect(harness.snapshot().focus?.target).toBe('state-heading');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
    // Nothing is left waiting: no city read was needed, and none is pending.
    expect(harness.gateway.countOf('listCities')).toBe(1);
    expect(harness.gateway.pendingCount).toBe(0);
  });
});

describe('range recovery', () => {
  const enterUncovered = async (harness: Harness): Promise<void> => {
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(
        ok(
          areas(
            area({
              collectionEvents: {
                availability: 'available',
                timeZone: 'Europe/Berlin',
                validity: { from: '2020-01-01', to: '2020-12-31' },
              },
            }),
          ),
        ),
      )
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
  };

  it('enters locally with no events request and reuses the entry reads instead of repeating them', async () => {
    const harness = createHarness();
    await enterUncovered(harness);

    expect(harness.view().kind).toBe('range_not_covered');
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
    // The entry-producing pipeline's fresh reads count as the initial cycle.
    expect(harness.gateway.calls.slice(3)).toEqual(['listProviders', 'listServiceAreas']);
    expect(harness.timers.countWithDelay(RANGE_RECOVERY_INTERVAL_MS)).toBe(1);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: true });
  });

  it('keeps one coordinator and schedules the next deadline when a cycle stays uncovered', async () => {
    const harness = createHarness();
    await enterUncovered(harness);
    const before = harness.gateway.countOf('listProviders');

    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();

    expect(harness.gateway.countOf('listProviders')).toBe(before + 1);
    expect(harness.view().kind).toBe('range_not_covered');
    expect(harness.timers.countWithDelay(RANGE_RECOVERY_INTERVAL_MS)).toBe(1);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: true });
  });

  it('accepts a schedule once the range becomes requestable and swaps the lifecycle owner', async () => {
    const harness = createHarness();
    await enterUncovered(harness);
    harness.gateway.replaceAreas(ok(AREAS));

    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();

    expect(harness.view().kind).toBe('live');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: true, coordinator: false });
    expect(harness.timers.countWithDelay(RANGE_RECOVERY_INTERVAL_MS)).toBe(0);
  });

  it('stores a transient failure as the nested diagnostic and keeps the coordinator', async () => {
    const harness = createHarness();
    await enterUncovered(harness);
    harness.gateway.replaceProviders(fail(NETWORK));

    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();
    const view = harness.view();

    expect(view.kind).toBe('range_not_covered');
    expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.failure).toEqual(NETWORK);
    expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.phase).toBe(
      'range_recovery',
    );
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: true });
    expect(harness.timers.countWithDelay(RANGE_RECOVERY_INTERVAL_MS)).toBe(1);
  });

  it('pauses while hidden and revalidates immediately on return, coalescing concurrent signals', async () => {
    const harness = createHarness();
    await enterUncovered(harness);
    const before = harness.gateway.countOf('listProviders');

    harness.lifecycle.hide();

    expect(harness.timers.countWithDelay(RANGE_RECOVERY_INTERVAL_MS)).toBe(0);

    harness.lifecycle.emit('visible');
    harness.lifecycle.emit('focus');
    harness.lifecycle.emit('pageshow');
    await harness.flush();

    expect(harness.gateway.countOf('listProviders')).toBe(before + 1);
  });

  it('clears the previous nested diagnostic when a new cycle begins', async () => {
    const harness = createHarness();
    await enterUncovered(harness);
    harness.gateway.replaceProviders(fail(NETWORK), ok(CATALOGUE));

    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();

    expect(harness.view().kind === 'range_not_covered' && harness.view()).toBeTruthy();

    harness.controller.retry();
    await harness.flush();
    const view = harness.view();

    expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure).toBeUndefined();
  });
});

describe('phase-aware retry', () => {
  it('retries only the provider catalogue for a selection_providers failure', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(fail(NETWORK), ok(CATALOGUE)).queueAreas(ok(AREAS));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.retry();
    await harness.flush();

    expect(harness.gateway.calls).toEqual([
      'listCities',
      'listProviders',
      'listProviders',
      'listServiceAreas',
    ]);
    expect(harness.view().kind).toBe('needs_selection');
  });

  it('retries only the areas for the draft provider on a selection_areas failure', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(
        fail({ kind: 'timeout', operation: 'listServiceAreas', timeoutMs: 8000 }),
        ok(AREAS),
      );
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.retry();
    await harness.flush();

    expect(harness.gateway.calls).toEqual([
      'listCities',
      'listProviders',
      'listServiceAreas',
      'listServiceAreas',
    ]);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });

  it('restarts the whole pipeline for a schedule failure reported on listProviders', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE), fail(NETWORK), ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    const view = harness.view();

    expect(view.kind === 'error' && view.context.phase).toBe('schedule_pipeline');

    harness.controller.retry();
    await harness.flush();

    expect(harness.view().kind).toBe('live');
    expect(harness.gateway.calls.slice(-3)).toEqual([
      'listProviders',
      'listServiceAreas',
      'listCollectionEvents',
    ]);
  });

  it('keeps range recovery in its own phase on retry', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(
        ok(
          areas(
            area({
              collectionEvents: {
                availability: 'available',
                timeZone: 'Europe/Berlin',
                validity: { from: '2020-01-01', to: '2020-12-31' },
              },
            }),
          ),
        ),
      )
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    const before = harness.gateway.countOf('listProviders');

    harness.controller.retry();
    await harness.flush();

    expect(harness.gateway.countOf('listProviders')).toBe(before + 1);
    expect(harness.view().kind).toBe('range_not_covered');
  });
});

describe('change selection', () => {
  it('stops the lifecycle owner, hides the schedule, and issues no events request until reconfirmation', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    const eventsBefore = harness.gateway.countOf('listCollectionEvents');

    harness.controller.changeSelection();
    await harness.flush();

    expect(harness.view().kind).toBe('needs_selection');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(eventsBefore);

    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(eventsBefore + 1);
    expect(harness.view().kind).toBe('live');
  });
});

describe('the configuration error surface', () => {
  it('renders the state and constructs no client', async () => {
    const harness = createHarness({ gateway: null });
    harness.controller.start();
    await harness.flush();

    expect(harness.view().kind).toBe('configuration_error');
    expect(harness.lifecycle.listenerCount).toBe(0);
  });
});

describe('editing a confirmed selection', () => {
  const reachEditing = async (harness: Harness): Promise<void> => {
    await reachSchedule(harness);
    harness.controller.changeSelection();
    await harness.flush();
  };

  it('keeps the confirmed area as the draft default when the catalogue is unchanged', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachEditing(harness);
    const view = harness.view();

    expect(view.kind).toBe('needs_selection');
    expect(view.kind === 'needs_selection' && view.selection.step).toBe('area');
    expect(
      view.kind === 'needs_selection' &&
        view.selection.step === 'area' &&
        view.selection.draftAreaId,
    ).toBe(AREA_ID);

    // The pair is confirmable again without reselecting what the user had already chosen.
    harness.controller.confirm();
    await harness.flush();

    expect(harness.view().kind).toBe('live');
  });

  it('restores no draft area when the confirmed one is gone or no longer available', async () => {
    const withdrawn = areas(
      area({ id: 'andere-lage', name: 'Andere Lage' }),
      area({ collectionEvents: { availability: 'unavailable' } }),
    );
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    harness.gateway.replaceAreas(ok(withdrawn));
    harness.controller.changeSelection();
    await harness.flush();
    const view = harness.view();

    expect(
      view.kind === 'needs_selection' &&
        view.selection.step === 'area' &&
        view.selection.draftAreaId,
    ).toBeNull();

    // Confirming without a draft area is inert, so nothing is requested for an unavailable pair.
    harness.controller.confirm();
    await harness.flush();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
  });

  it('auto-selects nothing when a different provider is chosen while editing', async () => {
    const harness = createHarness();
    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      .queueProviders(ok(providers(OFFICIAL_PROVIDER, SECOND_PROVIDER)))
      .queueAreas(ok(AREAS))
      .queueEvents(ok(SCHEDULE));
    await reachEditing(harness);
    harness.gateway.replaceAreas(ok(areas(area({ providerId: SECOND_PROVIDER.id }))));
    harness.controller.selectProvider(SECOND_PROVIDER.id);
    await harness.flush();
    const view = harness.view();

    expect(
      view.kind === 'needs_selection' &&
        view.selection.step === 'area' &&
        view.selection.draftAreaId,
    ).toBeNull();
  });
});

describe('repeated failures and superseded attempts', () => {
  it('issues a fresh request for every unsuccessful Retry and keeps the same failure phase', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(fail(NETWORK)).queueAreas(ok(AREAS));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    const announcements = [harness.snapshot().announcement];

    for (const attempt of [1, 2, 3]) {
      harness.controller.retry();
      await harness.flush();
      announcements.push(harness.snapshot().announcement);

      expect(harness.gateway.countOf('listProviders')).toBe(attempt + 1);
      expect(harness.view().kind).toBe('error');
    }

    const view = harness.view();

    expect(view.kind === 'error' && view.context.phase).toBe('selection_providers');
    expect(view.kind === 'error' && view.context.failure).toEqual(NETWORK);
    // The message never changes, so only the advancing sequence makes each failed attempt audible: the
    // live region is keyed by it and announces the identical text again.
    expect(new Set(announcements.map((announcement) => announcement.identity)).size).toBe(1);
    expect(
      announcements.every(
        (announcement, index) =>
          index === 0 || announcement.seq > (announcements[index - 1]?.seq ?? 0),
      ),
    ).toBe(true);
  });

  it('publishes nothing from a pipeline superseded by editing the selection', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(ok(SCHEDULE))
      .defer('listCollectionEvents');
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    harness.controller.changeSelection();
    await harness.flush();
    const published: string[] = [];
    harness.controller.subscribe(() => published.push(harness.view().kind));

    harness.gateway.release();
    await harness.flush();

    expect(published).not.toContain('live');
    expect(harness.view().kind).toBe('needs_selection');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
  });

  it('supersedes a candidate at the publication gate even when the clamped bounds are identical', async () => {
    const validity = { from: '2026-09-01', to: '2026-09-10' };
    const shortArea = areas(
      area({
        collectionEvents: { availability: 'available', timeZone: 'Europe/Berlin', validity },
      }),
    );
    const shortEvents = events([], {
      validFrom: validity.from,
      validTo: validity.to,
      range: validity,
    });
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(shortArea))
      .queueEvents(ok(shortEvents))
      .defer('listCollectionEvents');
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    harness.clock.set('2026-08-03T10:30:00Z');
    harness.gateway.release();
    await harness.flush();
    const view = harness.view();

    // Both days clamp to the same window, so only the derived date can tell the gate they differ.
    expect(harness.gateway.eventsCalls.map((call) => call.range)).toEqual([validity, validity]);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(2);
    expect(view.kind === 'empty' && view.schedule.sourceToday).toBe('2026-08-03');
  });
});

describe('local date failures inside a recovery cycle', () => {
  const UNCOVERED_AREAS = areas(
    area({
      collectionEvents: {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: '2020-01-01', to: '2020-12-31' },
      },
    }),
  );

  const enterUncovered = async (harness: Harness): Promise<void> => {
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(UNCOVERED_AREAS))
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    expect(harness.view().kind).toBe('range_not_covered');
  };

  it('records a preflight derivation failure as the cycle diagnostic and requests no events', async () => {
    const harness = createHarness();
    await enterUncovered(harness);
    harness.gateway.replaceAreas(ok(AREAS));
    harness.clock.set('invalid');

    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();
    const view = harness.view();

    expect(view.kind).toBe('range_not_covered');
    expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.phase).toBe(
      'range_recovery',
    );
    expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.failure).toEqual({
      kind: 'source_date_unavailable',
      timeZone: 'Europe/Berlin',
    });
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: true });
  });

  it('keeps a gate derivation failure in the recovery phase and publishes no schedule', async () => {
    const harness = createHarness();
    await enterUncovered(harness);
    harness.gateway
      .replaceAreas(ok(AREAS))
      .replaceEvents(ok(SCHEDULE))
      .defer('listCollectionEvents');

    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);

    harness.clock.set('invalid');
    harness.gateway.release();
    await harness.flush();
    const view = harness.view();

    expect(view.kind).toBe('range_not_covered');
    expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.phase).toBe(
      'range_recovery',
    );
    expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.failure).toEqual({
      kind: 'source_date_unavailable',
      timeZone: 'Europe/Berlin',
    });
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: true });
  });
});

/**
 * Supersession with two providers and two areas each.
 *
 * The live catalogue offers one of each, so switching exists only here. Every late reply in this block
 * is delivered as a real success through `ignoreAbort`: a gateway that turns an aborted call into
 * `cancelled` would prove its own behaviour rather than the controller's ownership checks.
 */
describe('supersession across providers and areas', () => {
  const SECOND_AREA_ID = 'koblenz-randlage';
  const TWO_PROVIDERS = providers(DEMO_PROVIDER, OFFICIAL_PROVIDER, SECOND_PROVIDER);
  const FIRST_AREAS = areas(area(), area({ id: SECOND_AREA_ID, name: 'Randlage' }));
  const SECOND_AREAS = areas(
    area({ id: 'musterstadt-mitte', name: 'Musterstadt Mitte', providerId: SECOND_PROVIDER.id }),
    area({ id: 'musterstadt-rand', name: 'Musterstadt Rand', providerId: SECOND_PROVIDER.id }),
  );

  /** Bootstraps and chooses the city, stopping on the provider step a two-provider city shows. */
  const reachProviderStep = async (harness: Harness): Promise<void> => {
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
  };

  const areaIds = (harness: Harness): string[] => {
    const view = harness.view();

    return view.kind === 'needs_selection' &&
      view.selection.step === 'area' &&
      view.selection.areas !== 'loading'
      ? view.selection.areas.map((entry) => entry.id)
      : [];
  };

  it('discards a superseded area list and aborts its request', async () => {
    const harness = createHarness();
    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      .queueProviders(ok(TWO_PROVIDERS))
      .queueAreas(ok(FIRST_AREAS), ok(SECOND_AREAS))
      .ignoreAbort('listServiceAreas')
      .defer('listServiceAreas');
    await reachProviderStep(harness);
    harness.controller.selectProvider(PROVIDER_ID);
    await harness.flush();
    harness.controller.selectProvider(SECOND_PROVIDER.id);
    await harness.flush();

    // The newer provider's areas are on screen before the older reply is delivered at all.
    expect(areaIds(harness)).toEqual(['musterstadt-mitte', 'musterstadt-rand']);

    harness.gateway.release();
    await harness.flush();

    expect(harness.gateway.signalsOf('listServiceAreas')[0]?.aborted).toBe(true);
    expect(areaIds(harness)).toEqual(['musterstadt-mitte', 'musterstadt-rand']);
    expect(harness.view().kind).toBe('needs_selection');
  });

  it('keeps the newest selection when the older reply resolves last', async () => {
    const harness = createHarness();
    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      .queueProviders(ok(TWO_PROVIDERS))
      .queueAreas(ok(FIRST_AREAS), ok(SECOND_AREAS))
      .ignoreAbort('listServiceAreas')
      .defer('listServiceAreas');
    await reachProviderStep(harness);
    harness.controller.selectProvider(PROVIDER_ID);
    await harness.flush();
    harness.gateway.defer('listServiceAreas');
    harness.controller.selectProvider(SECOND_PROVIDER.id);
    await harness.flush();

    // Newer first, then older: ordering, not arrival, decides.
    harness.gateway.releaseNewest();
    await harness.flush();

    expect(areaIds(harness)).toEqual(['musterstadt-mitte', 'musterstadt-rand']);

    harness.gateway.releaseOldest();
    await harness.flush();

    expect(areaIds(harness)).toEqual(['musterstadt-mitte', 'musterstadt-rand']);
  });

  it('renders the last of three rapid area confirmations and no intermediate reply', async () => {
    const harness = createHarness();
    const scheduleFor = (id: string) =>
      ok(events([curbside({ id: `paper-${id}`, serviceAreaId: id })]));

    harness.gateway
      .queueProviders(ok(TWO_PROVIDERS))
      .queueAreas(ok(FIRST_AREAS))
      .queueEvents(scheduleFor(AREA_ID), scheduleFor(SECOND_AREA_ID), scheduleFor(AREA_ID))
      .ignoreAbort('listCollectionEvents');
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    const published: string[] = [];

    harness.controller.subscribe(() => {
      const view = harness.view();

      if (view.kind === 'live') {
        published.push(view.schedule.selection.serviceAreaId);
      }
    });

    for (const id of [AREA_ID, SECOND_AREA_ID, AREA_ID]) {
      harness.gateway.defer('listCollectionEvents');
      harness.controller.selectArea(id);
      harness.controller.confirm();
      await harness.flush();
      harness.controller.changeSelection();
      await harness.flush();
    }

    // Every held events reply is delivered as a success only now, oldest first.
    harness.gateway.release();
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    expect(published).toEqual([AREA_ID]);
    expect(harness.view().kind).toBe('live');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: true, coordinator: false });
  });

  it('leaves the successor untouched: no error, no diagnostic, no extra request, one owner', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(TWO_PROVIDERS))
      .queueAreas(ok(FIRST_AREAS))
      .queueEvents(ok(SCHEDULE))
      .ignoreAbort('listCollectionEvents')
      .defer('listCollectionEvents');
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    // Supersede the in-flight attempt with a second confirmation of the same pair.
    harness.controller.changeSelection();
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    const callsBefore = harness.gateway.calls.length;
    const successor = harness.view();

    harness.gateway.release();
    await harness.flush();
    const after = harness.view();

    expect(harness.gateway.signalsOf('listCollectionEvents')[0]?.aborted).toBe(true);
    expect(after.kind).toBe(successor.kind);
    expect(after.kind).not.toBe('error');
    expect(harness.gateway.calls.length).toBe(callsBefore);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: true, coordinator: false });
    expect(harness.snapshot().announcement.identity).toBe('live:fresh');
  });
});

/**
 * The same four transport failures, reported in every phase that can carry them.
 *
 * Parameterized rather than sampled: the phase decides what Retry re-reads, and the diagnostic keeps
 * the real transport operation in every one of them. `cancelled` is excluded by the renderable type
 * and `source_date_unavailable` is web-owned, so both are asserted separately below.
 */
describe('the phase and failure matrix', () => {
  type Operation = 'listProviders' | 'listServiceAreas' | 'listCollectionEvents';

  const failures = (operation: Operation) =>
    [
      { kind: 'network', operation },
      { kind: 'timeout', operation, timeoutMs: 8000 },
      { kind: 'invalid_response', operation, status: 502 },
      {
        kind: 'problem',
        operation,
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        requestId: 'req-1',
      },
    ] as const;

  const UNCOVERED = areas(
    area({
      collectionEvents: {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: '2020-01-01', to: '2020-12-31' },
      },
    }),
  );

  for (const failure of failures('listProviders')) {
    it(`keeps the real operation and the selection phase for ${failure.kind} on listProviders`, async () => {
      const harness = createHarness();
      harness.gateway
        .queueProviders(fail(failure), fail(failure), ok(CATALOGUE))
        .queueAreas(ok(AREAS));
      harness.controller.start();
      await harness.flush();
      harness.controller.selectCity(CITY_ID);
      await harness.flush();
      const view = harness.view();

      expect(view.kind === 'error' && view.context.phase).toBe('selection_providers');
      expect(view.kind === 'error' && view.context.failure).toEqual(failure);

      // A second unsuccessful Retry stays retryable and re-reads only the catalogue.
      harness.controller.retry();
      await harness.flush();

      expect(harness.view().kind).toBe('error');

      harness.controller.retry();
      await harness.flush();

      // Retry re-reads only the catalogue; the third, successful read opens the city's single
      // provider's area step, which is the one further read below.
      expect(harness.gateway.calls).toEqual([
        'listCities',
        'listProviders',
        'listProviders',
        'listProviders',
        'listServiceAreas',
      ]);
      expect(harness.view().kind).toBe('needs_selection');
    });
  }

  for (const failure of failures('listServiceAreas')) {
    it(`keeps the real operation and the areas phase for ${failure.kind} on listServiceAreas`, async () => {
      const harness = createHarness();
      harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(fail(failure), ok(AREAS));
      harness.controller.start();
      await harness.flush();
      harness.controller.selectCity(CITY_ID);
      await harness.flush();
      const view = harness.view();

      expect(view.kind === 'error' && view.context.phase).toBe('selection_areas');
      expect(view.kind === 'error' && view.context.failure).toEqual(failure);

      harness.controller.retry();
      await harness.flush();

      // The selection phase re-reads only its own step, never the city or provider catalogue.
      expect(harness.gateway.calls).toEqual([
        'listCities',
        'listProviders',
        'listServiceAreas',
        'listServiceAreas',
      ]);
    });
  }

  for (const operation of ['listProviders', 'listServiceAreas', 'listCollectionEvents'] as const) {
    it(`reports a pipeline failure on ${operation} in schedule_pipeline and restarts the sequence`, async () => {
      const failure = { kind: 'network', operation } as const;
      const harness = createHarness();

      harness.gateway
        .queueProviders(
          ok(CATALOGUE),
          operation === 'listProviders' ? fail(failure) : ok(CATALOGUE),
        )
        .queueAreas(ok(AREAS), operation === 'listServiceAreas' ? fail(failure) : ok(AREAS))
        .queueEvents(operation === 'listCollectionEvents' ? fail(failure) : ok(SCHEDULE));
      await reachSchedule(harness);
      const view = harness.view();

      expect(view.kind === 'error' && view.context.phase).toBe('schedule_pipeline');
      // The phase routes Retry; the operation stays the truthful transport one.
      expect(view.kind === 'error' && view.context.failure).toEqual(failure);

      harness.gateway
        .replaceProviders(ok(CATALOGUE))
        .replaceAreas(ok(AREAS))
        .replaceEvents(ok(SCHEDULE));
      harness.controller.retry();
      await harness.flush();

      expect(harness.gateway.calls.slice(-3)).toEqual([
        'listProviders',
        'listServiceAreas',
        'listCollectionEvents',
      ]);
      expect(harness.view().kind).toBe('live');
    });
  }

  for (const failure of failures('listProviders')) {
    it(`contains ${failure.kind} inside range recovery instead of replacing the state`, async () => {
      const harness = createHarness();
      harness.gateway
        .queueProviders(ok(CATALOGUE))
        .queueAreas(ok(UNCOVERED))
        .queueEvents(ok(SCHEDULE));
      await reachSchedule(harness);
      harness.gateway.replaceProviders(fail(failure));

      harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
      await harness.flush();
      const view = harness.view();

      expect(view.kind).toBe('range_not_covered');
      expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.phase).toBe(
        'range_recovery',
      );
      expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.failure).toEqual(
        failure,
      );
      // Recovery Retry stays in its own phase and starts a cycle, not a selection read.
      expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: true });

      const before = harness.gateway.countOf('listProviders');

      harness.controller.retry();
      await harness.flush();

      expect(harness.gateway.countOf('listProviders')).toBe(before + 1);
      expect(harness.view().kind).toBe('range_not_covered');
    });
  }

  it('carries no fabricated transport metadata on a local source-date failure', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    harness.clock.set('invalid');
    await reachSchedule(harness);
    const view = harness.view();
    const failure = view.kind === 'error' ? view.context.failure : undefined;

    expect(failure).toEqual({ kind: 'source_date_unavailable', timeZone: 'Europe/Berlin' });
    // Asserted on the key set, so an invented operation, status, or identifier fails.
    expect(Object.keys(failure ?? {}).toSorted()).toEqual(['kind', 'timeZone']);
    expect(view.kind === 'error' && view.context.phase).toBe('schedule_pipeline');
  });

  it('clears a stale context when the phase or the selection changes', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(fail({ kind: 'network', operation: 'listServiceAreas' }), ok(AREAS));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    expect(harness.view().kind).toBe('error');

    harness.controller.back();
    await harness.flush();

    // One step back. The city offers a single provider, so no provider screen was ever shown and the
    // user returns to the city step, with the areas diagnostic dropped rather than carried along.
    const view = harness.view();

    expect(view.kind).toBe('needs_selection');
    expect(view.kind === 'needs_selection' && view.selection.step).toBe('city');
  });
});

describe('the failure type itself', () => {
  it('keeps the web-owned local failure out of both selection phases', () => {
    const SOURCE_DATE = { kind: 'source_date_unavailable', timeZone: 'Europe/Berlin' } as const;
    const CONFIRMED = { providerId: PROVIDER_ID, serviceAreaId: AREA_ID } as const;
    const context = (value: FailureContext): FailureContext => value;

    // Proven by the type checker rather than by a runtime branch: neither selection phase accepts the
    // local derivation failure, so neither needs copy for a failure it cannot carry. An unused
    // directive is itself an error, so this fails if the constraint is ever loosened.
    // @ts-expect-error `selection_providers` carries `ApiFailure` only.
    context({ phase: 'selection_providers', failure: SOURCE_DATE });
    // @ts-expect-error `selection_areas` carries `ApiFailure` only.
    context({ phase: 'selection_areas', draftProviderId: PROVIDER_ID, failure: SOURCE_DATE });

    // The two phases that own the derivation do accept it.
    expect(
      context({
        phase: 'schedule_pipeline',
        stage: 'initial',
        confirmedSelection: CONFIRMED,
        failure: SOURCE_DATE,
      }).phase,
    ).toBe('schedule_pipeline');
    expect(
      context({ phase: 'range_recovery', confirmedSelection: CONFIRMED, failure: SOURCE_DATE })
        .phase,
    ).toBe('range_recovery');
  });
});

/**
 * Derivation failure at each of the five checkpoints, with the events-request count for each.
 *
 * The count is the point: a preflight failure must never have issued the dependent request, while a
 * publication-gate failure happens after its request already completed. "No events request" without
 * naming the checkpoint is not a record.
 */
describe('source-date derivation failure at every checkpoint', () => {
  const UNCOVERED = areas(
    area({
      collectionEvents: {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: '2020-01-01', to: '2020-12-31' },
      },
    }),
  );
  const LOCAL_FAILURE = { kind: 'source_date_unavailable', timeZone: 'Europe/Berlin' } as const;

  it('schedule-pipeline preflight: no events request was issued', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    harness.clock.set('invalid');
    await reachSchedule(harness);
    const view = harness.view();

    expect(view.kind === 'error' && view.context.failure).toEqual(LOCAL_FAILURE);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
  });

  it('initial publication gate: its events request had already completed', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(ok(SCHEDULE))
      .defer('listCollectionEvents');
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();
    harness.clock.set('invalid');
    harness.gateway.release();
    await harness.flush();
    const view = harness.view();

    expect(view.kind === 'error' && view.context.failure).toEqual(LOCAL_FAILURE);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
  });

  it('reconciled publication gate: the reconciled request had already completed', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS))
      .queueEvents(fail(rangeProblem()), ok(SCHEDULE));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.gateway.defer('listCollectionEvents');
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    // The first exact 422 is answered and the reconciled retry is armed in the same tick, so the held
    // call is the reconciliation's own events request rather than the initial one.
    harness.gateway.release();
    harness.gateway.defer('listCollectionEvents');
    await harness.flush();
    harness.clock.set('invalid');
    harness.gateway.release();
    await harness.flush();
    const view = harness.view();

    expect(view.kind === 'error' && view.context.failure).toEqual(LOCAL_FAILURE);
    expect(view.kind === 'error' && view.context.phase).toBe('schedule_pipeline');
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(2);
  });

  it('accepted-pair watchdog: no further events request follows the failed check', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);

    harness.clock.set('invalid');
    harness.timers.fire(SOURCE_DATE_WATCH_INTERVAL_MS);
    await harness.flush();
    const view = harness.view();

    expect(view.kind === 'error' && view.context.failure).toEqual(LOCAL_FAILURE);
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
  });

  it('range-recovery preflight: no events request was issued by the cycle', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(UNCOVERED))
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    harness.gateway.replaceAreas(ok(AREAS));
    harness.clock.set('invalid');
    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();
    const view = harness.view();

    expect(view.kind).toBe('range_not_covered');
    expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.failure).toEqual(
      LOCAL_FAILURE,
    );
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: true });
  });

  it('recovered publication gate: the recovered request had already completed', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(UNCOVERED))
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    harness.gateway.replaceAreas(ok(AREAS)).defer('listCollectionEvents');
    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);

    harness.clock.set('invalid');
    harness.gateway.release();
    await harness.flush();
    const view = harness.view();

    expect(view.kind).toBe('range_not_covered');
    expect(view.kind === 'range_not_covered' && view.lastRecoveryFailure?.failure).toEqual(
      LOCAL_FAILURE,
    );
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: true });
  });
});

describe('the city-first flow', () => {
  const TWO_CITY_CATALOGUE = cities(KOBLENZ_CITY, {
    id: 'trier',
    name: 'Trier',
    providers: [SECOND_PROVIDER],
  });
  const TRIER_AREAS = areas(
    area({
      id: 'trier-mitte',
      name: 'Trier Mitte',
      providerId: SECOND_PROVIDER.id,
      cityId: 'trier',
      locality: 'Trier',
    }),
  );

  it('exposes only the officially supported city', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS));
    harness.controller.start();
    await harness.flush();
    const view = harness.view();

    expect(
      view.kind === 'needs_selection' && view.selection.step === 'city' && view.selection.cities,
    ).toEqual([KOBLENZ_CITY]);
  });

  it('issues no events request until a district is confirmed', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);

    harness.controller.selectArea(AREA_ID);
    await harness.flush();

    // A chosen district is still only a draft: confirmation is what asks for events.
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);

    harness.controller.confirm();
    await harness.flush();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
  });

  it('clears the district and the schedule when the city changes', async () => {
    const harness = createHarness();
    harness.gateway
      .queueCities(ok(TWO_CITY_CATALOGUE))
      .queueProviders(ok(CATALOGUE))
      // Selection, the confirmation pipeline, and the reopen each read Koblenz once; Trier comes fourth.
      // Were the reopen to read areas twice, Trier would receive Koblenz's answer and this test fails.
      .queueAreas(ok(AREAS), ok(AREAS), ok(AREAS), ok(TRIER_AREAS))
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    expect(harness.view().kind).toBe('live');

    harness.controller.changeSelection();
    await harness.flush();
    harness.gateway.replaceProviders(ok(providers(SECOND_PROVIDER)));
    harness.controller.selectCity('trier');
    await harness.flush();
    const view = harness.view();

    // Nothing of the previous city survives: no district draft, no schedule, no lifecycle owner.
    expect(view.kind === 'needs_selection' && view.draftCityId).toBe('trier');
    expect(
      view.kind === 'needs_selection' &&
        view.selection.step === 'area' &&
        view.selection.draftAreaId,
    ).toBeNull();
    // Only Trier's own district is offered.
    expect(
      view.kind === 'needs_selection' &&
        view.selection.step === 'area' &&
        view.selection.areas !== 'loading' &&
        view.selection.areas.map((entry) => entry.id),
    ).toEqual(['trier-mitte']);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
  });

  it('discards a superseded city’s area reply and aborts its request', async () => {
    const harness = createHarness();
    harness.gateway
      .queueCities(ok(TWO_CITY_CATALOGUE))
      .queueProviders(ok(CATALOGUE), ok(providers(SECOND_PROVIDER)))
      .queueAreas(ok(AREAS), ok(TRIER_AREAS))
      .ignoreAbort('listServiceAreas')
      .defer('listServiceAreas');
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectCity('trier');
    await harness.flush();
    harness.gateway.release();
    await harness.flush();
    const view = harness.view();

    expect(harness.gateway.signalsOf('listServiceAreas')[0]?.aborted).toBe(true);
    expect(view.kind === 'needs_selection' && view.draftCityId).toBe('trier');
    expect(
      view.kind === 'needs_selection' &&
        view.selection.step === 'area' &&
        view.selection.areas !== 'loading' &&
        view.selection.areas.map((entry) => entry.id),
    ).toEqual(['trier-mitte']);
  });

  it('renders the last of three rapid city changes', async () => {
    const harness = createHarness();
    // All three are served by the same official provider, so only the city choice varies.
    harness.gateway
      .queueCities(
        ok(
          cities(
            KOBLENZ_CITY,
            { id: 'trier', name: 'Trier', providers: [OFFICIAL_PROVIDER] },
            { id: 'mainz', name: 'Mainz', providers: [OFFICIAL_PROVIDER] },
          ),
        ),
      )
      .queueProviders(ok(CATALOGUE))
      .queueAreas(
        ok(
          areas(
            area(),
            area({ id: 'trier-mitte', cityId: 'trier', locality: 'Trier', name: 'Trier Mitte' }),
            area({ id: 'mainz-altstadt', cityId: 'mainz', locality: 'Mainz', name: 'Altstadt' }),
          ),
        ),
      )
      .ignoreAbort('listServiceAreas');
    harness.controller.start();
    await harness.flush();
    harness.gateway.defer('listServiceAreas');
    harness.controller.selectCity(CITY_ID);
    harness.controller.selectCity('trier');
    harness.controller.selectCity('mainz');
    await harness.flush();
    harness.gateway.release();
    await harness.flush();

    const view = harness.view();

    expect(view.kind).toBe('needs_selection');
    expect(view.kind === 'needs_selection' && view.draftCityId).toBe('mainz');
    // And the last city's own district only, from a provider response covering all three.
    expect(
      view.kind === 'needs_selection' &&
        view.selection.step === 'area' &&
        view.selection.areas !== 'loading' &&
        view.selection.areas.map((entry) => entry.id),
    ).toEqual(['mainz-altstadt']);
  });
});

// ---------------------------------------------------------------------------------------------------
// Review findings R1, R2, R5, R9 (2026-09-17)
// ---------------------------------------------------------------------------------------------------

/** The choices a person can actually make on the current step — never `'loading'`. */
const offeredChoices = (harness: Harness): { step: string; ids: string[] } => {
  const view = harness.view();

  if (view.kind !== 'needs_selection') {
    return { step: view.kind, ids: [] };
  }

  const { selection } = view;
  const list =
    selection.step === 'city'
      ? selection.cities
      : selection.step === 'provider'
        ? selection.catalogue
        : selection.areas;

  if (list === 'loading') {
    throw new Error(`the ${selection.step} step is still loading`);
  }

  return { step: selection.step, ids: list.map((entry) => entry.id) };
};

describe('R1 — an authoritative invalidation ends in a usable selection', () => {
  const OTHER_AREA = area({ id: 'koblenz-neuendorf', name: 'Neuendorf' });

  it('offers the city’s remaining provider when the confirmed one disappears before the schedule loads', async () => {
    const harness = createHarness();
    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      // Selection sees both providers; the confirmation pipeline sees only the second.
      .queueProviders(
        ok(providers(OFFICIAL_PROVIDER, SECOND_PROVIDER)),
        ok(providers(SECOND_PROVIDER)),
      )
      .queueAreas(ok(AREAS));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectProvider(PROVIDER_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    expect(offeredChoices(harness)).toEqual({ step: 'provider', ids: [SECOND_PROVIDER.id] });
    expect(harness.view().kind === 'needs_selection' && harness.view()).toMatchObject({
      draftCityId: CITY_ID,
      draftProviderId: null,
    });
    // Explicit choice: nothing is selected for the user, and focus is on the mounted provider step.
    expect(harness.snapshot().focus?.target).toBe('provider-step');
    expect(harness.gateway.pendingCount).toBe(0);
    expect(harness.gateway.countOf('listCities')).toBe(1);
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
  });

  it('offers the provider’s remaining districts when the confirmed district disappears', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(AREAS), ok(areas(OTHER_AREA)))
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    expect(offeredChoices(harness)).toEqual({ step: 'area', ids: ['koblenz-neuendorf'] });
    expect(harness.snapshot().focus?.target).toBe('area-step');
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
    expect(harness.gateway.pendingCount).toBe(0);
  });

  it('offers the other districts with a notice when the confirmed one becomes unavailable during recovery', async () => {
    const harness = createHarness();
    const expired = area({
      collectionEvents: {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: '2020-01-01', to: '2020-12-31' },
      },
    });
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(areas(expired)))
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    expect(harness.view().kind).toBe('range_not_covered');

    harness.gateway.replaceAreas(
      ok(areas(area({ collectionEvents: { availability: 'unavailable' } }), OTHER_AREA)),
    );
    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();

    expect(offeredChoices(harness)).toEqual({
      step: 'area',
      ids: [AREA_ID, 'koblenz-neuendorf'],
    });
    expect(harness.view().kind === 'needs_selection' && harness.view()).toMatchObject({
      notice: 'area_unavailable',
    });
    expect(harness.snapshot().focus?.target).toBe('area-step');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
    expect(harness.gateway.pendingCount).toBe(0);
  });

  it('offers the city’s remaining provider when the confirmed one disappears during range recovery', async () => {
    const harness = createHarness();
    const expired = area({
      collectionEvents: {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: '2020-01-01', to: '2020-12-31' },
      },
    });
    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      .queueProviders(ok(providers(OFFICIAL_PROVIDER, SECOND_PROVIDER)))
      .queueAreas(ok(areas(expired)));
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectProvider(PROVIDER_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    expect(harness.view().kind).toBe('range_not_covered');

    harness.gateway.replaceProviders(ok(providers(SECOND_PROVIDER)));
    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();

    expect(offeredChoices(harness)).toEqual({ step: 'provider', ids: [SECOND_PROVIDER.id] });
    expect(harness.snapshot().focus?.target).toBe('provider-step');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: false, coordinator: false });
  });
});

describe('R2 — the reopen-selection operation has one owner', () => {
  it('keeps a newer draft when an older reopen’s area read settles late', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(areas(area(), area({ id: 'new-area', name: 'New area' }))))
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    // Hold the reopen's area read, and deliver its answer even after it is aborted.
    harness.gateway.defer('listServiceAreas').ignoreAbort('listServiceAreas');
    harness.controller.changeSelection();
    await harness.flush();

    expect(harness.gateway.pendingCount).toBe(1);

    harness.controller.back();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea('new-area');

    const areasBefore = harness.gateway.countOf('listServiceAreas');

    harness.gateway.release();
    await harness.flush();
    await harness.flush();

    // The newer choice survives, and the superseded reopen issued nothing further.
    expect(harness.snapshot().state).toMatchObject({
      mode: 'selecting',
      draft: { cityId: CITY_ID, providerId: PROVIDER_ID, serviceAreaId: 'new-area' },
    });
    expect(harness.gateway.countOf('listServiceAreas')).toBe(areasBefore);
    expect(harness.gateway.pendingCount).toBe(0);
  });

  it('reads the areas once when reopening a single-provider city, restoring the confirmed district', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    const before = harness.gateway.calls.length;

    harness.controller.changeSelection();
    await harness.flush();
    await harness.flush();

    expect(harness.gateway.calls.slice(before)).toEqual([
      'listCities',
      'listProviders',
      'listServiceAreas',
    ]);
    expect(harness.snapshot().state).toMatchObject({
      mode: 'selecting',
      draft: { cityId: CITY_ID, providerId: PROVIDER_ID, serviceAreaId: AREA_ID },
    });
    expect(offeredChoices(harness)).toEqual({ step: 'area', ids: [AREA_ID] });
  });

  it('ends a reopen at an explicit provider choice when the provider is reported missing', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);
    harness.gateway.replaceAreas(
      fail({
        kind: 'problem',
        operation: 'listServiceAreas',
        status: 404,
        code: 'PROVIDER_NOT_FOUND',
        requestId: 'req-missing',
      }),
    );
    const before = harness.gateway.calls.length;

    harness.controller.changeSelection();
    for (let turn = 0; turn < 4; turn += 1) {
      await harness.flush();
    }

    // One area read, then the recovery's provider refresh — and no automatic retry of that provider.
    expect(harness.gateway.calls.slice(before)).toEqual([
      'listCities',
      'listProviders',
      'listServiceAreas',
      'listProviders',
    ]);
    expect(offeredChoices(harness)).toEqual({ step: 'provider', ids: [PROVIDER_ID] });
    expect(harness.view().kind === 'needs_selection' && harness.view()).toMatchObject({
      notice: 'provider_invalidated',
      draftProviderId: null,
    });
  });

  it('issues nothing after its held city read once stopping supersedes it', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(AREAS)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    harness.gateway.defer('listCities');
    harness.controller.changeSelection();
    await harness.flush();
    // Stopping ends the run while the city read is still held.
    harness.controller.stop();
    const before = harness.gateway.calls.length;

    harness.gateway.release();
    await harness.flush();
    await harness.flush();

    expect(harness.gateway.calls.length).toBe(before);
  });
});

describe('R5 — districts are scoped to the chosen city', () => {
  const ELSEWHERE = area({
    id: 'elsewhere',
    cityId: 'another-city',
    locality: 'Another city',
    name: 'Other district',
  });
  const SHARED = areas(area(), ELSEWHERE);

  it('offers only the chosen city’s districts from a provider serving two cities', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(SHARED));
    await reachAreaStep(harness);

    expect(offeredChoices(harness)).toEqual({ step: 'area', ids: [AREA_ID] });
  });

  it('refuses to draft or confirm a district of another city', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(SHARED)).queueEvents(ok(SCHEDULE));
    await reachAreaStep(harness);

    harness.controller.selectArea('elsewhere');
    harness.controller.confirmArea('elsewhere');
    harness.controller.confirm();
    await harness.flush();

    expect(harness.snapshot().state).toMatchObject({
      mode: 'selecting',
      draft: { cityId: CITY_ID, serviceAreaId: null },
    });
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });

  it('never lets confirmation change the city: the schedule stays in the chosen city', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(SHARED)).queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    expect(harness.snapshot().state).toMatchObject({ mode: 'schedule', cityId: CITY_ID });
  });

  it('treats a confirmed district that moved to another city as removed at revalidation', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      // The pipeline's fresh read reports the same district id under another city.
      .queueAreas(
        ok(AREAS),
        ok(
          areas(
            area({ cityId: 'another-city', locality: 'Another city' }),
            area({ id: 'koblenz-neuendorf', name: 'Neuendorf' }),
          ),
        ),
      )
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
    expect(offeredChoices(harness)).toEqual({ step: 'area', ids: ['koblenz-neuendorf'] });
    const view = harness.view();

    expect(view.kind === 'needs_selection' && view.draftCityId).toBe(CITY_ID);
  });

  it('checks identifier uniqueness across the whole response before narrowing it to the city', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      // A duplicate hidden behind the other city must still be caught.
      .queueAreas(ok(areas(area(), area({ cityId: 'another-city', locality: 'Another city' }))));
    await reachAreaStep(harness);
    const view = harness.view();

    expect(view.kind).toBe('error');
    expect(view.kind === 'error' && view.context.phase).toBe('selection_areas');
  });

  it('restores a confirmed district on reopen only while it is still in the confirmed city', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(
        ok(AREAS),
        ok(AREAS),
        ok(
          areas(
            area({ cityId: 'another-city', locality: 'Another city' }),
            area({ id: 'koblenz-neuendorf', name: 'Neuendorf' }),
          ),
        ),
      )
      .queueEvents(ok(SCHEDULE));
    await reachSchedule(harness);

    harness.controller.changeSelection();
    await harness.flush();
    await harness.flush();

    expect(offeredChoices(harness)).toEqual({ step: 'area', ids: ['koblenz-neuendorf'] });
    expect(harness.snapshot().state).toMatchObject({
      mode: 'selecting',
      draft: { cityId: CITY_ID, serviceAreaId: null },
    });
  });
});

describe('R9 — a user-initiated city Retry gives focus a mounted destination', () => {
  const CITIES_DOWN = { kind: 'network', operation: 'listCities' } as const;

  it('takes no focus on the first bootstrap, even when it fails', async () => {
    const harness = createHarness();
    harness.gateway.queueCities(fail(CITIES_DOWN));
    harness.controller.start();
    await harness.flush();

    expect(harness.view().kind).toBe('error');
    expect(harness.snapshot().focus).toBeNull();
  });

  it('moves focus to the city step when a Retry succeeds, and to the state heading when it fails', async () => {
    const harness = createHarness();
    harness.gateway.queueCities(fail(CITIES_DOWN), fail(CITIES_DOWN), ok(cities(KOBLENZ_CITY)));
    harness.controller.start();
    await harness.flush();

    harness.controller.retry();
    await harness.flush();

    expect(harness.view().kind).toBe('error');
    expect(harness.snapshot().focus?.target).toBe('state-heading');

    harness.controller.retry();
    await harness.flush();

    expect(offeredChoices(harness)).toEqual({ step: 'city', ids: [CITY_ID] });
    expect(harness.snapshot().focus?.target).toBe('city-step');
  });

  it('never moves focus from a stale Retry after a newer run superseded it', async () => {
    const harness = createHarness();
    harness.gateway.queueCities(fail(CITIES_DOWN), ok(cities(KOBLENZ_CITY)));
    harness.controller.start();
    await harness.flush();

    harness.gateway.defer('listCities');
    harness.controller.retry();
    await harness.flush();
    // A newer run supersedes the held Retry and completes on its own.
    harness.controller.stop();
    harness.controller.start();
    await harness.flush();
    const seq = harness.snapshot().focus?.seq;

    harness.gateway.release();
    await harness.flush();

    expect(harness.snapshot().focus?.seq).toBe(seq);
  });
});
