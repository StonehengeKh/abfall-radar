import { z } from 'zod';

/**
 * Lowercase ASCII letters and digits with internal hyphens only: the value starts and ends with an
 * alphanumeric character. This is a transport constraint, so a violation is a `400` while a well
 * formed but unregistered identifier is a `404`.
 */
export const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const PROVIDER_ID_MAX_LENGTH = 64;

export const ProviderSourceKindSchema = z.enum(['demo', 'official_ics']).meta({
  id: 'ProviderSourceKind',
  description:
    'The kind of source a provider reads. `official_ics` is the calendar the responsible municipal operator publishes. `demo` is generated sample data and must never be presented as official municipal data.',
});

export type ProviderSourceKind = z.infer<typeof ProviderSourceKindSchema>;

export const ProviderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    sourceKind: ProviderSourceKindSchema,
  })
  .meta({
    id: 'Provider',
    description: 'A schedule provider exposed by this API, without provider-specific fields.',
    examples: [{ id: 'demo', name: 'Demo provider', sourceKind: 'demo' }],
  });

export type Provider = z.infer<typeof ProviderSchema>;

export const ServiceAreaValiditySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .meta({
    id: 'ServiceAreaValidity',
    description:
      'The inclusive period the source declares it publishes collection dates for. A requested range that leaves it is refused rather than answered in part.',
    examples: [{ from: '2026-01-01', to: '2026-12-31' }],
  });

export const ServiceAreaCollectionEventsAvailableSchema = z
  .object({
    availability: z.literal('available'),
    timeZone: z.string().min(1),
    validity: ServiceAreaValiditySchema,
  })
  .meta({
    id: 'ServiceAreaCollectionEventsAvailable',
    description:
      'This provider publishes an official collection calendar for the area. `timeZone` is the zone the source publishes in, so a client derives the current date in the municipality’s zone rather than the device’s, and `validity` is the window a collection-events request must stay inside.',
    examples: [
      {
        availability: 'available',
        timeZone: 'Europe/Berlin',
        validity: { from: '2026-01-01', to: '2026-12-31' },
      },
    ],
  });

/**
 * Carries nothing else on purpose. A zone or a window here would have to be invented, and an invented
 * value is indistinguishable from a verified one to every client that reads it.
 */
export const ServiceAreaCollectionEventsUnavailableSchema = z
  .object({
    availability: z.literal('unavailable'),
  })
  .meta({
    id: 'ServiceAreaCollectionEventsUnavailable',
    description:
      'This provider publishes no official collection calendar for the area. A statement about the source, not about whether the area exists or is served: the area is real, and this provider simply has no calendar behind it. Every demo area reports this, with no zone and no window.',
    examples: [{ availability: 'unavailable' }],
  });

/**
 * A capability union rather than nullable date fields, so "this provider publishes no official calendar
 * for this area" cannot be confused with "a value is missing".
 */
export const ServiceAreaCollectionEventsSchema = z
  .discriminatedUnion('availability', [
    ServiceAreaCollectionEventsAvailableSchema,
    ServiceAreaCollectionEventsUnavailableSchema,
  ])
  .meta({
    id: 'ServiceAreaCollectionEvents',
    description:
      'Whether this provider publishes official collection events for the area. `availability` selects the variant: `available` carries the source’s zone and declared validity window, and `unavailable` carries nothing else.',
  });

export type ServiceAreaCollectionEvents = z.infer<typeof ServiceAreaCollectionEventsSchema>;

export const ServiceAreaSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    locality: z.string().min(1),
    name: z.string().min(1),
    collectionEvents: ServiceAreaCollectionEventsSchema,
  })
  .meta({
    id: 'ServiceArea',
    description:
      'A normalized collection area within a provider. `locality` is the town or city the area belongs to, and `collectionEvents` states whether this provider publishes an official calendar for it.',
    examples: [
      {
        id: 'koblenz-stadtmitte',
        providerId: 'koblenz-servicebetrieb',
        locality: 'Koblenz',
        name: 'Stadtmitte',
        collectionEvents: {
          availability: 'available',
          timeZone: 'Europe/Berlin',
          validity: { from: '2026-01-01', to: '2026-12-31' },
        },
      },
    ],
  });

export type ServiceArea = z.infer<typeof ServiceAreaSchema>;

export const ProviderListResponseSchema = z
  .object({
    data: z.array(ProviderSchema),
  })
  .meta({
    id: 'ProviderListResponse',
    description: 'The providers this API can serve. Only demo data is available today.',
    examples: [{ data: [{ id: 'demo', name: 'Demo provider', sourceKind: 'demo' }] }],
  });

export const ServiceAreaListResponseSchema = z
  .object({
    data: z.array(ServiceAreaSchema),
  })
  .meta({
    id: 'ServiceAreaListResponse',
    description:
      'The normalized service areas of the selected provider. Each area states its collection-events capability, so a client knows which areas it can request a schedule for before asking.',
    // One example per capability branch, each showing what that provider really returns: the official
    // provider publishes a calendar for its verified area, and the demo provider publishes none for any.
    examples: [
      {
        data: [
          {
            id: 'koblenz-stadtmitte',
            providerId: 'koblenz-servicebetrieb',
            locality: 'Koblenz',
            name: 'Stadtmitte',
            collectionEvents: {
              availability: 'available',
              timeZone: 'Europe/Berlin',
              validity: { from: '2026-01-01', to: '2026-12-31' },
            },
          },
        ],
      },
      {
        data: [
          {
            id: 'koblenz-stadtmitte',
            providerId: 'demo',
            locality: 'Koblenz',
            name: 'Stadtmitte',
            collectionEvents: { availability: 'unavailable' },
          },
          {
            id: 'koblenz-metternich-1',
            providerId: 'demo',
            locality: 'Koblenz',
            name: 'Metternich 1',
            collectionEvents: { availability: 'unavailable' },
          },
        ],
      },
    ],
  });

/**
 * Deliberately not registered with an `id`: `@fastify/swagger` expands parameter schemas into an
 * OpenAPI `parameters` array, which cannot be done through a `$ref`.
 */
export const ProviderIdParamsSchema = z.object({
  providerId: z
    .string()
    .max(PROVIDER_ID_MAX_LENGTH)
    .regex(PROVIDER_ID_PATTERN)
    .meta({
      description: 'Identifier of a provider returned by `GET /api/v1/providers`.',
      examples: ['demo'],
    }),
});
