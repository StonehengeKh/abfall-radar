import { storage } from 'wxt/utils/storage';
import { z } from 'zod';
import { CACHE_RETENTION_MS, type CacheKeyParts, toCacheKey } from '@/src/storage/schedule-cache';

/**
 * A record that one area's cached schedule has been **authoritatively withdrawn**.
 *
 * Invalidation used to be nothing more than a successful deletion, which made it exactly as reliable as the
 * storage write it depended on. When the write was refused the entry stayed on disk and remained perfectly
 * restorable — so a schedule the operator had stopped publishing could be presented again, as official current
 * data, by the very next popup that opened. The worker's in-memory generation covered that within one worker
 * lifetime and nothing at all after a restart, which for a Manifest V3 service worker is minutes away.
 *
 * So invalidation is a **state** rather than an act. A tombstone is written independently of the physical
 * eviction, and a restore consults it before it hands anything back. The two are deliberately separate: the
 * eviction reclaims space and is best-effort, while the tombstone is the guarantee.
 *
 * Owned by the worker, like the cache itself. Keyed identically — normalized origin, provider, area — so a
 * withdrawal cannot be read across origins, and so one area's withdrawal says nothing about another's.
 *
 * **The boundary this cannot cross.** If every persistent write fails, no durable state exists to be written; a
 * forcible restart before the selection clear has been persisted then leaves neither a tombstone nor a cleared
 * selection, and the surviving entry becomes restorable again. Nothing in a storage-backed design can prevent
 * that, and this file does not pretend otherwise. What it does guarantee: the current worker stays safe through
 * the in-memory marker, the tombstone survives an ordinary restart, and clearing the selection is never blocked
 * by either write failing — because a cleared selection is itself what stops anything asking for the area.
 */

const TOMBSTONE_KEY = 'local:schedule-tombstones' as const;

/**
 * The most withdrawals kept at once.
 *
 * A bound is required: without one, every area a user ever tries and loses would accumulate for ever in a store
 * that is only ever appended to. When the cap is reached the oldest withdrawal is dropped, because a tombstone
 * older than every other one is also the one whose cache entry is most likely already gone — and any entry it
 * was protecting has to be inside the retention window to be restorable at all.
 */
export const MAX_TOMBSTONES = 50;

/**
 * Strict, like every persisted schema. The identity is stored in the record as well as in its key so a record
 * filed under a contradictory key can be rejected rather than trusted, exactly as a cache entry is.
 */
const TombstoneSchema = z.strictObject({
  origin: z.string().min(1),
  providerId: z.string().min(1),
  serviceAreaId: z.string().min(1),
  /** When the withdrawal was learned. Bounds the record by the same window the cache uses. */
  invalidatedAt: z.iso.datetime(),
  /**
   * Which invalidation this record belongs to.
   *
   * A replacement is authorized to forget **one** withdrawal: the one it observed. Without a token, removal was an
   * unconditional delete, so a replacement whose own withdrawal had already been superseded by a newer one deleted
   * the newer record — and that newer withdrawal was forgotten by an operation that knew nothing about it.
   *
   * Derived from **what is on disk** (`existing + 1`) rather than from the worker's generation counter, so it keeps
   * increasing across a restart. A worker's counter starts again at zero, so a record written by a previous worker
   * would carry a number the new one could never match, and its withdrawal could never be lifted at all.
   */
  token: z.number().int().nonnegative(),
});

export type ScheduleTombstone = z.infer<typeof TombstoneSchema>;

/**
 * What a compare-and-clear decided.
 *
 * `superseded` is not a failure and is not success either: the record is still there, deliberately, because a newer
 * invalidation owns it. A caller must treat it exactly as it treats a refusal — the withdrawal stands.
 */
export type ScheduleInvalidationClearOutcome = 'cleared' | 'absent' | 'superseded';

const TombstoneStoreSchema = z.record(z.string(), z.unknown());

const tombstoneItem = storage.defineItem<Record<string, unknown>>(TOMBSTONE_KEY, {
  fallback: {},
});

/**
 * A tombstone outlives nothing it needs to.
 *
 * The retention window is the cache's own: an entry older than it cannot be restored, so a tombstone guarding
 * one has nothing left to guard. Reusing the constant keeps the two from drifting into a window where an entry is
 * still restorable and its withdrawal has been forgotten.
 */
const isStale = (tombstone: ScheduleTombstone, now: Date): boolean => {
  const age = now.getTime() - Date.parse(tombstone.invalidatedAt);

  // A future stamp is untrustworthy in both directions, so it is dropped rather than kept for ever — the same
  // rule the cache applies to its own timestamps.
  return age < 0 || age > CACHE_RETENTION_MS;
};

