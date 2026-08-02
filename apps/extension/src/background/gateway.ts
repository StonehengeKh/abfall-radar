import type {
  ApiClient,
  ApiFailure,
  CollectionEventListResponse,
  ProviderListResponse,
  ServiceAreaListResponse,
} from '@abfall-radar/api-client';
import {
  type CollectionEventsPayload,
  type GatewayFailure,
  type GatewayRequest,
  GatewayRequestSchema,
  type GatewayResponse,
  isSettingsRequest,
  type ProviderSummary,
  CACHE_STORAGE_UNAVAILABLE,
  SETTINGS_STORAGE_UNAVAILABLE,
  SETTINGS_UNSUPPORTED_VERSION,
  type RestoredSchedulePayload,
  type SchedulePayload,
  type ServiceAreaSummary,
  type SettingsRequestKind,
  UNSUPPORTED_MESSAGE,
} from '@/src/messaging/contract';
import type { SourceWindow } from '@/src/schedule/capability';
import { deriveTargetRange, intersectRanges, isWithinRange } from '@/src/schedule/schedule-range';
import {
  evictCacheEntry,
  readCacheEntry,
  type ScheduleCacheEntry,
  toCacheKey,
  writeCacheEntry,
} from '@/src/storage/schedule-cache';
import {
  clearScheduleInvalidation,
  isScheduleInvalidated,
  markScheduleInvalidated,
  scheduleInvalidationToken,
} from '@/src/storage/schedule-tombstone';
import { type AppSettings, SETTINGS_SCHEMA_VERSION } from '@/src/storage/settings';
import {
  invalidateSelectionIfMatches,
  persistSelection,
  persistSettings,
  readSettingsState,
  UnsupportedSettingsVersionError,
} from '@/src/storage/settings-repository';
import {
  consoleGatewayLogger,
  type GatewayLogger,
  logCacheFailure,
  logFailure,
  logSettingsFailure,
} from './logger';

/**
 * The network boundary, owned by the background service worker.
 *
 * The popup is a short-lived window that can be closed mid-request, so letting each UI surface issue its
 * own requests would scatter the timeout, cache, and error policy across components that disappear. Every
 * request is constructed here, and every UI surface reaches this through the validated message contract.
 *
 * No rejection escapes: every path — success, expected failure, unexpected failure, unrecognized message —
 * answers with an envelope, because a dropped reply leaves the popup waiting for something that never
 * arrives.
 */

export interface GatewayDependencies {
  readonly client: ApiClient;
  readonly logger?: GatewayLogger;
  /** Injected so the source-local date and cache ageing are deterministic in tests. */
  readonly now?: () => Date;
}

/**
 * What a typed worker-internal read answers with.
 *
 * The same two members the message envelope carries, without the envelope: a caller inside the worker already
 * knows which operation it asked for, so it needs the data or the failure rather than a union of every reply
 * the boundary can produce.
 */
export type GatewayResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly failure: GatewayFailure };

export interface Gateway {
  /** The untrusted entry point: an inbound message of unknown shape, answered with an envelope. */
  handle(message: unknown): Promise<GatewayResponse>;
  /**
   * The three API reads, typed, for callers inside the worker.
   *
   * These exist because the reminder is not a UI surface and must not depend on one. It runs from an alarm
   * with no popup open, so when nothing trustworthy is cached it has to be able to fetch a schedule itself —
   * and going through `handle` would mean narrowing a union of every envelope the message boundary can carry,
   * then re-deriving what each one meant.
   *
   * Every one of them is the **same code path** the message boundary uses: the same transport call, the same
   * failure translation, the same cache write and the same coalescing. Nothing here is a second implementation
   * for the worker's own benefit.
   */
  listProviders(): Promise<GatewayResult<ProviderSummary[]>>;
  listServiceAreas(providerId: string): Promise<GatewayResult<ServiceAreaSummary[]>>;
  listCollectionEvents(request: {
    readonly providerId: string;
    readonly serviceAreaId: string;
    readonly from: string;
    readonly to: string;
  }): Promise<GatewayResult<CollectionEventsPayload>>;
  /**
   * The same local restore, typed, for callers inside the worker.
   *
   * The reminder path uses this rather than `handle`, so it reads a `RestoredSchedulePayload` directly
   * instead of narrowing a union of every envelope the message boundary can carry.
   */
  restoreCachedSchedule(parts: {
    readonly providerId: string;
    readonly serviceAreaId: string;
  }): Promise<RestoredSchedulePayload | null>;
  /**
   * Drops the cached schedule for one area, keyed by the configured origin.
   *
   * Called when a successful capability response reports the area `unavailable`. Cache ownership stays here:
   * the popup asks through the message contract rather than touching the storage item.
   */
  invalidateCachedSchedule(parts: {
    readonly providerId: string;
    readonly serviceAreaId: string;
  }): Promise<void>;
}

/**
 * Translates a transport failure into the message vocabulary, one branch at a time.
 *
 * Explicit rather than a pass-through so the two unions cannot drift, and so no member can start crossing
 * the boundary because it was added upstream.
 */
