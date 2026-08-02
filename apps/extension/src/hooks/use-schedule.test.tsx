import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderVerification } from '@/src/hooks/use-catalogue';
import type { MessagingClient, MessagingResult } from '@/src/messaging/client';
import type {
  CollectionEventsPayload,
  RestoredSchedulePayload,
  SchedulePayload,
} from '@/src/messaging/contract';
import {
  AVAILABLE_AREA,
  curbsideEvent,
  MIXED_AREAS,
  OFFICIAL_AREA_ID,
  OFFICIAL_PROVIDER,
  OFFICIAL_PROVIDER_ID,
  restoredSchedule,
  schedule,
  UNAVAILABLE_AREA,
  UNAVAILABLE_AREA_ID,
  settingsOperationsRefused,
} from '@/src/test/fixtures';
import type { ServiceAreaSelection } from '@/src/storage/settings';
import { useSchedule } from './use-schedule';

const SELECTION = {
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: OFFICIAL_AREA_ID,
} as const;

const NOW = new Date('2026-03-01T09:00:00.000Z');

/**
 * The verdicts a caller can hand in.
 *
 * Built fresh by each helper rather than shared, because the hook must not depend on their identity — a
 * caller derives them on every render, so an equal-but-new object is the ordinary case and not new work.
 */
const OFFERED: ProviderVerification = { kind: 'offered', provider: OFFICIAL_PROVIDER };

const PENDING_VERIFICATION: ProviderVerification = { kind: 'pending' };

const REJECTED: ProviderVerification = { kind: 'rejected' };

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

/** The ordinary live answer, wrapped in the discriminant the worker actually replies with. */
const liveEvents = (
  payload: SchedulePayload = schedule(),
): MessagingResult<CollectionEventsPayload> => ok({ kind: 'live', schedule: payload });

interface StubOptions {
  readonly restored?: RestoredSchedulePayload | null;
  readonly areas?: MessagingResult<typeof MIXED_AREAS>;
  readonly events?: MessagingResult<CollectionEventsPayload>;
  /** Delays the restore so a late reply can be driven deliberately. */
  readonly restoreGate?: Promise<void>;
}

const createStubClient = ({ restored = null, areas, events, restoreGate }: StubOptions = {}) => {
  const calls: string[] = [];

  const client: MessagingClient = {
    ...settingsOperationsRefused,
    async listProviders() {
      calls.push('listProviders');

      return ok([AVAILABLE_AREA].map(() => ({ id: 'x', name: 'x', sourceKind: 'official_ics' })));
    },
    async listServiceAreas() {
      calls.push('listServiceAreas');

      return areas ?? ok(MIXED_AREAS);
    },
    async listCollectionEvents() {
      calls.push('listCollectionEvents');

      return events ?? liveEvents();
    },
    async restoreCachedSchedule() {
      calls.push('restoreCachedSchedule');

      await restoreGate;

      // A separate marker, so a test can wait for the restore to have actually *resolved* rather than
      // merely been called. Waiting on the call alone would assert before a late repaint could land.
      calls.push('restoreCachedSchedule:resolved');

      return ok(restored);
    },
    async invalidateCachedSchedule() {
      calls.push('invalidateCachedSchedule');

      return ok(null);
    },
  };

  return { client, calls };
};

const renderSchedule = (options: StubOptions = {}, onAreaUnavailable = vi.fn()) => {
  const { client, calls } = createStubClient(options);
  const view = renderHook(() =>
    useSchedule({
      selection: SELECTION,
      providerVerification: OFFERED,
      onAreaUnavailable,
      client,
      now: () => NOW,
    }),
  );

  return { ...view, calls, onAreaUnavailable };
};

describe('with no selection', () => {
  it('shows the needs-selection state and issues nothing at all', async () => {
    const { client, calls } = createStubClient();
    const { result } = renderHook(() =>
      useSchedule({
        selection: null,
        providerVerification: PENDING_VERIFICATION,
        onAreaUnavailable: vi.fn(),
        client,
        now: () => NOW,
      }),
    );

    await waitFor(() => {
      expect(result.current.view.kind).toBe('needs_selection');
    });

    expect(calls).toEqual([]);
  });
});

describe('the startup paths', () => {
  it('restores a cached schedule without issuing any request first', async () => {
    // The offline case is the case the cache exists for, so requiring a live capability lookup would mean
    // it could not render at all.
    const { result, calls } = renderSchedule({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
      areas: offline(),
    });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('cached');
    });

    expect(calls[0]).toBe('restoreCachedSchedule');
    expect(calls).not.toContain('listCollectionEvents');
  });

  it('labels a restored schedule offline when the API could not be reached', async () => {
    const { result } = renderSchedule({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
      areas: offline(),
    });

    await waitFor(() => {
      expect(result.current.view).toMatchObject({ kind: 'cached', reason: 'offline' });
    });
  });

  it('replaces a restored schedule with a current response', async () => {
    const { result } = renderSchedule({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('live');
    });
  });

  it('reaches the error state when nothing is cached and the API is unreachable', async () => {
    const { result } = renderSchedule({ restored: null, areas: offline() });

    await waitFor(() => {
      expect(result.current.view).toMatchObject({ kind: 'error' });
    });
  });
});

