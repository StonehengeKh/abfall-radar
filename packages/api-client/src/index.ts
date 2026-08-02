/**
 * `@abfall-radar/api-client` — the typed transport boundary for the AbfallRadar HTTP API.
 *
 * Browser-safe and transport-only: `zod` is its single runtime dependency, and it owns no application
 * state, no UI behavior, no cache, and no product retry policy. It deliberately does not depend on
 * `@abfall-radar/domain` either — this package owns the wire shape, the domain owns the business model,
 * and mapping between them belongs to whichever consumer needs it.
 *
 * See [ADR 0004](../../../docs/decisions/0004-extension-api-integration.md).
 */

export { type Deadline, startDeadline } from './abort';
export {
  API_BASE_URL_REJECTIONS,
  type ApiBaseUrl,
  type ApiBaseUrlRejection,
  type ApiBaseUrlResult,
  type ApiBaseUrlScheme,
  parseApiBaseUrl,
} from './base-url';
export {
  API_V1_PREFIX,
  type ApiClient,
  type ApiClientOptions,
  type CollectionEventsQuery,
  createApiClient,
  type FetchLike,
  type RequestOptions,
} from './client';
export {
  AllDayTimingSchema,
  type CollectionEventListResponse,
  CollectionEventListResponseSchema,
  type CollectionEventMeta,
  CollectionEventMetaSchema,
  CollectionEventSchema,
  type CollectionEventTransport,
  CollectionLocationSchema,
  CurbsideCollectionEventSchema,
  MobileDropOffCollectionEventSchema,
  ScheduleCoverageSchema,
  type ScheduleRange,
  ScheduleRangeSchema,
  ScheduleServiceAreaSchema,
  type ScheduleSource,
  ScheduleSourceSchema,
  TimeWindowTimingSchema,
  type WasteTypeTransport,
  WasteTypeTransportSchema,
} from './contracts/collection-events';
export {
  type ProblemDetails,
  ProblemDetailsSchema,
  type ProblemProjectionInput,
  toProblemFailure,
  ValidationIssueSchema,
} from './contracts/problem-details';
export {
  type Provider,
  type ProviderListResponse,
  ProviderListResponseSchema,
  ProviderSchema,
  type ProviderSourceKind,
  ProviderSourceKindSchema,
} from './contracts/providers';
export { isUsableTimeZone, TimeZoneSchema } from './contracts/time-zone';
export { isWebUrl, WebUrlSchema } from './contracts/web-url';
export {
  type ServiceArea,
  type ServiceAreaCollectionEvents,
  ServiceAreaCollectionEventsAvailableSchema,
  ServiceAreaCollectionEventsSchema,
  ServiceAreaCollectionEventsUnavailableSchema,
  type ServiceAreaListResponse,
  ServiceAreaListResponseSchema,
  ServiceAreaSchema,
  type ServiceAreaValidity,
  ServiceAreaValiditySchema,
} from './contracts/service-areas';
export {
  API_FAILURE_SCHEMAS,
  ApiClientConfigurationError,
  type ApiFailure,
  type ApiFailureKind,
  ApiFailureSchema,
  type ApiResult,
  type CancelledFailure,
  CancelledFailureSchema,
  DEFAULT_TIMEOUT_MS,
  type InvalidResponseFailure,
  InvalidResponseFailureSchema,
  type NetworkFailure,
  NetworkFailureSchema,
  OPERATIONS,
  type Operation,
  OperationSchema,
  type ProblemFailure,
  ProblemFailureSchema,
  type TimeoutFailure,
  TimeoutFailureSchema,
  TimeoutMsSchema,
} from './errors';
export type { components, operations, paths } from './generated/api';
