import { z } from 'zod';
import { TimeZoneSchema } from './time-zone';

/**
 * What the extension knows about whether a provider publishes a calendar for a service area.
 *
 * Declared here rather than imported from `@abfall-radar/api-client` because this shape crosses two
 * internal boundaries — the worker message envelope and the settings repository — and both are reachable
 * from the popup, which must never reach the transport client. The worker maps the client's validated
 * capability onto this explicitly.
 *
 * These schemas are **strict**, unlike the API response validators that strip unknown members. Both
 * sides of an internal boundary ship in one artifact, so an unexpected member here is a defect rather
 * than a newer contract.
 */

/**
 * A date window whose two ends are in order.
 *
 * An inverted window fails *after* being accepted: `deriveTargetRange` clamps the requested range into the
 * declared validity, and `intersectRanges` intersects a served range with it, so `from > to` silently produces an
 * empty result that every surface reads as the source publishing nothing for the period. That is a statement
 * about the operator made from a contradiction in their own metadata, so it is refused here instead.
 */
export const SourceWindowSchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine(({ from, to }) => from <= to, {
    error: 'The window must not start after it ends.',
    path: ['to'],
  });

export type SourceWindow = z.infer<typeof SourceWindowSchema>;

/**
 * The zone and window a requested range is derived from. Kept as one value because deriving a range
 * needs both: a zone without a window cannot be clamped, and a window without a zone cannot say which
 * day "today" is.
 */
export const SourceCalendarSchema = z.strictObject({
  /** Validated for usability, because this is the zone a range is derived in. */
  timeZone: TimeZoneSchema,
  validity: SourceWindowSchema,
});

export type SourceCalendar = z.infer<typeof SourceCalendarSchema>;

export const AvailableCapabilitySchema = z.strictObject({
  availability: z.literal('available'),
  timeZone: TimeZoneSchema,
  validity: SourceWindowSchema,
});

export const UnavailableCapabilitySchema = z.strictObject({
  availability: z.literal('unavailable'),
});

export const ServiceAreaCapabilitySchema = z.discriminatedUnion('availability', [
  AvailableCapabilitySchema,
  UnavailableCapabilitySchema,
]);

export type ServiceAreaCapability = z.infer<typeof ServiceAreaCapabilitySchema>;

export type AvailableCapability = z.infer<typeof AvailableCapabilitySchema>;

/**
 * A capability **together with the area it was read for**.
 *
 * A bare capability is evidence about nothing in particular. Passed alongside a selection it looks like evidence
 * for that selection, and nothing in the type system said otherwise — so a surface that found the capability by
 * area id in whichever list it happened to be showing could hand over an `available` capability belonging to a
 * different area, or a different provider entirely, and the repository would persist the candidate on the
 * strength of it. That is the one guarantee the capability check exists to provide: an area is persisted only
 * when *its own* calendar was confirmed.
 *
 * So identity travels with the evidence and is **required**, which makes the mismatch checkable rather than
 * assumed. Both identifiers are needed: an area id is unique only within its provider, so an area id alone would
 * still let one provider's confirmation stand in for another's.
 */
export const ServiceAreaCapabilityEvidenceSchema = z.strictObject({
  providerId: z.string().min(1),
  serviceAreaId: z.string().min(1),
  collectionEvents: ServiceAreaCapabilitySchema,
});

export type ServiceAreaCapabilityEvidence = z.infer<typeof ServiceAreaCapabilityEvidenceSchema>;

/**
 * Whether evidence describes exactly the area it is being offered for.
 *
 * Compared structurally on both identifiers, because the two values reach the repository from different places —
 * one from a draft or a confirmation, the other from a validated response.
 */
export const describesArea = (
  evidence: ServiceAreaCapabilityEvidence,
  area: { readonly providerId: string; readonly serviceAreaId: string },
): boolean =>
  evidence.providerId === area.providerId && evidence.serviceAreaId === area.serviceAreaId;

export const isAvailable = (capability: ServiceAreaCapability): capability is AvailableCapability =>
  capability.availability === 'available';

/** The zone and window of an available capability, or `undefined` when no calendar is published. */
export const toSourceCalendar = (capability: ServiceAreaCapability): SourceCalendar | undefined =>
  isAvailable(capability)
    ? { timeZone: capability.timeZone, validity: capability.validity }
    : undefined;

/** Whether two windows describe the same period, compared by their ends rather than by identity. */
export const sameSourceWindow = (left: SourceWindow, right: SourceWindow): boolean =>
  left.from === right.from && left.to === right.to;

/**
 * True when a live capability response agrees with what the extension last knew.
 *
 * Used to decide whether a displayed range still stands: a changed zone can move the local date, and a
 * moved window can turn full cache coverage into partial, so a difference has to force a recomputation
 * before any events are fetched.
 *
 * Agreement about the *source* is not on its own agreement about the **requested range**. The range is
 * derived from this metadata **and the current source-local date**, so it moves at every source-local
 * midnight while every field compared here stays identical. A caller deciding whether a displayed cache
 * still stands has to compare the derived range too — see `sameSourceWindow`.
 */
export const sameSourceCalendar = (
  left: SourceCalendar | undefined,
  right: SourceCalendar | undefined,
): boolean => {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return left.timeZone === right.timeZone && sameSourceWindow(left.validity, right.validity);
};
