import type { CollectionEvent } from '@abfall-radar/domain';
import { tryToDomainCollectionEvents } from '@/src/adapters/collection-event';
import type {
  GatewayFailure,
  RestoredSchedulePayload,
  SchedulePayload,
  ScheduleProvenance,
} from '@/src/messaging/contract';
import type { SourceWindow } from './capability';
import { isWithinRange, type RangeCoverage } from './schedule-range';

/**
 * One pure function decides every schedule state the popup can render.
 *
 * Scattering these conditions through components is how a surface ends up claiming a period it has no
 * data for. Deriving them in one place means the rules that matter most — that a cached schedule is
 * never labelled fresh, and that a partial intersection is never presented as coverage of the whole
 * requested window — are stated exactly once.
 */

/**
 * Why a cached schedule is on screen.
 *
 * `refreshing` is the one that has to exist. Without it, a restored cache with no failure yet — the ordinary
 * state during the first moments after opening the popup — was labelled as a failed refresh, telling the
 * reader something had gone wrong while the request was still perfectly in flight.
 *
 * `retained_newer` is the opposite case: the refresh **succeeded** and returned a response older than what
 * was already stored. Nothing failed and nothing is offline, so calling it either would be untrue.
 */
export type CachedReason = 'refreshing' | 'offline' | 'refresh_failed' | 'retained_newer';

/**
 * The phase of the live refresh, stated explicitly rather than inferred.
 *
 * The absence of a live result is not evidence that anything failed: it can mean the request has not answered
 * yet, or that a newer selection superseded it. Making the caller name the phase is what stops those from
 * being read as a failure.
 */
export type LiveRefreshPhase =
  /** In flight. Nothing has gone wrong. */
  | { readonly kind: 'pending' }
  | { readonly kind: 'succeeded'; readonly schedule: SchedulePayload }
  /**
   * The request succeeded, but the stored entry was newer, so the worker answered with that entry restored
   * against the requested range. Distinct from `succeeded`, because a restored entry may never be labelled
   * with a live response's freshness.
   */
  | { readonly kind: 'retained_newer_cache'; readonly restored: RestoredSchedulePayload }
  | { readonly kind: 'failed'; readonly failure: GatewayFailure }
  /** A newer attempt replaced this one. Never a failure: the user themselves moved on. */
  | { readonly kind: 'superseded' }
  /** The source publishes no calendar for the current period, so no request was issued. */
  | { readonly kind: 'outside_validity' };

export type ScheduleView =
  /** No area chosen. Nothing is preselected, fetched, or reminded about. */
  | { readonly kind: 'needs_selection' }
  | { readonly kind: 'loading' }
  /** A current response. The only state that may be labelled fresh. */
  | {
      readonly kind: 'live';
      readonly freshness: 'fresh' | 'stale';
      readonly events: CollectionEvent[];
      readonly provenance: ScheduleProvenance;
      readonly displayRange: SourceWindow;
    }
  /**
   * A restored cache entry. Always labelled with its own retrieval time and never as fresh, and it states
   * whether it covers the requested window in full or only in part.
   *
   * `reason` says **why** the cache is what is being shown, and `refreshing` is one of the answers: a refresh
   * that has not answered yet is a phase, not a failure.
   */
  | {
      readonly kind: 'cached';
      readonly reason: CachedReason;
      readonly coverage: RangeCoverage;
      readonly events: CollectionEvent[];
      readonly provenance: ScheduleProvenance;
      readonly displayRange: SourceWindow;
      /**
       * The range that was asked for, alongside the range that is covered.
       *
       * Both are needed to describe a partial cache truthfully, because an intersection can fall short at
       * **either** end: a window that has moved forward leaves an uncovered head, a served range that ends
       * early leaves an uncovered tail, and a narrow entry inside a wide window leaves both. With only
       * `displayRange` on hand a surface can tell that something is missing but not which side, so it
       * defaults to naming the tail — and says data is missing after a date when what is actually missing
       * is the days before it.
       */
      readonly requestedRange: SourceWindow;
      readonly storedAt: string;
    }
  /** The source publishes no calendar for the current period. Not an error and not an empty schedule. */
  | { readonly kind: 'range_not_covered' }
  /** Nothing trustworthy is available at all. */
  | { readonly kind: 'error'; readonly failure: GatewayFailure };