describe('the authoritative capability response', () => {
  it('leaves the displayed range unchanged when it matches the snapshot', async () => {
    const restored = restoredSchedule({ events: [curbsideEvent('2026-03-10')] });
    const { result, calls } = renderSchedule({ restored, events: offline() });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('cached');
    });

    expect(result.current.view).toMatchObject({ displayRange: restored.displayRange });
    // Restored once: a matching snapshot forces no re-evaluation.
    expect(calls.filter((call) => call === 'restoreCachedSchedule')).toHaveLength(1);
  });

  /**
   * Renders with an events request that never settles, so the state observed is exactly the state that
   * existed **before** the fetch could have influenced it. A re-evaluation that happened only after the
   * response arrived would leave the old range visible here, which is what makes this an ordering test
   * rather than an outcome test.
   */
  const renderWithPendingFetch = (areaOverride: (typeof MIXED_AREAS)[number], now: Date = NOW) => {
    const calls: string[] = [];
    const client: MessagingClient = {
      ...settingsOperationsRefused,
      listProviders: async () => ok([]),
      listServiceAreas: async () => {
        calls.push('listServiceAreas');

        return ok([areaOverride]);
      },
      listCollectionEvents: () => {
        calls.push('listCollectionEvents');

        return new Promise(() => {
          // Never settles.
        });
      },
      restoreCachedSchedule: async () => {
        calls.push('restoreCachedSchedule');

        return ok(
          restoredSchedule({
            servedRange: { from: '2026-03-01', to: '2026-05-30' },
            displayRange: { from: '2026-03-01', to: '2026-05-30' },
            events: [curbsideEvent('2026-03-10'), curbsideEvent('2026-05-20')],
          }),
        );
      },
      invalidateCachedSchedule: async () => {
        calls.push('invalidateCachedSchedule');

        return ok(null);
      },
    };

    const view = renderHook(() =>
      useSchedule({
        selection: SELECTION,
        providerVerification: OFFERED,
        onAreaUnavailable: vi.fn(),
        client,
        now: () => now,
      }),
    );

    return { ...view, calls };
  };

  it('re-evaluates the displayed cache against a changed window before fetching events', async () => {
    // The live window ends earlier than the entry's served range, so the presented range has to shrink to
    // the authoritative window even though the entry still covers all of it.
    const { result, calls } = renderWithPendingFetch({
      ...AVAILABLE_AREA,
      collectionEvents: {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: '2026-02-01', to: '2026-04-30' },
      },
    });

    await waitFor(() => {
      expect(calls).toContain('listCollectionEvents');
    });

    await waitFor(() => {
      expect(result.current.view).toMatchObject({
        kind: 'cached',
        // The narrowed window is entirely inside the served range, so the entry still covers all of it.
        coverage: 'full',
        // Bounded by the authoritative window, not by the snapshot the entry was stored with.
        displayRange: { from: '2026-03-01', to: '2026-04-30' },
      });
    });

    const view = result.current.view;

    // The event beyond the authoritative window is no longer presented.
    expect(view.kind === 'cached' && view.events.map((event) => event.date)).toEqual([
      '2026-03-10',
    ]);
  });

  it('re-evaluates the displayed cache against a changed zone before fetching events', async () => {
    // At 13:00 UTC it is already the next day in Auckland but not in Berlin, so a corrected zone moves the
    // derived today — and therefore the whole requested window — by a day.
    const { result, calls } = renderWithPendingFetch(
      {
        ...AVAILABLE_AREA,
        collectionEvents: {
          availability: 'available',
          timeZone: 'Pacific/Auckland',
          validity: { from: '2026-01-01', to: '2026-12-31' },
        },
      },
      new Date('2026-03-01T13:00:00.000Z'),
    );

    await waitFor(() => {
      expect(calls).toContain('listCollectionEvents');
    });

    await waitFor(() => {
      expect(result.current.view).toMatchObject({ kind: 'cached', coverage: 'partial' });
    });

    // The window now starts on 2026-03-02 and ends on 2026-05-31, so the entry's served range no longer
    // contains it in full and the uncovered tail is excluded rather than rendered as nothing scheduled.
    expect(result.current.view).toMatchObject({
      displayRange: { from: '2026-03-02', to: '2026-05-30' },
    });
  });

  it('drops a cache that no longer overlaps the authoritative window', async () => {
    const { result } = renderWithPendingFetch({
      ...AVAILABLE_AREA,
      collectionEvents: {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: '2026-06-01', to: '2026-12-31' },
      },
    });

    await waitFor(() => {
      // No overlap means no cached event may be shown at all, so nothing cached remains presented.
      expect(result.current.view.kind).not.toBe('cached');
    });
  });

  it('invalidates the selection when the stored area is now unavailable', async () => {
    const onAreaUnavailable = vi.fn();
    const { result, calls } = renderSchedule(
      {
        restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
        areas: ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]),
      },
      onAreaUnavailable,
    );

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalled();
    });

    // The cached schedule stops being presented and no events request is issued: a withdrawn calendar must
    // not keep answering through a cache.
    expect(result.current.view.kind).not.toBe('cached');
    expect(calls).not.toContain('listCollectionEvents');
  });

  it('never paints a restore that resolves after the area is known to be unavailable', async () => {
    // The regression. The two startup paths run independently, so the restore can still be in flight when the
    // capability response arrives. Without superseding it, the cached schedule repaints a moment after the
    // state was cleared — presenting a withdrawn calendar as current, which is exactly what invalidating the
    // selection exists to prevent. `isCurrent()` does not catch it: this is the same attempt.
    let releaseRestore: (() => void) | undefined;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });

    const onAreaUnavailable = vi.fn();
    const { result, calls } = renderSchedule(
      {
        restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
        areas: ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]),
        restoreGate,
      },
      onAreaUnavailable,
    );

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalled();
    });

    expect(result.current.view.kind).not.toBe('cached');

    // The delayed restore now answers, carrying a perfectly valid cached schedule.
    releaseRestore?.();

    // Waiting for the *resolution* marker, then flushing, is what gives a late repaint every chance to land.
    // Without that, this assertion runs before the update and would pass even with the defect present.
    await waitFor(() => {
      expect(calls).toContain('restoreCachedSchedule:resolved');
    });
    await act(async () => {});

    expect(result.current.view.kind).not.toBe('cached');
    expect(calls).not.toContain('listCollectionEvents');
  });

  it('reports the unavailable area exactly once and issues no events request', async () => {
    const onAreaUnavailable = vi.fn();
    const { calls } = renderSchedule(
      {
        restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
        areas: ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]),
      },
      onAreaUnavailable,
    );

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalled();
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(onAreaUnavailable).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain('listCollectionEvents');
  });

  it('reports the withdrawal rather than performing the cleanup itself', async () => {
    /**
     * The hook stops presenting and says which area it was. It does **not** invalidate the cache or clear the
     * selection: those are an ordered pair whose two steps fail and retry differently, and doing them from here
     * meant the callback this ended with dispatched the selection clear on its own — undoing any ordering
     * established here. `useWithdrawal` owns that sequence and has its own tests for it.
     */
    const { calls, result, onAreaUnavailable } = renderSchedule({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
      areas: ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]),
    });

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalledWith(SELECTION);
    });

    expect(result.current.view.kind).not.toBe('cached');
    // Storage is never touched from here, by this route or any other.
    expect(calls).not.toContain('invalidateCachedSchedule');
  });

  it('does not discard the cache when the area is still available', async () => {
    const { calls } = renderSchedule({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    await waitFor(() => {
      expect(calls).toContain('listCollectionEvents');
    });

    expect(calls).not.toContain('invalidateCachedSchedule');
  });

  it('invalidates the selection when the stored area is gone from the list', async () => {
    const onAreaUnavailable = vi.fn();

    renderSchedule({ areas: ok([]) }, onAreaUnavailable);

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalled();
    });
  });
});

