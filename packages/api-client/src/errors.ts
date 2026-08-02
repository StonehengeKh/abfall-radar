import { z } from 'zod';

/**
 * The failure taxonomy of a request this client makes.
 *
 * A strict discriminated union rather than one shape with optional members, because that is what makes
 * the rules enforceable rather than conventional:
 *
 * - a `requestId` exists **only** on `problem`, where a validated Problem Details body supplied one. A
 *   failure that never reached a server has no identifier to carry, so no code path can reach for one
 *   and no placeholder can be substituted. Handing someone a generated correlation value that matches
 *   nothing in any server log is worse than plainly stating the API was never reached.
 * - `timeout` carries the **configured deadline**, never a measured elapsed duration. The fact worth
 *   reporting is the budget that was exceeded, not how long the runtime took to notice, and a
 *   measurement would vary per run.
 * - every branch is a strict object, so an extra member is a validation failure instead of an
 *   unnoticed extra field travelling to a UI or a log.
 */

export const OPERATIONS = ['listProviders', 'listServiceAreas', 'listCollectionEvents'] as const;

export type Operation = (typeof OPERATIONS)[number];

export const OperationSchema = z.enum(OPERATIONS);

export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * A deadline that could never have been enforced is rejected rather than defaulted. A missing,
 * fractional, zero, or negative value each describes exactly that.
 */
export const TimeoutMsSchema = z.number().int().positive();

export const ProblemFailureSchema = z.strictObject({
  kind: z.literal('problem'),
  operation: OperationSchema,
  status: z.number().int(),
  // A string rather than a closed set, so a problem code newer than this build degrades to a generic
  // message instead of failing validation.
  code: z.string().min(1),
  requestId: z.string().min(1),
});

export const NetworkFailureSchema = z.strictObject({
  kind: z.literal('network'),
  operation: OperationSchema,
});

export const TimeoutFailureSchema = z.strictObject({
  kind: z.literal('timeout'),
  operation: OperationSchema,
  timeoutMs: TimeoutMsSchema,
});

export const CancelledFailureSchema = z.strictObject({
  kind: z.literal('cancelled'),
  operation: OperationSchema,
});

export const InvalidResponseFailureSchema = z.strictObject({
  kind: z.literal('invalid_response'),
  operation: OperationSchema,
  status: z.number().int(),
});

/**
 * The branches are exported individually as well as in this union, so a consumer that adds a boundary
 * failure of its own — the extension's `unsupported_message`, raised before any request exists — builds
 * one union from these same schemas rather than restating them and drifting.
 */
export const API_FAILURE_SCHEMAS = [
  ProblemFailureSchema,
  NetworkFailureSchema,
  TimeoutFailureSchema,
  CancelledFailureSchema,
  InvalidResponseFailureSchema,
] as const;

export const ApiFailureSchema = z.discriminatedUnion('kind', [
  ProblemFailureSchema,
  NetworkFailureSchema,
  TimeoutFailureSchema,
  CancelledFailureSchema,
  InvalidResponseFailureSchema,
]);

export type ProblemFailure = z.infer<typeof ProblemFailureSchema>;

export type NetworkFailure = z.infer<typeof NetworkFailureSchema>;

export type TimeoutFailure = z.infer<typeof TimeoutFailureSchema>;

export type CancelledFailure = z.infer<typeof CancelledFailureSchema>;

export type InvalidResponseFailure = z.infer<typeof InvalidResponseFailureSchema>;

export type ApiFailure = z.infer<typeof ApiFailureSchema>;

export type ApiFailureKind = ApiFailure['kind'];

/** A result rather than a thrown error, so no caller can forget that a request can fail. */
export type ApiResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly failure: ApiFailure };

export class ApiClientConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiClientConfigurationError';
  }
}
