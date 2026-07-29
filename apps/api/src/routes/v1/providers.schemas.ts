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

export const ServiceAreaSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    locality: z.string().min(1),
    name: z.string().min(1),
  })
  .meta({
    id: 'ServiceArea',
    description:
      'A normalized collection area within a provider. `locality` is the town or city the area belongs to.',
    examples: [
      {
        id: 'koblenz-stadtmitte',
        providerId: 'demo',
        locality: 'Koblenz',
        name: 'Stadtmitte',
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
    description: 'The normalized service areas of the selected provider.',
    examples: [
      {
        data: [
          {
            id: 'koblenz-stadtmitte',
            providerId: 'demo',
            locality: 'Koblenz',
            name: 'Stadtmitte',
          },
          {
            id: 'koblenz-metternich-1',
            providerId: 'demo',
            locality: 'Koblenz',
            name: 'Metternich 1',
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