describe('the requested range', () => {
  it('is clamped into the declared window before any events request', async () => {
    const { client, calls } = createStubClient({ restored: null });
    const listCollectionEvents = vi.spyOn(client, 'listCollectionEvents');

    renderHook(() =>
      useSchedule({
        selection: SELECTION,
        providerVerification: OFFERED,
        onAreaUnavailable: vi.fn(),
        client,
        now: () => new Date('2026-11-15T09:00:00.000Z'),
      }),
    );

    await waitFor(() => {
      expect(calls).toContain('listCollectionEvents');
    });

    expect(listCollectionEvents).toHaveBeenCalledWith({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      from: '2026-11-15',
      // Clamped to the declared window rather than running 90 days past it.
      to: '2026-12-31',
    });
  });

  it('issues no events request when the derived today is past the declared window', async () => {
    const { client, calls } = createStubClient({ restored: null });
    const { result } = renderHook(() =>
      useSchedule({
        selection: SELECTION,
        providerVerification: OFFERED,
        onAreaUnavailable: vi.fn(),
        client,
        now: () => new Date('2027-02-01T09:00:00.000Z'),
      }),
    );

    await waitFor(() => {
      expect(result.current.view.kind).toBe('range_not_covered');
    });

    expect(calls).not.toContain('listCollectionEvents');
  });

  it('reports a 422 as its own state rather than a generic error', async () => {
    const { result } = renderSchedule({
      events: {
        ok: false,
        failure: {
          kind: 'problem',
          operation: 'listCollectionEvents',
          status: 422,
          code: 'SCHEDULE_RANGE_NOT_COVERED',
          requestId: 'req-1',
        },
      },
    });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('range_not_covered');
    });
  });
});

/**
 * An unusable zone must not leave the popup loading forever.
 *
 * Every boundary validates zones now, so a capability carrying one is a defect rather than an expected input.
 * That is precisely why this path has to end somewhere: the derivation used to throw inside the effect, which
 * became an unhandled rejection, left the phase pending, and produced a spinner with no failure, no message,
 * and no way to retry. The area fixture here bypasses the schema exactly as a stale worker reply could.
 */
describe('a capability whose time zone cannot be resolved', () => {
  const unusableZoneArea = {
    ...AVAILABLE_AREA,
    collectionEvents: {
      availability: 'available',
      timeZone: 'Not/AZone',
      validity: { from: '2026-01-01', to: '2026-12-31' },
    },
  } as const;

  it('reaches an explicit error state rather than staying pending', async () => {
    const { result } = renderSchedule({ restored: null, areas: ok([unusableZoneArea]) });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('error');
    });

    // Reported as an unreadable response, because that is what it is: the answer carried a zone this runtime
    // cannot use. `status: 0` is the worker's convention for a failure no HTTP status describes.
    expect(result.current.view).toMatchObject({
      kind: 'error',
      failure: { kind: 'invalid_response', operation: 'listCollectionEvents', status: 0 },
    });
  });

  it('issues no collection-events request', async () => {
    const { result, calls } = renderSchedule({ restored: null, areas: ok([unusableZoneArea]) });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('error');
    });
    await act(async () => {});

    // There is no range to ask for, so asking would mean inventing one.
    expect(calls).not.toContain('listCollectionEvents');
  });

  it('never settles on the loading state', async () => {
    const { result } = renderSchedule({ restored: null, areas: ok([unusableZoneArea]) });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('error');
    });

    // Several turns later it is still an error, so this is a settled state rather than a moment in transit.
    await act(async () => {});
    await act(async () => {});

    expect(result.current.view.kind).not.toBe('loading');
  });

  it('offers a retry that starts one new attempt', async () => {
    const { result, calls } = renderSchedule({ restored: null, areas: ok([unusableZoneArea]) });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('error');
    });

    const before = calls.filter((call) => call === 'listServiceAreas').length;

    result.current.refresh();

    await waitFor(() => {
      expect(calls.filter((call) => call === 'listServiceAreas').length).toBe(before + 1);
    });
  });

  it('does not present a restored cache as a live schedule in that state', async () => {
    // The cache is still allowed to show — it has its own validated zone — but it stays labelled as a cache.
    const { result } = renderSchedule({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
      areas: ok([unusableZoneArea]),
    });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('cached');
    });

    expect(result.current.view).not.toMatchObject({ kind: 'live' });
  });
});

describe('newest-selection-wins', () => {
  it('discards a reply from a superseded attempt', async () => {
    // `runtime.sendMessage` offers the sender no cancellation, so the discard rule is what stops an older
    // response from overwriting a newer selection.
    let resolveFirst: ((result: MessagingResult<CollectionEventsPayload>) => void) | undefined;

    const client: MessagingClient = {
      ...settingsOperationsRefused,
      listProviders: async () => ok([]),
      listServiceAreas: async () => ok(MIXED_AREAS),
      invalidateCachedSchedule: async () => ok(null),
      listCollectionEvents: (input) =>
        input.providerId === 'slow-provider'
          ? new Promise((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve(liveEvents(schedule({ events: [curbsideEvent('2026-04-01')] }))),
      restoreCachedSchedule: async () => ok(null),
    };

    const { result, rerender } = renderHook(
      ({ providerId }: { providerId: string }) =>
        useSchedule({
          selection: { providerId, serviceAreaId: OFFICIAL_AREA_ID },
          providerVerification: OFFERED,
          onAreaUnavailable: vi.fn(),
          client,
          now: () => NOW,
        }),
      { initialProps: { providerId: 'slow-provider' } },
    );

    await waitFor(() => {
      expect(resolveFirst).toBeDefined();
    });

    rerender({ providerId: OFFICIAL_PROVIDER_ID });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('live');
    });

    // The superseded first attempt now answers. It must not overwrite the newer selection.
    resolveFirst?.(liveEvents(schedule({ events: [curbsideEvent('2026-03-10')] })));

    await waitFor(() => {
      expect(result.current.view).toMatchObject({ kind: 'live' });
    });

    const view = result.current.view;

    expect(view.kind === 'live' && view.events.map((event) => event.date)).toEqual(['2026-04-01']);
  });

  it('starts a new attempt on refresh', async () => {
    const { result, calls } = renderSchedule();

    await waitFor(() => {
      expect(result.current.view.kind).toBe('live');
    });

    const before = calls.filter((call) => call === 'listCollectionEvents').length;

    result.current.refresh();

    await waitFor(() => {
      expect(calls.filter((call) => call === 'listCollectionEvents').length).toBeGreaterThan(
        before,
      );
    });
  });
});

