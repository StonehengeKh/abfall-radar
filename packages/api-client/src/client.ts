import type { z } from 'zod';
import { startDeadline } from './abort';
import { parseApiBaseUrl } from './base-url';
import {
  type CollectionEventListResponse,
  CollectionEventListResponseSchema,
  type ScheduleRange,
} from './contracts/collection-events';
import { ProblemDetailsSchema, toProblemFailure } from './contracts/problem-details';
import { type ProviderListResponse, ProviderListResponseSchema } from './contracts/providers';
import {
  type ServiceAreaListResponse,
  ServiceAreaListResponseSchema,
} from './contracts/service-areas';
import {
  ApiClientConfigurationError,
  type ApiFailure,
  type ApiResult,
  DEFAULT_TIMEOUT_MS,
  type Operation,
  TimeoutMsSchema,
} from './errors';

/**
 * Transport for the AbfallRadar HTTP API.
 *
 * Owns request construction, the deadline, and translation of an HTTP outcome into the failure taxonomy.
 * It owns no application state, no cache, no retry policy, and no UI behavior: those are product
 * decisions belonging to whichever surface uses this.
 *
 * Every request URL is built from the exact configured base URL, including its port. That matters
 * because a Chrome host-permission match pattern cannot express a port, so the permission a build
 * requests is broader than the requests this client actually makes — and this is where the narrowness is
 * really enforced.
 */

export const API_V1_PREFIX = '/api/v1';

const JSON_CONTENT_TYPE = 'application/json';

const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** An origin only: scheme, host, and optional port. Anything else is a configuration error. */
  readonly baseUrl: string;
  /** Injected in tests, so no test reaches the network. Defaults to the platform `fetch`. */
  readonly fetch?: FetchLike;
  /** The deadline every request runs under, in milliseconds. Defaults to `8000`. */
  readonly timeoutMs?: number;
}

export interface RequestOptions {
  /**
   * Cancellation from the caller, reported distinctly from a timeout. `runtime.sendMessage` offers the
   * extension popup no cancellation, so this exists for the web and mobile consumers that can use it.
   */
  readonly signal?: AbortSignal;
}

export interface CollectionEventsQuery extends RequestOptions {
  readonly providerId: string;
  readonly serviceAreaId: string;
  readonly range: ScheduleRange;
}

export interface ApiClient {
  /** The normalized origin every request is built from. Part of a consumer's cache key. */
  readonly origin: string;
  readonly timeoutMs: number;
  listProviders(options?: RequestOptions): Promise<ApiResult<ProviderListResponse>>;
  listServiceAreas(
    providerId: string,
    options?: RequestOptions,
  ): Promise<ApiResult<ServiceAreaListResponse>>;
  listCollectionEvents(
    query: CollectionEventsQuery,
  ): Promise<ApiResult<CollectionEventListResponse>>;
}

const failure = <Data>(value: ApiFailure): ApiResult<Data> => ({ ok: false, failure: value });

/**
 * Whether a collection-events response actually answers the request that was made.
 *
 * Schema validity says the body is well formed; it says nothing about it being *this* schedule. A response
 * that names another provider, another area, or another range is well formed and completely untrustworthy
 * as an answer here — and it would be cached under the requested key, presented with the requested area's
 * name, and turned into reminders for dates nobody asked about. A proxy serving a stale entry from a shared
 * cache, or a server-side mix-up between two concurrent requests, produces exactly that.
 *
 * The whole response is rejected rather than the mismatched parts filtered out. Filtering would keep
 * whichever events happened to match and present the remainder as a complete schedule for the range, which
 * is a confident claim assembled from a reply already known to be about something else. There is no partial
 * trust available here: either this is the requested schedule or it is not.
 *
 * Each event's **date** is checked against the range as well as its area. `meta.range` agreeing is the
 * server's claim about what it filtered; an event outside that range is proof it did not. Left unchecked, the
 * date is what everything downstream trusts: the cache records the served range as covering it, the display
 * range is derived from that, and a reminder fires on a day the source never scheduled — the one failure that
 * tells a person to act on nothing.
 */
const answersRequest = (
  response: CollectionEventListResponse,
  { providerId, serviceAreaId, range }: CollectionEventsIdentity,
): boolean =>
  response.meta.provider.id === providerId &&
  response.meta.serviceArea.id === serviceAreaId &&
  response.meta.range.from === range.from &&
  response.meta.range.to === range.to &&
  isOfficial(response) &&
  // Every event, not merely the first: one foreign event is enough to make the set untrustworthy.
  response.data.every(
    (event) => event.serviceAreaId === serviceAreaId && isWithinRange(event.date, range),
  );

