import type { CollectionEventTransport } from '@abfall-radar/api-client';
import { type CollectionEvent, CollectionEventSchema } from '@abfall-radar/domain';

/**
 * Maps a validated transport event onto the domain `CollectionEvent`.
 *
 * The transport and the domain name the same things differently: `serviceAreaId` is the location-neutral
 * transport term for the domain's `districtId`, and `wasteType` is its `type`. The result is **validated**
 * through `CollectionEventSchema` rather than asserted, so nothing is inferred and nothing is cast.
 *
 * Consumer-local on purpose: ADR 0005 records why this adapter and the extension's each stay in their
 * own workspace — the two boundaries differ in lifecycle, failure handling, and persistence.
 */
export const toDomainCollectionEvent = (
  event: CollectionEventTransport,
): CollectionEvent | undefined => {
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

  // Non-throwing: this runs while deriving view state during React rendering, where a throw has no error
  // boundary to catch it. The caller treats `undefined` as a failure of the whole response, never as a
  // dropped event — a partial schedule is indistinguishable from a complete one to the person reading it.
  return parsed.success ? parsed.data : undefined;
};