export interface ScheduleViewInput {
  readonly hasSelection: boolean;
  /** A restored cache entry, when one exists. */
  readonly restored?: RestoredSchedulePayload | undefined;
  /** Where the live refresh has got to. Required, so no phase can be inferred from an absence. */
  readonly phase: LiveRefreshPhase;
}

/**
 * A failure that means the API could not be reached at all, as opposed to one it answered.
 *
 * The distinction decides whether a restored cache is labelled offline or refresh-failed, which is what
 * tells a person whether to check their connection.
 */
const isOffline = (failure: GatewayFailure): boolean =>
  failure.kind === 'network' || failure.kind === 'timeout';

/**
 * A cancellation is never a failure to show.
 *
 * It means a newer selection superseded an older request — work the user themselves replaced. Rendering an
 * error for it would blame the product for something the person just did.
 */
const isSupersession = (phase: LiveRefreshPhase): boolean =>
  phase.kind === 'superseded' || (phase.kind === 'failed' && phase.failure.kind === 'cancelled');

/** The failure worth reporting, if the phase carries one at all. */
const reportableFailure = (phase: LiveRefreshPhase): GatewayFailure | undefined =>
  phase.kind === 'failed' && !isSupersession(phase) ? phase.failure : undefined;

const cachedReasonFor = (phase: LiveRefreshPhase): CachedReason => {
  if (phase.kind === 'retained_newer_cache') {
    return 'retained_newer';
  }

  const failure = reportableFailure(phase);

  if (failure === undefined) {
    // Pending or superseded: a refresh is in flight or about to be, and nothing has gone wrong.
    return 'refreshing';
  }

  return isOffline(failure) ? 'offline' : 'refresh_failed';
};

/**
 * A schedule that could not be mapped onto the domain at all.
 *
 * Stated rather than thrown, because this function runs during React rendering: an exception here takes the popup
 * down with no error boundary to catch it. `status: 0` follows the worker's convention for a failure no HTTP
 * status describes — the response arrived and is unusable.
 */
const UNUSABLE: ScheduleView = {
  kind: 'error',
  failure: { kind: 'invalid_response', operation: 'listCollectionEvents', status: 0 },
};

/**
 * The one place a restored entry becomes a view, so its coverage and display range are never bypassed.
 *
 * `null` when the events cannot be mapped, which the caller turns into the error state above.
 */
const cachedView = (
  restored: RestoredSchedulePayload,
  reason: CachedReason,
): Extract<ScheduleView, { kind: 'cached' }> | null => {
  // Already bounded to the intersection by the worker; filtered again here so this function's output cannot
  // claim more than its own `displayRange` regardless of what it was handed.
  const events = tryToDomainCollectionEvents(
    restored.schedule.events.filter((event) => isWithinRange(event.date, restored.displayRange)),
  );

  if (events === null) {
    return null;
  }

  return {
    kind: 'cached',
    reason,
    coverage: restored.coverage,
    events,
    provenance: restored.schedule.provenance,
    displayRange: restored.displayRange,
    requestedRange: restored.requestedRange,
    storedAt: restored.storedAt,
  };
};

