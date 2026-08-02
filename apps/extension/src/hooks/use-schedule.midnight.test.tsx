/**
 * The requested range moves at **source-local** midnight, and a displayed cache has to move with it.
 *
 * A restored entry records the range it was evaluated against. The live capability that arrives afterwards can
 * be byte-for-byte identical — same availability, same zone, same validity — while the range derived from it has
 * advanced by a day, because the derivation also reads today's source-local date. Comparing only the metadata
 * therefore concluded that yesterday's evaluation still stood: the popup kept yesterday's `requestedRange` and
 * its full-coverage claim, stated coverage of a period extending a day beyond anything the entry held, and went
 * on showing an event the moved window had left behind.
 *
 * The device zone is pinned to one that **disagrees** with the source across the crossing: every case below
 * happens at an instant where Berlin has already turned the page and New York has not. Each case asserts that
 * disagreement, so a runtime that ignored the source zone could not make these pass for the wrong reason.
 */
process.env.TZ = 'America/New_York';

// Marks this file as a module. Without it TypeScript treats a file whose every import is dynamic as a script,
// where top-level `await` is disallowed and top-level names collide with globals.
export {};

const { act, renderHook, waitFor } = await import('@testing-library/react');
const { describe, expect, it, vi } = await import('vitest');
const { useSchedule } = await import('./use-schedule');

type ProviderVerification = import('@/src/hooks/use-catalogue').ProviderVerification;
type MessagingClient = import('@/src/messaging/client').MessagingClient;
type MessagingResult<Data> = import('@/src/messaging/client').MessagingResult<Data>;
type CollectionEventsPayload = import('@/src/messaging/contract').CollectionEventsPayload;
type RestoredSchedulePayload = import('@/src/messaging/contract').RestoredSchedulePayload;
type ServiceAreaSummary = import('@/src/messaging/contract').ServiceAreaSummary;

const {
  AVAILABLE_AREA,
  curbsideEvent,
  OFFICIAL_AREA_ID,
  OFFICIAL_PROVIDER,
  OFFICIAL_PROVIDER_ID,
  restoredSchedule,
  settingsOperationsRefused,
  UNAVAILABLE_AREA_ID,
} = await import('@/src/test/fixtures');

const SELECTION = {
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: OFFICIAL_AREA_ID,
} as const;

const OFFERED: ProviderVerification = { kind: 'offered', provider: OFFICIAL_PROVIDER };

const PENDING_VERIFICATION: ProviderVerification = { kind: 'pending' };

/** Berlin 23:30 on the first, New York 17:30 on the first. Both are still on the first. */
const BEFORE_MIDNIGHT = new Date('2026-03-01T22:30:00.000Z');

/** Berlin 00:30 on the second, New York 18:30 on the **first**. Only the source turned the page. */
const AFTER_MIDNIGHT = new Date('2026-03-01T23:30:00.000Z');

/** What the source declares before midnight, and what the moving range makes of it afterwards. */
const YESTERDAY_RANGE = { from: '2026-03-01', to: '2026-05-30' } as const;

const TODAY_RANGE = { from: '2026-03-02', to: '2026-05-31' } as const;

/**
 * The entry as the worker restored it: served for yesterday's window, evaluated against yesterday's range, and
 * claiming to cover the whole of it.
 *
 * It holds one event on the day the moved window drops and one well inside it, so "the tail is now uncovered"
 * and "the stale event is gone" are two separate observations rather than one.
 */
const STORED = restoredSchedule({
  servedRange: { ...YESTERDAY_RANGE },
  requestedRange: { ...YESTERDAY_RANGE },
  displayRange: { ...YESTERDAY_RANGE },
  rangeCoverage: 'full',
  events: [curbsideEvent('2026-03-01'), curbsideEvent('2026-03-10')],
});

/**
 * A success envelope, deliberately not annotated with one result family.
 *
 * The schedule reads answer in the API's failure family and the cache invalidation answers in its own, so a helper
 * pinned to either would not build stubs for the other. The success branch is identical in both, which is what
 * makes one helper correct here.
 */
const ok = <Data,>(data: Data): { readonly ok: true; readonly data: Data } => ({ ok: true, data });

const offline = <Data,>(): MessagingResult<Data> => ({
  ok: false,
  failure: { kind: 'network', operation: 'listCollectionEvents' },
});

interface Deferred<Value> {
  readonly value: Promise<Value>;
  readonly settle: (value: Value) => void;
}

const deferred = <Value,>(): Deferred<Value> => {
  let settle: ((value: Value) => void) | undefined;
  const value = new Promise<Value>((resolve) => {
    settle = resolve;
  });

  return {
    value,
    settle: (settled) => {
      settle?.(settled);
    },
  };
};

interface MidnightProps {
  readonly selection: { readonly providerId: string; readonly serviceAreaId: string } | null;
  readonly verification: ProviderVerification;
}

