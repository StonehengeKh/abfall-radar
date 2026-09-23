import { compareTimestamps, deriveSourceToday } from '@abfall-radar/schedule-format';
import type {
  CollectionEventListResponse,
  CollectionEventTransport,
  InvalidResponseFailure,
  Operation,
  Provider,
  ServiceArea,
} from '@/src/adapters/schedule-gateway';

/**
 * Web-owned invariants that the transport client deliberately does not check, because they compare
 * entries against each other or against the request that produced the response.
 *
 * Each failure is a local `invalid_response` with the real operation and `status: 0` — the established
 * sentinel for a failure no HTTP status describes. `ApiResult`'s success branch retains no status, so any
 * other number would be fabricated. No `requestId` is invented and no rejected record is exposed.
 */

export const localInvalidResponse = (operation: Operation): InvalidResponseFailure => ({
  kind: 'invalid_response',
  operation,
  status: 0,
});

const hasDuplicateIds = (entries: readonly { readonly id: string }[]): boolean =>
  new Set(entries.map((entry) => entry.id)).size !== entries.length;

/** Checked across the complete validated response, **before** demo filtering. */
export const checkProviderUniqueness = (
  providers: readonly Provider[],
): InvalidResponseFailure | undefined =>
  hasDuplicateIds(providers) ? localInvalidResponse('listProviders') : undefined;

export const checkServiceAreaUniqueness = (
  areas: readonly ServiceArea[],
): InvalidResponseFailure | undefined =>
  hasDuplicateIds(areas) ? localInvalidResponse('listServiceAreas') : undefined;

/** The capability the request was built from; the response must answer in exactly its terms. */
export interface RequestingCapability {
  readonly timeZone: string;
  readonly validity: { readonly from: string; readonly to: string };
}

export type EventResponseCheck =
  | { readonly kind: 'accepted' }
  /** Accepted-shape metadata that disagrees with the requesting capability. Reconciliation may answer it. */
  | { readonly kind: 'metadata_mismatch' }
  | { readonly kind: 'invalid'; readonly failure: InvalidResponseFailure };

const localDateOf = (instant: string, timeZone: string): string | undefined => {
  const derived = deriveSourceToday(timeZone, new Date(instant));

  return derived.ok ? derived.date : undefined;
};

const checkDropOff = (event: CollectionEventTransport, sourceTimeZone: string): boolean => {
  if (event.collectionMode !== 'mobile_drop_off') {
    return true;
  }

  const order = compareTimestamps(event.timing.startsAt, event.timing.endsAt);

  // `endsAt` equal to `startsAt` is allowed; only a window that closes before it opens is rejected.
  if (!order.ok || order.order === 1) {
    return false;
  }

  if (event.timing.timeZone !== sourceTimeZone) {
    return false;
  }

  // `event.date` is the source-local date the window starts on — never the UTC date substring.
  return localDateOf(event.timing.startsAt, sourceTimeZone) === event.date;
};

/**
 * Runs, in order, the checks that must pass before anything from an events response is mapped,
 * ordered, rendered, or published: capability/schedule metadata consistency, then response-wide
 * identifier uniqueness, then each drop-off's window order, zone, and source-local date.
 *
 * Metadata is compared first because a mismatch is the one outcome reconciliation may still answer.
 */
export const checkEventResponse = (
  response: CollectionEventListResponse,
  capability: RequestingCapability,
): EventResponseCheck => {
  const { meta } = response;

  if (
    meta.source.timeZone !== capability.timeZone ||
    meta.validFrom !== capability.validity.from ||
    meta.validTo !== capability.validity.to
  ) {
    return { kind: 'metadata_mismatch' };
  }

  if (hasDuplicateIds(response.data)) {
    return { kind: 'invalid', failure: localInvalidResponse('listCollectionEvents') };
  }

  if (!response.data.every((event) => checkDropOff(event, capability.timeZone))) {
    return { kind: 'invalid', failure: localInvalidResponse('listCollectionEvents') };
  }

  return { kind: 'accepted' };
};
