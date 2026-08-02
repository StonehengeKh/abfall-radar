import { z } from 'zod';
import type { Operation, ProblemFailure } from '../errors';

/**
 * RFC 9457 Problem Details, validated in full and then projected onto a safe subset.
 *
 * The whole body is validated so a malformed error body becomes an explicit invalid-response failure
 * rather than a partially trusted object. It is then reduced at this parse site to the HTTP status, the
 * `code`, and the `requestId`, and everything else is discarded here:
 *
 * - `detail` is diagnostic API copy, not product copy, and is not localized;
 * - `instance` is an internal request path;
 * - `errors` can carry request input.
 *
 * None of those belongs in a user-visible message, and a browser console is not a private place to put
 * them either — which is why the projection happens at the boundary rather than being left to each
 * caller's discretion. `requestId` is enough for correlation, because the API already logs the full
 * failure, including its underlying cause, against that identifier.
 */

export const ValidationIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

export const ProblemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string(),
  requestId: z.string().min(1),
  /**
   * Deliberately a string rather than the closed set the contract publishes today. A problem code newer
   * than this installed build must degrade to a generic message, not fail validation and turn a
   * describable server failure into an unexplained one.
   */
  code: z.string().min(1),
  errors: z.array(ValidationIssueSchema).optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export interface ProblemProjectionInput {
  readonly operation: Operation;
  /** The HTTP status of the response, not the `status` member of the body. */
  readonly status: number;
  readonly problem: ProblemDetails;
}

/**
 * The only way a Problem Details body leaves this module. Written as an explicit member list rather than
 * a spread-and-delete, so a member added to the body cannot start travelling by accident.
 */
export const toProblemFailure = ({
  operation,
  status,
  problem,
}: ProblemProjectionInput): ProblemFailure => ({
  kind: 'problem',
  operation,
  status,
  code: problem.code,
  requestId: problem.requestId,
});