describe('a refresh that answered with the newer stored entry', () => {
  /**
   * The worker says which of the two a collection-events reply is, and the popup may not relabel one as the
   * other. A stored entry that was newer than the response comes back as `cached`, and presenting it as a
   * live answer would put a current-data label on data that is not the current answer.
   */
  const retained = restoredSchedule({
    events: [curbsideEvent('2026-03-10')],
    retrievedAt: '2026-03-05T08:00:00.000Z',
    storedAt: '2026-03-05T08:10:00.000Z',
  });

  it('presents it as a cache with its own reason rather than as a live response', async () => {
    const { result } = renderSchedule({
      restored: null,
      events: ok({ kind: 'cached', restored: retained }),
    });

    await waitFor(() => {
      expect(result.current.view).toMatchObject({ kind: 'cached', reason: 'retained_newer' });
    });

    // Nothing failed and nothing is offline, so neither of those reasons may be used for it.
    expect(result.current.view).not.toMatchObject({ reason: 'offline' });
    expect(result.current.view).not.toMatchObject({ reason: 'refresh_failed' });
  });

  it('carries the stored entry’s own storage time and ranges', async () => {
    const { result } = renderSchedule({
      restored: null,
      events: ok({ kind: 'cached', restored: retained }),
    });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('cached');
    });

    expect(result.current.view).toMatchObject({
      storedAt: retained.storedAt,
      displayRange: retained.displayRange,
      requestedRange: retained.requestedRange,
    });
  });
});

/**
 * A rerender is not news.
 *
 * The caller derives the verification on every render, so an equal-but-new object arrives constantly — and
 * every state update the hook itself causes triggers one. Depending on that object meant a restored cache
 * landing, or a live schedule arriving, restarted the whole attempt: phase back to pending, the previous
 * attempt superseded, and both requests issued a second time. These count the requests exactly.
 */
describe('request counts across rerenders', () => {
  const countOf = (calls: readonly string[], call: string): number =>
    calls.filter((entry) => entry === call).length;

  const renderCounting = (options: StubOptions = {}) => {
    const { client, calls } = createStubClient(options);
    const view = renderHook(
      // A fresh verdict object and a fresh callback on every render, exactly as a real caller produces them.
      // `marker` exists only so each rerender really is a render with changed props.
      (_props: { marker: number }) =>
        useSchedule({
          selection: SELECTION,
          providerVerification: { kind: 'offered', provider: { ...OFFICIAL_PROVIDER } },
          onAreaUnavailable: () => {},
          client,
          now: () => NOW,
        }),
      { initialProps: { marker: 0 } },
    );

    return { ...view, calls, countOf };
  };

  it('issues exactly one area and one events request for one selection', async () => {
    const { result, calls } = renderCounting({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('live');
    });

    expect(countOf(calls, 'listServiceAreas')).toBe(1);
    expect(countOf(calls, 'listCollectionEvents')).toBe(1);
  });

  it('issues nothing more when the caller rerenders with a new but equal verdict', async () => {
    const { result, calls, rerender } = renderCounting({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('live');
    });

    rerender({ marker: 1 });
    rerender({ marker: 2 });
    rerender({ marker: 3 });
    await act(async () => {});

    expect(countOf(calls, 'listServiceAreas')).toBe(1);
    expect(countOf(calls, 'listCollectionEvents')).toBe(1);
    // The answer already delivered is still the answer: the attempt was not superseded or reset to pending.
    expect(result.current.view.kind).toBe('live');
  });

  it('does not restart the attempt when the restored cache lands', async () => {
    // The restore resolves *after* the first render, so the state update it causes is the one that used to
    // produce a new verdict object and start everything again.
    let releaseRestore: (() => void) | undefined;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });

    const { result, calls } = renderCounting({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
      restoreGate,
      events: offline(),
    });

    await waitFor(() => {
      expect(calls).toContain('restoreCachedSchedule');
    });

    releaseRestore?.();

    await waitFor(() => {
      expect(result.current.view.kind).toBe('cached');
    });
    await act(async () => {});

    expect(countOf(calls, 'restoreCachedSchedule')).toBe(1);
    expect(countOf(calls, 'listServiceAreas')).toBe(1);
    expect(countOf(calls, 'listCollectionEvents')).toBe(1);
  });

  it('does not restart the attempt when the live schedule arrives', async () => {
    const { result, calls } = renderCounting({ restored: null });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('live');
    });

    // Several microtask turns after the answer, so a re-triggered effect would have had every chance to run.
    await act(async () => {});
    await act(async () => {});

    expect(countOf(calls, 'listServiceAreas')).toBe(1);
    expect(countOf(calls, 'listCollectionEvents')).toBe(1);
    expect(result.current.view.kind).toBe('live');
  });

  it('still starts a new attempt when the verdict genuinely changes', async () => {
    // The mirror image, so the tests above cannot pass by the hook having stopped reacting altogether.
    const { client, calls } = createStubClient({ restored: null });
    // Declared, so the props type is the whole union rather than being inferred from the first value.
    const initialProps: { verification: ProviderVerification } = {
      verification: PENDING_VERIFICATION,
    };
    const { result, rerender } = renderHook(
      ({ verification }: { verification: ProviderVerification }) =>
        useSchedule({
          selection: SELECTION,
          providerVerification: verification,
          onAreaUnavailable: vi.fn(),
          client,
          now: () => NOW,
        }),
      { initialProps },
    );

    await act(async () => {});

    expect(countOf(calls, 'listServiceAreas')).toBe(0);

    rerender({ verification: OFFERED });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('live');
    });

    expect(countOf(calls, 'listServiceAreas')).toBe(1);
    expect(countOf(calls, 'listCollectionEvents')).toBe(1);
  });
});