/** Everything currently valid, with its own identity agreeing with the key it was found under. */
const readUsable = async (
  origin: string,
  now: Date,
): Promise<Record<string, ScheduleTombstone>> => {
  const parsed = TombstoneStoreSchema.safeParse(await tombstoneItem.getValue());
  const raw = parsed.success ? parsed.data : {};
  const usable: Record<string, ScheduleTombstone> = {};

  for (const [key, value] of Object.entries(raw)) {
    const record = TombstoneSchema.safeParse(value);

    if (!record.success || record.data.origin !== origin || isStale(record.data, now)) {
      continue;
    }

    // Derived rather than trusted: a record claiming one area under another's key would otherwise withhold the
    // wrong area's schedule, or fail to withhold the right one.
    if (toCacheKey(record.data) !== key) {
      continue;
    }

    usable[key] = record.data;
  }

  return usable;
};

/**
 * Serialized against itself, for the reason the cache and the settings repository are.
 *
 * Every operation here is a read-modify-write of one storage key, and two of them running concurrently would
 * both read the same record and both write their own version — losing whichever landed first. Losing a *write*
 * here means forgetting a withdrawal.
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
 * Records that this area's schedule has been withdrawn.
 *
 * Rejects when storage refuses, and the caller is expected to carry on: the in-memory marker still protects this
 * worker, and refusing to clear the selection would leave it pointing at an area the operator no longer serves.
 */
export const markScheduleInvalidated = async (parts: CacheKeyParts, now: Date): Promise<void> =>
  serializeMutation(async () => {
    const usable = await readUsable(parts.origin, now);
    const key = toCacheKey(parts);

    /**
     * A token strictly newer than whatever was there.
     *
     * Every invalidation issues one, so a replacement holding an earlier token can be recognized as stale — and two
     * invalidations landing in either order both leave a record newer than any replacement already in flight.
     * Serialized with every other operation here, so the read and the write see the same value.
     */
    const token = (usable[key]?.token ?? 0) + 1;

    usable[key] = {
      origin: parts.origin,
      providerId: parts.providerId,
      serviceAreaId: parts.serviceAreaId,
      invalidatedAt: now.toISOString(),
      token,
    };

    await tombstoneItem.setValue(bounded(usable));
  });

/**
 * The token of the withdrawal currently recorded for this area, or `null` when there is none.
 *
 * A replacement reads this **before** it writes, so the removal afterwards can prove that nothing replaced the
 * record in between. Rejects when the store cannot be read, which the caller treats as a reason not to relax
 * anything — the same fail-closed direction `isScheduleInvalidated` takes.
 */
export const scheduleInvalidationToken = async (
  parts: CacheKeyParts,
  now: Date,
): Promise<number | null> => {
  const usable = await readUsable(parts.origin, now);

  return usable[toCacheKey(parts)]?.token ?? null;
};

/**
 * Drops the oldest records until the store is within its cap.
 *
 * Applied on write rather than on read, so the bound holds even if nothing ever reads the store again.
 */
const bounded = (usable: Record<string, ScheduleTombstone>): Record<string, ScheduleTombstone> => {
  const entries = Object.entries(usable);

  if (entries.length <= MAX_TOMBSTONES) {
    return usable;
  }

  const newest = entries
    .sort(([, left], [, right]) => Date.parse(right.invalidatedAt) - Date.parse(left.invalidatedAt))
    .slice(0, MAX_TOMBSTONES);

  return Object.fromEntries(newest);
};

/**
 * Whether this area's schedule is withdrawn.
 *
 * Answers `true` when the store cannot be read at all. That is the fail-closed direction: withholding an offline
 * restore costs a person a cached schedule until the network answers, while the other direction presents a
 * calendar the operator has stopped publishing as current official data.
 */
export const isScheduleInvalidated = async (parts: CacheKeyParts, now: Date): Promise<boolean> => {
  try {
    const usable = await readUsable(parts.origin, now);

    return toCacheKey(parts) in usable;
  } catch {
    return true;
  }
};

/**
 * Forgets **one** withdrawal — the one whose token the caller was authorized to replace.
 *
 * Compare-and-clear rather than delete, and that is the correction. The caller establishes from its own generation
 * that its response started after a particular invalidation; it cannot know whether *another* invalidation has
 * happened since, because a storage round trip separates the two. An unconditional delete therefore removed
 * whatever record it found, including one written moments earlier by a withdrawal this operation knew nothing
 * about — and that newer withdrawal was then forgotten, leaving its area restorable again.
 *
 * `superseded` is the answer for exactly that case: the record is still there, deliberately, and the caller must
 * treat it as a refusal. Serialized with every other operation here, so the compare and the write see the same
 * value — reading first and deleting afterwards would leave the window this exists to close.
 *
 * Rejects when storage refuses, and the caller must then keep its own guards in place.
 */
export const clearScheduleInvalidation = async (
  parts: CacheKeyParts,
  now: Date,
  expectedToken: number,
): Promise<ScheduleInvalidationClearOutcome> =>
  serializeMutation(async () => {
    const usable = await readUsable(parts.origin, now);
    const key = toCacheKey(parts);
    const existing = usable[key];

    if (existing === undefined) {
      // Already gone, which is the outcome the caller wanted. Nothing to compare and nothing to write.
      return 'absent';
    }

    if (existing.token !== expectedToken) {
      return 'superseded';
    }

    delete usable[key];

    await tombstoneItem.setValue(usable);

    return 'cleared';
  });
