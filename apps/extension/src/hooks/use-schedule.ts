import { useCallback, useEffect, useRef, useState } from 'react';
import { type ProviderVerification, verificationSignature } from '@/src/hooks/use-catalogue';
import { createMessagingClient, type MessagingClient } from '@/src/messaging/client';
import type { RestoredSchedulePayload, ServiceAreaSummary } from '@/src/messaging/contract';
import {
  type SourceCalendar,
  type SourceWindow,
  sameSourceCalendar,
  sameSourceWindow,
  toSourceCalendar,
} from '@/src/schedule/capability';
import { deriveTargetRange, intersectRanges, isWithinRange } from '@/src/schedule/schedule-range';
import {
  deriveScheduleView,
  type LiveRefreshPhase,
  type ScheduleView,
} from '@/src/schedule/view-state';
import type { ServiceAreaSelection } from '@/src/storage/settings';

/**
 * Loads the schedule for the selected area.
 *
 * Startup is **two independent paths**, not one sequence. The cached restore paints first and never waits
 * for the network, because requiring a live capability lookup would mean the offline case — the case the
 * cache exists for — could not render at all. The live refresh runs alongside it.
 *
 * A later successful capability response is authoritative:
 *
 * - matching the snapshot: the displayed range stands and the events request proceeds;
 * - a changed zone or window: the target range is recomputed and the displayed cache re-evaluated
 *   **before** any events request, because a corrected zone can move the local date and a moved window can
 *   turn full coverage into partial;
 * - now unavailable: the cached schedule stops being presented, no events request is issued, and the
 *   caller is told to invalidate the stored selection.
 *
 * Every attempt carries a monotonically increasing identifier and a reply that is not the latest is
 * discarded. `runtime.sendMessage` offers the sender no cancellation, so this discard rule — not
 * cancellation — is what stops an older provider, area, or range response from overwriting a newer one.
 */

export interface UseScheduleInput {
  readonly selection: ServiceAreaSelection | null;
  /**
   * What the catalogue has established about the stored provider.
   *
   * No member issues a provider-specific request except `offered`, and none of them gates the local cache
   * restore, so an offline start is never held behind the network:
   *
   * - `pending` — nothing established yet. The refresh stays in flight, so a restored cache reads as
   *   refreshing and an empty one as loading.
   * - `offered` — the ordinary path: areas, then events.
   * - `rejected` — authoritative. The selection is invalidated, its cache stops being presented, and no
   *   provider-specific request is issued.
   * - `failed` — the catalogue could not be read. The failure becomes the refresh's failure, so a restored
   *   cache reads as offline or refresh-failed and an empty one as an error. It never sits pending forever.
   */
  readonly providerVerification: ProviderVerification;
  /**
   * Reports that a **successful** response says this area can no longer be served.
   *
   * Called synchronously, the moment the conclusion is reached, and carrying the exact area it is about. It is a
   * *report*, not a cleanup: the receiver owns the ordered invalidation — cache first, acknowledged, then the
   * persisted selection — because those two steps fail and retry differently. This hook has already stopped
   * presenting the schedule by the time this is called.
   */
  readonly onAreaUnavailable: (target: ServiceAreaSelection) => void;
  readonly client?: MessagingClient;
  readonly now?: () => Date;
}

export interface UseScheduleResult {
  readonly view: ScheduleView;
  readonly refresh: () => void;
}

/**
 * Which schedule a piece of state is about.
 *
 * Every stored value names its key, so nothing can survive a selection change by accident. The two states below
 * are read only when their key equals the current one, which makes a stale value invisible in the very render the
 * selection changes rather than one commit later.
 */
const cacheKeyOf = (providerId: string | null, serviceAreaId: string | null): string | null =>
  providerId === null || serviceAreaId === null ? null : `${providerId}|${serviceAreaId}`;

/**
 * What the local cache restored, for one key.
 *
 * Separate state from the live phase, and that separation is the fix. Both used to live in one object updated by
 * one effect, so a verification transition — `pending` to `offered`, which says nothing whatsoever about the cache
 * — re-ran that effect, reset the whole object, and wiped an already-displayed cached schedule. The popup flashed
 * from a rendered schedule back to a loading spinner and issued a second restore for the same key.
 */
interface RestoreState {
  readonly key: string | null;
  readonly restored: RestoredSchedulePayload | undefined;
}