describe('a stored provider the catalogue has not confirmed', () => {
  const renderWith = (providerVerification: ProviderVerification, options: StubOptions = {}) => {
    const { client, calls } = createStubClient(options);
    const onAreaUnavailable = vi.fn();
    const view = renderHook(() =>
      useSchedule({
        selection: SELECTION,
        providerVerification,
        onAreaUnavailable,
        client,
        now: () => NOW,
      }),
    );

    return { ...view, calls, onAreaUnavailable };
  };

  it('issues no provider-specific request while the catalogue is unconfirmed', async () => {
    // A schema-valid stored selection is still only an identifier: it can name a demo provider or one the API
    // no longer offers. Asking for its areas would either surface demo data as official or chase a provider
    // that is gone.
    const { calls } = renderWith(PENDING_VERIFICATION, {
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    await waitFor(() => {
      expect(calls).toContain('restoreCachedSchedule');
    });
    await act(async () => {});

    expect(calls).not.toContain('listServiceAreas');
    expect(calls).not.toContain('listCollectionEvents');
  });

  it('still restores the cache offline-first, ungated by the catalogue', async () => {
    const { result, calls } = renderWith(PENDING_VERIFICATION, {
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('cached');
    });

    // An unreachable catalogue is not a conclusion about the provider, so a valid last-known official cache
    // keeps being presented.
    expect(result.current.view).toMatchObject({ reason: 'refreshing' });
    expect(calls).not.toContain('listServiceAreas');
  });

  it('does not invalidate the selection while the catalogue is unconfirmed', async () => {
    const { onAreaUnavailable } = renderWith(PENDING_VERIFICATION, {
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    await act(async () => {});

    expect(onAreaUnavailable).not.toHaveBeenCalled();
  });

  it('invalidates the selection once a successful catalogue rejects the provider', async () => {
    const { result, calls, onAreaUnavailable } = renderWith(REJECTED, {
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalledOnce();
    });

    // No provider-specific request, and the cache stops being presented.
    expect(calls).not.toContain('listServiceAreas');
    expect(calls).not.toContain('listCollectionEvents');
    expect(result.current.view.kind).not.toBe('cached');
    // Reported, not cleaned up here: the ordered cleanup belongs to `useWithdrawal`.
    expect(calls).not.toContain('invalidateCachedSchedule');
  });

  it('proceeds normally once the provider is confirmed as offered', async () => {
    const { result, calls } = renderWith(OFFERED, {
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    await waitFor(() => {
      expect(result.current.view.kind).toBe('live');
    });

    expect(calls).toContain('listServiceAreas');
    expect(calls).toContain('listCollectionEvents');
  });
});

/**
 * What the hook does when a successful response withdraws the selection: stop presenting it, and say so.
 *
 * The ordered cleanup — cache invalidated and acknowledged, only then the persisted selection cleared — moved to
 * `useWithdrawal`, which owns its two failure states and their two different retries. Its ordering assertions live
 * with it. What is still this hook's to guarantee is that the withdrawn schedule leaves the screen **immediately**,
 * without waiting for any of that.
 */
describe('clearing a withdrawn schedule', () => {
  const withdrawnAreaClient = (): MessagingClient => ({
    ...settingsOperationsRefused,
    listProviders: async () => ok([]),
    listServiceAreas: async () => ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]),
    listCollectionEvents: async () => liveEvents(),
    restoreCachedSchedule: async () =>
      ok(restoredSchedule({ events: [curbsideEvent('2026-03-10')] })),
    invalidateCachedSchedule: async () => ok(null),
  });

  it('removes the cached calendar without waiting for any cleanup', async () => {
    // The guarantee this has always held: a withdrawn calendar used to stay on screen for as long as storage took
    // to answer, and forever if it never did. Nothing awaited now stands between the conclusion and the screen.
    const onAreaUnavailable = vi.fn();
    const { result } = renderHook(() =>
      useSchedule({
        selection: SELECTION,
        providerVerification: OFFERED,
        onAreaUnavailable,
        client: withdrawnAreaClient(),
        now: () => NOW,
      }),
    );

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalledOnce();
    });

    // Already gone in the same commit the conclusion was reached.
    expect(result.current.view.kind).not.toBe('cached');
  });

  it('names the withdrawn area, so the cleanup cannot infer the wrong one', async () => {
    /**
     * The cleanup awaits a round trip in the middle, so by the time it clears a selection the one on screen may be
     * a different area. Inferring the target then would compare-and-clear something nothing had withdrawn.
     */
    const onAreaUnavailable = vi.fn();

    renderHook(() =>
      useSchedule({
        selection: SELECTION,
        providerVerification: OFFERED,
        onAreaUnavailable,
        client: withdrawnAreaClient(),
        now: () => NOW,
      }),
    );

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalledWith(SELECTION);
    });
  });

  it('reports the withdrawal exactly once for one conclusion', async () => {
    const onAreaUnavailable = vi.fn();

    renderHook(() =>
      useSchedule({
        selection: SELECTION,
        providerVerification: OFFERED,
        onAreaUnavailable,
        client: withdrawnAreaClient(),
        now: () => NOW,
      }),
    );

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalled();
    });
    await act(async () => {});
    await act(async () => {});

    expect(onAreaUnavailable).toHaveBeenCalledTimes(1);
  });
});

/**
 * Startup is two independent paths, and these hold them apart.
 *
 * The local cache is keyed by the selection alone. The catalogue's verdict is news about the *provider* and
 * says nothing whatsoever about what is stored locally, so a `pending` to `offered` transition may change the
 * refresh indicator and may replace the events with a current response — but it may not erase the events that
 * are already on screen for the same key, restore that key a second time, or flash a loading spinner in
 * between. Both used to share one effect and one state object, so every one of those happened.
 *
 * Every assertion here is made on an *intermediate* render as well as the final one, because the defect was
 * only ever visible in between.
 */
