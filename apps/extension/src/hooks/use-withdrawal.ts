import { useCallback, useEffect, useRef, useState } from 'react';
import { createMessagingClient, type MessagingClient } from '@/src/messaging/client';
import type { SelectionInvalidationPayload } from '@/src/messaging/contract';
import type { ServiceAreaSelection } from '@/src/storage/settings';

/**
 * Discarding everything the extension holds for an area a **successful** response can no longer serve.
 *
 * The **one** place the order is decided, for all three authoritative outcomes — a catalogue that no longer offers
 * the provider, an area list that omits the area, and an area that publishes no calendar. They are the same
 * conclusion, and three implementations of "clean this up" is how they came to differ.
 *
 * The order is not a preference. Each step is only safe once the one before it has finished:
 *
 * 1. The schedule stops being presented. That happens in `useSchedule`, synchronously, before anything here is
 *    reached — a withdrawn calendar must stop being shown the moment that is known, never when a cleanup finishes.
 * 2. The **cache** is invalidated, and this waits for the worker to acknowledge it. Advancing the generation is
 *    what makes a collection-events request already in flight unusable; waiting for the acknowledgement is what
 *    turns that from a hope into a barrier. Whether the stored entry could actually be removed is deliberately not
 *    part of the answer — that is best-effort, and holding the withdrawal for it would leave a selection pointing
 *    at a withdrawn area on any device whose storage was refusing writes.
 * 3. Only then is the persisted **selection** compare-and-cleared. Doing it earlier left a window in which
 *    nothing pointed at the area while its entry was still on disk and its generation had not moved — so a
 *    response in flight could rewrite the cache for an area with no selection left to re-validate it against.
 *
 * Which is why this hook exists at all rather than the schedule calling a single "it's gone" callback: that
 * callback dispatched the selection clear, so *any* ordering inside the schedule was undone by the callback
 * itself. Local presentation state and the persisted mutation are separate concerns with separate owners, and
 * this owns the second.
 *
 * Both failures are recoverable and they recover **differently**, which is the other reason the two steps cannot
 * share one state:
 *
 * - the invalidation was never **acknowledged**: the worker did not answer, or answered with a failure. The
 *   generation advance is what makes an in-flight response unusable, and an unanswered message is no evidence it
 *   happened — so the selection is deliberately *not* cleared, and retrying starts again from the invalidation.
 *   A refused *eviction* is a different thing and does not arrive here: removing the stored entry is best-effort
 *   inside the worker, which acknowledges success regardless, because the generation moved either way.
 * - the cache is gone but the clear refused: the entry stays gone and the schedule stays hidden. Retrying repeats
 *   only the compare-and-clear, because redoing the invalidation would be asking for something already true.
 *
 * Neither ever puts the withdrawn schedule back on screen, and no path here rejects: an unhandled rejection in a
 * popup is invisible, and the surface would sit on a state with nothing coming.
 */

export type WithdrawalState =
  /** Nothing has been withdrawn, which is the state every ordinary session stays in. */
  | { readonly kind: 'idle' }
  | { readonly kind: 'invalidating'; readonly target: ServiceAreaSelection }
  /**
   * The worker never acknowledged the invalidation. The selection is untouched on purpose: without that
   * acknowledgement there is no evidence the generation advanced, so an in-flight response may still be trusted.
   */
  | { readonly kind: 'cache_failed'; readonly target: ServiceAreaSelection }
  | { readonly kind: 'clearing'; readonly target: ServiceAreaSelection }
  /** The entry is gone; only the persisted selection survived. */
  | { readonly kind: 'clear_failed'; readonly target: ServiceAreaSelection };

export interface UseWithdrawalInput {
  /**
   * The selection that is stored **now**.
   *
   * A withdrawal is about one area, and it stops meaning anything the moment that area is no longer the stored
   * one. The worker can move the selection with nobody here watching — another popup choosing a different area,
   * an alarm clearing it — so this is what lets a withdrawal recognize that it has been superseded rather than
   * holding the surface on an error about somewhere nobody is looking.
   */
  readonly selection: ServiceAreaSelection | null;
  readonly clearSelectionIfUnchanged: (
    expected: ServiceAreaSelection,
  ) => Promise<SelectionInvalidationPayload>;
  /**
   * Called once the stored selection really has been cleared.
   *
   * Only then, and never on `superseded`: that answer means somebody chose a different area while this was
   * running, so no transition of this person's happened and none is theirs to react to.
   */
  readonly onCleared?: (() => void) | undefined;
  readonly client?: MessagingClient | undefined;
}