/** Where the live refresh has got to, for one key. Stated, never inferred from what is missing. */
interface LiveState {
  readonly key: string | null;
  readonly phase: LiveRefreshPhase;
}

const NO_RESTORE: RestoreState = { key: null, restored: undefined };

/** A fresh attempt starts with the refresh in flight, which is a phase and not a failure. */
const PENDING_LIVE: LiveState = { key: null, phase: { kind: 'pending' } };

const findArea = (
  areas: readonly ServiceAreaSummary[],
  serviceAreaId: string,
): ServiceAreaSummary | undefined => areas.find((area) => area.id === serviceAreaId);

/** The zone and window the cached response itself was validated with. */
const snapshotOf = (restored: RestoredSchedulePayload): SourceCalendar => ({
  timeZone: restored.schedule.provenance.timeZone,
  validity: restored.schedule.provenance.validity,
});

/**
 * Re-decides what a restored entry covers against an authoritative window.
 *
 * The worker derives the restore from the entry's own snapshot, because it must answer without touching
 * the network. Once the live capability arrives it may disagree — a corrected zone moves the local date,
 * and a moved window can turn full coverage into partial — and the entry's served range then has to be
 * intersected with the range the live capability implies. Both facts are here, so this needs no second
 * message and no request.
 *
 * `null` means the entry no longer overlaps what is wanted, so no cached event may be shown at all.
 */
/**
 * Whether a restored entry's evaluation still describes what is being asked for.
 *
 * Both halves are load-bearing:
 *
 * - the **source metadata**, because a corrected zone moves the local date and a moved validity window can turn
 *   full coverage into partial;
 * - the **derived requested range**, because it is derived from that metadata *and the current source-local
 *   date*. Every field of the metadata can be identical across a source-local midnight while the range has
 *   advanced by a day — which is exactly the case that used to slip through. The entry then kept yesterday's
 *   `requestedRange` and yesterday's full-coverage claim, so the popup stated coverage of a period that now
 *   extended one day beyond anything the entry held, and a stale event a day behind the window stayed visible.
 *
 * Comparing the range is what makes the moving window real rather than something only a fresh response can
 * discover — and it has to be decided **before** the events request, so a failed refresh leaves a correctly
 * re-evaluated cache behind rather than an optimistic one.
 */
const stillStands = (
  restored: RestoredSchedulePayload,
  calendar: SourceCalendar,
  requestedRange: SourceWindow,
): boolean =>
  sameSourceCalendar(snapshotOf(restored), calendar) &&
  sameSourceWindow(restored.requestedRange, requestedRange);

const reEvaluateAgainst = (
  restored: RestoredSchedulePayload,
  requestedRange: SourceWindow,
): RestoredSchedulePayload | null => {
  const intersection = intersectRanges(restored.schedule.servedRange, requestedRange);

  if (intersection === undefined) {
    return null;
  }

  return {
    ...restored,
    coverage: intersection.coverage,
    displayRange: intersection.displayRange,
    requestedRange,
    schedule: {
      ...restored.schedule,
      events: restored.schedule.events.filter((event) =>
        isWithinRange(event.date, intersection.displayRange),
      ),
    },
  };
};