/**
 * A hook under a clock the test moves and a capability the test releases.
 *
 * Both have to be deliberate: the crossing is the whole subject, so an instant the test did not choose would
 * decide the outcome, and a capability that resolved on its own would land before or after the crossing by luck.
 */
const renderAtClock = (initial: Date, initialProps?: Partial<MidnightProps>) => {
  let clock = initial;
  const requestedRanges: { readonly from: string; readonly to: string }[] = [];
  const areas = deferred<MessagingResult<ServiceAreaSummary[]>>();
  const events = deferred<MessagingResult<CollectionEventsPayload>>();
  const restore = deferred<MessagingResult<RestoredSchedulePayload | null>>();

  const client: MessagingClient = {
    ...settingsOperationsRefused,
    listProviders: async () => ok([]),
    listServiceAreas: async () => areas.value,
    listCollectionEvents: async (input) => {
      requestedRanges.push({ from: input.from, to: input.to });

      return events.value;
    },
    restoreCachedSchedule: async () => restore.value,
    invalidateCachedSchedule: async () => ok(null),
  };

  const props: MidnightProps = {
    selection: SELECTION,
    verification: PENDING_VERIFICATION,
    ...initialProps,
  };

  const view = renderHook(
    ({ selection, verification }: MidnightProps) =>
      useSchedule({
        selection,
        providerVerification: verification,
        onAreaUnavailable: vi.fn(),
        client,
        now: () => clock,
      }),
    { initialProps: props },
  );

  return {
    ...view,
    requestedRanges,
    advanceTo: (instant: Date) => {
      clock = instant;
    },
    settleRestore: async (result: MessagingResult<RestoredSchedulePayload | null>) => {
      await act(async () => {
        restore.settle(result);
      });
    },
    settleAreas: async (result: MessagingResult<ServiceAreaSummary[]>) => {
      await act(async () => {
        areas.settle(result);
      });
    },
    settleEvents: async (result: MessagingResult<CollectionEventsPayload>) => {
      await act(async () => {
        events.settle(result);
      });
    },
  };
};

/** The cache on screen, before any live capability has been released. */
const restoredBeforeMidnight = async () => {
  const harness = renderAtClock(BEFORE_MIDNIGHT);

  await harness.settleRestore(ok(STORED));

  return harness;
};

const datesOf = (view: ReturnType<typeof useSchedule>['view']): string[] =>
  view.kind === 'cached' || view.kind === 'live' ? view.events.map((event) => event.date) : [];

describe('the device and the source across the crossing', () => {
  it('has the device on the earlier date at both instants, so only the source turns the page', () => {
    // Without this the cases below could pass on a machine whose own zone happens to be the source's.
    expect(BEFORE_MIDNIGHT.getDate()).toBe(1);
    expect(AFTER_MIDNIGHT.getDate()).toBe(1);
    expect(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(AFTER_MIDNIGHT),
    ).toBe('2026-03-02');
  });
});

describe('a restored cache before source-local midnight', () => {
  it('states yesterday’s requested range and a full-coverage claim', async () => {
    const { result } = await restoredBeforeMidnight();

    expect(result.current.view).toMatchObject({
      kind: 'cached',
      coverage: 'full',
      displayRange: YESTERDAY_RANGE,
      requestedRange: YESTERDAY_RANGE,
    });
    expect(datesOf(result.current.view)).toEqual(['2026-03-01', '2026-03-10']);
  });

  it('is left exactly as it is when the derived range has not moved', async () => {
    /**
     * The mirror image of every case below, so none of them can pass by the hook having started re-evaluating
     * unconditionally. The capability is identical and the clock has not crossed anything, so yesterday's
     * evaluation genuinely is today's.
     */
    const harness = await restoredBeforeMidnight();

    harness.rerender({ selection: SELECTION, verification: OFFERED });
    await harness.settleAreas(ok([AVAILABLE_AREA]));

    expect(harness.result.current.view).toMatchObject({
      kind: 'cached',
      coverage: 'full',
      displayRange: YESTERDAY_RANGE,
      requestedRange: YESTERDAY_RANGE,
    });
    expect(datesOf(harness.result.current.view)).toEqual(['2026-03-01', '2026-03-10']);
    expect(harness.requestedRanges).toEqual([YESTERDAY_RANGE]);
  });
});

