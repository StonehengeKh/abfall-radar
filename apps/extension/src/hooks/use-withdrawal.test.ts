import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CacheResult, MessagingClient } from '@/src/messaging/client';
import type { SelectionInvalidationPayload } from '@/src/messaging/contract';
import { defaultSettings, type ServiceAreaSelection } from '@/src/storage/settings';
import {
  OFFICIAL_AREA_ID,
  OFFICIAL_PROVIDER_ID,
  settingsOperationsRefused,
} from '@/src/test/fixtures';
import { useWithdrawal } from './use-withdrawal';

/**
 * The order in which an authoritative withdrawal takes effect.
 *
 * Every reply is gated, so each test decides when a step completes rather than racing the scheduler for it — the
 * ordering is the whole subject, and an assertion made after everything settled would pass whatever the order was.
 *
 * The rule under test: the cache is invalidated and **acknowledged** before the persisted selection is
 * compare-and-cleared. Clearing first left a window in which nothing pointed at the area while its entry was still
 * on disk and its generation had not moved, so a collection-events response already in flight could rewrite the
 * cache for an area with no selection left to re-validate it against.
 */

const TARGET: ServiceAreaSelection = {
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: OFFICIAL_AREA_ID,
};

const OTHER: ServiceAreaSelection = {
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: 'koblenz-oberwerth',
};

interface Deferred<Value> {
  readonly value: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: Error) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolve: ((value: Value) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const value = new Promise<Value>((resolveImpl, rejectImpl) => {
    resolve = resolveImpl;
    reject = rejectImpl;
  });

  return {
    value,
    resolve: (settled) => {
      resolve?.(settled);
    },
    reject: (reason) => {
      reject?.(reason);
    },
  };
};

const invalidatedPayload = (
  outcome: SelectionInvalidationPayload['outcome'],
): SelectionInvalidationPayload => ({
  outcome,
  settings: { ...defaultSettings, selection: outcome === 'superseded' ? OTHER : null },
});

/** Both operations gated, and every call recorded in the order it was made. */
const renderWithdrawal = () => {
  const order: string[] = [];
  const cache = deferred<CacheResult<null>>();
  const clear = deferred<SelectionInvalidationPayload>();
  const cleared = vi.fn();

  const client: MessagingClient = {
    ...settingsOperationsRefused,
    listProviders: async () => ({ ok: true, data: [] }),
    listServiceAreas: async () => ({ ok: true, data: [] }),
    listCollectionEvents: async () => {
      throw new Error('the withdrawal must never request a schedule.');
    },
    restoreCachedSchedule: async () => ({ ok: true, data: null }),
    invalidateCachedSchedule: (input) => {
      order.push(`invalidateCachedSchedule:${input.serviceAreaId}`);

      return cache.value;
    },
  };

  const clearSelectionIfUnchanged = vi.fn(async (expected: ServiceAreaSelection) => {
    order.push(`clearSelection:${expected.serviceAreaId}`);

    return clear.value;
  });

  /**
   * The stored selection is a prop, so a test can move it and watch a withdrawal recognize that it has been
   * superseded. Every case starts from the area the withdrawal is about.
   */
  const view = renderHook(
    ({ selection }: { selection: ServiceAreaSelection | null }) =>
      useWithdrawal({ selection, clearSelectionIfUnchanged, onCleared: cleared, client }),
    { initialProps: { selection: TARGET as ServiceAreaSelection | null } },
  );

  return {
    ...view,
    /** Moves the stored selection, as another popup or an alarm would. */
    selectInstead: async (selection: ServiceAreaSelection | null) => {
      await act(async () => {
        view.rerender({ selection });
      });
    },
    order,
    cleared,
    clearSelectionIfUnchanged,
    settleCache: async (result: CacheResult<null>) => {
      await act(async () => {
        cache.resolve(result);
      });
    },
    rejectCache: async () => {
      await act(async () => {
        cache.reject(new Error('storage unavailable'));
      });
    },
    settleClear: async (outcome: SelectionInvalidationPayload['outcome']) => {
      await act(async () => {
        clear.resolve(invalidatedPayload(outcome));
      });
    },
    rejectClear: async () => {
      await act(async () => {
        clear.reject(new Error('storage unavailable'));
      });
    },
  };
};

const ok: CacheResult<null> = { ok: true, data: null };

const refused: CacheResult<null> = { ok: false, failure: { kind: 'cache_storage' } };