export const useSchedule = ({
  selection,
  providerVerification,
  onAreaUnavailable,
  client,
  now,
}: UseScheduleInput): UseScheduleResult => {
  const [restore, setRestore] = useState<RestoreState>(NO_RESTORE);
  const [live, setLive] = useState<LiveState>(PENDING_LIVE);
  const [attempt, setAttempt] = useState(0);

  /** The identifier of the newest attempt of each path. A reply carrying anything older is discarded. */
  const latestRestore = useRef(0);
  const latestLive = useRef(0);

  /**
   * Held in refs rather than in the dependency list, so an inline callback or clock from a caller cannot
   * make this refetch on every render. Only the selection and an explicit refresh start new work.
   *
   * The verification belongs here for the same reason and one more: it is *derived* by the caller, so it is
   * a new object on every render even when the catalogue has said nothing new. Depending on the object made
   * an unrelated state update — a restored cache landing, a live schedule arriving — look like fresh news
   * about the provider, which reset the phase to pending, superseded the attempt that had just answered,
   * and asked for the areas and the events all over again. What the effect depends on instead is
   * `verificationSignature`, so it re-runs when the verdict *says* something different and not before.
   */
  const dependencies = useRef({ client, now, onAreaUnavailable, providerVerification });

  dependencies.current = { client, now, onAreaUnavailable, providerVerification };

  const refresh = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const providerId = selection?.providerId ?? null;
  const serviceAreaId = selection?.serviceAreaId ?? null;
  const cacheKey = cacheKeyOf(providerId, serviceAreaId);
  /** A primitive, so an equal-but-new verdict is not new work. */
  const verificationKey = verificationSignature(providerVerification);

  /**
   * The restore path's newest run, published so the live path can order itself against it without reading state
   * React has not committed yet — and without the two paths sharing a single effect again.
   *
   * Written by the effect below and read by the effect after it, which is sound because React runs effects in
   * declaration order: the restore effect has always published its promise before the live effect body runs. A
   * verification transition re-runs only the live effect, which then finds the promise the unchanged restore
   * path already put there.
   *
   * Identified by `latestRestore`'s counter rather than by the key and the attempt. Those two are not a unique
   * identity — selecting A, then B, then A again with no refresh in between produces the same pair twice — and
   * anything comparing against a repeatable identity would mistake the returning selection for the earlier one.
   * The counter only ever increases, so no run can be confused with another.
   */
  const restorePromise = useRef<{
    readonly attempt: number;
    readonly value: Promise<RestoredSchedulePayload | null>;
  } | null>(null);

  /** The restore run whose entry an authoritative response has withdrawn. */
  const withdrawnRestore = useRef(0);

  /**
   * Path A — the local cache. Keyed by the selection alone, and deliberately **not** by the verification.
   *
   * It starts as soon as there is a selection and never waits for the catalogue, which is what makes an
   * offline start render at all. Because the verdict is not a dependency, news about the provider cannot
   * restore the same key a second time, and one selection restores exactly once per attempt.
   */
  useEffect(() => {
    latestRestore.current += 1;

    const thisAttempt = latestRestore.current;

    if (providerId === null || serviceAreaId === null) {
      restorePromise.current = null;

      return;
    }

    const messaging = dependencies.current.client ?? createMessagingClient();
    const value = messaging.restoreCachedSchedule({ providerId, serviceAreaId }).then((result) => {
      const restored = result.ok ? result.data : null;

      // Applied even when there is nothing stored, which is how a key with no cache states that rather than
      // leaving the previous key's answer to be checked. A withdrawn calendar is never repainted: the live
      // path marks this run before it clears, because that reply belongs to the same run and the counter
      // therefore still reads as current.
      if (latestRestore.current === thisAttempt && withdrawnRestore.current !== thisAttempt) {
        setRestore({ key: cacheKey, restored: restored ?? undefined });
      }

      return restored;
    });

    restorePromise.current = { attempt: thisAttempt, value };

    return () => {
      latestRestore.current += 1;
    };
  }, [providerId, serviceAreaId, attempt, cacheKey]);

  /**
   * Path B — the live verification and refresh. Owns the refresh phase and nothing else.
   *
   * It may say a refresh is in flight, has failed, or has delivered, and it may replace the cache with a
   * trustworthy current response. What it can no longer do is erase a restored schedule for the same key
   * merely because the verdict moved on: the cache lives in its own state above, so a `pending` to `offered`
   * transition re-runs this effect alone and leaves the displayed events exactly where they are.
   */
  useEffect(() => {
    latestLive.current += 1;

    const thisAttempt = latestLive.current;
    const isCurrent = (): boolean => latestLive.current === thisAttempt;

    setLive({ key: cacheKey, phase: { kind: 'pending' } });

    if (providerId === null || serviceAreaId === null) {
      return;
    }

    // Read through the ref, so the effect uses the current verdict while depending only on what it says.
    const verification = dependencies.current.providerVerification;
    const messaging = dependencies.current.client ?? createMessagingClient();
    const clock = dependencies.current.now ?? (() => new Date());
    const reportUnavailable = dependencies.current.onAreaUnavailable;
    const target = { providerId, serviceAreaId };

    const applyPhase = (phase: LiveRefreshPhase): void => {
      if (isCurrent()) {
        setLive({ key: cacheKey, phase });
      }
    };

    /**
     * Withdraws the cached schedule of the restore run in progress.
     *
     * The two writes belong together: marking the run is what stops a restore that is still in flight from
     * painting the withdrawn calendar back a moment later, and it has to happen before the state is cleared
     * rather than after. `isCurrent()` does not catch that reply, because it belongs to the same run.
     */
    const withdrawRestored = (): void => {
      withdrawnRestore.current = latestRestore.current;

      if (isCurrent()) {
        setRestore({ key: cacheKey, restored: undefined });
      }
    };

    /**
     * Stops presenting a selection a **successful** response says can no longer be served.
     *
     * One helper for both authoritative outcomes — a catalogue that no longer offers the provider, and an area
     * list that either omits the area or reports it publishing nothing — because they are the same conclusion.
     *
     * **Presentation only, and synchronous.** A calendar that has stopped being published must stop being shown
     * the moment that is known, not when a cleanup finishes and never for as long as extension storage takes to
     * answer. Nothing here is awaited, so nothing can delay it.
     *
     * The cleanup — invalidating the cache, waiting for the worker to confirm it, then compare-and-clearing the
     * persisted selection — deliberately does **not** happen here. It is an ordered sequence whose two steps fail
     * differently and retry differently, and it used to be attempted from inside this effect while the callback it
     * ended with dispatched the selection clear on its own: any ordering established here was undone by the
     * callback. `useWithdrawal` owns that sequence now, and this reports the conclusion to it.
     *
     * The **exact withdrawn target** is what is reported, never left to be inferred from whatever the popup is
     * showing by then. The sequence awaits a round trip in the middle, so "the current selection" can have moved
     * on; inferring it would compare-and-clear an area nothing had withdrawn.
     */
    const withdrawAuthoritatively = (): void => {
      withdrawRestored();
      applyPhase({ kind: 'superseded' });

      reportUnavailable(target);
    };

    const livePath = async (): Promise<void> => {
      if (verification.kind === 'pending') {
        // The catalogue has not answered yet. Nothing is established, so no provider-specific request is
        // issued and the refresh stays in flight — a restored cache reads as refreshing, not as a failure.
        return;
      }

      if (verification.kind === 'failed') {
        /**
         * The catalogue could not be read, so this provider's areas cannot be requested — but a refresh that
         * cannot start is still a refresh that will not deliver, and leaving the phase pending would strand
         * the popup on a loading spinner with no way to say why. The catalogue's own failure becomes the
         * refresh's failure, which is what turns a restored cache into an honest offline or refresh-failed
         * label and an empty one into the matching error state.
         *
         * Still no provider-specific request: the failure is about reaching the API at all.
         */
        applyPhase({ kind: 'failed', failure: verification.failure });

        return;
      }

      if (verification.kind === 'rejected') {
        // A successful catalogue says this provider is demo data or is no longer offered. Same conclusion as a
        // withdrawn calendar, so the same withdrawal — and no provider-specific request is issued at all.
        withdrawAuthoritatively();

        return;
      }

      const areas = await messaging.listServiceAreas(providerId);

      /**
       * Stop here if the selection moved while that request was in flight.
       *
       * Checked **before** anything is read out of the answer, because everything below it is a side effect about
       * `providerId`/`serviceAreaId` — the area this attempt was started for, which is no longer the area anyone is
       * looking at. Each of them was reachable:
       *
       * - `withdrawAuthoritatively` reported the *old* area as withdrawn, which sent the popup into a withdrawal
       *   for it: a cache invalidation and a compare-and-clear for a selection nobody holds any more.
       * - the same call marked the newest restore run as withdrawn — `withdrawnRestore` is keyed on whichever run
       *   is current — so the **new** area's cache was suppressed by a conclusion about the old one.
       * - the collection-events request below fetched and cached a schedule for the replaced area.
       *
       * The phase is not touched either: a superseded attempt reporting its failure would overwrite the state of
       * the attempt that replaced it.
       */
      if (!isCurrent()) {
        return;
      }

      if (!areas.ok) {
        applyPhase({ kind: 'failed', failure: areas.failure });

        return;
      }

      const area = findArea(areas.data, serviceAreaId);
      const calendar = area === undefined ? undefined : toSourceCalendar(area.collectionEvents);

      if (calendar === undefined) {
        /**
         * Authoritative, and for either of two reasons: the area is not in this complete list at all, or it is
         * and it publishes no calendar. Both are conclusions drawn from a **successful** response, so both are
         * withdrawn identically — matching the reminder, which routes the same two outcomes and an unoffered
         * provider through one helper. A request that *failed* is handled above and infers nothing.
         */
        withdrawAuthoritatively();

        return;
      }

      /**
       * One reading of the clock, captured before anything is derived from it.
       *
       * Calling the clock again for the comparison below could read a different source-local day than the range
       * was derived in, so a single decision would straddle midnight internally and reach a conclusion that was
       * true at neither instant.
       */
      const at = clock();
      const requested = deriveTargetRange(calendar, at);

      if (requested.kind === 'outside_validity') {
        // No events request is issued, and the state says so explicitly. The cache is left alone: the view
        // states the window before it considers a restored entry, so nothing stale is shown either way, and
        // an entry the source has not withdrawn is not this path's to delete.
        applyPhase({ kind: 'outside_validity' });

        return;
      }

      if (requested.kind === 'unusable_zone') {
        /**
         * The zone could not be resolved, so there is no range to ask for.
         *
         * Every boundary validates zones now, so this is a defect rather than an expected input — which is
         * exactly why it must land in a *stated* failure instead of nothing at all. Left unhandled, the
         * derivation threw inside this effect, the phase stayed pending, and the popup showed a loading
         * spinner that never resolved with no way to retry.
         *
         * Reported as an unreadable response, because that is what it is: the API's answer carried a zone
         * this runtime cannot use. `status: 0` follows the worker's convention for a failure where no HTTP
         * status is the honest answer. Crucially, no collection-events request is issued.
         */
        applyPhase({
          kind: 'failed',
          failure: { kind: 'invalid_response', operation: 'listCollectionEvents', status: 0 },
        });

        return;
      }

      // The displayed cache is re-evaluated against the authoritative window **before** the events request.
      // Awaiting path A's own promise is what makes that ordering real rather than incidental, and reading it
      // by run is what keeps a promise from a superseded selection out of it.
      const published = restorePromise.current;
      const restored =
        published !== null && published.attempt === latestRestore.current
          ? await published.value
          : null;

      // The restore can resolve after the selection changed, and everything below asks about this attempt's area.
      if (!isCurrent()) {
        return;
      }

      if (restored !== null && !stillStands(restored, calendar, requested.range)) {
        // Either the operator changed the zone or the window, or the requested range has moved on since the
        // entry was evaluated. Both mean what the cache covers is decided again from the authoritative range
        // rather than kept from an evaluation that no longer describes what is being asked for.
        const reEvaluated = reEvaluateAgainst(restored, requested.range);

        if (isCurrent() && withdrawnRestore.current !== latestRestore.current) {
          setRestore({ key: cacheKey, restored: reEvaluated ?? undefined });
        }
      }

      const schedule = await messaging.listCollectionEvents({
        providerId,
        serviceAreaId,
        from: requested.range.from,
        to: requested.range.to,
      });

      // Newest-selection-wins, stated once here rather than relied on inside each writer below.
      if (!isCurrent()) {
        return;
      }

      if (!schedule.ok) {
        // The cache stays exactly as it is. A refresh that failed is the one moment a stored schedule is
        // most worth showing, and it is labelled as stored either way.
        applyPhase({ kind: 'failed', failure: schedule.failure });

        return;
      }

      // The worker says which of the two this is. A response older than the stored entry comes back as that
      // entry, restored against the range that was requested, and is shown as a cache — never relabelled
      // with a live response's freshness.
      if (schedule.data.kind === 'live') {
        applyPhase({ kind: 'succeeded', schedule: schedule.data.schedule });

        return;
      }

      if (isCurrent()) {
        setRestore({ key: cacheKey, restored: schedule.data.restored });
      }

      applyPhase({ kind: 'retained_newer_cache', restored: schedule.data.restored });
    };

    void livePath();

    return () => {
      // Bumping the counter is what supersedes any reply still in flight.
      latestLive.current += 1;
    };
  }, [providerId, serviceAreaId, attempt, verificationKey, cacheKey]);

  /**
   * Only what belongs to the selection on screen is rendered.
   *
   * Checked here rather than trusted from the effects, so a value left over from a previous key disappears in
   * the very render the selection changes instead of one commit later — and so a reply from an older key that
   * somehow survives its cleanup still cannot repaint anything.
   */
  const view = deriveScheduleView({
    hasSelection: selection !== null,
    ...(restore.key === cacheKey && restore.restored !== undefined
      ? { restored: restore.restored }
      : {}),
    phase: live.key === cacheKey ? live.phase : { kind: 'pending' },
  });

  return { view, refresh };
};