describe('an identical capability arriving after source-local midnight', () => {
  /** Nothing about the source changed. Only the day did. */
  const crossMidnight = async () => {
    const harness = await restoredBeforeMidnight();

    harness.advanceTo(AFTER_MIDNIGHT);
    harness.rerender({ selection: SELECTION, verification: OFFERED });
    await harness.settleAreas(ok([AVAILABLE_AREA]));

    return harness;
  };

  it('derives a requested range advanced by one day', async () => {
    const { requestedRanges } = await crossMidnight();

    expect(requestedRanges).toEqual([TODAY_RANGE]);
  });

  it('re-evaluates the displayed cache before the events request is answered', async () => {
    // Asserted while the events request is still in flight, which is the ordering that matters: a refresh that
    // never answers must not leave yesterday's claim on screen.
    const { result, requestedRanges } = await crossMidnight();

    expect(requestedRanges).toHaveLength(1);
    expect(result.current.view).toMatchObject({
      kind: 'cached',
      displayRange: { from: '2026-03-02', to: '2026-05-30' },
      requestedRange: TODAY_RANGE,
    });
  });

  it('turns the previous full-coverage claim into a partial one', async () => {
    const { result } = await crossMidnight();

    // The entry was served through the 30th and the range now runs to the 31st, so one day of it is uncovered.
    expect(result.current.view).toMatchObject({ kind: 'cached', coverage: 'partial' });
  });

  it('drops the event the moved window no longer covers', async () => {
    const { result } = await crossMidnight();

    expect(datesOf(result.current.view)).toEqual(['2026-03-10']);
  });

  it('keeps the re-evaluated state and the truthful tail when the refresh fails', async () => {
    const harness = await crossMidnight();

    await harness.settleEvents(offline());

    expect(harness.result.current.view).toMatchObject({
      kind: 'cached',
      reason: 'offline',
      coverage: 'partial',
      displayRange: { from: '2026-03-02', to: '2026-05-30' },
      requestedRange: TODAY_RANGE,
    });
    // Yesterday's full claim is gone rather than being restored by the failure.
    expect(harness.result.current.view).not.toMatchObject({ coverage: 'full' });
    expect(datesOf(harness.result.current.view)).toEqual(['2026-03-10']);
  });

  it('shows no event outside the new display range for a reminder to pick up', async () => {
    const harness = await crossMidnight();

    await harness.settleEvents(offline());

    const view = harness.result.current.view;
    const displayed = view.kind === 'cached' ? view.displayRange : null;

    expect(displayed).toEqual({ from: '2026-03-02', to: '2026-05-30' });
    expect(datesOf(view).every((date) => date >= '2026-03-02' && date <= '2026-05-30')).toBe(true);
  });
});

describe('a capability whose own metadata changed', () => {
  it('re-evaluates when the source time zone moved the local date', async () => {
    // The clock has not crossed Berlin's midnight, so the corrected zone is the only reason the range moves.
    const harness = await restoredBeforeMidnight();

    harness.rerender({ selection: SELECTION, verification: OFFERED });
    await harness.settleAreas(
      ok([
        {
          ...AVAILABLE_AREA,
          collectionEvents: {
            availability: 'available',
            timeZone: 'Pacific/Auckland',
            validity: { from: '2026-01-01', to: '2026-12-31' },
          },
        },
      ]),
    );

    expect(harness.requestedRanges).toEqual([TODAY_RANGE]);
    expect(harness.result.current.view).toMatchObject({
      kind: 'cached',
      coverage: 'partial',
      requestedRange: TODAY_RANGE,
    });
  });

  it('re-evaluates when the declared validity window shrank', async () => {
    const harness = await restoredBeforeMidnight();

    harness.rerender({ selection: SELECTION, verification: OFFERED });
    await harness.settleAreas(
      ok([
        {
          ...AVAILABLE_AREA,
          collectionEvents: {
            availability: 'available',
            timeZone: 'Europe/Berlin',
            validity: { from: '2026-01-01', to: '2026-04-15' },
          },
        },
      ]),
    );

    expect(harness.requestedRanges).toEqual([{ from: '2026-03-01', to: '2026-04-15' }]);
    expect(harness.result.current.view).toMatchObject({
      kind: 'cached',
      displayRange: { from: '2026-03-01', to: '2026-04-15' },
      requestedRange: { from: '2026-03-01', to: '2026-04-15' },
    });
  });

  it('drops the entry entirely when the moved range no longer overlaps what it holds', async () => {
    const harness = renderAtClock(BEFORE_MIDNIGHT);

    await harness.settleRestore(
      ok(
        restoredSchedule({
          servedRange: { from: '2026-01-05', to: '2026-01-20' },
          requestedRange: { from: '2026-01-05', to: '2026-01-20' },
          displayRange: { from: '2026-01-05', to: '2026-01-20' },
          events: [curbsideEvent('2026-01-10')],
        }),
      ),
    );

    expect(harness.result.current.view.kind).toBe('cached');

    harness.rerender({ selection: SELECTION, verification: OFFERED });
    await harness.settleAreas(ok([AVAILABLE_AREA]));

    // The range now starts in March, so nothing the entry holds may be shown at all.
    expect(harness.result.current.view.kind).toBe('loading');
  });
});

describe('a selection change while the range is being re-evaluated', () => {
  it('renders nothing from the previous area’s entry', async () => {
    const harness = await restoredBeforeMidnight();

    harness.advanceTo(AFTER_MIDNIGHT);
    harness.rerender({
      selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: UNAVAILABLE_AREA_ID },
      verification: OFFERED,
    });

    expect(harness.result.current.view.kind).toBe('loading');

    await waitFor(() => {
      expect(harness.result.current.view.kind).toBe('loading');
    });
  });
});
