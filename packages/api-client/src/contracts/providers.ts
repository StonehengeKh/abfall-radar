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

/**
 * A city and the official providers behind it.
 *
 * `providers` is non-empty by contract: a city exists because something serves it, so an empty list
 * would describe a city this client cannot act on. Rejecting it here keeps that impossible state out of
 * every surface rather than leaving each one to guard it.
 */
export const CitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  providers: z.array(ProviderSchema).min(1),
});

export type City = z.infer<typeof CitySchema>;

export const CityListResponseSchema = z.object({
  data: z.array(CitySchema),
});

export type CityListResponse = z.infer<typeof CityListResponseSchema>;