export const toGatewayFailure = (failure: ApiFailure): GatewayFailure => {
  switch (failure.kind) {
    case 'problem':
      return {
        kind: 'problem',
        operation: failure.operation,
        status: failure.status,
        code: failure.code,
        requestId: failure.requestId,
      };
    case 'timeout':
      return { kind: 'timeout', operation: failure.operation, timeoutMs: failure.timeoutMs };
    case 'invalid_response':
      return { kind: 'invalid_response', operation: failure.operation, status: failure.status };
    case 'network':
      return { kind: 'network', operation: failure.operation };
    case 'cancelled':
      return { kind: 'cancelled', operation: failure.operation };
  }
};

const toProviderSummaries = (response: ProviderListResponse): ProviderSummary[] =>
  response.data.map((provider) => ({
    id: provider.id,
    name: provider.name,
    sourceKind: provider.sourceKind,
  }));

const toServiceAreaSummaries = (response: ServiceAreaListResponse): ServiceAreaSummary[] =>
  response.data.map((area) => ({
    id: area.id,
    providerId: area.providerId,
    locality: area.locality,
    name: area.name,
    collectionEvents:
      area.collectionEvents.availability === 'available'
        ? {
            availability: 'available',
            timeZone: area.collectionEvents.timeZone,
            validity: area.collectionEvents.validity,
          }
        : { availability: 'unavailable' },
  }));

/**
 * Flattens the validated transport response onto the schedule payload the UI reads.
 *
 * Deliberately a typed mapping rather than a runtime re-parse: the transport validators already checked
 * every member, and the return type makes the two vocabularies agree at compile time. If they ever
 * diverge this stops compiling, which is strictly better than throwing inside a message handler.
 */
const toSchedulePayload = (response: CollectionEventListResponse): SchedulePayload => ({
  events: response.data,
  provenance: {
    providerName: response.meta.provider.name,
    sourceName: response.meta.source.name,
    landingPageUrl: response.meta.source.landingPageUrl,
    attribution: response.meta.source.attribution,
    timeZone: response.meta.source.timeZone,
    locality: response.meta.serviceArea.locality,
    areaName: response.meta.serviceArea.name,
    retrievedAt: response.meta.retrievedAt,
    freshness: response.meta.freshness,
    coverage: response.meta.coverage.wasteTypes,
    validity: { from: response.meta.validFrom, to: response.meta.validTo },
  },
  servedRange: response.meta.range,
});

/**
 * The **one** way a stored entry becomes something presentable.
 *
 * Every cached presentation goes through here — the local restore at startup and the newer-entry answer to a
 * live request alike — so the rule that a partial intersection is never presented as coverage of the whole
 * requested window is stated exactly once. A second path that filtered events without recording `coverage`
 * and `displayRange` is precisely how an uncovered tail ends up rendered as "no collection scheduled".
 *
 * `null` means the entry does not overlap the range being asked about, so no cached event may be shown at
 * all.
 */
const restoreEntryAgainst = (
  entry: ScheduleCacheEntry,
  requestedRange: SourceWindow,
): RestoredSchedulePayload | null => {
  const intersection = intersectRanges(entry.schedule.servedRange, requestedRange);

  if (intersection === undefined) {
    return null;
  }

  return {
    schedule: {
      ...entry.schedule,
      // Bounded to the intersection, so no event outside it is ever returned. The stored entry keeps its
      // full contents and its own served range, so a later request overlapping differently still finds
      // everything it holds.
      events: entry.schedule.events.filter((event) =>
        isWithinRange(event.date, intersection.displayRange),
      ),
    },
    coverage: intersection.coverage,
    displayRange: intersection.displayRange,
    storedAt: entry.storedAt,
    requestedRange,
  };
};

/**
 * Restores a cached schedule bounded by the intersection of what it covers and what is wanted now.
 *
 * The entry is its own **last-known capability snapshot**: a cached response already carries validated
 * `timeZone`, `validFrom`, and `validTo`, which is the same information the capability publishes. Startup
 * therefore never has to reach the network before it can decide what a cached schedule covers, which is
 * the whole point of caching it, and no second persisted representation of the zone or window exists to
 * drift away from the response it came from.
 *
 * `null` means nothing trustworthy is cached. A missing entry, an invalid one, an expired one, one from
 * another origin, a today past the cached validity, and a served range that no longer overlaps are all
 * that same statement, and none of them is an error.
 */
const restoreFromCache = async (
  request: Extract<GatewayRequest, { kind: 'restore_cached_schedule' }>,
  origin: string,
  now: Date,
): Promise<RestoredSchedulePayload | null> => {
  const entry = await readCacheEntry(
    { origin, providerId: request.providerId, serviceAreaId: request.serviceAreaId },
    now,
  );

  if (entry === undefined) {
    return null;
  }

  const target = deriveTargetRange(
    { timeZone: entry.schedule.provenance.timeZone, validity: entry.schedule.provenance.validity },
    now,
  );

  if (target.kind !== 'covered') {
    /**
     * No range, so nothing restorable — for either reason.
     *
     * `outside_validity` means the snapshot's window has passed. `unusable_zone` means the entry's own zone
     * cannot be resolved on this runtime, which a build with the boundary validation in place would never
     * have written, but an **older** build could have. `null` is the correct answer to both: nothing
     * trustworthy is cached. It is emphatically not an error, and the reminder path reads this same value, so
     * an entry whose zone cannot decide a calendar date silently reminds nobody instead of throwing in the
     * background worker where no one would see it.
     */
    return null;
  }

  return restoreEntryAgainst(entry, target.range);
};