/**
 * Whether the whole response is official municipal data.
 *
 * This client exists to deliver what a municipal operator published, and every surface above it presents what it
 * returns as exactly that: an official calendar, under the operator's name, with their attribution link. Two
 * things could break that promise, and both are expressible in a schema-valid response:
 *
 * - a provider whose `sourceKind` is `demo`, whose events are sample data by construction;
 * - an event whose `source` is `demo` or `user_rule` — sample data, or something a person entered themselves.
 *
 * Any of them makes the response untrustworthy **as a whole**, so it is refused rather than filtered. Keeping the
 * official events and dropping the rest would present the remainder as the complete official schedule for the
 * range, which is a confident claim assembled from a reply already known to contain something else — and the gap
 * left behind would read as "no collection scheduled".
 *
 * An empty event array from an `official_ics` provider is untouched by this: no event fails the test, and an
 * empty result inside a covered range is a real answer meaning "no collection in this period".
 */
const isOfficial = (response: CollectionEventListResponse): boolean =>
  response.meta.provider.sourceKind === 'official_ics' &&
  response.data.every((event) => event.source === 'municipal_ics');

/**
 * Whether a calendar date falls inside the requested range, inclusive at both ends.
 *
 * Both operands are `YYYY-MM-DD`, which sorts lexicographically, so this is calendar comparison with no
 * instant and no zone involved — the same property that lets the range parameters be dates at all.
 *
 * Inclusive deliberately: `from` and `to` are the days that were asked for, so an event on either is exactly
 * what the request wanted rather than an edge case to be excluded.
 */
const isWithinRange = (date: string, range: ScheduleRange): boolean =>
  date >= range.from && date <= range.to;

interface CollectionEventsIdentity {
  readonly providerId: string;
  readonly serviceAreaId: string;
  readonly range: ScheduleRange;
}

/**
 * Whether a service-areas response really belongs to the provider it was requested for.
 *
 * The audit counterpart of the check above. This is the only other read whose contract carries an identity
 * field tying the body back to the request: every `ServiceArea` states its `providerId`. The provider
 * catalogue has no such field — it is not requested *for* anything — so there is nothing to compare there,
 * and inventing a comparison would assert something the contract does not express.
 */
const belongsToProvider = (response: ServiceAreaListResponse, providerId: string): boolean =>
  response.data.every((area) => area.providerId === providerId);

/**
 * The media type a response declares, normalized for comparison.
 *
 * RFC 9110 allows parameters after the media type and makes the type itself case-insensitive, so
 * `application/json; charset=utf-8` and `APPLICATION/JSON` are both the documented type — while everything
 * after the first `;` says nothing about which representation the body is.
 *
 * `''` for a missing header, which is never equal to a type this client accepts.
 */
const mediaTypeOf = (response: Response): string => {
  const declared = response.headers.get('content-type');

  if (declared === null) {
    return '';
  }

  const [mediaType = ''] = declared.split(';');

  return mediaType.trim().toLowerCase();
};

/**
 * Whether the response declares **exactly** the media type this operation documents.
 *
 * Equality, not containment. A substring test accepted every lookalike that happens to contain the documented
 * type: `application/jsonp` is a different format entirely, `text/application/json` is a text document that
 * merely mentions it, `application/problem+json-extra` is an undeclared type, and `application/json, text/plain`
 * is a malformed header naming two. Each one would have had its body parsed as the documented contract — and a
 * body that then happened to satisfy the schema would have been trusted as an official schedule.
 *
 * The check runs **before** the body is read as the expected representation, so nothing is parsed on the
 * strength of a header that does not say what it is.
 */
const hasContentType = (response: Response, expected: string): boolean =>
  mediaTypeOf(response) === expected;

/**
 * Reads a JSON body, reporting *why* it failed rather than collapsing every cause into one.
 *
 * A body read can be aborted just like the headers can: the deadline covers the whole operation, and a
 * caller can cancel while a response is still streaming. Swallowing that here and calling it an invalid
 * response would report a stall or a supersession as a malformed server reply, so the abort is handed back
 * for the request layer to classify.
 */
type BodyRead = { ok: true; body: unknown } | { ok: false; aborted: boolean };

const readJson = async (response: Response): Promise<BodyRead> => {
  try {
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, aborted: isAbortError(error) };
  }
};

/**
 * An abort surfaces as a `DOMException` named `AbortError` in the browser and the service worker, and as an
 * `Error` with that name elsewhere. Only the name is checked, so no runtime-specific class is required.
 */
const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