describe('the two startup paths', () => {
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

  const OTHER_SELECTION = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: UNAVAILABLE_AREA_ID,
  } as const;

  const CACHED = restoredSchedule({ events: [curbsideEvent('2026-03-10')] });

  const OTHER_CACHED = restoredSchedule({ events: [curbsideEvent('2026-03-12')] });

  const keyOf = (target: { readonly providerId: string; readonly serviceAreaId: string }): string =>
    `${target.providerId}/${target.serviceAreaId}`;

  interface StartupProps {
    readonly selection: { readonly providerId: string; readonly serviceAreaId: string } | null;
    readonly verification: ProviderVerification;
  }

  /**
   * Every reply of every path is gated, so a test decides the order in which they land instead of racing the
   * scheduler for it.
   */
  const renderStartup = (initialProps: StartupProps) => {
    const calls: string[] = [];
    const restores = new Map<string, Deferred<MessagingResult<RestoredSchedulePayload | null>>>();
    const areas = new Map<string, Deferred<MessagingResult<typeof MIXED_AREAS>>>();
    const events = new Map<string, Deferred<MessagingResult<CollectionEventsPayload>>>();

    const gate = <Value,>(store: Map<string, Deferred<Value>>, key: string): Deferred<Value> => {
      const existing = store.get(key);

      if (existing !== undefined) {
        return existing;
      }

      const created = deferred<Value>();

      store.set(key, created);

      return created;
    };

    const onAreaUnavailable = vi.fn();

    const client: MessagingClient = {
      ...settingsOperationsRefused,
      listProviders: async () => ok([]),
      listServiceAreas: async (providerId) => {
        calls.push(`listServiceAreas:${providerId}`);

        return gate(areas, providerId).value;
      },
      listCollectionEvents: async (input) => {
        calls.push(`listCollectionEvents:${keyOf(input)}`);

        return gate(events, keyOf(input)).value;
      },
      restoreCachedSchedule: async (input) => {
        calls.push(`restoreCachedSchedule:${keyOf(input)}`);

        return gate(restores, keyOf(input)).value;
      },
      invalidateCachedSchedule: async (input) => {
        calls.push(`invalidateCachedSchedule:${keyOf(input)}`);

        return ok(null);
      },
    };

    const view = renderHook(
      ({ selection, verification }: StartupProps) =>
        useSchedule({
          selection,
          providerVerification: verification,
          onAreaUnavailable,
          client,
          now: () => NOW,
        }),
      { initialProps },
    );

    return {
      ...view,
      calls,
      onAreaUnavailable,
      countOf: (call: string) => calls.filter((entry) => entry === call).length,
      /** Discards a settled gate, so the next request for that target waits on a fresh one. */
      rearmRestore: (target: StartupProps['selection']) => {
        restores.delete(keyOf(target ?? SELECTION));
      },
      settleRestore: async (
        target: StartupProps['selection'],
        result: MessagingResult<RestoredSchedulePayload | null>,
      ) => {
        await act(async () => {
          gate(restores, keyOf(target ?? SELECTION)).settle(result);
        });
      },
      settleAreas: async (providerId: string, result: MessagingResult<typeof MIXED_AREAS>) => {
        await act(async () => {
          gate(areas, providerId).settle(result);
        });
      },
      settleEvents: async (
        target: StartupProps['selection'],
        result: MessagingResult<CollectionEventsPayload>,
      ) => {
        await act(async () => {
          gate(events, keyOf(target ?? SELECTION)).settle(result);
        });
      },
    };
  };

  /** Settings hydrate before the catalogue answers, which is the ordinary offline-first start. */
  const startWithCacheWhilePending = async () => {
    const harness = renderStartup({
      selection: SELECTION,
      verification: PENDING_VERIFICATION,
    });

    await waitFor(() => {
      expect(harness.calls).toContain(`restoreCachedSchedule:${keyOf(SELECTION)}`);
    });

    await harness.settleRestore(SELECTION, ok(CACHED));

    return harness;
  };

  it('restores the cache while the catalogue verdict is still pending', async () => {
    const { result, calls } = await startWithCacheWhilePending();

    expect(result.current.view).toMatchObject({ kind: 'cached', reason: 'refreshing' });
    // The restore did not wait for the verdict, and the verdict being pending issued no request of its own.
    expect(calls).toEqual([`restoreCachedSchedule:${keyOf(SELECTION)}`]);
  });

  it('keeps the restored events visible across the pending-to-offered transition', async () => {
    const { result, rerender } = await startWithCacheWhilePending();
    const before = result.current.view;

    rerender({ selection: SELECTION, verification: OFFERED });

    // Asserted on the render the transition produced, with nothing awaited in between: this is the moment the
    // shared effect reset the state and the popup fell back to a spinner.
    expect(result.current.view.kind).toBe('cached');
    expect(result.current.view.kind === 'cached' && result.current.view.events).toEqual(
      before.kind === 'cached' ? before.events : [],
    );
  });

  it('restores the cache exactly once for one key across the transition', async () => {
    const { rerender, countOf } = await startWithCacheWhilePending();

    rerender({ selection: SELECTION, verification: OFFERED });
    await act(async () => {});
    rerender({ selection: SELECTION, verification: OFFERED });
    await act(async () => {});

    expect(countOf(`restoreCachedSchedule:${keyOf(SELECTION)}`)).toBe(1);
  });

  it('starts the live request only once the verdict is offered', async () => {
    const { rerender, calls } = await startWithCacheWhilePending();

    expect(calls).not.toContain(`listServiceAreas:${OFFICIAL_PROVIDER_ID}`);

    rerender({ selection: SELECTION, verification: OFFERED });

    await waitFor(() => {
      expect(calls).toContain(`listServiceAreas:${OFFICIAL_PROVIDER_ID}`);
    });
  });

  it('shows no loading state at any point between the cache and the live answer', async () => {
    const harness = await startWithCacheWhilePending();
    const seen: string[] = [];
    const record = () => {
      seen.push(harness.result.current.view.kind);
    };

    record();
    harness.rerender({ selection: SELECTION, verification: OFFERED });
    record();
    await harness.settleAreas(OFFICIAL_PROVIDER_ID, ok(MIXED_AREAS));
    record();
    await harness.settleEvents(SELECTION, liveEvents());
    record();

    expect(seen).toEqual(['cached', 'cached', 'cached', 'live']);
  });

  it('replaces the cache when the live response is trustworthy', async () => {
    const harness = await startWithCacheWhilePending();

    harness.rerender({ selection: SELECTION, verification: OFFERED });
    await harness.settleAreas(OFFICIAL_PROVIDER_ID, ok(MIXED_AREAS));
    await harness.settleEvents(
      SELECTION,
      liveEvents(schedule({ events: [curbsideEvent('2026-03-20')] })),
    );

    expect(harness.result.current.view).toMatchObject({ kind: 'live' });
    expect(
      harness.result.current.view.kind === 'live' &&
        harness.result.current.view.events.map((event) => event.date),
    ).toEqual(['2026-03-20']);
  });

  it('leaves the cache visible and offline-labelled when the live request fails', async () => {
    const harness = await startWithCacheWhilePending();

    harness.rerender({ selection: SELECTION, verification: OFFERED });
    await harness.settleAreas(OFFICIAL_PROVIDER_ID, ok(MIXED_AREAS));
    await harness.settleEvents(SELECTION, offline());

    expect(harness.result.current.view).toMatchObject({ kind: 'cached', reason: 'offline' });
    expect(
      harness.result.current.view.kind === 'cached' &&
        harness.result.current.view.events.map((event) => event.date),
    ).toEqual(['2026-03-10']);
  });

  it('labels the still-visible cache as refresh-failed when the failure is not a network one', async () => {
    const harness = await startWithCacheWhilePending();

    harness.rerender({ selection: SELECTION, verification: OFFERED });
    await harness.settleAreas(OFFICIAL_PROVIDER_ID, ok(MIXED_AREAS));
    await harness.settleEvents(SELECTION, {
      ok: false,
      failure: {
        kind: 'problem',
        operation: 'listCollectionEvents',
        status: 500,
        code: 'INTERNAL',
        requestId: 'req-1',
      },
    });

    expect(harness.result.current.view).toMatchObject({
      kind: 'cached',
      reason: 'refresh_failed',
    });
  });

  it('removes the previous key’s events in the very render the selection changes', async () => {
    const { result, rerender } = await startWithCacheWhilePending();

    expect(result.current.view.kind).toBe('cached');

    rerender({ selection: OTHER_SELECTION, verification: OFFERED });

    // Nothing awaited: a schedule belonging to a key that is no longer selected must never be rendered, not
    // even for the one commit it would take the new key's restore to answer.
    expect(result.current.view.kind).toBe('loading');
  });

  it('shows the new key’s own cache after the selection changes', async () => {
    const harness = await startWithCacheWhilePending();

    harness.rerender({ selection: OTHER_SELECTION, verification: OFFERED });
    await harness.settleRestore(OTHER_SELECTION, ok(OTHER_CACHED));

    expect(
      harness.result.current.view.kind === 'cached' &&
        harness.result.current.view.events.map((event) => event.date),
    ).toEqual(['2026-03-12']);
  });

  it('cannot be repainted by a restore that belongs to a superseded key', async () => {
    const harness = await renderStartup({
      selection: SELECTION,
      verification: PENDING_VERIFICATION,
    });

    await waitFor(() => {
      expect(harness.calls).toContain(`restoreCachedSchedule:${keyOf(SELECTION)}`);
    });

    // The selection changes while the first key's restore is still in flight.
    harness.rerender({ selection: OTHER_SELECTION, verification: PENDING_VERIFICATION });
    await harness.settleRestore(OTHER_SELECTION, ok(null));

    expect(harness.result.current.view.kind).toBe('loading');

    // The superseded key now answers, with a schedule.
    await harness.settleRestore(SELECTION, ok(CACHED));

    expect(harness.result.current.view.kind).toBe('loading');
  });

  it('clears the cache when the catalogue rejects the stored provider', async () => {
    const { result, rerender, onAreaUnavailable } = await startWithCacheWhilePending();

    expect(result.current.view.kind).toBe('cached');

    rerender({ selection: SELECTION, verification: REJECTED });

    expect(result.current.view.kind).toBe('loading');

    await waitFor(() => {
      expect(onAreaUnavailable).toHaveBeenCalled();
    });

    expect(result.current.view.kind).toBe('loading');
  });

  it('clears the cache when the area no longer publishes a calendar', async () => {
    const harness = await startWithCacheWhilePending();

    harness.rerender({ selection: SELECTION, verification: OFFERED });

    expect(harness.result.current.view.kind).toBe('cached');

    await harness.settleAreas(OFFICIAL_PROVIDER_ID, ok([UNAVAILABLE_AREA]));

    expect(harness.result.current.view.kind).toBe('loading');
    // Reported with the exact area, and no events request is made for it.
    expect(harness.onAreaUnavailable).toHaveBeenCalledWith(SELECTION);
    expect(harness.calls).not.toContain(`listCollectionEvents:${keyOf(SELECTION)}`);
  });

  it('restores the cache again for a selection that is returned to after a withdrawal', async () => {
    /**
     * The withdrawal is remembered by the run it belongs to, and this is why that identity has to be one that
     * cannot repeat. Going to another area and back produces the same key and the same refresh count as the
     * first visit, so a marker built from those two would take this second restore for the withdrawn one and
     * refuse to display it — leaving the popup on a spinner over a schedule it was holding all along.
     *
     * The intermediate area publishes a calendar, so nothing withdraws in between and the returning visit is
     * genuinely the only withdrawn run. The entry can still be there: the invalidation is best-effort, and
     * re-selecting an area means the catalogue offers it again.
     */
    const harness = renderStartup({ selection: OTHER_SELECTION, verification: OFFERED });

    await harness.settleAreas(OFFICIAL_PROVIDER_ID, ok(MIXED_AREAS));
    await harness.settleRestore(OTHER_SELECTION, ok(null));

    expect(harness.result.current.view.kind).toBe('loading');
    expect(harness.onAreaUnavailable).toHaveBeenCalledWith(OTHER_SELECTION);

    harness.rearmRestore(OTHER_SELECTION);
    harness.rerender({ selection: SELECTION, verification: OFFERED });
    await harness.settleRestore(SELECTION, ok(null));

    // The area in between publishes a calendar, so it withdraws nothing.
    expect(harness.onAreaUnavailable.mock.calls).toEqual([[OTHER_SELECTION]]);

    // Back, with the catalogue unconfirmed, so the live path cannot withdraw it a second time.
    harness.rerender({ selection: OTHER_SELECTION, verification: PENDING_VERIFICATION });

    await waitFor(() => {
      expect(harness.countOf(`restoreCachedSchedule:${keyOf(OTHER_SELECTION)}`)).toBe(2);
    });

    await harness.settleRestore(OTHER_SELECTION, ok(OTHER_CACHED));

    expect(harness.result.current.view).toMatchObject({ kind: 'cached' });
    expect(
      harness.result.current.view.kind === 'cached' &&
        harness.result.current.view.events.map((event) => event.date),
    ).toEqual(['2026-03-12']);
  });

  it('withdraws the selection when a successful area list does not contain it at all', async () => {
    // The other half of the same conclusion. An area missing from a complete list is as authoritative as one
    // reported unavailable, and the reminder treats them identically — so this surface must too.
    const harness = await startWithCacheWhilePending();

    harness.rerender({ selection: SELECTION, verification: OFFERED });

    expect(harness.result.current.view.kind).toBe('cached');

    await harness.settleAreas(OFFICIAL_PROVIDER_ID, ok([]));

    expect(harness.result.current.view.kind).toBe('loading');
    expect(harness.onAreaUnavailable).toHaveBeenCalledWith(SELECTION);
    expect(harness.calls).not.toContain(`listCollectionEvents:${keyOf(SELECTION)}`);
  });

  it('cannot be repainted by a restore that lands after the calendar was withdrawn', async () => {
    // The withdrawal and the restore are the same attempt, so the attempt counter cannot separate them: the
    // session marker is what does.
    const harness = renderStartup({ selection: SELECTION, verification: OFFERED });

    await waitFor(() => {
      expect(harness.calls).toContain(`listServiceAreas:${OFFICIAL_PROVIDER_ID}`);
    });

    await harness.settleAreas(OFFICIAL_PROVIDER_ID, ok([UNAVAILABLE_AREA]));

    expect(harness.result.current.view.kind).toBe('loading');

    await harness.settleRestore(SELECTION, ok(CACHED));

    expect(harness.result.current.view.kind).toBe('loading');
  });
});

