import { storage } from 'wxt/utils/storage';
import { z } from 'zod';
import { type SchedulePayload, SchedulePayloadSchema } from '@/src/messaging/contract';

/**
 * The last successful schedule response, so the popup paints immediately on open and stays useful while
 * the API is briefly unreachable.
 *
 * Owned by the background worker, which is the only surface that talks to the API. The popup reaches this
 * through the message boundary, never directly, so the intersection policy lives in one place.
 */

const SCHEDULE_CACHE_KEY = 'local:schedule-cache' as const;

/** Mirrors the stale-if-error window the server chose, so neither side outlives the other. */
export const CACHE_RETENTION_DAYS = 7;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const CACHE_RETENTION_MS = CACHE_RETENTION_DAYS * MILLISECONDS_PER_DAY;

/**
 * Keyed by the **normalized API origin** as well as the provider and area.
 *
 * The origin is part of the key so data retrieved from a development API can never be presented under a
 * different configured origin.
 */
export interface CacheKeyParts {
  readonly origin: string;
  readonly providerId: string;
  readonly serviceAreaId: string;
}

export const toCacheKey = ({ origin, providerId, serviceAreaId }: CacheKeyParts): string =>
  `${origin}|${providerId}|${serviceAreaId}`;

/** Strict, like every persisted schema: an unexpected member is a defect, not a newer contract. */
export const ScheduleCacheEntrySchema = z.strictObject({
  origin: z.string().min(1),
  providerId: z.string().min(1),
  serviceAreaId: z.string().min(1),
  /** Everything the response held, unfiltered. Restoring bounds only what is presented. */
  schedule: SchedulePayloadSchema,
  /** This client's own storage time, distinct from the server's `retrievedAt`. */
  storedAt: z.iso.datetime(),
});

export type ScheduleCacheEntry = z.infer<typeof ScheduleCacheEntrySchema>;

const ScheduleCacheSchema = z.record(z.string(), z.unknown());

const cacheItem = storage.defineItem<Record<string, unknown>>(SCHEDULE_CACHE_KEY, {
  fallback: {},
});

const readRawCache = async (): Promise<Record<string, unknown>> => {
  const parsed = ScheduleCacheSchema.safeParse(await cacheItem.getValue());

  return parsed.success ? parsed.data : {};
};

/**
 * Serializes every mutation of the cache item.
 *
 * All three operations below are read-modify-write over the **whole** record: they read it, drop what is
 * unusable, and write the result back. Two of them running concurrently would both read the same base and
 * both write their own version, so the second write silently discards the first — a schedule stored for one
 * area would vanish because another area was refreshed at the same moment. The worker really does issue
 * these concurrently: the popup restores while a refresh writes, and an invalidation can land in between.
 *
 * A promise chain is enough here and needs no dependency. The tail is deliberately kept **non-rejecting**,
 * so one failed mutation cannot poison the queue and block every later operation; the failure still reaches
 * its own caller through the returned promise.
 */
let mutationTail: Promise<void> = Promise.resolve();

const serializeMutation = <Result>(mutate: () => Promise<Result>): Promise<Result> => {
  const result = mutationTail.then(mutate);

  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
};

/**
 * Whether an entry's age puts it outside the retention window — in **either** direction.
 *
 * The age was computed as `now - storedAt` and compared only against the upper bound, so a timestamp in the
 * future produced a *negative* age and passed as comfortably fresh. That is not a hypothetical: this stamp is
 * written by the client's own clock, so a device whose clock was ahead when the entry was stored and has since
 * been corrected leaves an entry dated in the future — and it would then be retained for the whole seven days
 * plus however far ahead the clock had been, long after the policy says it should have gone.
 *
 * An entry cannot have been stored later than the moment it is being read, so a future stamp means the entry's
 * own record of when it was written cannot be trusted at all. There is nothing to salvage: the age is what
 * decides whether the data may still be presented as a recent official schedule, and an untrustworthy age makes
 * that decision unanswerable.
 *
 * `storedAt` exactly equal to `now` is valid — it is an entry stored this instant, which is the freshest
 * possible — so the future check is strict while the retention check stays inclusive.
 */