export const createGateway = ({
  client,
  logger = consoleGatewayLogger,
  now = () => new Date(),
}: GatewayDependencies): Gateway => {
  /**
   * Identical concurrent reads share one upstream call, the same way the server coalesces concurrent
   * refreshes of one source.
   *
   * One map per operation rather than one keyed by the whole message, because coalescing has to happen *below*
   * the message boundary. Keying on the parsed message meant only `handle` was covered: the worker's own reads
   * called the operations directly and bypassed it entirely, so a reminder firing while the popup was open
   * issued a second identical HTTP request for the same provider, area, and range. Both entry points now go
   * through the same three functions, so both join the same flight.
   *
   * Typed per operation, so no cast is needed to get a result back out — a single `Map<string, Promise<unknown>>`
   * could only be read by asserting what came out of it.
   */
  const providerFlights = new Map<string, Promise<GatewayResult<ProviderSummary[]>>>();

  const serviceAreaFlights = new Map<string, Promise<GatewayResult<ServiceAreaSummary[]>>>();

  const collectionEventFlights = new Map<string, Promise<GatewayResult<CollectionEventsPayload>>>();

  /**
   * Joins an identical flight, or starts one.
   *
   * The entry is removed as soon as the flight settles — success or failure alike — so a retry after a failure
   * really does issue a new request rather than being handed the failure that already happened.
   */
  const coalesce = <Data>(
    flights: Map<string, Promise<GatewayResult<Data>>>,
    key: string,
    operation: () => Promise<GatewayResult<Data>>,
  ): Promise<GatewayResult<Data>> => {
    const pending = flights.get(key);

    if (pending !== undefined) {
      return pending;
    }

    const flight = operation().finally(() => {
      flights.delete(key);
    });

    flights.set(key, flight);

    return flight;
  };

  const fail = (failure: GatewayFailure): GatewayResponse => {
    logFailure(logger, failure);

    return { ok: false, failure };
  };

  /**
   * Caching is best-effort. A validated response is good data whether or not extension storage accepted
   * it, so a storage failure must not turn a usable schedule into an error.
   */
  /**
   * How many times each cache key has been invalidated.
   *
   * A collection-events request captures the generation before it starts. If the key is invalidated while the
   * request is in flight, the generation moves on and the late response is refused the cache — otherwise it
   * would quietly recreate the very entry that was just withdrawn, and a provider that has stopped publishing
   * a calendar would keep answering through it.
   */
  const generations = new Map<string, number>();

  const generationOf = (key: string): number => generations.get(key) ?? 0;

  /**
   * Keys whose cached schedule has been withdrawn and not yet safely replaced.
   *
   * The generation counter and this set answer two different questions, which is why both exist:
   *
   * - the **generation** rejects work that started *before* an invalidation. It is a comparison against a value
   *   captured at the start of a request, so it says nothing about a request or a restore that starts *afterwards*.
   * - this **set** marks the key itself unusable. A restore issued after the invalidation captures the current
   *   generation, finds it unchanged, and used to hand the entry straight back — which is exactly what happened
   *   when both the durable tombstone write and the physical eviction were refused. The whole withdrawal then came
   *   down to the selection being cleared, and if that write failed too there was nothing left at all.
   *
   * In memory, so it cannot fail. It is added to synchronously before anything is awaited, which makes same-worker
   * safety independent of every storage operation and of whether the selection clear succeeded. The durable
   * tombstone is what carries a withdrawal across a restart; this is what makes the current worker correct
   * regardless of storage.
   */
  const invalidatedKeys = new Set<string>();

  const cacheKeyFor = (parts: {
    readonly providerId: string;
    readonly serviceAreaId: string;
  }): string => toCacheKey({ origin: client.origin, ...parts });

  /**
   * Stores a validated response, unless something newer or an invalidation says otherwise.
   *
   * Answers with what should be **presented**, and says which of the two it is. Normally that is the response
   * just retrieved. When the stored entry is newer, the response may neither displace it nor stand in for it:
   * returning the older schedule through the live path would relabel it as the current answer, and returning
   * the stored entry raw would present its whole served range as coverage of the requested range. So the
   * stored entry goes back through the ordinary restoration instead, bounded by the range this request asked
   * for, and is answered as `cached`.
   *
   * If the newer entry does not overlap the requested range at all there is nothing cached to show, so the
   * retrieved response is returned as the live answer it is — labelled with its own retrieval time and
   * freshness, claiming nothing about being newer than anything.
   */
  const cacheSchedule = async (
    // The parts it actually uses, rather than the message shape, so a worker-internal caller with no `kind`
    // reaches exactly the same caching decision.
    request: {
      readonly providerId: string;
      readonly serviceAreaId: string;
      readonly from: string;
      readonly to: string;
    },
    schedule: SchedulePayload,
    generationAtRequestStart: number,
  ): Promise<CollectionEventsPayload> => {
    const live: CollectionEventsPayload = { kind: 'live', schedule };
    const key = cacheKeyFor(request);
    const parts = {
      origin: client.origin,
      providerId: request.providerId,
      serviceAreaId: request.serviceAreaId,
    };

    if (generationOf(key) !== generationAtRequestStart) {
      // Invalidated while this request was in flight. The response is still returned to its caller — it was a
      // real answer — but it may not recreate the entry.
      logger.warn('AbfallRadar discarded a superseded schedule write', {
        operation: 'listCollectionEvents',
      });

      return live;
    }

    try {
      /**
       * Replacing a withdrawn entry is a **transaction**, and its order is the whole guarantee.
       *
       * The replacement is written first, while the tombstone is still on disk. Only once that write reports
       * `written` — the replacement is durable — may the tombstone be removed, and only once *that* succeeds may the
       * in-memory marker be cleared. Clearing the tombstone first, which is what used to happen, left a window in
       * which the withdrawal was already forgotten and the replacement was not yet there: a worker destroyed in
       * that window came back holding a withdrawn entry with nothing left to say so.
       *
       * The generation check above is what makes this response eligible at all — it started after the withdrawal.
       */

      /**
       * The withdrawal this response is authorized to forget, read **before** the write.
       *
       * Compare-and-clear needs something to compare against, and it has to be the record as it stood at the moment
       * this replacement became eligible. Reading it afterwards would observe whatever an invalidation landing in
       * the meantime had written, and the removal would then authorize itself against the very record it must not
       * touch. `null` means there is nothing to forget, which is the ordinary uninvalidated case.
       */
      const authorizedToken = await scheduleInvalidationToken(parts, now());

      if (generationOf(key) !== generationAtRequestStart) {
        return live;
      }

      const outcome = await writeCacheEntry({ ...parts, schedule, now: now() });

      /**
       * A withdrawal that landed while the write was pending wins, and this response is **discarded**.
       *
       * The first of three identical checks, one after every await in the transaction, and the one that was missing:
       * the generation was confirmed before the write and then trusted for the rest of the sequence, so an
       * invalidation arriving during it went on to have its brand-new tombstone removed and its `invalidatedKeys`
       * entry deleted by an operation that predated it.
       *
       * Returning `live` here does not present it. `listCollectionEvents` re-checks the generation after this
       * function and answers `cancelled` — the member the view layer already reads as a supersession rather than an
       * error, so no surface renders a failure and no notification follows. Nothing is touched on the way out.
       */
      if (generationOf(key) !== generationAtRequestStart) {
        logger.warn('AbfallRadar discarded a schedule overtaken by an invalidation', {
          operation: 'listCollectionEvents',
        });

        return live;
      }

      if (outcome === 'kept_newer') {
        /**
         * A stored entry survived because its `retrievedAt` is later than this response's. That says which is
         * **newer**; it says nothing at all about whether it may be used.
         *
         * An entry that outlived a failed eviction is still withdrawn, and its timestamp is exactly what makes it
         * look authoritative. So the withdrawal is consulted before the entry is read — against both markers,
         * because a restarted worker holds the durable tombstone and not the in-memory set, and an unreadable
         * tombstone store fails closed. When it is withdrawn the entry is neither read, nor returned as cached,
         * nor returned as live data, and neither marker is touched.
         */
        if (invalidatedKeys.has(key) || (await isScheduleInvalidated(parts, now()))) {
          logger.warn('AbfallRadar withheld a retained schedule for a withdrawn area', {
            operation: 'listCollectionEvents',
          });

          return live;
        }

        const stored = await readCacheEntry(parts, now());

        // That read touched storage too, so the same question is asked again before anything is handed back.
        if (generationOf(key) !== generationAtRequestStart) {
          return live;
        }

        if (stored === undefined) {
          return live;
        }

        const restored = restoreEntryAgainst(stored, { from: request.from, to: request.to });

        return restored === null ? live : { kind: 'cached', restored };
      }

      /**
       * `written`: the replacement is durable. Now, and only now, the withdrawal may be lifted.
       *
       * Nothing to lift when no record was observed, which is the ordinary uninvalidated case — and skipping it
       * there also keeps a tombstone-store failure from turning an ordinary successful response into a refusal.
       */
      if (authorizedToken === null) {
        return live;
      }

      /**
       * **Compare-and-clear against the exact record this response observed.**
       *
       * A record stamped with anything newer belongs to an invalidation that happened after this replacement became
       * eligible — one this operation knows nothing about — and it is left exactly where it is. A refusal throws to
       * the handler below, which keeps both guards.
       */
      const removal = await clearScheduleInvalidation(parts, now(), authorizedToken);

      /**
       * The last of the three checks, and the marker is cleared only if everything still holds.
       *
       * `superseded` means the compare-and-clear found a newer token and correctly did nothing, so the withdrawal
       * stands and the marker stays. A generation that has moved on says the same thing about this worker. Either
       * way the key remains unusable for offline restoration — the fail-closed direction, because complete
       * durability could not be proven.
       */
      if (removal === 'superseded' || generationOf(key) !== generationAtRequestStart) {
        logger.warn('AbfallRadar kept a withdrawal a newer invalidation still owns', {
          operation: 'listCollectionEvents',
        });

        return live;
      }

      invalidatedKeys.delete(key);

      return live;
    } catch {
      // Nothing about the error is logged: it could carry a payload or a stack trace.
      logger.warn('AbfallRadar could not store the retrieved schedule', {
        operation: 'listCollectionEvents',
      });

      return live;
    }
  };

  /**
   * An unreadable cache is "nothing trustworthy is cached", which is exactly what `null` says. It is not a
   * failure, so it never becomes an error state or blocks a live refresh.
   */
  /**
   * The one restore both surfaces go through, and the one place a withdrawal is enforced.
   *
   * The popup reaches this by message and the reminder calls it directly, so putting the guard here is what makes
   * "a withdrawn schedule is never restored" a property of the worker rather than of whichever caller remembered.
   *
   * The invalidation state is checked **twice**, and both checks are load-bearing:
   *
   * - **before** reading, so an entry whose physical eviction was refused is never even fetched;
   * - **again** before returning, because reading touches storage and a withdrawal can land during it. Without
   *   the second check a restore that began a microsecond earlier would hand back the entry an invalidation was
   *   concurrently withdrawing.
   *
   * The second check compares the in-memory generation captured before the read, which is exact and synchronous:
   * the durable tombstone is a fallback for a *restarted* worker, while within one lifetime the generation is what
   * cannot be raced.
   */
  const restoreCachedSchedule = async (parts: {
    readonly providerId: string;
    readonly serviceAreaId: string;
  }): Promise<RestoredSchedulePayload | null> => {
    const key = cacheKeyFor(parts);
    const generationAtRestoreStart = generationOf(key);
    const identity = { origin: client.origin, ...parts };

    // Before any storage is touched, and it cannot fail. This is what holds even when the tombstone write and the
    // eviction were both refused — the entry may still be on disk and perfectly valid, and it is still withdrawn.
    if (invalidatedKeys.has(key)) {
      return null;
    }

    try {
      // Fails closed: a store that cannot be read is treated as withdrawn, because withholding an offline
      // schedule costs a person a cached view while the alternative presents a withdrawn calendar as current.
      if (await isScheduleInvalidated(identity, now())) {
        return null;
      }

      const restored = await restoreFromCache(
        { kind: 'restore_cached_schedule', ...parts },
        client.origin,
        now(),
      );

      /**
       * Checked again, because reading touches storage and an invalidation can land during it.
       *
       * Both markers are consulted: the generation catches an invalidation of a key that was already withdrawn
       * once, and the set catches the first withdrawal of a key that was clean when this restore began. Either
       * alone leaves a gap — a restore that started a microsecond earlier would otherwise hand back the very
       * entry being withdrawn.
       */
      if (generationOf(key) !== generationAtRestoreStart || invalidatedKeys.has(key)) {
        return null;
      }

      return restored;
    } catch {
      logger.warn('AbfallRadar could not read the stored schedule', {
        operation: 'listCollectionEvents',
      });

      return null;
    }
  };

  /**
   * Drops everything the worker holds for one area. Two halves, and only the first of them decides anything.
   *
   * - The **generation** is advanced first, in memory, and cannot fail. That ordering is the whole guarantee: a
   *   collection-events request already in flight is refused the cache *and* refused delivery from this line
   *   onwards, even if it answers before the storage write completes. Nothing asynchronous precedes it,
   *   deliberately — an await before it would be a window in which a late response was still trusted.
   * - The **eviction** touches storage and is **best-effort**.
   *
   * Best-effort is the correction. Reporting a refused eviction as a failure sounded safer and was worse: it
   * blocked the withdrawal, so a device whose storage was refusing writes kept a selection pointing at an area the
   * operator no longer serves — indefinitely, and with the popup stuck on an error it could not clear. The
   * authoritative fact is that this area publishes nothing, and that holds whether or not storage cooperated.
   *
   * What makes it safe to proceed is that the surviving entry cannot be reached. The generation blocks every
   * in-flight response, and the caller's next step clears the selection — after which nothing asks for this area at
   * all: the popup restores a cache only for a selection it holds, and the reminder returns before touching one
   * when there is none. A stale entry with nothing pointing at it is inert, and the next successful eviction or the
   * retention window removes it.
   */
  const invalidateCachedSchedule = async (parts: {
    readonly providerId: string;
    readonly serviceAreaId: string;
  }): Promise<void> => {
    const key = cacheKeyFor(parts);
    const identity = { origin: client.origin, ...parts };

    /**
     * Both in-memory markers, set before anything is awaited.
     *
     * Neither can fail, and between them they cover the two different questions: the generation rejects work that
     * started earlier, and the set makes the key itself unusable for anything starting later. Calling this twice
     * for the same key is idempotent — the set already holds it and the generation simply moves on again.
     */
    generations.set(key, generationOf(key) + 1);
    invalidatedKeys.add(key);

    /**
     * The **durable** half of the marker, written before the eviction is attempted, and stamped with this
     * invalidation's own token.
     *
     * Order matters: the tombstone is the guarantee and the eviction is housekeeping, so the guarantee is
     * established first. If this write is refused the in-memory generation still protects the current worker, and
     * the caller still clears the selection — which is what stops anything asking for this area at all.
     *
     * The record carries a token of its own, derived from what is on disk, so a replacement can compare rather than
     * simply delete — and so a withdrawal written after that replacement became eligible is never the one removed.
     */
    try {
      await markScheduleInvalidated(identity, now());
    } catch {
      logCacheFailure(logger, CACHE_STORAGE_UNAVAILABLE);
    }

    try {
      await evictCacheEntry(identity, now());
    } catch {
      // Kind-only, like every local failure: the storage rejection could name an internal path, and there is no
      // operation or status to attribute a refused delete to. Logged and not surfaced — the caller must not stop.
      logCacheFailure(logger, CACHE_STORAGE_UNAVAILABLE);
    }
  };

  /**
   * The three API reads, each in exactly one place, **uncoalesced**.
   *
   * Private on purpose: nothing may call these directly. Every caller goes through the coalesced wrappers
   * below, which is what makes "one identical request at a time" a property of the gateway rather than of
   * whichever entry point happened to be used. `run` shapes their results into message envelopes and the
   * public methods hand them back directly, so the transport call, the failure translation, the cache write
   * and the generation check are written once and cannot drift between the popup's path and the worker's own.
   */
  const readProviders = async (): Promise<GatewayResult<ProviderSummary[]>> => {
    const result = await client.listProviders();

    if (!result.ok) {
      const failure = toGatewayFailure(result.failure);

      logFailure(logger, failure);

      return { ok: false, failure };
    }

    return { ok: true, data: toProviderSummaries(result.data) };
  };

  const readServiceAreas = async (
    providerId: string,
  ): Promise<GatewayResult<ServiceAreaSummary[]>> => {
    const result = await client.listServiceAreas(providerId);

    if (!result.ok) {
      const failure = toGatewayFailure(result.failure);

      logFailure(logger, failure);

      return { ok: false, failure };
    }

    return { ok: true, data: toServiceAreaSummaries(result.data) };
  };

  const readCollectionEvents = async (request: {
    readonly providerId: string;
    readonly serviceAreaId: string;
    readonly from: string;
    readonly to: string;
  }): Promise<GatewayResult<CollectionEventsPayload>> => {
    const key = cacheKeyFor(request);
    // Captured before the request begins, so an invalidation landing mid-flight is detectable afterwards.
    const generationAtRequestStart = generationOf(key);

    /**
     * Whether an invalidation has overtaken this request.
     *
     * The generation governs **delivery**, not only caching. Refusing the cache write while still handing the
     * response back left the schedule reaching a surface anyway: the popup rendered a calendar the provider had
     * withdrawn moments earlier, and the reminder built a notification from it. Neither one re-checks — by the
     * time they hold a payload, the decision has already been made for them.
     *
     * Asked at every point where control has been given up and taken back: after the HTTP round trip, after the
     * cache work, and once more immediately before returning. Anything less leaves a window between the last
     * check and the return in which an invalidation lands unnoticed.
     */
    const isSuperseded = (): boolean => generationOf(key) !== generationAtRequestStart;

    /**
     * What a superseded request answers with.
     *
     * `cancelled` is the existing member for work the user themselves replaced — the view layer already reads it
     * as a supersession rather than an error, so no surface renders a failure for it and no notification follows.
     * It carries no request identifier, because none was fabricated: a `requestId` belongs to a validated Problem
     * Details body, and inventing one would name something no server log contains.
     */
    const superseded = (): GatewayResult<CollectionEventsPayload> => ({
      ok: false,
      failure: { kind: 'cancelled', operation: 'listCollectionEvents' },
    });

    const result = await client.listCollectionEvents({
      providerId: request.providerId,
      serviceAreaId: request.serviceAreaId,
      range: { from: request.from, to: request.to },
    });

    if (!result.ok) {
      // A failed refresh writes nothing and preserves every still-usable entry.
      const failure = toGatewayFailure(result.failure);

      logFailure(logger, failure);

      return { ok: false, failure };
    }

    // Checked after the HTTP round trip and its validation, before anything is stored or handed back.
    if (isSuperseded()) {
      return superseded();
    }

    // The answer may be the stored entry rather than this response, when the stored one is newer — and it
    // says which, so no caller can label a restored entry as live.
    const payload = await cacheSchedule(
      request,
      toSchedulePayload(result.data),
      generationAtRequestStart,
    );

    // Checked again after the cache work, which awaits storage and is where an invalidation most easily lands.
    if (isSuperseded()) {
      return superseded();
    }

    return { ok: true, data: payload };
  };

  /**
   * The public reads. One flight per distinct question, shared by every caller.
   *
   * The keys spell out exactly what makes two requests the same question: the operation, and every parameter
   * that changes the answer. A different provider, area, or range is a different question and gets its own
   * request — which is why the range is part of the collection-events key rather than only the area.
   */
  const listProviders = (): Promise<GatewayResult<ProviderSummary[]>> =>
    coalesce(providerFlights, 'list_providers', readProviders);

  const listServiceAreas = (providerId: string): Promise<GatewayResult<ServiceAreaSummary[]>> =>
    coalesce(serviceAreaFlights, providerId, () => readServiceAreas(providerId));

  const listCollectionEvents = (request: {
    readonly providerId: string;
    readonly serviceAreaId: string;
    readonly from: string;
    readonly to: string;
  }): Promise<GatewayResult<CollectionEventsPayload>> =>
    coalesce(
      collectionEventFlights,
      /**
       * The generation is part of the key, so an invalidation ends the flight rather than poisoning it.
       *
       * Two callers asking the same question at the same moment still share one request — that is what coalescing
       * is for. But a caller arriving *after* an invalidation is asking a different question: the entry it would
       * have joined is now destined to be refused, and handing it that refusal would fail a request that had every
       * right to succeed. A new generation means a new key, so it starts its own flight.
       */
      `${request.providerId}|${request.serviceAreaId}|${request.from}|${request.to}|${generationOf(
        cacheKeyFor(request),
      )}`,
      () => readCollectionEvents(request),
    );

  /**
   * The settings to report alongside an outcome that deliberately wrote nothing.
   *
   * Read as a *state* rather than through `readSettings`, so the one window the mutation queue cannot cover — a
   * newer build writing between the mutation being refused and this read — is refused here too. `readSettings`
   * would answer that value with the migration's v2 defaults, and reporting those as the current settings would
   * put a fresh installation in front of someone whose real settings are on disk.
   *
   * It raises the same error the mutations do, so the one handler below states it once.
   */
  const settingsAfterRefusal = async (): Promise<AppSettings> => {
    const state = await readSettingsState();

    if (state.status === 'unsupported_version') {
      throw new UnsupportedSettingsVersionError();
    }

    return state.settings;
  };

  /**
   * The settings intents, applied by the **one** context that owns the settings item.
   *
   * Each one delegates straight to the repository, whose queue is the only serialization that can work: the
   * popup and this worker are separate module instances, so a queue in a module variable serializes each context
   * against itself and neither against the other. Routing every mutation here is what makes "one queue" true
   * rather than aspirational.
   *
   * A storage rejection is translated into the failure vocabulary rather than escaping. The popup has to be able
   * to show its own recoverable error, and an alarm handler must not be taken down by a refused write.
   */
  const runSettings = async (
    request: Extract<GatewayRequest, { kind: SettingsRequestKind }>,
  ): Promise<GatewayResponse> => {
    try {
      switch (request.kind) {
        case 'read_settings': {
          // Read here as well as written here, so a migration write can never happen inside the popup — where it
          // would be a second, unserialized writer of the same key.
          const state = await readSettingsState();

          if (state.status === 'unsupported_version') {
            /**
             * A newer build wrote this. The migration answers with defaults, which are correct for leaving the
             * stored object alone and completely wrong to hand back as a person's settings — so the state is
             * reported instead, and the surface explains it rather than offering an editable fresh installation.
             */
            logSettingsFailure(logger, SETTINGS_UNSUPPORTED_VERSION);

            return { ok: false, failure: SETTINGS_UNSUPPORTED_VERSION };
          }

          return { ok: true, data: state.settings };
        }

        case 'select_service_area': {
          const result = await persistSelection({
            selection: request.selection,
            evidence: request.evidence,
          });

          return {
            ok: true,
            data:
              result.outcome === 'persisted'
                ? { outcome: 'persisted', settings: result.settings }
                : { outcome: result.outcome, settings: await settingsAfterRefusal() },
          };
        }

        case 'save_settings': {
          const result = await persistSettings({
            expectedSelection: request.expectedSelection,
            // The version is this build's to state, never something a caller may assert.
            settings: {
              version: SETTINGS_SCHEMA_VERSION,
              selection: request.selection,
              remindersEnabled: request.remindersEnabled,
              reminderDaysBefore: request.reminderDaysBefore,
              reminderTime: request.reminderTime,
              visibleWasteTypes: [...request.visibleWasteTypes],
            },
            ...(request.evidence === undefined ? {} : { evidence: request.evidence }),
          });

          if (result.outcome === 'persisted') {
            return { ok: true, data: { outcome: 'persisted', settings: result.settings } };
          }

          if (result.outcome === 'conflict') {
            // The stale draft wrote nothing. What comes back is the newer value it was refused in favour of.
            return { ok: true, data: { outcome: 'conflict', settings: result.currentSettings } };
          }

          return {
            ok: true,
            data: { outcome: result.outcome, settings: await settingsAfterRefusal() },
          };
        }

        case 'invalidate_selection_if_matches': {
          const result = await invalidateSelectionIfMatches(request.expectedSelection);

          return { ok: true, data: { outcome: result.outcome, settings: result.settings } };
        }
      }
    } catch (error) {
      if (error instanceof UnsupportedSettingsVersionError) {
        // A mutation refused before it read or wrote anything, because the stored value is a newer build's.
        logSettingsFailure(logger, SETTINGS_UNSUPPORTED_VERSION);

        return { ok: false, failure: SETTINGS_UNSUPPORTED_VERSION };
      }

      /**
       * Storage refused, or the stored value could not be read at all.
       *
       * Reported in the settings command's **own** failure family, carrying its kind and nothing else. It used to
       * be an `invalid_response` attributed to `listProviders`, which invented three things at once: a request
       * that was never made, an operation that had nothing to do with it, and an HTTP status for an operation
       * that speaks no HTTP. Anyone reading the log line would have gone looking for a provider-catalogue
       * failure that does not exist.
       *
       * Nothing about the underlying rejection crosses the boundary — it could name an internal storage path or
       * carry a stack — and the popup turns this into its own locally owned recoverable state.
       */
      logSettingsFailure(logger, SETTINGS_STORAGE_UNAVAILABLE);

      return { ok: false, failure: SETTINGS_STORAGE_UNAVAILABLE };
    }
  };

  const run = async (request: GatewayRequest): Promise<GatewayResponse> => {
    if (isSettingsRequest(request)) {
      return runSettings(request);
    }

    switch (request.kind) {
      case 'list_providers':
        return listProviders();

      case 'list_service_areas':
        return listServiceAreas(request.providerId);

      case 'list_collection_events':
        return listCollectionEvents(request);

      case 'restore_cached_schedule':
        return {
          ok: true,
          data: await restoreCachedSchedule({
            providerId: request.providerId,
            serviceAreaId: request.serviceAreaId,
          }),
        };

      case 'invalidate_cached_schedule': {
        await invalidateCachedSchedule({
          providerId: request.providerId,
          serviceAreaId: request.serviceAreaId,
        });

        /**
         * Acknowledged whether or not storage cooperated.
         *
         * The part that matters has already happened and cannot fail: the generation moved, so nothing in flight
         * can write the cache or be delivered. Reporting a refused *eviction* as a failure would stop the caller
         * from clearing the selection, leaving it pointing at an area the operator no longer serves.
         */
        return { ok: true, data: null };
      }
    }
  };

  return {
    listProviders,
    listServiceAreas,
    listCollectionEvents,
    restoreCachedSchedule,
    invalidateCachedSchedule,

    async handle(message) {
      const request = GatewayRequestSchema.safeParse(message);

      if (!request.success) {
        // Raised before anything about the request is known to be valid, so there is no trustworthy
        // operation to name and nothing about the message is echoed back.
        return fail(UNSUPPORTED_MESSAGE);
      }

      /**
       * No coalescing of its own. `run` delegates to the public reads, which are where flights are shared, so
       * wrapping again here would put a second layer keyed on the message — and that layer is precisely what
       * left the worker's own reads outside the boundary. The two cache operations are deliberately not
       * coalesced with anything: an invalidation joining a read's flight would return a read's answer, and a
       * read joining an invalidation's would report an eviction as a schedule.
       */
      try {
        return await run(request.data);
      } catch {
        // The last resort, which no known path reaches: the mappings are typed rather than parsed, cache
        // writes are best-effort, and cache reads fall back to `null`. It exists because a dropped reply
        // would leave the popup waiting forever, and a defect must not be able to cause that. Nothing
        // about the error is logged or returned — it could carry a URL, a payload, or a stack trace.
        if (request.data.kind === 'invalidate_cached_schedule') {
          // Answers in the cache family, which is the only family its envelope accepts. Attributing a defect here
          // to `listCollectionEvents` with a status of `0` would describe a request that was never made.
          logCacheFailure(logger, CACHE_STORAGE_UNAVAILABLE);

          return { ok: false, failure: CACHE_STORAGE_UNAVAILABLE };
        }

        const operation = operationOf(request.data);

        if (operation === null) {
          // A settings intent, which answers in its own family and names no operation.
          logSettingsFailure(logger, SETTINGS_STORAGE_UNAVAILABLE);

          return { ok: false, failure: SETTINGS_STORAGE_UNAVAILABLE };
        }

        return fail({
          kind: 'invalid_response',
          operation,
          // No response existed, so there is no status the server sent. Stated as `0` rather than as a
          // plausible-looking `500`, and never rendered to a user.
          status: 0,
        });
      }
    },
  };
};

/**
 * The operation a request belongs to.
 *
 * The local restore performs no request, so it is attributed to the schedule operation the caller was
 * trying to satisfy rather than to a manufactured value.
 */
const operationOf = (request: GatewayRequest) => {
  switch (request.kind) {
    case 'list_providers':
      return 'listProviders' as const;
    case 'list_service_areas':
      return 'listServiceAreas' as const;
    case 'list_collection_events':
    case 'restore_cached_schedule':
    case 'invalidate_cached_schedule':
      return 'listCollectionEvents' as const;
    case 'read_settings':
    case 'select_service_area':
    case 'save_settings':
    case 'invalidate_selection_if_matches':
      /**
       * Unreachable: a settings intent performs no HTTP request, so it never reaches the last-resort handler that
       * needs an operation to attribute a defect to. `runSettings` catches its own failures and answers in its own
       * family, which is exactly why nothing here has to invent an operation for it.
       *
       * `null` rather than a plausible-looking `'listProviders'`, so a caller has to decide what to do about the
       * absence instead of being handed a value that reads like a real operation and describes nothing.
       */
      return null;
  }
};
