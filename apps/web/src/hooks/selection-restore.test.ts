import { describe, expect, it } from 'vitest';
import type {
  ConfirmedSelectionStore,
  StoredConfirmedSelection,
} from '@/src/adapters/confirmed-selection-store';
import { CONFIRMED_SELECTION_VERSION } from '@/src/adapters/confirmed-selection-store';
import { SOURCE_DATE_WATCH_INTERVAL_MS } from '@/src/schedule/source-date-watchdog';
import {
  AREA_ID,
  area,
  areas,
  CATALOGUE_SINGLE,
  CITY_ID,
  cities,
  curbside,
  events,
  KOBLENZ_CITY,
  OFFICIAL_PROVIDER,
  PROVIDER_ID,
  providers,
  SECOND_PROVIDER,
  SECOND_PROVIDER_ID,
  TWO_PROVIDER_CITY,
} from '@/src/test/fixtures';
import { createHarness, type Harness, ok } from '@/src/test/harness';

/**
 * Restoring a confirmed selection on a fresh run — what a browser reload is to the controller.
 *
 * A remembered selection is a claim about the catalogue, never a substitute for reading it: every case
 * below asserts what was asked of the API as well as what ended up on screen. The record is only ever
 * written for a schedule that was accepted, and only ever forgotten when a successful read contradicted
 * it — a failed read leaves it alone, because a catalogue that could not be read says nothing about
 * whether the district still exists.
 */

const SECOND_AREA_ID = 'koblenz-neuendorf';

/** A store over a plain object, so a test can state what the last visit left behind. */
const storeWith = (
  initial: StoredConfirmedSelection | null,
): ConfirmedSelectionStore & {
  current: StoredConfirmedSelection | null;
  readonly writes: number;
} => {
  let current = initial;
  let writes = 0;

  return {
    read: () => current,
    write: (selection) => {
      writes += 1;
      current = { version: CONFIRMED_SELECTION_VERSION, ...selection };
    },
    clear: () => {
      current = null;
    },
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
    get writes() {
      return writes;
    },
  };
};

const remembered = (serviceAreaId = AREA_ID, providerId = PROVIDER_ID) => ({
  version: CONFIRMED_SELECTION_VERSION,
  cityId: CITY_ID,
  providerId,
  serviceAreaId,
});

const neuendorf = (overrides: Record<string, unknown> = {}) =>
  area({ id: SECOND_AREA_ID, name: 'Neuendorf', ...overrides });

/** Cities, providers, districts and one collection: what a complete restore has to read. */
const scriptFullCatalogue = (harness: Harness): void => {
  harness.gateway
    .queueCities(ok(cities(KOBLENZ_CITY)))
    .queueProviders(ok(CATALOGUE_SINGLE))
    .queueAreas(ok(areas(area(), neuendorf())))
    .queueEvents(ok(events([curbside()])));
};

const operations = (harness: Harness): string[] => harness.gateway.calls;

/** The selection step on screen, or the view kind when the user is not on the selection surface. */
const step = (harness: Harness): string => {
  const view = harness.view();

  return view.kind === 'needs_selection' ? view.selection.step : view.kind;
};

describe('a remembered selection on a fresh run', () => {
  it('revalidates it, restores the schedule, and reads each step exactly once', async () => {
    const store = storeWith(remembered(SECOND_AREA_ID));
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    harness.controller.start();
    await harness.flush();

    const view = harness.view();

    expect(view.kind).toBe('live');
    expect(view.kind === 'live' && view.schedule.selection.serviceAreaId).toBe(SECOND_AREA_ID);
    /*
     * The same reads a person's own flow makes, in the same order and the same number: the three
     * selection reads, then the confirmation pipeline's own revalidation of provider and districts
     * before the events request. Nothing is read twice for having been restored rather than chosen.
     */
    const manual = createHarness();

    scriptFullCatalogue(manual);
    manual.controller.start();
    await manual.flush();
    manual.controller.selectCity(CITY_ID);
    await manual.flush();
    manual.controller.selectArea(SECOND_AREA_ID);
    manual.controller.confirm();
    await manual.flush();

    expect(manual.view().kind).toBe('live');
    expect(operations(harness)).toEqual(operations(manual));
    expect(operations(harness).filter((call) => call === 'listCities')).toHaveLength(1);
    expect(operations(harness).filter((call) => call === 'listCollectionEvents')).toHaveLength(1);
    // Still remembered, and not rewritten into a second record.
    expect(store.current).toEqual(remembered(SECOND_AREA_ID));
  });

  it('shows the city step when nothing was remembered, and asks for nothing else', async () => {
    const store = storeWith(null);
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    harness.controller.start();
    await harness.flush();

    expect(step(harness)).toBe('city');
    expect(operations(harness)).toEqual(['listCities']);
    expect(store.current).toBeNull();
  });

  it('does not take focus, because the page has only just loaded', async () => {
    const store = storeWith(remembered());
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    harness.controller.start();
    await harness.flush();

    expect(harness.view().kind).toBe('live');
    // A restored schedule is where the browser left the page, not somewhere focus was moved to.
    expect(harness.snapshot().focus).toBeNull();
  });
});

