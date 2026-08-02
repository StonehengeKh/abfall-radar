import { type CollectionEvent, CollectionEventSchema } from '@abfall-radar/domain';
import type { CollectionEventPayload } from '@/src/messaging/contract';

/**
 * Maps a transport event onto the domain `CollectionEvent`.
 *
 * The transport and the domain deliberately use different names for the same things — `serviceAreaId` is
 * the location-neutral transport term for the domain's `districtId`, and `wasteType` is its `type`. This
 * adapter is the one place that renames them, and it **validates the result** through
 * `CollectionEventSchema` rather than asserting it: nothing is inferred and nothing is cast.
 *
 * Keeping the domain model intact is what lets `getUpcomingEvents`, `findReminderEvent`,
 * `getRelativeDateLabel`, and the existing dashboard props keep working unchanged, so the responsive
 * popup this project already reviewed is preserved rather than rebuilt.
 *
 * It lives in the extension until a second consumer exists, per the rule that a shared abstraction waits
 * for a real second consumer.
 */

export class CollectionEventAdapterError extends Error {
  constructor(cause: unknown) {
    super('A collection event did not satisfy the domain model.', { cause });
    this.name = 'CollectionEventAdapterError';
  }
}

export const toDomainCollectionEvent = (event: CollectionEventPayload): CollectionEvent => {
  const shared = {
    id: event.id,
    districtId: event.serviceAreaId,
    type: event.wasteType,
    date: event.date,
    title: event.title,
    source: event.source,
  };

  const candidate =
    event.collectionMode === 'mobile_drop_off'
      ? {
          ...shared,
          collectionMode: event.collectionMode,
          timing: event.timing,
          location: event.location,
        }
      : { ...shared, collectionMode: event.collectionMode, timing: event.timing };

  const parsed = CollectionEventSchema.safeParse(candidate);

  if (!parsed.success) {
    // A loud failure rather than a dropped event: a partial schedule is indistinguishable from a complete
    // one to the person reading it.
    throw new CollectionEventAdapterError(parsed.error);
  }

  return parsed.data;
};

export const toDomainCollectionEvents = (
  events: readonly CollectionEventPayload[],
): CollectionEvent[] => events.map(toDomainCollectionEvent);

/**
 * The same mapping, reporting failure instead of throwing.
 *
 * Both consumers of this adapter run somewhere a throw is destructive rather than merely loud: the view
 * derivation runs **during React rendering**, where an exception takes the whole popup down, and the reminder
 * runs inside an **alarm handler**, where a rejection is invisible and silently ends the run. Neither can
 * usefully catch a throw at its call site — the render has no error boundary and the alarm has no reader.
 *
 * `null` should be unreachable. Every boundary above now enforces what the domain requires: the transport refuses
 * an inverted window, an unusable zone, a non-official source, a foreign area and an out-of-range date, and the
 * persisted-cache validator enforces the same invariants independently on the way out of storage. This exists so
 * that a *defect* in one of those — a member added to the domain and not to a validator, say — degrades to a
 * stated error state rather than a blank popup or a reminder that never fires.
 */
export const tryToDomainCollectionEvents = (
  events: readonly CollectionEventPayload[],
): CollectionEvent[] | null => {
  try {
    return toDomainCollectionEvents(events);
  } catch {
    // Nothing about the error is surfaced: it could carry a payload. The caller states an honest failure instead.
    return null;
  }
};