/**
 * A delayed area response belongs to the selection it was asked for, and to nothing else.
 *
 * The area list is requested per provider and can take as long as the network does. If the selection changes while
 * it is in flight, everything the answer implies is about an area nobody is looking at any more — so the attempt
 * has to stop the moment it resumes, before it reads the answer at all. Every side effect below was reachable:
 *
 * - an `unavailable` answer for the old area reported *that* area as withdrawn, which sent the popup into a
 *   withdrawal for it: a cache invalidation and a compare-and-clear for a selection nobody holds;
 * - the same report marked the **newest** restore run as withdrawn, suppressing the new area's own cache;
 * - an `available` answer went on to fetch and cache a schedule for the replaced area.
 */
describe('an area response that arrives after the selection changed', () => {
  interface Gate<Value> {
    readonly value: Promise<Value>;
    readonly settle: (value: Value) => void;
  }

  const gate = <Value,>(): Gate<Value> => {
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

  const AREA_B_ID = UNAVAILABLE_AREA_ID;

  const SELECTION_B = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: AREA_B_ID,
  } as const;

  /** Area B, published and available, so B's own attempt can complete normally. */
  const AREA_B = { ...AVAILABLE_AREA, id: AREA_B_ID };

  /**
   * A hook whose **first** provider request hangs until released.
   *
   * Both selections share a provider, so the areas request is the same call twice — the first is held and the
   * second answers at once. That is what puts A's answer behind B's.
   */
  const renderRacing = () => {
    const calls: string[] = [];
    const first = gate<MessagingResult<typeof MIXED_AREAS>>();
    let requests = 0;
    const onAreaUnavailable = vi.fn();

    const client: MessagingClient = {
      ...settingsOperationsRefused,
      listProviders: async () => ok([]),
      listServiceAreas: async () => {
        requests += 1;
        calls.push('listServiceAreas');

        return requests === 1 ? first.value : ok([AREA_B]);
      },
      listCollectionEvents: async (input) => {
        calls.push(`listCollectionEvents:${input.serviceAreaId}`);

        return liveEvents();
      },
      restoreCachedSchedule: async (input) => {
        calls.push(`restoreCachedSchedule:${input.serviceAreaId}`);

        return ok(null);
      },
      invalidateCachedSchedule: async (input) => {
        calls.push(`invalidateCachedSchedule:${input.serviceAreaId}`);

        return ok(null);
      },
    };

    const view = renderHook(
      ({ selection }: { selection: ServiceAreaSelection }) =>
        useSchedule({
          selection,
          providerVerification: OFFERED,
          onAreaUnavailable,
          client,
          now: () => NOW,
        }),
      // Declared, so the prop type covers both selections rather than being inferred from the first.
      { initialProps: { selection: SELECTION } as { selection: ServiceAreaSelection } },
    );

    return {
      ...view,
      calls,
      onAreaUnavailable,
      countOf: (call: string) => calls.filter((entry) => entry === call).length,
      /** Moves to area B and lets its own attempt finish. */
      switchToB: async () => {
        view.rerender({ selection: SELECTION_B });
        await act(async () => {});
      },
      releaseFirst: async (result: MessagingResult<typeof MIXED_AREAS>) => {
        await act(async () => {
          first.settle(result);
        });
        await act(async () => {});
      },
    };
  };

  const startedForA = async () => {
    const harness = renderRacing();

    await waitFor(() => {
      expect(harness.calls).toContain('listServiceAreas');
    });

    await harness.switchToB();

    return harness;
  };

  it('reports no withdrawal when the delayed answer says the old area is unavailable', async () => {
    const harness = await startedForA();

    // A's answer finally arrives, and it withdraws A.
    await harness.releaseFirst(ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]));

    expect(harness.onAreaUnavailable).not.toHaveBeenCalled();
  });

  it('performs no cache operation for the old area', async () => {
    const harness = await startedForA();

    await harness.releaseFirst(ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]));

    expect(harness.calls).not.toContain(`invalidateCachedSchedule:${OFFICIAL_AREA_ID}`);
  });

  it('requests no collection events for the old area when the delayed answer says it is available', async () => {
    const harness = await startedForA();

    // The other half: an answer that would have led straight to a fetch and a cache write.
    await harness.releaseFirst(ok([AVAILABLE_AREA]));

    expect(harness.calls).not.toContain(`listCollectionEvents:${OFFICIAL_AREA_ID}`);
  });

  it('leaves the new area rendered and its own attempt intact', async () => {
    const harness = await startedForA();

    await waitFor(() => {
      expect(harness.calls).toContain(`listCollectionEvents:${AREA_B_ID}`);
    });

    await harness.releaseFirst(ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]));

    // B answered and is on screen; the superseded attempt changed nothing about it.
    expect(harness.result.current.view.kind).toBe('live');
    expect(harness.countOf(`listCollectionEvents:${AREA_B_ID}`)).toBe(1);
  });

  it('does not suppress the new area’s own cache restore', async () => {
    /**
     * The subtle one. Reporting a withdrawal marks whichever restore run is current, and by the time A's answer
     * arrives that is **B's** run — so A's conclusion used to suppress B's cache.
     */
    const harness = await startedForA();

    await harness.releaseFirst(ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]));

    // B restored, and nothing about A interfered with it.
    expect(harness.calls).toContain(`restoreCachedSchedule:${AREA_B_ID}`);
    expect(harness.result.current.view.kind).not.toBe('loading');
  });

  it('still withdraws normally when the answer belongs to the current selection', async () => {
    // The mirror image, so none of the above can pass by the hook having stopped withdrawing altogether.
    const harness = renderRacing();

    await waitFor(() => {
      expect(harness.calls).toContain('listServiceAreas');
    });

    await harness.releaseFirst(ok([{ ...UNAVAILABLE_AREA, id: OFFICIAL_AREA_ID }]));

    expect(harness.onAreaUnavailable).toHaveBeenCalledWith(SELECTION);
    expect(harness.result.current.view.kind).not.toBe('cached');
  });
});