describe('what a remembered selection may not survive', () => {
  it('forgets a city the catalogue no longer lists, and stops at the city step', async () => {
    const store = storeWith({ ...remembered(), cityId: 'trier' });
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    harness.controller.start();
    await harness.flush();

    expect(step(harness)).toBe('city');
    expect(operations(harness)).toEqual(['listCities']);
    expect(store.current).toBeNull();
  });

  it('forgets a provider the catalogue no longer offers, and stops at the provider choice', async () => {
    const store = storeWith(remembered(AREA_ID, 'koblenz-gone'));
    const harness = createHarness({ selectionStore: store });

    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      // Two providers remain, neither of them the remembered one.
      .queueProviders(ok(providers(OFFICIAL_PROVIDER, SECOND_PROVIDER)))
      .queueAreas(ok(areas(area())));
    harness.controller.start();
    await harness.flush();

    // Left on a choice, not on a spinner, and no other provider was substituted for the missing one.
    expect(step(harness)).toBe('provider');
    expect(harness.view().kind === 'needs_selection' && harness.view()).toMatchObject({
      draftProviderId: null,
    });
    expect(store.current).toBeNull();
    expect(operations(harness)).toEqual(['listCities', 'listProviders']);
  });

  it('stops at the districts of the one provider that is left, without confirming one', async () => {
    const store = storeWith(remembered(AREA_ID, SECOND_PROVIDER_ID));
    const harness = createHarness({ selectionStore: store });

    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      // Only the other provider survives; the accepted rule selects a lone provider for the user.
      .queueProviders(ok(CATALOGUE_SINGLE))
      .queueAreas(ok(areas(area())));
    harness.controller.start();
    await harness.flush();

    // Its districts are offered, and none of them is confirmed in the missing provider's place.
    expect(step(harness)).toBe('area');
    expect(harness.view().kind).not.toBe('live');
    expect(store.current).toBeNull();
  });

  it('forgets a district that disappeared, and offers the provider’s remaining districts', async () => {
    const store = storeWith(remembered('koblenz-arzheim'));
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    harness.controller.start();
    await harness.flush();

    const view = harness.view();
    const offered =
      view.kind === 'needs_selection' && view.selection.step === 'area'
        ? view.selection
        : undefined;

    expect(step(harness)).toBe('area');
    // The districts that do exist are offered; none of them is chosen for the user.
    expect(offered?.areas === 'loading' ? [] : offered?.areas.map((entry) => entry.id)).toEqual([
      AREA_ID,
      SECOND_AREA_ID,
    ]);
    expect(offered?.draftAreaId).toBeNull();
    expect(store.current).toBeNull();
    expect(operations(harness)).toEqual(['listCities', 'listProviders', 'listServiceAreas']);
  });

  it('forgets a district that is no longer available, rather than confirming it', async () => {
    const store = storeWith(remembered(SECOND_AREA_ID));
    const harness = createHarness({ selectionStore: store });

    harness.gateway
      .queueCities(ok(cities(KOBLENZ_CITY)))
      .queueProviders(ok(CATALOGUE_SINGLE))
      .queueAreas(
        ok(areas(area(), neuendorf({ collectionEvents: { availability: 'unavailable' } }))),
      );
    harness.controller.start();
    await harness.flush();

    expect(step(harness)).toBe('area');
    expect(store.current).toBeNull();
    expect(operations(harness)).toEqual(['listCities', 'listProviders', 'listServiceAreas']);
  });

  it('keeps the record when the catalogue could not be read at all', async () => {
    const store = storeWith(remembered());
    const harness = createHarness({ selectionStore: store });

    harness.gateway.queueCities({
      ok: false,
      failure: { kind: 'network', operation: 'listCities' },
    });
    harness.controller.start();
    await harness.flush();

    // A failed read is not evidence that the selection is gone, so it survives for the next attempt.
    expect(harness.view().kind).toBe('error');
    expect(store.current).toEqual(remembered());
  });
});