export interface UseWithdrawalResult {
  readonly state: WithdrawalState;
  /** Begins the ordered withdrawal of one area. Safe to call again for the same area. */
  readonly begin: (target: ServiceAreaSelection) => void;
  /** Resumes from whichever step failed. Does nothing when nothing has failed. */
  readonly retry: () => void;
}

const IDLE: WithdrawalState = { kind: 'idle' };

export const useWithdrawal = ({
  selection,
  clearSelectionIfUnchanged,
  onCleared,
  client,
}: UseWithdrawalInput): UseWithdrawalResult => {
  const [state, setState] = useState<WithdrawalState>(IDLE);

  /**
   * The same value, readable synchronously.
   *
   * `retry` has to know which step failed, and a state updater is the wrong place to find out: an updater must be
   * pure, and React is free to call it twice — which would start two sequences from one press.
   */
  const latest = useRef<WithdrawalState>(IDLE);

  const enter = useCallback((next: WithdrawalState): void => {
    latest.current = next;
    setState(next);
  }, []);

  /**
   * Held in refs so `begin` and `retry` stay stable.
   *
   * `begin` is handed to the schedule, which keeps its callbacks in refs of its own; a new function identity on
   * every render would be harmless there but would make this hook's contract depend on that. `retry` is wired to
   * a button.
   */
  const dependencies = useRef({ clearSelectionIfUnchanged, onCleared, client });

  dependencies.current = { clearSelectionIfUnchanged, onCleared, client };

  /**
   * The withdrawal running right now — which area, and under which token.
   *
   * Recorded synchronously, because `begin` can be called more than once for the same conclusion (the schedule may
   * re-derive it) and state cannot be read for that: it is not committed yet when the second call arrives.
   *
   * The **token** is what the target alone could not provide. Every step of a withdrawal is asynchronous, so a run
   * for area A can complete after a run for area B has started — and each of A's three completion paths used to
   * write `inFlight` and the state unconditionally. A's success set `idle`, wiping B's in-progress state; A's
   * failure replaced B's error with one about A; either cleared B's `inFlight`, so B's own completion then looked
   * superseded and did nothing. The result was a surface showing the wrong area's error, or no error at all, with
   * B's retry gone.
   *
   * Monotonic and never reused, so "is this still the current run" is exact rather than a comparison of targets that
   * two consecutive withdrawals of the same area would both satisfy.
   */
  const nextToken = useRef(0);

  const inFlight = useRef<{ readonly token: number; readonly target: ServiceAreaSelection } | null>(
    null,
  );

  /** Whether the run that is asking is still the one this hook is running. */
  const isCurrentRun = (token: number): boolean => inFlight.current?.token === token;

  const keyOf = (target: ServiceAreaSelection): string =>
    `${target.providerId}|${target.serviceAreaId}`;

  /** The stored selection as the same primitive, so a fresh-but-equal object is not a change. */
  const selectionKey = selection === null ? null : keyOf(selection);

  /**
   * Whether a withdrawal is still about the area that is actually selected.
   *
   * `idle` is always relevant — it is the absence of a withdrawal. Anything else names a target, and once the
   * stored selection has moved on, that target is somewhere nobody is looking.
   */
  const describesSelection = useCallback(
    (candidate: WithdrawalState): boolean =>
      candidate.kind === 'idle' || keyOf(candidate.target) === selectionKey,
    [selectionKey],
  );

  /** Step three. Separate, because a failed clear retries only this. */
  const clear = useCallback(
    async (target: ServiceAreaSelection, token: number): Promise<void> => {
      if (!isCurrentRun(token)) {
        return;
      }

      enter({ kind: 'clearing', target });

      try {
        const result = await dependencies.current.clearSelectionIfUnchanged(target);

        // Superseded while the write was in flight. Reporting success here would set `idle` over whatever the run
        // that replaced this one is doing, and clearing `inFlight` would make *that* run look superseded in turn.
        if (!isCurrentRun(token)) {
          return;
        }

        inFlight.current = null;
        enter(IDLE);

        if (result.outcome === 'invalidated') {
          dependencies.current.onCleared?.();
        }
      } catch {
        // Nothing about the error is surfaced: it could name an internal storage path. What the surface needs is
        // that it failed and that it can be tried again — and only if this is still the run being watched, or the
        // error would be about an area nobody asked about.
        if (!isCurrentRun(token)) {
          return;
        }

        inFlight.current = null;
        enter({ kind: 'clear_failed', target });
      }
    },
    [enter],
  );

  /** Step two, then step three. A failed cache retries from here. */
  const invalidateThenClear = useCallback(
    async (target: ServiceAreaSelection, token: number): Promise<void> => {
      if (!isCurrentRun(token)) {
        return;
      }

      enter({ kind: 'invalidating', target });

      const messaging = dependencies.current.client ?? createMessagingClient();
      let acknowledged = false;

      try {
        /**
         * `ok` means the worker **acknowledged** the invalidation — that the generation advanced and nothing in
         * flight can be used. It does not mean the stored entry was removed: that is best-effort inside the
         * worker, which acknowledges success either way, because a selection left pointing at a withdrawn area
         * would be worse than a stale entry nothing can reach.
         */
        acknowledged = (await messaging.invalidateCachedSchedule(target)).ok;
      } catch {
        // No worker answered at all. Indistinguishable from an answering failure as far as what may happen next.
        acknowledged = false;
      }

      // Superseded while the barrier was in flight: neither the failure nor the next step is this run's to report.
      if (!isCurrentRun(token)) {
        return;
      }

      if (!acknowledged) {
        inFlight.current = null;
        enter({ kind: 'cache_failed', target });

        return;
      }

      await clear(target, token);
    },
    [clear, enter],
  );

  const begin = useCallback(
    (target: ServiceAreaSelection) => {
      // The same conclusion reported twice is one withdrawal, not two overlapping ones.
      if (inFlight.current !== null && keyOf(inFlight.current.target) === keyOf(target)) {
        return;
      }

      // A different area supersedes whatever was running the moment this is assigned: the previous run's token
      // stops being current, so none of its completions can write state or clear this one's `inFlight`.
      const token = nextToken.current + 1;

      nextToken.current = token;
      inFlight.current = { token, target };

      void invalidateThenClear(target, token);
    },
    [invalidateThenClear],
  );

  const retry = useCallback(() => {
    const current = latest.current;

    /**
     * Only ever the failure that is currently being shown.
     *
     * A callback captured while area A had failed can outlive that: the surface it belonged to is gone once the
     * selection moves, but the function is still reachable. Checking the target against the selection here is what
     * stops it acting on A — and re-checking the kind is what stops it acting at all once the state has moved on.
     */
    if (!describesSelection(current)) {
      return;
    }

    if (current.kind === 'cache_failed') {
      const token = nextToken.current + 1;

      nextToken.current = token;
      inFlight.current = { token, target: current.target };

      void invalidateThenClear(current.target, token);

      return;
    }

    if (current.kind === 'clear_failed') {
      // Only the compare-and-clear. The entry is already gone, so asking for it again would be asking for
      // something already true — and would reset a barrier that has already served its purpose.
      const token = nextToken.current + 1;

      nextToken.current = token;
      inFlight.current = { token, target: current.target };

      void clear(current.target, token);
    }
  }, [clear, describesSelection, invalidateThenClear]);

  /**
   * A superseded withdrawal is forgotten, so nothing can act on it later.
   *
   * The exposed state below already hides it, which is what removes the stale screen; this is what stops `retry`
   * from being handed an obsolete target if it is ever reachable, and keeps the internal state honest rather than
   * quietly disagreeing with what the surface is rendering.
   */
  useEffect(() => {
    if (!describesSelection(latest.current)) {
      enter(IDLE);
    }

    /**
     * Decided on `inFlight`'s **own** target rather than on the state's.
     *
     * The two normally name the same area — `begin` and `retry` set them together — but clearing one on the other's
     * evidence is the shape of every bug this pass is about. If they ever disagreed, a run that is still current
     * would have its token discarded, and its completion would then silently report nothing at all.
     */
    const running = inFlight.current;

    if (running !== null && keyOf(running.target) !== selectionKey) {
      inFlight.current = null;
    }
  }, [describesSelection, enter, selectionKey]);

  /**
   * Reported as `idle` once the withdrawal no longer describes the stored selection.
   *
   * Derived here as well as forgotten by the effect above, so the reported state is consistent with the selection
   * **within the same render** rather than one commit later. The two are individually sufficient for the outcome a
   * test can observe — the effect settles it before anything can assert — so this is not what makes the fix work;
   * it is what stops this branch, which takes precedence over every selection-based screen, from ever being asked
   * to render an error about an area that is no longer selected.
   */
  return { state: describesSelection(state) ? state : IDLE, begin, retry };
};