const isExpired = (entry: ScheduleCacheEntry, now: Date): boolean => {
  const age = now.getTime() - Date.parse(entry.storedAt);

  return age < 0 || age > CACHE_RETENTION_MS;
};

/** Inclusive at both ends, on `YYYY-MM-DD` values that sort lexicographically. */
const isWithinRange = (date: string, range: { from: string; to: string }): boolean =>
  date >= range.from && date <= range.to;

/**
 * Whether an entry's contents agree with the entry's own identity.
 *
 * Schema validity says every member has the right shape. It says nothing about the members *describing the
 * same schedule* — and persisted storage is where that stops being a theoretical concern: it survives
 * upgrades, it was written by builds whose validation was weaker than today's, and nothing prevents a
 * corrupted or partial write from combining one area's identity with another's events.
 *
 * Each check below closes a path by which a schedule would cross a boundary it must never cross:
 *
 * - an event belonging to **another service area** would be displayed under this area's name and reminded
 *   about as this area's collection. One foreign event is enough; the set cannot be partly trusted.
 * - an event **outside the served range** breaks the one derivation everything downstream depends on. The
 *   display range is the intersection of the served range with what is wanted now, and the reminder considers
 *   only events inside it — so an event outside the served range is either invisible or, worse, treated as
 *   covered by a range that never included it.
 * - a served range **outside the declared validity window** contradicts the entry's own provenance: the
 *   requested range is clamped into that window before any request, so an entry claiming to have been served
 *   beyond it is describing something that could not have happened.
 * - an **inverted** served range makes every intersection meaningless, and would silently produce an empty
 *   display range that reads as "no collection scheduled".
 *
 * A contradiction drops the **whole** entry. Filtering the offending events out would leave a schedule that
 * looks complete for its range while being assembled from a record already known to be inconsistent, and
 * repairing it would mean inventing which half was correct.
 */
const isSelfConsistent = (entry: ScheduleCacheEntry): boolean => {
  const { servedRange, provenance, events } = entry.schedule;

  if (servedRange.from > servedRange.to) {
    return false;
  }

  // The declared window itself has to contain a day. An inverted one makes every intersection against it empty,
  // which reads as the source publishing nothing rather than as a contradictory record.
  if (provenance.validity.from > provenance.validity.to) {
    return false;
  }

  if (servedRange.from < provenance.validity.from || servedRange.to > provenance.validity.to) {
    return false;
  }

  return events.every(
    (event) =>
      event.serviceAreaId === entry.serviceAreaId &&
      isWithinRange(event.date, servedRange) &&
      /**
       * Official municipal data only, checked independently of the HTTP boundary that first accepted it.
       *
       * The transport now refuses a demo provider and any event that is not `municipal_ics`, but this record may
       * have been written by a build that did not — or altered since. A cached demo or hand-entered event is the
       * most damaging thing this extension could present: it appears under the operator's name, with their
       * attribution, and a reminder built from it tells someone to act on a date nobody published.
       *
       * The provider's own `sourceKind` is not part of the persisted payload — the worker flattens the response
       * and keeps `providerName` rather than the kind — so the event's `source` is what carries the claim here.
       * That is the field the demo and user-rule cases both fail.
       */
      event.source === 'municipal_ics',
  );
};

export interface CacheReadContext {
  readonly origin: string;
  readonly now: Date;
}

/**
 * Removes every entry that is unusable: past its retention, belonging to another origin, or no longer
 * validating against the current entry schema.
 *
 * Eviction runs on every read and write, which is what bounds growth. A failed refresh never calls this
 * with a reason to drop a still-usable entry — that is the precise meaning of not destroying a usable
 * cached result.
 */
