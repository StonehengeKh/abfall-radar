import { z } from 'zod';

/**
 * The provider catalogue as it arrives over HTTP.
 *
 * Hand-written rather than generated, because generated types vanish at runtime and an HTTP response is
 * untrusted input. Every known member is required and validated; unknown members are stripped, so an
 * additive server field can neither break an installed extension nor be forwarded into a cache or a UI
 * by a build that does not understand it.
 *
 * `packages/api-client/src/contracts/compatibility.ts` pins the output of every validator here to the
 * type OpenAPI generated, so the two representations cannot drift apart silently.
 */

export const ProviderSourceKindSchema = z.enum(['demo', 'official_ics']);

export type ProviderSourceKind = z.infer<typeof ProviderSourceKindSchema>;

export const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceKind: ProviderSourceKindSchema,
});

export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderListResponseSchema = z.object({
  data: z.array(ProviderSchema),
});

export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;
