import type { CollectionEvent } from '@abfall-radar/domain';
import {
  type CollectionSourceManifest,
  isSourceFailureError,
  type SourceFailureError,
  type SourceFreshness,
  type StaleWarning,
} from '../source';
import type { Clock } from './dependencies';

/**
 * Process-local per-source cache with stale-if-error semantics.
 *
 * Lost on restart and not shared between instances, which ADR 0003 accepts for now: a shared cache or
 * a scheduled refresh job becomes necessary only once more than one instance runs.
 */

export const FRESH_TTL_MS = 6 * 60 * 60 * 1000;

export const STALE_IF_ERROR_MAX_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  readonly events: readonly CollectionEvent[];
  /** The timestamp of the last *successful* retrieval. Never advanced by a failed refresh. */
  readonly retrievedAt: Date;
}

/**
 * A settled value rather than a rejecting promise, so several callers awaiting one coalesced refresh
 * each handle the outcome independently and a shared rejection cannot go unhandled.
 *
 * `unexpected` is kept distinct from `source-failure` on purpose: a bug in our own code must surface as
 * an internal error, not be dressed up as an upstream problem and hidden behind stale data.
 */
type RefreshOutcome =
  | { readonly status: 'fulfilled'; readonly events: readonly CollectionEvent[] }
  | { readonly status: 'source-failure'; readonly failure: SourceFailureError }
  | { readonly status: 'unexpected'; readonly error: unknown };

export interface CachedSchedule {
  readonly events: readonly CollectionEvent[];
  readonly retrievedAt: Date;
  readonly freshness: SourceFreshness;
  readonly staleWarning?: StaleWarning;
}

export interface ScheduleCacheOptions {
  readonly clock: Clock;
  readonly refresh: (manifest: CollectionSourceManifest) => Promise<readonly CollectionEvent[]>;
}

export interface ScheduleCache {
  read(manifest: CollectionSourceManifest): Promise<CachedSchedule>;
}

const cacheKey = (manifest: CollectionSourceManifest): string =>
  `${manifest.providerId}:${manifest.serviceAreaId}`;

export const createScheduleCache = ({ clock, refresh }: ScheduleCacheOptions): ScheduleCache => {
  const entries = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<RefreshOutcome>>();

  const runRefresh = (manifest: CollectionSourceManifest): Promise<RefreshOutcome> => {
    const key = cacheKey(manifest);
    const existing = inFlight.get(key);

    // Concurrent requests for one source share one upstream request.
    if (existing !== undefined) {
      return existing;
    }

    const started = (async (): Promise<RefreshOutcome> => {
      try {
        return { status: 'fulfilled', events: await refresh(manifest) };
      } catch (error) {
        return isSourceFailureError(error)
          ? { status: 'source-failure', failure: error }
          : { status: 'unexpected', error };
      }
    })().finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, started);

    return started;
  };

  const read = async (manifest: CollectionSourceManifest): Promise<CachedSchedule> => {
    const key = cacheKey(manifest);
    const cached = entries.get(key);

    if (
      cached !== undefined &&
      clock.now().getTime() - cached.retrievedAt.getTime() < FRESH_TTL_MS
    ) {
      return { events: cached.events, retrievedAt: cached.retrievedAt, freshness: 'fresh' };
    }

    const outcome = await runRefresh(manifest);

    if (outcome.status === 'unexpected') {
      throw outcome.error;
    }

    if (outcome.status === 'fulfilled') {
      const entry: CacheEntry = { events: outcome.events, retrievedAt: clock.now() };

      entries.set(key, entry);

      return { events: entry.events, retrievedAt: entry.retrievedAt, freshness: 'fresh' };
    }

    const fallback = entries.get(key);

    if (
      fallback !== undefined &&
      clock.now().getTime() - fallback.retrievedAt.getTime() <= STALE_IF_ERROR_MAX_MS
    ) {
      return {
        events: fallback.events,
        // The last successful retrieval time, so a stale response never claims to be newer than it is.
        retrievedAt: fallback.retrievedAt,
        freshness: 'stale',
        staleWarning: { reason: outcome.failure.reason },
      };
    }

    // Stale data is never manufactured: with no usable previous success the request fails instead of
    // returning something merely labelled stale.
    throw outcome.failure;
  };

  return { read };
};