describe('Retry after a startup that could not reach the API', () => {
  const unreachable = {
    ok: false as const,
    failure: { kind: 'network' as const, operation: 'listCities' as const },
  };

  it('resumes the remembered selection and restores the schedule', async () => {
    const store = storeWith(remembered(SECOND_AREA_ID));
    const harness = createHarness({ selectionStore: store });

    harness.gateway.queueCities(unreachable);
    harness.controller.start();
    await harness.flush();

    // The failure surface, with the record untouched: a read that never arrived contradicts nothing.
    expect(harness.view().kind).toBe('error');
    expect(store.current).toEqual(remembered(SECOND_AREA_ID));

    // The API comes back, and the person presses Retry.
    harness.gateway
      .replaceCities(ok(cities(KOBLENZ_CITY)))
      .queueProviders(ok(CATALOGUE_SINGLE))
      .queueAreas(ok(areas(area(), neuendorf())))
      .queueEvents(ok(events([curbside()])));
    harness.controller.retry();
    await harness.flush();

    const view = harness.view();

    expect(view.kind).toBe('live');
    expect(view.kind === 'live' && view.schedule.selection.serviceAreaId).toBe(SECOND_AREA_ID);
    expect(store.current).toEqual(remembered(SECOND_AREA_ID));
  });

  it('resumes through one pipeline, with each read made once', async () => {
    const store = storeWith(remembered(SECOND_AREA_ID));
    const harness = createHarness({ selectionStore: store });

    harness.gateway.queueCities(unreachable);
    harness.controller.start();
    await harness.flush();

    harness.gateway
      .replaceCities(ok(cities(KOBLENZ_CITY)))
      .queueProviders(ok(CATALOGUE_SINGLE))
      .queueAreas(ok(areas(area(), neuendorf())))
      .queueEvents(ok(events([curbside()])));
    harness.controller.retry();
    await harness.flush();

    const afterRetry = operations(harness).slice(1);

    // The failed read, then exactly the sequence a confirmation makes — no second attempt alongside it.
    expect(operations(harness)[0]).toBe('listCities');
    expect(afterRetry.filter((call) => call === 'listCities')).toHaveLength(1);
    expect(afterRetry.filter((call) => call === 'listCollectionEvents')).toHaveLength(1);

    const manual = createHarness();

    scriptFullCatalogue(manual);
    manual.controller.start();
    await manual.flush();
    manual.controller.selectCity(CITY_ID);
    await manual.flush();
    manual.controller.selectArea(SECOND_AREA_ID);
    manual.controller.confirm();
    await manual.flush();

    expect(afterRetry).toEqual(operations(manual));
  });

  it('ends at the district step when the catalogue no longer has the remembered district', async () => {
    const store = storeWith(remembered('koblenz-arzheim'));
    const harness = createHarness({ selectionStore: store });

    harness.gateway.queueCities(unreachable);
    harness.controller.start();
    await harness.flush();

    expect(store.current).toEqual(remembered('koblenz-arzheim'));

    harness.gateway
      .replaceCities(ok(cities(KOBLENZ_CITY)))
      .queueProviders(ok(CATALOGUE_SINGLE))
      .queueAreas(ok(areas(area(), neuendorf())));
    harness.controller.retry();
    await harness.flush();

    // The usable choice, nothing confirmed in its place, and only now is the record forgotten.
    expect(step(harness)).toBe('area');
    expect(harness.view().kind).not.toBe('live');
    expect(store.current).toBeNull();
  });

  it('keeps the ordinary city step when nothing was remembered', async () => {
    const store = storeWith(null);
    const harness = createHarness({ selectionStore: store });

    harness.gateway.queueCities(unreachable);
    harness.controller.start();
    await harness.flush();

    expect(harness.view().kind).toBe('error');

    harness.gateway.replaceCities(ok(cities(KOBLENZ_CITY))).queueProviders(ok(CATALOGUE_SINGLE));
    harness.controller.retry();
    await harness.flush();

    expect(step(harness)).toBe('city');
    expect(store.current).toBeNull();
  });

  it('does not resume a restore the person has already moved past', async () => {
    const store = storeWith(remembered(SECOND_AREA_ID));
    const harness = createHarness({ selectionStore: store });

    harness.gateway.queueCities(unreachable);
    harness.controller.start();
    await harness.flush();

    // A city read that succeeds on its own, then the person chooses for themselves.
    harness.gateway
      .replaceCities(ok(cities(KOBLENZ_CITY)))
      .queueProviders({ ok: false, failure: { kind: 'network', operation: 'listProviders' } });
    harness.controller.retry();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    harness.gateway
      .replaceProviders(ok(CATALOGUE_SINGLE))
      .queueAreas(ok(areas(area(), neuendorf())));
    harness.controller.retry();
    await harness.flush();

    // Their own city choice stands; nothing was confirmed on their behalf.
    expect(step(harness)).toBe('area');
    expect(harness.view().kind).not.toBe('live');
  });
});

