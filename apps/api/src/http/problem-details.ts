import { z } from 'zod';

/**
 * ADR 0002 requires an owned URI or URN for every problem type. A URN is used so the project never
 * publishes a documentation URL under a domain it does not control.
 */
export const PROBLEM_TYPE_PREFIX = 'urn:abfall-radar:problem:';

export const PROBLEM_CODES = [
  'VALIDATION_ERROR',
  'REQUEST_ERROR',
  'PROVIDER_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'INTERNAL_SERVER_ERROR',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

interface ProblemDefinition {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
}

/**
 * `detail` is fixed diagnostic API copy. It never interpolates request input, upstream responses, or
 * framework internals, which keeps every documented failure safe to return unchanged.
 */
export const problemCatalogue: Record<ProblemCode, ProblemDefinition> = {
  VALIDATION_ERROR: {
    type: `${PROBLEM_TYPE_PREFIX}validation-error`,
    title: 'Invalid request',
    status: 400,
    detail: 'The request did not match the documented contract.',
  },
  REQUEST_ERROR: {
    type: `${PROBLEM_TYPE_PREFIX}request-error`,
    title: 'Request error',
    status: 400,
    detail: 'The request could not be processed as sent.',
  },
  PROVIDER_NOT_FOUND: {
    type: `${PROBLEM_TYPE_PREFIX}provider-not-found`,
    title: 'Provider not found',
    status: 404,
    detail: 'No schedule provider exists for the supplied identifier.',
  },
  ROUTE_NOT_FOUND: {
    type: `${PROBLEM_TYPE_PREFIX}route-not-found`,
    title: 'Route not found',
    status: 404,
    detail: 'The requested route does not exist on this API.',
  },
  INTERNAL_SERVER_ERROR: {
    type: `${PROBLEM_TYPE_PREFIX}internal-server-error`,
    title: 'Internal server error',
    status: 500,
    detail: 'The request could not be completed because of an unexpected server error.',
  },
};

export const ValidationIssueSchema = z
  .object({
    path: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .meta({
    id: 'ValidationIssue',
    description:
      'A single field-level validation failure. `path` is a JSON Pointer into the rejected request part and `code` is a stable machine-readable reason.',
    examples: [
      {
        path: '/providerId',
        code: 'invalid_format',
        message: 'Invalid string: must match pattern /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/',
      },
    ],
  });

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ProblemDetailsSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string(),
    code: z.enum(PROBLEM_CODES),
    requestId: z.string(),
    errors: z.array(ValidationIssueSchema).optional(),
  })
  .meta({
    id: 'ProblemDetails',
    description:
      'An unexpected server error occurred. The response follows RFC 9457 and never contains stack traces, upstream payloads, or infrastructure details. Correlate `requestId` with the server logs.',
    examples: [
      {
        type: `${PROBLEM_TYPE_PREFIX}internal-server-error`,
        title: 'Internal server error',
        status: 500,
        detail: problemCatalogue.INTERNAL_SERVER_ERROR.detail,
        instance: '/api/v1/providers',
        code: 'INTERNAL_SERVER_ERROR',
        requestId: 'req-1',
      },
    ],
  });

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export const ValidationProblemSchema = ProblemDetailsSchema.meta({
  id: 'ValidationProblem',
  description:
    'The request did not satisfy the documented request schema. `errors` lists the rejected fields with stable paths and machine-readable codes.',
  examples: [
    {
      type: `${PROBLEM_TYPE_PREFIX}validation-error`,
      title: 'Invalid request',
      status: 400,
      detail: problemCatalogue.VALIDATION_ERROR.detail,
      instance: '/api/v1/providers/Invalid_ID/service-areas',
      code: 'VALIDATION_ERROR',
      requestId: 'req-1',
      errors: [
        {
          path: '/providerId',
          code: 'invalid_format',
          message: 'Invalid string: must match pattern /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/',
        },
      ],
    },
  ],
});

export const ProviderNotFoundProblemSchema = ProblemDetailsSchema.meta({
  id: 'ProviderNotFoundProblem',
  description:
    'The supplied provider identifier is well formed but no provider is registered for it.',
  examples: [
    {
      type: `${PROBLEM_TYPE_PREFIX}provider-not-found`,
      title: 'Provider not found',
      status: 404,
      detail: problemCatalogue.PROVIDER_NOT_FOUND.detail,
      instance: '/api/v1/providers/unknown/service-areas',
      code: 'PROVIDER_NOT_FOUND',
      requestId: 'req-1',
    },
  ],
});

export interface ApiProblemOptions {
  readonly status?: number;
  readonly errors?: readonly ValidationIssue[];
}

export class ApiProblem extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly detail: string;
  readonly errors: readonly ValidationIssue[] | undefined;

  constructor(code: ProblemCode, options: ApiProblemOptions = {}) {
    const definition = problemCatalogue[code];

    super(definition.detail);
    this.name = 'ApiProblem';
    this.code = code;
    this.status = options.status ?? definition.status;
    this.detail = definition.detail;
    this.errors = options.errors;
  }

  static providerNotFound(): ApiProblem {
    return new ApiProblem('PROVIDER_NOT_FOUND');
  }
}

export interface BuildProblemInput {
  readonly code: ProblemCode;
  readonly instance: string;
  readonly requestId: string;
  readonly status?: number;
  readonly errors?: readonly ValidationIssue[];
}

export const buildProblem = ({
  code,
  instance,
  requestId,
  status,
  errors,
}: BuildProblemInput): ProblemDetails => {
  const definition = problemCatalogue[code];

  return {
    type: definition.type,
    title: definition.title,
    status: status ?? definition.status,
    detail: definition.detail,
    instance,
    code,
    requestId,
    ...(errors === undefined ? {} : { errors: [...errors] }),
  };
};
