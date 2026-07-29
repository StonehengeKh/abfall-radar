import type { CollectionEvent, District, WasteType } from '@abfall-radar/domain';

/**
 * Source metadata for official municipal ingestion.
 *
 * This module is deliberately browser-safe: it holds only types and pure functions, so `apps/api` can
 * type its responses and translate failures without pulling the Node-only retrieval boundary under
 * `./node` into a bundle. See [ADR 0003](../../../docs/decisions/0003-official-schedule-ingestion.md).
 */

/**
 * The allowlisted origin of a source, as three parsed parts rather than one string. Pinning only a
 * hostname would leave two real holes: a downgrade to HTTP hands the payload to whoever is on the
 * path, and a port change reaches a different service on the same name.
 */
export interface SourceOrigin {
  readonly scheme: 'https';
  readonly hostname: string;
  /** Effective port, stated explicitly, so a default-port URL and an explicit `:443` compare equal. */
  readonly port: number;
}

/**
 * Everything the server knows about one ingestible source, recorded from a manual verification of the
 * real source. No member is inferred from a URL pattern, a naming convention, or another area's
 * entry, and no client can supply or influence any of it.
 */
export interface CollectionSourceManifest {
  readonly providerId: string;
  readonly serviceAreaId: string;
  readonly locality: string;
  /** The official area name as the operator publishes it. */
  readonly areaName: string;
  readonly sourceName: string;
  readonly attribution: string;
  /** The public page a response attributes. Never the direct calendar download. */
  readonly landingPageUrl: string;
  /** The exact allowlisted URL. Never constructed, never guessed, never client-influenced. */
  readonly calendarUrl: string;
  readonly origin: SourceOrigin;
  readonly acceptedContentTypes: readonly string[];
  /** The zone the calendar is expected to attest. An expectation to check, never a default to apply. */
  readonly timeZone: string;
  readonly validFrom: string;
  readonly validTo: string;
  /**
   * The waste types the source actually contains, declared rather than inferred: an empty result can
   * mean "no collection in this range" or "this source does not carry this waste type", and those are
   * different statements.
   */
  readonly coverage: readonly WasteType[];
}

export interface SourceProvenance {
  readonly name: string;
  readonly landingPageUrl: string;
  readonly attribution: string;
  readonly timeZone: string;
}

export interface SourceCoverage {
  readonly wasteTypes: readonly WasteType[];
}

export type SourceFreshness = 'fresh' | 'stale';

/**
 * `invalid` means the source was reached but is unusable. `unavailable` means it could not be reached
 * at all. The distinction is what lets the HTTP layer separate a `502` from a `503`.
 */
export type SourceFailureKind = 'invalid' | 'unavailable';

/**
 * Every way ingestion can fail, mapped to its kind in one place so the HTTP status of a new failure
 * mode cannot drift away from its meaning.
 */
export const sourceFailureKinds = {
  'content-type-rejected': 'invalid',
  'body-limit-exceeded': 'invalid',
  'parse-failed': 'invalid',
  'zone-missing': 'invalid',
  'zone-duplicated': 'invalid',
  'zone-mismatch': 'invalid',
  'summary-unmapped': 'invalid',
  'timing-mode-mismatch': 'invalid',
  'event-invalid': 'invalid',
  'recurrence-unsupported': 'invalid',
  'identity-collision': 'invalid',
  'deadline-exceeded': 'unavailable',
  'network-error': 'unavailable',
  'status-rejected': 'unavailable',
  'redirect-off-origin': 'unavailable',
  'redirect-limit-exceeded': 'unavailable',
  'redirect-loop': 'unavailable',
} as const satisfies Record<string, SourceFailureKind>;

export type SourceFailureReason = keyof typeof sourceFailureKinds;

/**
 * The message is fixed diagnostic text built from the reason alone. No upstream payload, upstream URL,
 * library message, or response body is ever carried, because this error is logged and its kind
 * decides a client-visible status.
 */
export class SourceFailureError extends Error {
  readonly kind: SourceFailureKind;
  readonly reason: SourceFailureReason;

  /**
   * `cause` carries the underlying error for the server log only. A caller must never put it in a
   * response: it can hold a library message, a host, or an address. It exists because a thrown `fetch`
   * is how a real connection failure arrives, so discarding it would leave a genuine defect inside
   * retrieval with no diagnostic trace at all.
   */
  constructor(reason: SourceFailureReason, options: { readonly cause?: unknown } = {}) {
    const kind = sourceFailureKinds[reason];

    super(
      `Official source ${kind}: ${reason}.`,
      options.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = 'SourceFailureError';
    this.kind = kind;
    this.reason = reason;
  }
}

export const isSourceFailureError = (value: unknown): value is SourceFailureError =>
  value instanceof SourceFailureError;

export interface StaleWarning {
  readonly reason: SourceFailureReason;
}

export interface OfficialScheduleResult {
  readonly events: readonly CollectionEvent[];
  readonly provenance: SourceProvenance;
  readonly coverage: SourceCoverage;
  /** The timestamp of the last *successful* retrieval, preserved across failed refreshes. */
  readonly retrievedAt: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly freshness: SourceFreshness;
  /** Present only on a stale result, so the caller can log why the refresh failed. */
  readonly staleWarning?: StaleWarning;
}

/**
 * The official counterpart of `ScheduleProvider`. It is a separate contract rather than a widening of
 * that one, because an official adapter must return provenance and an explicit freshness state, and
 * the demo provider has neither.
 */
export interface OfficialScheduleProvider {
  readonly id: string;
  readonly name: string;
  getDistricts(): Promise<District[]>;
  /** The manifest for an area, or `undefined` when this provider does not serve it. */
  findManifest(serviceAreaId: string): CollectionSourceManifest | undefined;
  getCollectionSchedule(serviceAreaId: string): Promise<OfficialScheduleResult>;
}

export const toSourceProvenance = (manifest: CollectionSourceManifest): SourceProvenance => ({
  name: manifest.sourceName,
  landingPageUrl: manifest.landingPageUrl,
  attribution: manifest.attribution,
  timeZone: manifest.timeZone,
});

export const toSourceCoverage = (manifest: CollectionSourceManifest): SourceCoverage => ({
  wasteTypes: manifest.coverage,
});