describe('the order an authoritative withdrawal takes effect in', () => {
  it('invalidates the cache first', async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });

    await waitFor(() => {
      expect(harness.order).toEqual([`invalidateCachedSchedule:${OFFICIAL_AREA_ID}`]);
    });
  });

  it('does not clear the selection while the invalidation is unresolved', async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });

    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });

    // Several turns with the invalidation still pending, so a clear dispatched ahead of it would have landed.
    await act(async () => {});
    await act(async () => {});

    expect(harness.clearSelectionIfUnchanged).not.toHaveBeenCalled();
    expect(harness.result.current.state.kind).toBe('invalidating');
  });

  it('clears the selection once the invalidation resolves', async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });

    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });

    await harness.settleCache(ok);

    await waitFor(() => {
      expect(harness.clearSelectionIfUnchanged).toHaveBeenCalledWith(TARGET);
    });

    expect(harness.order).toEqual([
      `invalidateCachedSchedule:${OFFICIAL_AREA_ID}`,
      `clearSelection:${OFFICIAL_AREA_ID}`,
    ]);
  });

  it('reaches idle and reports the clear once both steps succeed', async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.settleCache(ok);
    await harness.settleClear('invalidated');

    await waitFor(() => {
      expect(harness.result.current.state.kind).toBe('idle');
    });

    expect(harness.cleared).toHaveBeenCalledOnce();
  });

  it('reports nothing to react to when a newer area superseded the clear', async () => {
    // Somebody chose a different area while this was running. Their choice stands and is re-evaluated on its own
    // merits, so no transition of this person's happened.
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.settleCache(ok);
    await harness.settleClear('superseded');

    await waitFor(() => {
      expect(harness.result.current.state.kind).toBe('idle');
    });

    // The compare-and-clear preserved the newer selection, and no focus transition was claimed.
    expect(harness.cleared).not.toHaveBeenCalled();
    expect(harness.clearSelectionIfUnchanged).toHaveBeenCalledWith(TARGET);
  });

  it('never requests a schedule as part of a withdrawal', async () => {
    // The stub throws on a schedule request, so reaching one would fail this rather than pass it quietly.
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.settleCache(ok);
    await harness.settleClear('invalidated');

    expect(harness.order.some((entry) => entry.startsWith('listCollectionEvents'))).toBe(false);
  });

  it('runs one sequence when the same conclusion is reported twice', async () => {
    // The schedule can re-derive the same verdict, and reacting to each report would run two overlapping
    // sequences against one area.
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
      harness.result.current.begin(TARGET);
    });

    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await act(async () => {});

    expect(harness.order).toEqual([`invalidateCachedSchedule:${OFFICIAL_AREA_ID}`]);
  });
});

describe('a withdrawal whose cache invalidation is refused', () => {
  it('does not clear the persisted selection', async () => {
    /**
     * The entry is still on disk. Clearing the selection now would leave a stored schedule with nothing left to
     * re-validate it against and no selection to rediscover the problem.
     */
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.settleCache(refused);

    await waitFor(() => {
      expect(harness.result.current.state.kind).toBe('cache_failed');
    });

    expect(harness.clearSelectionIfUnchanged).not.toHaveBeenCalled();
  });

  it('treats a rejected invalidation the same as a refused one', async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.rejectCache();

    await waitFor(() => {
      expect(harness.result.current.state.kind).toBe('cache_failed');
    });

    expect(harness.clearSelectionIfUnchanged).not.toHaveBeenCalled();
  });

  it('retries beginning with the invalidation again', async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.settleCache(refused);
    await waitFor(() => {
      expect(harness.result.current.state.kind).toBe('cache_failed');
    });

    act(() => {
      harness.result.current.retry();
    });

    // A second invalidation, and still no clear: the retry redoes the step that failed.
    await waitFor(() => {
      expect(harness.order).toEqual([
        `invalidateCachedSchedule:${OFFICIAL_AREA_ID}`,
        `invalidateCachedSchedule:${OFFICIAL_AREA_ID}`,
      ]);
    });

    expect(harness.clearSelectionIfUnchanged).not.toHaveBeenCalled();
  });

  it('names the area it stalled on, so the retry cannot drift onto another', async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.settleCache(refused);

    await waitFor(() => {
      expect(harness.result.current.state).toEqual({ kind: 'cache_failed', target: TARGET });
    });
  });
});

