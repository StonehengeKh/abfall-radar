import { type SourceFailureError, isSourceFailureError } from '@abfall-radar/data-providers';
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
  'SERVICE_AREA_NOT_FOUND',
  'COLLECTION_EVENTS_NOT_AVAILABLE',
  'SCHEDULE_RANGE_NOT_COVERED',
  'ROUTE_NOT_FOUND',
  'INTERNAL_SERVER_ERROR',
  'UPSTREAM_SOURCE_INVALID',
  'UPSTREAM_SOURCE_UNAVAILABLE',
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
  SERVICE_AREA_NOT_FOUND: {
    type: `${PROBLEM_TYPE_PREFIX}service-area-not-found`,
    title: 'Service area not found',
    status: 404,
    detail: 'The selected provider does not serve a service area with the supplied identifier.',
  },
  COLLECTION_EVENTS_NOT_AVAILABLE: {
    type: `${PROBLEM_TYPE_PREFIX}collection-events-not-available`,
    title: 'Collection events not available',
    status: 404,
    detail:
      'The selected provider does not publish official collection events for this service area.',
  },
  SCHEDULE_RANGE_NOT_COVERED: {
    type: `${PROBLEM_TYPE_PREFIX}schedule-range-not-covered`,
    title: 'Requested range not covered',
    status: 422,
    detail: 'The requested date range is not covered by the validity window the source declares.',
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
  UPSTREAM_SOURCE_INVALID: {
    type: `${PROBLEM_TYPE_PREFIX}upstream-source-invalid`,
    title: 'Official source unusable',
    status: 502,
    detail:
      'The official source was retrieved but could not be used, and no valid schedule is available.',
  },
  UPSTREAM_SOURCE_UNAVAILABLE: {
    type: `${PROBLEM_TYPE_PREFIX}upstream-source-unavailable`,
    title: 'Official source unavailable',
    status: 503,
    detail: 'The official source could not be retrieved and no valid schedule is available.',
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

const problemShape = {
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string(),
  requestId: z.string(),
  errors: z.array(ValidationIssueSchema).optional(),
};

export const ProblemDetailsSchema = z
  .object({ ...problemShape, code: z.enum(PROBLEM_CODES) })
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

interface CodedProblemOptions {
  readonly id: string;
  readonly description: string;
  readonly instance: string;
  readonly errors?: readonly ValidationIssue[];
}

/**
 * Builds a per-code problem schema whose `code` is a literal rather than the whole enum.
 *
 * The literal is what lets several 404 variants be published as a discriminable `oneOf`, and it also
 * documents a single-code response more precisely. The example is derived from the catalogue, so a
 * change to a `detail`, `title`, or `status` cannot leave the published example behind.
 */
const codedProblem = <Code extends ProblemCode>(code: Code, options: CodedProblemOptions) => {
  const definition = problemCatalogue[code];

  return z.object({ ...problemShape, code: z.literal(code) }).meta({
    id: options.id,
    description: options.description,
    examples: [
      {
        type: definition.type,
        title: definition.title,
        status: definition.status,
        detail: definition.detail,
        instance: options.instance,
        code,
        requestId: 'req-1',
        ...(options.errors === undefined ? {} : { errors: [...options.errors] }),
      },
    ],
  });
};

const COLLECTION_EVENTS_INSTANCE =
  '/api/v1/providers/koblenz-servicebetrieb/service-areas/koblenz-stadtmitte/collection-events?from=2026-03-01&to=2026-03-31';

export const ValidationProblemSchema = codedProblem('VALIDATION_ERROR', {
  id: 'ValidationProblem',
  description:
    'The request did not satisfy the documented request schema. `errors` lists the rejected fields with stable paths and machine-readable codes.',
  instance: '/api/v1/providers/Invalid_ID/service-areas',
  errors: [
    {
      path: '/providerId',
      code: 'invalid_format',
      message: 'Invalid string: must match pattern /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/',
    },
  ],
});

export const ProviderNotFoundProblemSchema = codedProblem('PROVIDER_NOT_FOUND', {
  id: 'ProviderNotFoundProblem',
  description:
    'The supplied provider identifier is well formed but no provider is registered for it.',
  instance: '/api/v1/providers/unknown/service-areas',
});

export const ServiceAreaNotFoundProblemSchema = codedProblem('SERVICE_AREA_NOT_FOUND', {
  id: 'ServiceAreaNotFoundProblem',
  description:
    'The provider exists and the service-area identifier is well formed, but that provider does not serve it.',
  instance:
    '/api/v1/providers/koblenz-servicebetrieb/service-areas/unknown-area/collection-events?from=2026-03-01&to=2026-03-31',
});

export const CollectionEventsNotAvailableProblemSchema = codedProblem(
  'COLLECTION_EVENTS_NOT_AVAILABLE',
  {
    id: 'CollectionEventsNotAvailableProblem',
    description:
      'The provider and the service area both exist, but this provider publishes no official collection calendar for that area. The demo provider never publishes one.',
    instance:
      '/api/v1/providers/demo/service-areas/koblenz-stadtmitte/collection-events?from=2026-03-01&to=2026-03-31',
  },
);

/**
 * One 404 response carrying every reason the resource can be absent. An OpenAPI operation permits a
 * single entry per status code, so three separately registered 404 schemas would overwrite each other.
 */
export const CollectionEventsNotFoundProblemSchema = z
  .discriminatedUnion('code', [
    ProviderNotFoundProblemSchema,
    ServiceAreaNotFoundProblemSchema,
    CollectionEventsNotAvailableProblemSchema,
  ])
  .meta({
    id: 'CollectionEventsNotFoundProblem',
    description:
      'The requested collection-events resource does not exist. `code` states which part was not found: the provider, the service area, or an official calendar for that area.',
  });

export const ScheduleRangeNotCoveredProblemSchema = codedProblem('SCHEDULE_RANGE_NOT_COVERED', {
  id: 'ScheduleRangeNotCoveredProblem',
  description:
    'The requested range is not fully inside the validity window the source declares. Decided from that declared window alone, never from an empty result: a covered range that happens to contain no collection returns an empty list instead.',
  instance:
    '/api/v1/providers/koblenz-servicebetrieb/service-areas/koblenz-stadtmitte/collection-events?from=2025-01-01&to=2025-12-31',
});

export const UpstreamSourceInvalidProblemSchema = codedProblem('UPSTREAM_SOURCE_INVALID', {
  id: 'UpstreamSourceInvalidProblem',
  description:
    'The official source was reached but is unusable — an unexpected content type, an oversized body, a parse failure, a calendar zone that is missing, duplicated, malformed, or not the expected one, an unmapped event summary, or an entry that cannot produce a valid event — and no valid cached schedule exists. Where a valid cached schedule does exist, a stale `200` is returned instead.',
  instance: COLLECTION_EVENTS_INSTANCE,
});

export const UpstreamSourceUnavailableProblemSchema = codedProblem('UPSTREAM_SOURCE_UNAVAILABLE', {
  id: 'UpstreamSourceUnavailableProblem',
  description:
    'The official source could not be retrieved — the retrieval deadline elapsed, a connection error, a non-success status, a redirect leaving the approved origin, too many redirect hops, or a redirect loop — and no valid cached schedule exists. Where a valid cached schedule does exist, a stale `200` is returned instead.',
  instance: COLLECTION_EVENTS_INSTANCE,
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

  static serviceAreaNotFound(): ApiProblem {
    return new ApiProblem('SERVICE_AREA_NOT_FOUND');
  }

  static collectionEventsNotAvailable(): ApiProblem {
    return new ApiProblem('COLLECTION_EVENTS_NOT_AVAILABLE');
  }

  static scheduleRangeNotCovered(): ApiProblem {
    return new ApiProblem('SCHEDULE_RANGE_NOT_COVERED');
  }

  /**
   * Translates a provider failure into its documented status. The provider decides whether a source was
   * unusable or unreachable; this only maps that decision onto the contract, and carries across no
   * upstream message, payload, or URL.
   */
  static fromSourceFailure(error: SourceFailureError): ApiProblem {
    return new ApiProblem(
      error.kind === 'invalid' ? 'UPSTREAM_SOURCE_INVALID' : 'UPSTREAM_SOURCE_UNAVAILABLE',
    );
  }

  static fromUnknown(error: unknown): ApiProblem | undefined {
    return isSourceFailureError(error) ? ApiProblem.fromSourceFailure(error) : undefined;
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

const AREA_PATH = '/api/v1/providers/koblenz-servicebetrieb/service-areas';

const RANGE_QUERY = 'collection-events?from=2026-03-01&to=2026-03-31';

/**
 * The three reasons the collection-events resource can be absent, published as named examples on its
 * single 404 response. Built from the catalogue so they cannot drift from what the API really returns.
 */
export const COLLECTION_EVENTS_NOT_FOUND_EXAMPLES = {
  providerNotFound: {
    summary: 'Unknown provider',
    description: 'The provider identifier is well formed but no provider is registered for it.',
    value: buildProblem({
      code: 'PROVIDER_NOT_FOUND',
      instance: `/api/v1/providers/unknown/service-areas/koblenz-stadtmitte/${RANGE_QUERY}`,
      requestId: 'req-1',
    }),
  },
  serviceAreaNotFound: {
    summary: 'Unknown service area',
    description: 'The provider exists but does not serve a service area with that identifier.',
    value: buildProblem({
      code: 'SERVICE_AREA_NOT_FOUND',
      instance: `${AREA_PATH}/unknown-area/${RANGE_QUERY}`,
      requestId: 'req-1',
    }),
  },
  collectionEventsNotAvailable: {
    summary: 'No official calendar for this area',
    description:
      'The provider and the area both exist, but this provider publishes no official calendar for it. The demo provider never publishes one.',
    value: buildProblem({
      code: 'COLLECTION_EVENTS_NOT_AVAILABLE',
      instance: `/api/v1/providers/demo/service-areas/koblenz-stadtmitte/${RANGE_QUERY}`,
      requestId: 'req-1',
    }),
  },
} as const;