export const createApiClient = ({
  baseUrl,
  fetch: fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ApiClientOptions): ApiClient => {
  const parsed = parseApiBaseUrl(baseUrl);

  if (!parsed.ok) {
    throw new ApiClientConfigurationError(
      `The API base URL is not a usable origin: ${parsed.rejection}.`,
    );
  }

  // Validated rather than defaulted: a missing, fractional, zero, or negative deadline each describes a
  // budget that could never have been enforced, and silently substituting 8000 would hide the mistake.
  const deadlineMilliseconds = TimeoutMsSchema.safeParse(timeoutMs);

  if (!deadlineMilliseconds.success) {
    throw new ApiClientConfigurationError(
      'The request deadline must be a positive integer number of milliseconds.',
    );
  }

  const configuredTimeoutMs = deadlineMilliseconds.data;
  const origin = parsed.baseUrl.origin;
  const requestFetch = fetchImpl ?? ((input, init) => fetch(input, init));

  /**
   * An extra condition a *schema-valid* body must also satisfy to be usable.
   *
   * Applied where the real HTTP status is still in scope, so a refusal reports the status the server
   * actually sent rather than a plausible-looking constant. Returning `false` produces the same
   * `invalid_response` a malformed body does, because both mean the same thing to a caller: the server
   * answered and the answer cannot be used.
   */
  type Verify<Data> = (data: Data) => boolean;

  const request = async <Schema extends z.ZodType>(
    operation: Operation,
    path: string,
    schema: Schema,
    options: RequestOptions,
    verify?: Verify<z.infer<Schema>>,
  ): Promise<ApiResult<z.infer<Schema>>> => {
    const deadline = startDeadline(configuredTimeoutMs, options.signal);

    /**
     * Which abort ended the operation, or `undefined` when none did.
     *
     * Asked at every point the operation can be interrupted — before the headers arrive and while either
     * body is being read — because the deadline stays active for the whole operation. The deadline is
     * checked first: when both happen close together, a stall that has already elapsed is the more accurate
     * report, and a cancellation is never presented as a timeout or the reverse.
     */
    const abortFailure = (): ApiFailure | undefined => {
      if (deadline.hasExpired()) {
        return { kind: 'timeout', operation, timeoutMs: configuredTimeoutMs };
      }

      return options.signal?.aborted === true ? { kind: 'cancelled', operation } : undefined;
    };

    try {
      let response: Response;

      try {
        response = await requestFetch(`${origin}${path}`, {
          method: 'GET',
          headers: { accept: `${JSON_CONTENT_TYPE}, ${PROBLEM_CONTENT_TYPE}` },
          signal: deadline.signal,
        });
      } catch {
        // A thrown fetch is an abort or a connection failure, in that order of precedence.
        return failure(abortFailure() ?? { kind: 'network', operation });
      }

      if (!response.ok) {
        if (!hasContentType(response, PROBLEM_CONTENT_TYPE)) {
          return failure({ kind: 'invalid_response', operation, status: response.status });
        }

        const body = await readJson(response);

        if (!body.ok) {
          // An aborted problem-body read is a timeout or a cancellation, not a malformed reply.
          return failure(
            (body.aborted ? abortFailure() : undefined) ?? {
              kind: 'invalid_response',
              operation,
              status: response.status,
            },
          );
        }

        const problem = ProblemDetailsSchema.safeParse(body.body);

        // A malformed error body becomes an explicit invalid response rather than a partially trusted
        // object, because a half-read problem is not something to base a message on.
        return problem.success
          ? failure(toProblemFailure({ operation, status: response.status, problem: problem.data }))
          : failure({ kind: 'invalid_response', operation, status: response.status });
      }

      if (!hasContentType(response, JSON_CONTENT_TYPE)) {
        return failure({ kind: 'invalid_response', operation, status: response.status });
      }

      const body = await readJson(response);

      if (!body.ok) {
        // Same distinction on the success path: the deadline covers reading the body, not only the headers.
        return failure(
          (body.aborted ? abortFailure() : undefined) ?? {
            kind: 'invalid_response',
            operation,
            status: response.status,
          },
        );
      }

      const parsedBody = schema.safeParse(body.body);

      if (!parsedBody.success) {
        return failure({ kind: 'invalid_response', operation, status: response.status });
      }

      // Well formed is not the same as being an answer to this request.
      if (verify !== undefined && !verify(parsedBody.data)) {
        return failure({ kind: 'invalid_response', operation, status: response.status });
      }

      return { ok: true, data: parsedBody.data };
    } finally {
      deadline.dispose();
    }
  };

  return {
    origin,
    timeoutMs: configuredTimeoutMs,

    async listProviders(options = {}) {
      return request(
        'listProviders',
        `${API_V1_PREFIX}/providers`,
        ProviderListResponseSchema,
        options,
      );
    },

    async listServiceAreas(providerId, options = {}) {
      return request(
        'listServiceAreas',
        `${API_V1_PREFIX}/providers/${encodeURIComponent(providerId)}/service-areas`,
        ServiceAreaListResponseSchema,
        options,
        (data) => belongsToProvider(data, providerId),
      );
    },

    async listCollectionEvents({ providerId, serviceAreaId, range, ...options }) {
      const query = new URLSearchParams({ from: range.from, to: range.to });

      /**
       * The identity check runs **here**, at the transport boundary, so nothing downstream ever holds a
       * mismatched response.
       *
       * The gateway caches whatever this returns and the reminder path reads that cache, so a response
       * rejected any later than this would already have been written to storage under the requested key —
       * where a subsequent read has no way left to tell it apart from a genuine answer.
       */
      return request(
        'listCollectionEvents',
        `${API_V1_PREFIX}/providers/${encodeURIComponent(providerId)}/service-areas/${encodeURIComponent(serviceAreaId)}/collection-events?${query.toString()}`,
        CollectionEventListResponseSchema,
        options,
        (data) => answersRequest(data, { providerId, serviceAreaId, range }),
      );
    },
  };
};
