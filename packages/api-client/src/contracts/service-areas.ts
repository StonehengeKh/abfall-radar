import { z } from 'zod';
import { TimeZoneSchema } from './time-zone';

/**
 * The service areas of one provider, each stating whether that provider publishes an official calendar
 * for it.
 *
 * The capability is what lets a client construct a correct range before asking for a schedule: the
 * validity window used to be visible only on a collection-events response, which is the request it is
 * needed to build.
 */

/**
 * The window a source declares it publishes for, with its two ends in order.
 *
 * An inverted window would fail *after* being accepted: `deriveTargetRange` clamps the requested range into it,
 * so `from > to` makes the clamp invert and the range become empty — which every surface then reads as the source
 * publishing no calendar for the current period. That is a statement about the operator, made on the strength of
 * a contradiction in their own metadata, so it has to be refused here instead.
 */
export const ServiceAreaValiditySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine(({ from, to }) => from <= to, {
    error: 'The validity window must not start after it ends.',
    path: ['to'],
  });

export type ServiceAreaValidity = z.infer<typeof ServiceAreaValiditySchema>;

export const ServiceAreaCollectionEventsAvailableSchema = z.object({
  availability: z.literal('available'),
  /**
   * Validated for **usability**, not merely for being a nonempty string.
   *
   * This is the zone the requested range is derived in, so an identifier this runtime cannot resolve does
   * not produce a slightly wrong window — it throws inside date derivation, one layer below the boundary
   * that accepted it.
   */
  timeZone: TimeZoneSchema,
  validity: ServiceAreaValiditySchema,
});

/**
 * A zone or a window on this branch is a contradiction, not an additive field, so it is **rejected**
 * rather than stripped: `unavailable` means the source publishes no calendar, and a window alongside it
 * would describe a period that does not exist. Everything else unknown is still stripped, which is why
 * this is a loose object narrowed by a check and a projection rather than a strict one.
 *
 * The projection is also why the capability below is a plain union: a transformed branch is not a valid
 * member of `z.discriminatedUnion`. Discrimination is still exact, because each branch pins
 * `availability` to its own literal, and an unrecognized value therefore matches neither.
 */
const FORBIDDEN_UNAVAILABLE_MEMBERS = ['timeZone', 'validity'] as const;

export const ServiceAreaCollectionEventsUnavailableSchema = z
  .looseObject({
    availability: z.literal('unavailable'),
  })
  .superRefine((value, ctx) => {
    for (const member of FORBIDDEN_UNAVAILABLE_MEMBERS) {
      if (member in value) {
        ctx.addIssue({
          code: 'custom',
          path: [member],
          message: `An unavailable capability must not carry \`${member}\`.`,
        });
      }
    }
  })
  .transform(({ availability }) => ({ availability }));

export const ServiceAreaCollectionEventsSchema = z.union([
  ServiceAreaCollectionEventsAvailableSchema,
  ServiceAreaCollectionEventsUnavailableSchema,
]);

export type ServiceAreaCollectionEvents = z.infer<typeof ServiceAreaCollectionEventsSchema>;

export const ServiceAreaSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  locality: z.string().min(1),
  name: z.string().min(1),
  collectionEvents: ServiceAreaCollectionEventsSchema,
});

export type ServiceArea = z.infer<typeof ServiceAreaSchema>;

export const ServiceAreaListResponseSchema = z.object({
  data: z.array(ServiceAreaSchema),
});

export type ServiceAreaListResponse = z.infer<typeof ServiceAreaListResponseSchema>;
