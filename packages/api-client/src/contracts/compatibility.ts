import type { z } from 'zod';
import type { components } from '../generated/api';
import type { CollectionEventListResponseSchema } from './collection-events';
import type { ProblemDetailsSchema } from './problem-details';
import type { ProviderListResponseSchema } from './providers';
import type {
  ServiceAreaCollectionEventsSchema,
  ServiceAreaListResponseSchema,
} from './service-areas';

/**
 * Pins every hand-written validator to the type OpenAPI generated.
 *
 * Two representations of one contract exist — generated types and hand-written runtime validators — and
 * this is what keeps them honest. A validator that stops matching its generated type is a compile error
 * here, not a runtime surprise in a browser, and the drift test in `apps/api` separately guarantees the
 * generated type still matches the route schemas.
 *
 * Each assertion is a `const` whose type can only be `true` when the two types are mutually assignable,
 * so nothing is cast and no diagnostic is suppressed.
 */

type Schemas = components['schemas'];

/** `never` on either failing direction, so an assignment of `true` stops compiling. */
type AssignableBothWays<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** One direction only, for a validator that is deliberately wider than the contract. */
type AssignableTo<A, B> = [A] extends [B] ? true : never;

export const providerListResponseMatchesContract: AssignableBothWays<
  z.infer<typeof ProviderListResponseSchema>,
  Schemas['ProviderListResponse']
> = true;

export const serviceAreaListResponseMatchesContract: AssignableBothWays<
  z.infer<typeof ServiceAreaListResponseSchema>,
  Schemas['ServiceAreaListResponse']
> = true;

export const serviceAreaCapabilityMatchesContract: AssignableBothWays<
  z.infer<typeof ServiceAreaCollectionEventsSchema>,
  Schemas['ServiceAreaCollectionEvents']
> = true;

export const collectionEventListResponseMatchesContract: AssignableBothWays<
  z.infer<typeof CollectionEventListResponseSchema>,
  Schemas['CollectionEventListResponse']
> = true;

/**
 * One-directional on purpose, and the asymmetry is the point.
 *
 * Every Problem Details body the contract can produce is accepted by this validator, which is what has
 * to hold. The reverse does not, because the validator reads `code` as a string rather than as today's
 * closed set: a problem code newer than this installed build must degrade to a generic message instead of
 * failing validation. Asserting equality here would forbid exactly the forward compatibility this
 * boundary was designed for.
 */
export const problemDetailsAcceptsEveryContractBody: AssignableTo<
  Schemas['ProblemDetails'],
  z.infer<typeof ProblemDetailsSchema>
> = true;

/** Each documented per-code problem body is accepted by the same validator. */
export const validationProblemIsAccepted: AssignableTo<
  Schemas['ValidationProblem'],
  z.infer<typeof ProblemDetailsSchema>
> = true;

export const collectionEventsNotFoundProblemIsAccepted: AssignableTo<
  Schemas['CollectionEventsNotFoundProblem'],
  z.infer<typeof ProblemDetailsSchema>
> = true;

export const scheduleRangeNotCoveredProblemIsAccepted: AssignableTo<
  Schemas['ScheduleRangeNotCoveredProblem'],
  z.infer<typeof ProblemDetailsSchema>
> = true;

export const upstreamSourceInvalidProblemIsAccepted: AssignableTo<
  Schemas['UpstreamSourceInvalidProblem'],
  z.infer<typeof ProblemDetailsSchema>
> = true;

export const upstreamSourceUnavailableProblemIsAccepted: AssignableTo<
  Schemas['UpstreamSourceUnavailableProblem'],
  z.infer<typeof ProblemDetailsSchema>
> = true;

/** Every assertion above, so a test can confirm the module is really evaluated rather than dead code. */
export const CONTRACT_COMPATIBILITY_ASSERTIONS = {
  providerListResponseMatchesContract,
  serviceAreaListResponseMatchesContract,
  serviceAreaCapabilityMatchesContract,
  collectionEventListResponseMatchesContract,
  problemDetailsAcceptsEveryContractBody,
  validationProblemIsAccepted,
  collectionEventsNotFoundProblemIsAccepted,
  scheduleRangeNotCoveredProblemIsAccepted,
  upstreamSourceInvalidProblemIsAccepted,
  upstreamSourceUnavailableProblemIsAccepted,
} as const;