const evictUnusable = (
  raw: Record<string, unknown>,
  { origin, now }: CacheReadContext,
): Record<string, ScheduleCacheEntry> => {
  const usable: Record<string, ScheduleCacheEntry> = {};

  for (const [key, value] of Object.entries(raw)) {
    const parsed = ScheduleCacheEntrySchema.safeParse(value);

    if (!parsed.success || parsed.data.origin !== origin || isExpired(parsed.data, now)) {
      continue;
    }

    // Persisted storage is untrusted: it survives upgrades, and nothing stops another process or a corrupted
    // write from filing a record under a key that contradicts its own contents. A record claiming one area
    // while stored under another's key would hand a lookup the wrong area's schedule — official-looking dates
    // for somewhere the user never chose. Its identity therefore has to *derive* the key it was found under.
    if (toCacheKey(parsed.data) !== key) {
      continue;
    }

    // ...and the contents have to agree with that identity, not merely be well shaped.
    if (!isSelfConsistent(parsed.data)) {
      continue;
    }

    usable[key] = parsed.data;
  }

  return usable;
};

/**
 * Reads one entry, evicting anything unusable in the process.
 *
 * Returns `undefined` for a missing, invalid, expired, or foreign-origin entry — all four are "nothing
 * trustworthy is cached", and none of them is an error.
 */
export const readCacheEntry = async (
  parts: CacheKeyParts,
  now: Date,
): Promise<ScheduleCacheEntry | undefined> =>
  // Serialized like the writes: this reads the record and can replace it, so it is a mutation too.
  serializeMutation(async () => {
    const raw = await readRawCache();
    const usable = evictUnusable(raw, { origin: parts.origin, now });

    if (Object.keys(usable).length !== Object.keys(raw).length) {
      await cacheItem.setValue(usable);
    }

    const entry = usable[toCacheKey(parts)];

    if (entry === undefined) {
      return undefined;
    }

    // Belt and braces on top of the key-derivation check above: the entry handed back must name exactly the
    // origin, provider, and area that were asked for. Nothing downstream re-checks this, and both the display
    // and the reminder path treat what they receive as the schedule for the requested area.
    return entry.origin === parts.origin &&
      entry.providerId === parts.providerId &&
      entry.serviceAreaId === parts.serviceAreaId
      ? entry
      : undefined;
  });

export interface WriteCacheEntryInput extends CacheKeyParts {
  readonly schedule: SchedulePayload;
  readonly now: Date;
}

export type CacheWriteOutcome = 'written' | 'kept_newer';

/**
 * Stores a validated response.
 *
 * Only a response that passed transport validation ever reaches here; a failed refresh writes nothing.
 * An entry is overwritten only when the new `retrievedAt` is not older than the stored one, so an
 * upstream-stale response cannot displace a newer cached result.
 */
export const writeCacheEntry = async ({
  origin,
  providerId,
  serviceAreaId,
  schedule,
  now,
}: WriteCacheEntryInput): Promise<CacheWriteOutcome> =>
  serializeMutation(async () => {
    const raw = await readRawCache();
    const usable = evictUnusable(raw, { origin, now });
    const key = toCacheKey({ origin, providerId, serviceAreaId });
    const existing = usable[key];

    if (
      existing !== undefined &&
      Date.parse(schedule.provenance.retrievedAt) <
        Date.parse(existing.schedule.provenance.retrievedAt)
    ) {
      // The stored result is newer. Persist the eviction pass, but keep the better entry.
      await cacheItem.setValue(usable);

      return 'kept_newer';
    }

    const entry: ScheduleCacheEntry = {
      origin,
      providerId,
      serviceAreaId,
      schedule,
      storedAt: now.toISOString(),
    };

    await cacheItem.setValue({ ...usable, [key]: ScheduleCacheEntrySchema.parse(entry) });

    return 'written';
  });

/**
 * Drops one entry.
 *
 * Used when a successful capability refresh reports the area `unavailable`: a provider that has withdrawn
 * a calendar must not keep answering through a cache, which is precisely the case where old data reads as
 * current official data.
 */
export const evictCacheEntry = async (parts: CacheKeyParts, now: Date): Promise<void> =>
  serializeMutation(async () => {
    const usable = evictUnusable(await readRawCache(), { origin: parts.origin, now });
    const key = toCacheKey(parts);

    if (!(key in usable)) {
      return;
    }

    delete usable[key];

    await cacheItem.setValue(usable);
  });