describe('when the record is written', () => {
  const reachSchedule = async (harness: Harness): Promise<void> => {
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    await harness.flush();
  };

  it('remembers nothing until the confirmed schedule is accepted', async () => {
    const store = storeWith(null);
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    await reachSchedule(harness);

    // A draft is an intention, not a selection.
    expect(step(harness)).toBe('area');
    expect(store.current).toBeNull();

    harness.controller.confirm();
    await harness.flush();

    expect(harness.view().kind).toBe('live');
    expect(store.current).toEqual(remembered(AREA_ID));
    expect(store.writes).toBe(1);
  });

  it('leaves the previous record intact when a new schedule fails', async () => {
    const store = storeWith(remembered(SECOND_AREA_ID));
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    harness.controller.start();
    await harness.flush();

    expect(harness.view().kind).toBe('live');

    // Reopen, draft the other district, and let its schedule fail.
    harness.gateway.replaceEvents({
      ok: false,
      failure: { kind: 'network', operation: 'listCollectionEvents' },
    });
    harness.controller.changeSelection();
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    expect(harness.view().kind).toBe('error');
    // The district whose schedule never arrived did not replace the one that had been accepted.
    expect(store.current).toEqual(remembered(SECOND_AREA_ID));
  });

  it('replaces the record once a different district is accepted', async () => {
    const store = storeWith(remembered(AREA_ID));
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    harness.controller.start();
    await harness.flush();

    harness.controller.changeSelection();
    await harness.flush();
    harness.controller.selectArea(SECOND_AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    expect(harness.view().kind).toBe('live');
    expect(store.current).toEqual(remembered(SECOND_AREA_ID));
  });

  it('keeps the confirmed selection restorable after a reopen that was abandoned', async () => {
    const store = storeWith(remembered(SECOND_AREA_ID));
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    harness.controller.start();
    await harness.flush();

    harness.controller.changeSelection();
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.back();
    await harness.flush();

    // Nothing was confirmed, so the last confirmed district is still what a reload would restore.
    expect(store.current).toEqual(remembered(SECOND_AREA_ID));
  });

  it('forgets a pair the schedule pipeline found to be invalid', async () => {
    const store = storeWith(remembered(SECOND_AREA_ID));
    const harness = createHarness({ selectionStore: store });

    scriptFullCatalogue(harness);
    harness.controller.start();
    await harness.flush();

    expect(harness.view().kind).toBe('live');

    // The next pipeline run — the source day turning over — finds the confirmed provider gone.
    harness.gateway.replaceProviders(ok(providers(SECOND_PROVIDER)));
    harness.clock.advanceHours(24);
    harness.timers.fire(SOURCE_DATE_WATCH_INTERVAL_MS);
    await harness.flush();

    expect(harness.view().kind).not.toBe('live');
    expect(store.current).toBeNull();
  });
});