describe('a withdrawal whose selection clear is refused', () => {
  const stalledAtClear = async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.settleCache(ok);
    await waitFor(() => {
      expect(harness.clearSelectionIfUnchanged).toHaveBeenCalled();
    });
    await harness.rejectClear();
    await waitFor(() => {
      expect(harness.result.current.state.kind).toBe('clear_failed');
    });

    return harness;
  };

  it('leaves the cache invalidated and reports only the clear as failed', async () => {
    const harness = await stalledAtClear();

    expect(harness.result.current.state).toEqual({ kind: 'clear_failed', target: TARGET });
    // Exactly one invalidation happened, and it succeeded.
    expect(harness.order.filter((entry) => entry.startsWith('invalidateCachedSchedule'))).toEqual([
      `invalidateCachedSchedule:${OFFICIAL_AREA_ID}`,
    ]);
  });

  it('retries only the compare-and-clear', async () => {
    /**
     * The entry is already gone, so asking for it again would be asking for something already true — and would
     * reset a barrier that has served its purpose.
     */
    const harness = await stalledAtClear();

    act(() => {
      harness.result.current.retry();
    });

    await waitFor(() => {
      expect(harness.clearSelectionIfUnchanged).toHaveBeenCalledTimes(2);
    });

    expect(
      harness.order.filter((entry) => entry.startsWith('invalidateCachedSchedule')),
    ).toHaveLength(1);
  });

  it('reports nothing and stays idle-free until the retry resolves', async () => {
    const harness = await stalledAtClear();

    expect(harness.cleared).not.toHaveBeenCalled();
    expect(harness.result.current.state.kind).toBe('clear_failed');
  });
});

describe('a withdrawal that nothing has started', () => {
  it('does nothing on a retry', async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.retry();
    });
    await act(async () => {});

    expect(harness.order).toEqual([]);
    expect(harness.result.current.state.kind).toBe('idle');
  });
});

/**
 * A withdrawal stops meaning anything once its area is no longer the stored selection.
 *
 * Its screen takes precedence over every selection-based one, so a failed withdrawal of area A held the popup on an
 * error about A after another window selected area B — indefinitely, and the only way out was retrying an operation
 * for an area nobody was looking at.
 */
describe('a withdrawal whose area is no longer selected', () => {
  const stalledAtCache = async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.settleCache(refused);
    await waitFor(() => {
      expect(harness.result.current.state.kind).toBe('cache_failed');
    });

    return harness;
  };

  it('is reported as idle once another area is selected', async () => {
    const harness = await stalledAtCache();

    await harness.selectInstead(OTHER);

    expect(harness.result.current.state.kind).toBe('idle');
  });

  it('is reported as idle once the selection is cleared entirely', async () => {
    // Another popup or an alarm got there first. There is nothing left to say about the old area either way.
    const harness = await stalledAtCache();

    await harness.selectInstead(null);

    expect(harness.result.current.state.kind).toBe('idle');
  });

  it('supersedes a failed selection clear the same way', async () => {
    const harness = renderWithdrawal();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.order).toHaveLength(1);
    });
    await harness.settleCache(ok);
    await waitFor(() => {
      expect(harness.clearSelectionIfUnchanged).toHaveBeenCalled();
    });
    await harness.rejectClear();
    await waitFor(() => {
      expect(harness.result.current.state.kind).toBe('clear_failed');
    });

    await harness.selectInstead(OTHER);

    expect(harness.result.current.state.kind).toBe('idle');
  });

  it('leaves a withdrawal of the still-selected area alone', async () => {
    // The counterweight: supersession is about the target moving, not about time passing.
    const harness = await stalledAtCache();

    await harness.selectInstead(TARGET);

    expect(harness.result.current.state).toEqual({ kind: 'cache_failed', target: TARGET });
  });

  it('does nothing on a retry once it has been superseded', async () => {
    /**
     * The screen is gone, so the button is unreachable — but the internal state is forgotten too, rather than left
     * quietly disagreeing with what is rendered and able to act on an obsolete target.
     */
    const harness = await stalledAtCache();
    const before = harness.order.length;

    await harness.selectInstead(OTHER);

    act(() => {
      harness.result.current.retry();
    });
    await act(async () => {});

    expect(harness.order).toHaveLength(before);
    expect(harness.result.current.state.kind).toBe('idle');
  });

  it('can withdraw the newly selected area afterwards', async () => {
    // Superseding must not leave the hook unable to start again — including for the area it stalled on.
    const harness = await stalledAtCache();

    await harness.selectInstead(OTHER);

    act(() => {
      harness.result.current.begin(OTHER);
    });

    await waitFor(() => {
      expect(harness.order).toContain(`invalidateCachedSchedule:${OTHER.serviceAreaId}`);
    });
  });
});