export const deriveScheduleView = ({
  hasSelection,
  restored,
  phase,
}: ScheduleViewInput): ScheduleView => {
  if (!hasSelection) {
    return { kind: 'needs_selection' };
  }

  /**
   * A current response replaces a restored one, which is the only moment a cached label may be dropped.
   *
   * Both delivered phases are decided here, ahead of `restored`, and that ordering is the whole guarantee that
   * a late cache restore cannot paint over an answer: the caller no longer has to check the phase before it
   * stores what the cache gave back, because a stored entry is only ever consulted for a refresh that has not
   * delivered one.
   */
  if (phase.kind === 'succeeded') {
    const events = tryToDomainCollectionEvents(phase.schedule.events);

    if (events === null) {
      return UNUSABLE;
    }

    return {
      kind: 'live',
      freshness: phase.schedule.provenance.freshness,
      events,
      provenance: phase.schedule.provenance,
      displayRange: phase.schedule.servedRange,
    };
  }

  // The refresh succeeded with an older response, so the newer stored entry is what is shown — as a cache,
  // with its own storage time and the coverage of the range that was requested.
  if (phase.kind === 'retained_newer_cache') {
    return cachedView(phase.restored, 'retained_newer') ?? UNUSABLE;
  }

  if (
    phase.kind === 'failed' &&
    phase.failure.kind === 'problem' &&
    phase.failure.code === 'SCHEDULE_RANGE_NOT_COVERED'
  ) {
    // Its own state rather than a generic error: the range genuinely is not covered, which is a statement
    // about the source rather than a fault.
    return { kind: 'range_not_covered' };
  }

  // Checked before a restored entry: with today outside the declared window there is no range to request
  // and nothing a cache could cover, so this is the honest statement rather than a stale schedule.
  if (phase.kind === 'outside_validity') {
    return { kind: 'range_not_covered' };
  }

  if (restored !== undefined) {
    return cachedView(restored, cachedReasonFor(phase)) ?? UNUSABLE;
  }

  const failure = reportableFailure(phase);

  if (failure !== undefined) {
    return { kind: 'error', failure };
  }

  // Pending, or superseded with nothing cached: an answer simply does not exist yet, which is not a failure.
  return { kind: 'loading' };
};

/**
 * Whether a selected waste type is one the source declares it publishes.
 *
 * `coverage.wasteTypes` is the source's own declaration, so an empty result inside a covered range means
 * "no collection in this period", while a waste type absent from the declaration means "this source does
 * not publish it". Conflating them would turn a gap in coverage into a claim about the calendar.
 */
export const undeclaredWasteTypes = (
  provenance: ScheduleProvenance,
  selected: readonly CollectionEvent['type'][],
): CollectionEvent['type'][] => selected.filter((type) => !provenance.coverage.includes(type));

/**
 * The start of a timed window, or the empty string for an all-day collection.
 *
 * The empty string sorts before every ISO datetime, so an all-day collection precedes a timed one on the same
 * date without a branch deciding it. That is the honest order too: an all-day event names no time, so it cannot
 * be placed after something that does.
 */
const startsAtOf = (event: CollectionEvent): string =>
  event.timing.kind === 'time_window' ? event.timing.startsAt : '';

/**
 * A total order over collection events, so which one comes "first" is a fact rather than an artefact of the
 * order a response happened to arrive in.
 *
 * Nothing in the contract promises the API, a cache restore, or a range intersection returns events in date
 * order. Two consumers depended on that anyway: the dashboard took the first element as the next collection,
 * and the reminder took the first match on the reminder date — so an unsorted response put the wrong date under
 * "Nächste Abholung", and two collections on one day could produce a notification naming either of them.
 *
 * Shared rather than duplicated per surface, because a second comparator is how the popup and the notification
 * come to disagree about which collection is next. Every comparison is on a validated field, and `id` is unique
 * per event, so the order is **total**: it does not depend on the sort being stable, and two runs over the same
 * set cannot disagree.
 */
export const byDisplayOrder = (left: CollectionEvent, right: CollectionEvent): number => {
  if (left.date !== right.date) {
    // Calendar dates, compared lexicographically. Both are `YYYY-MM-DD`, so no instant is involved.
    return left.date < right.date ? -1 : 1;
  }

  const leftStart = startsAtOf(left);
  const rightStart = startsAtOf(right);

  if (leftStart !== rightStart) {
    return leftStart < rightStart ? -1 : 1;
  }

  if (left.type !== right.type) {
    return left.type < right.type ? -1 : 1;
  }

  if (left.id === right.id) {
    return 0;
  }

  return left.id < right.id ? -1 : 1;
};

/** The events a surface should show, filtered to what the user asked to see. */
export const visibleEvents = (
  events: readonly CollectionEvent[],
  visibleWasteTypes: readonly CollectionEvent['type'][],
): CollectionEvent[] => events.filter((event) => visibleWasteTypes.includes(event.type));