/**
 * Two withdrawals overlapping, and neither allowed to answer for the other.
 *
 * Every step is asynchronous, so a run for area A can complete after a run for area B has started. Each of A's three
 * completion paths used to write the shared state unconditionally: A's success set `idle` over whatever B was doing,
 * A's failure replaced B's error with one about A, and either cleared B's `inFlight` — after which B's own
 * completion looked superseded and did nothing at all, leaving the surface with no error and no retry.
 *
 * Each run carries a monotonic token, and every completion checks it before touching anything.
 */
describe('a completion from a superseded withdrawal', () => {
  /**
   * Two independently gated withdrawals against one hook.
   *
   * The gates are per target, so a test decides which run answers when — the whole point being that they answer in
   * the wrong order.
   */
  const renderTwoRuns = () => {
    const order: string[] = [];
    const caches = new Map<string, Deferred<CacheResult<null>>>();
    const clears = new Map<string, Deferred<SelectionInvalidationPayload>>();
    const cleared = vi.fn();

    const gate = <Value>(store: Map<string, Deferred<Value>>, key: string): Deferred<Value> => {
      const existing = store.get(key);

      if (existing !== undefined) {
        return existing;
      }

      const created = deferred<Value>();

      store.set(key, created);

      return created;
    };

    const client: MessagingClient = {
      ...settingsOperationsRefused,
      listProviders: async () => ({ ok: true, data: [] }),
      listServiceAreas: async () => ({ ok: true, data: [] }),
      listCollectionEvents: async () => {
        throw new Error('a withdrawal must never request a schedule.');
      },
      restoreCachedSchedule: async () => ({ ok: true, data: null }),
      invalidateCachedSchedule: (input) => {
        order.push(`invalidate:${input.serviceAreaId}`);

        return gate(caches, input.serviceAreaId).value;
      },
    };

    const clearSelectionIfUnchanged = vi.fn(async (expected: ServiceAreaSelection) => {
      order.push(`clear:${expected.serviceAreaId}`);

      return gate(clears, expected.serviceAreaId).value;
    });

    const view = renderHook(
      ({ selection }: { selection: ServiceAreaSelection | null }) =>
        useWithdrawal({ selection, clearSelectionIfUnchanged, onCleared: cleared, client }),
      { initialProps: { selection: TARGET as ServiceAreaSelection | null } },
    );

    return {
      ...view,
      order,
      cleared,
      clearSelectionIfUnchanged,
      settleCache: async (target: ServiceAreaSelection, result: CacheResult<null>) => {
        await act(async () => {
          gate(caches, target.serviceAreaId).resolve(result);
        });
      },
      settleClear: async (
        target: ServiceAreaSelection,
        outcome: SelectionInvalidationPayload['outcome'],
      ) => {
        await act(async () => {
          gate(clears, target.serviceAreaId).resolve(invalidatedPayload(outcome));
        });
      },
      rejectClear: async (target: ServiceAreaSelection) => {
        await act(async () => {
          gate(clears, target.serviceAreaId).reject(new Error('storage unavailable'));
        });
      },
      select: async (selection: ServiceAreaSelection | null) => {
        await act(async () => {
          view.rerender({ selection });
        });
      },
    };
  };

  /** A's clear is pending; B has started and reached `cache_failed`. */
  const bFailedWhileAPending = async () => {
    const harness = renderTwoRuns();

    // A gets as far as its compare-and-clear, which never answers yet.
    act(() => {
      harness.result.current.begin(TARGET);
    });
    await harness.settleCache(TARGET, ok);
    await waitFor(() => {
      expect(harness.clearSelectionIfUnchanged).toHaveBeenCalledWith(TARGET);
    });

    // B is selected and its own withdrawal fails.
    await harness.select(OTHER);
    act(() => {
      harness.result.current.begin(OTHER);
    });
    await harness.settleCache(OTHER, refused);
    await waitFor(() => {
      expect(harness.result.current.state).toEqual({ kind: 'cache_failed', target: OTHER });
    });

    return harness;
  };

  it('leaves B’s error in place when A’s clear then succeeds', async () => {
    const harness = await bFailedWhileAPending();

    await harness.settleClear(TARGET, 'invalidated');

    // A's success is not B's to inherit: it must not become `idle`.
    expect(harness.result.current.state).toEqual({ kind: 'cache_failed', target: OTHER });
    expect(harness.cleared).not.toHaveBeenCalled();
  });

  it('leaves B’s error in place when A’s clear then rejects', async () => {
    const harness = await bFailedWhileAPending();

    await harness.rejectClear(TARGET);

    // And A's failure is not B's to display.
    expect(harness.result.current.state).toEqual({ kind: 'cache_failed', target: OTHER });
  });

  it('lets B’s retry still work after A has completed', async () => {
    /**
     * The consequence that made the bug worse than a wrong label: A's completion cleared the shared `inFlight`, so
     * B's retry started a run whose token was no longer current and which therefore reported nothing at all.
     */
    const harness = await bFailedWhileAPending();

    await harness.settleClear(TARGET, 'invalidated');

    act(() => {
      harness.result.current.retry();
    });

    await waitFor(() => {
      expect(
        harness.order.filter((entry) => entry === `invalidate:${OTHER.serviceAreaId}`),
      ).toHaveLength(2);
    });
  });

  it('does not let A’s success clear the run B has in flight', async () => {
    const harness = renderTwoRuns();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await harness.settleCache(TARGET, ok);
    await waitFor(() => {
      expect(harness.clearSelectionIfUnchanged).toHaveBeenCalledWith(TARGET);
    });

    // B starts and is still invalidating.
    await harness.select(OTHER);
    act(() => {
      harness.result.current.begin(OTHER);
    });
    await waitFor(() => {
      expect(harness.result.current.state).toEqual({ kind: 'invalidating', target: OTHER });
    });

    // A finishes. B must still be invalidating, not idle.
    await harness.settleClear(TARGET, 'invalidated');

    expect(harness.result.current.state).toEqual({ kind: 'invalidating', target: OTHER });

    // And B can still finish for itself.
    await harness.settleCache(OTHER, refused);

    expect(harness.result.current.state).toEqual({ kind: 'cache_failed', target: OTHER });
  });

  it('supersedes A immediately when B begins', async () => {
    const harness = renderTwoRuns();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await waitFor(() => {
      expect(harness.result.current.state).toEqual({ kind: 'invalidating', target: TARGET });
    });

    await harness.select(OTHER);
    act(() => {
      harness.result.current.begin(OTHER);
    });

    await waitFor(() => {
      expect(harness.result.current.state).toEqual({ kind: 'invalidating', target: OTHER });
    });

    // A's barrier answers late and reports nothing.
    await harness.settleCache(TARGET, refused);

    expect(harness.result.current.state).toEqual({ kind: 'invalidating', target: OTHER });
  });

  it('will not let a retry captured while A failed operate on B', async () => {
    /**
     * The callback outlives the surface it belonged to. Once the selection has moved, pressing it must do nothing
     * at all — not retry A, whose withdrawal is no longer anyone's concern, and certainly not run against B.
     */
    const harness = renderTwoRuns();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await harness.settleCache(TARGET, refused);
    await waitFor(() => {
      expect(harness.result.current.state).toEqual({ kind: 'cache_failed', target: TARGET });
    });

    // Captured while A was the failure on screen.
    const staleRetry = harness.result.current.retry;

    await harness.select(OTHER);

    const before = [...harness.order];

    act(() => {
      staleRetry();
    });
    await act(async () => {});

    // Nothing was requested for either area.
    expect(harness.order).toEqual(before);
    expect(harness.result.current.state.kind).toBe('idle');
  });

  it('reports idle only for the run that actually completed', async () => {
    // The ordinary path, unchanged: a current withdrawal that succeeds reaches idle and reports the clear.
    const harness = renderTwoRuns();

    act(() => {
      harness.result.current.begin(TARGET);
    });
    await harness.settleCache(TARGET, ok);
    await waitFor(() => {
      expect(harness.clearSelectionIfUnchanged).toHaveBeenCalledWith(TARGET);
    });
    await harness.settleClear(TARGET, 'invalidated');

    expect(harness.result.current.state.kind).toBe('idle');
    expect(harness.cleared).toHaveBeenCalledOnce();
  });
});
