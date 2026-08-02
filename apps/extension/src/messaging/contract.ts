import { CollectionLocationSchema, WasteTypeSchema } from '@abfall-radar/domain';
import { z } from 'zod';
import {
  ServiceAreaCapabilityEvidenceSchema,
  ServiceAreaCapabilitySchema,
  SourceWindowSchema,
} from '@/src/schedule/capability';
import {
  AppSettingsSchema,
  ReminderTimeSchema,
  ServiceAreaSelectionSchema,
} from '@/src/storage/settings';
import { TimeZoneSchema } from '@/src/schedule/time-zone';
import { WebUrlSchema } from '@/src/schedule/web-url';

/**
 * The typed contract between the popup and the background service worker.
 *
 * A message crosses a process boundary, so it is untrusted input even though both sides ship in the same
 * artifact — and it is validated at runtime on both sides.
 *
 * Every schema here is **strict**, unlike the API response validators that strip unknown members. Both
 * sides of this boundary are built together, so an unexpected member is a defect rather than a newer
 * contract. That is also why these payload schemas are declared here rather than imported from
 * `@abfall-radar/api-client`: the popup must never reach the transport client, and this boundary has
 * different rules from the HTTP one.
 */

export const MESSAGE_OPERATIONS = [
  'listProviders',
  'listServiceAreas',
  'listCollectionEvents',
] as const;

export type MessageOperation = (typeof MESSAGE_OPERATIONS)[number];

const OperationSchema = z.enum(MESSAGE_OPERATIONS);

const identifier = () => z.string().min(1);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const ListProvidersRequestSchema = z.strictObject({
  kind: z.literal('list_providers'),
});

export const ListServiceAreasRequestSchema = z.strictObject({
  kind: z.literal('list_service_areas'),
  providerId: identifier(),
});

export const ListCollectionEventsRequestSchema = z.strictObject({
  kind: z.literal('list_collection_events'),
  providerId: identifier(),
  serviceAreaId: identifier(),
  from: z.iso.date(),
  to: z.iso.date(),
});

/**
 * The local cache restore. Performs **no** network request.
 *
 * It deliberately accepts no `from` or `to`: the worker derives the requested window from the cached
 * entry's own capability snapshot, so a caller cannot ask for a range the cache was never evaluated
 * against. This is the approved AR-004 implementation clarification that lets an offline start paint
 * before anything is fetched — the case the cache exists for.
 */
export const RestoreCachedScheduleRequestSchema = z.strictObject({
  kind: z.literal('restore_cached_schedule'),
  providerId: identifier(),
  serviceAreaId: identifier(),
});

/**
 * Discards the cached schedule for one area. Performs **no** network request.
 *
 * Sent when a successful capability response reports the selected area `unavailable`: a provider that has
 * withdrawn a calendar must not keep answering through a cache, which is precisely the case where old data
 * reads as current official data. The popup asks for it rather than doing it, because the cache is owned by
 * the worker and no UI surface may read or write that storage item.
 *
 * Like the restore, it takes no range: there is nothing to evaluate, only an entry to drop.
 */
export const InvalidateCachedScheduleRequestSchema = z.strictObject({
  kind: z.literal('invalidate_cached_schedule'),
  providerId: identifier(),
  serviceAreaId: identifier(),
});

/**
 * The settings operations, expressed as **intents** rather than as snapshots.
 *
 * Every one of them crosses into the service worker, because the worker owns the settings item outright. That
 * is not a stylistic choice: the popup and the Manifest V3 worker are separate module instances, so a queue held
 * in a module variable serializes each context against itself and neither against the other. Two contexts
 * read-modify-writing one storage key that way lose whichever write landed first. Only one context can own the
 * queue, and the worker is the one that outlives the popup.
 *
 * Each intent carries the change a person asked for and nothing else. Sending a complete settings snapshot would
 * carry a *read* alongside the write — a value observed before the request was sent — so a concurrent change
 * would be silently overwritten by fields the sender never meant to touch. The worker rereads inside its
 * serialized operation and applies only the named change.
 */
export const ReadSettingsRequestSchema = z.strictObject({
  kind: z.literal('read_settings'),
});

/**
 * Confirms or changes the chosen area.
 *
 * The capability travels with it because an area publishing no calendar may never be persisted, and the check
 * belongs to the repository rather than to whichever surface asked.
 *
 * It travels as **evidence carrying its own identity**, and the schema requires both identifiers. A bare
 * capability next to a selection reads as evidence for that selection while asserting nothing of the kind: a
 * sender that looked the capability up by area id in the wrong list could confirm one area on another's
 * confirmation. The worker compares the two identities before it writes anything.
 */
export const SelectServiceAreaRequestSchema = z.strictObject({
  kind: z.literal('select_service_area'),
  selection: ServiceAreaSelectionSchema,
  evidence: ServiceAreaCapabilityEvidenceSchema,
});

/**
 * Saves the settings surface's draft: the selection together with the preferences, as one transactional change.
 *
 * `version` is deliberately absent — it is the worker's to decide, not something a caller may assert. The
 * evidence is optional for the same reason it is in the repository: an unchanged selection asserts nothing new
 * about the area, so preferences remain editable while the API is unreachable.
 */
export const SaveSettingsRequestSchema = z.strictObject({
  kind: z.literal('save_settings'),
  /**
   * The selection that was stored when this draft was created.
   *
   * Required, so a sender cannot opt out of the concurrency check. A Settings session can stay open while a
   * reminder clears the area or another window chooses a different one, and both of those are newer than the
   * draft — so the worker compares this against what is stored before applying anything.
   */
  expectedSelection: ServiceAreaSelectionSchema.nullable(),
  selection: ServiceAreaSelectionSchema.nullable(),
  remindersEnabled: z.boolean(),
  reminderDaysBefore: z.number().int().min(0).max(7),
  reminderTime: ReminderTimeSchema,
  visibleWasteTypes: z.array(WasteTypeSchema).min(1),
  /** Identity-bound for the same reason as above, and optional for the same reason as in the repository. */
  evidence: ServiceAreaCapabilityEvidenceSchema.optional(),
});

/**
 * Clears the selection **only if it is still the one the sender saw**.
 *
 * The expected selection is the whole point: the decision was made about a selection observed earlier, and
 * somebody may have chosen differently since. Sending it lets the worker compare inside its serialized
 * operation rather than trusting a sender's view of the world.
 */
export const InvalidateSelectionRequestSchema = z.strictObject({
  kind: z.literal('invalidate_selection_if_matches'),
  expectedSelection: ServiceAreaSelectionSchema,
});

export const GatewayRequestSchema = z.discriminatedUnion('kind', [
  ListProvidersRequestSchema,
  ListServiceAreasRequestSchema,
  ListCollectionEventsRequestSchema,
  RestoreCachedScheduleRequestSchema,
  InvalidateCachedScheduleRequestSchema,
  ReadSettingsRequestSchema,
  SelectServiceAreaRequestSchema,
  SaveSettingsRequestSchema,
  InvalidateSelectionRequestSchema,
]);

export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;

export type ListCollectionEventsRequest = z.infer<typeof ListCollectionEventsRequestSchema>;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export const ProviderSummarySchema = z.strictObject({
  id: identifier(),
  name: z.string().min(1),
  sourceKind: z.enum(['demo', 'official_ics']),
});

export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;

export const ServiceAreaSummarySchema = z.strictObject({
  id: identifier(),
  providerId: identifier(),
  locality: z.string().min(1),
  name: z.string().min(1),
  collectionEvents: ServiceAreaCapabilitySchema,
});

export type ServiceAreaSummary = z.infer<typeof ServiceAreaSummarySchema>;

const AllDayTimingSchema = z.strictObject({ kind: z.literal('all_day') });

/**
 * A drop-off window whose end may not precede its start.
 *
 * Enforced here as well as at the HTTP boundary, because a cached entry written by an **older build** passes back
 * through this schema on every read. That is the one remaining path by which an inverted window could still reach
 * the adapter, where the domain refuses it by throwing — during React rendering, or inside the alarm handler
 * where nobody would see it.
 *
 * Compared as parsed instants rather than as strings, matching the domain exactly: inclusive, so a zero-length
 * window stays representable and the two validators cannot disagree about it.
 */
const TimeWindowTimingSchema = z
  .strictObject({
    kind: z.literal('time_window'),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    /** Rendered with `Intl`, so an unusable zone would throw while formatting the window. */
    timeZone: TimeZoneSchema,
  })
  .refine(({ startsAt, endsAt }) => Date.parse(endsAt) >= Date.parse(startsAt), {
    error: 'endsAt must not precede startsAt.',
    path: ['endsAt'],
  });

const collectionEventBaseShape = {
  id: identifier(),
  serviceAreaId: identifier(),
  wasteType: WasteTypeSchema,
  date: z.iso.date(),
  title: z.string().min(1),
  source: z.enum(['demo', 'municipal_ics', 'user_rule']),
};

export const CurbsideEventSchema = z.strictObject({
  ...collectionEventBaseShape,
  collectionMode: z.literal('curbside'),
  timing: AllDayTimingSchema,
});

export const MobileDropOffEventSchema = z.strictObject({
  ...collectionEventBaseShape,
  collectionMode: z.literal('mobile_drop_off'),
  timing: TimeWindowTimingSchema,
  /**
   * Reused from the domain rather than restated, so the canonical-name rule cannot drift between what a message
   * may carry and what the domain will accept. An untrimmed or blank name is **refused** here, not trimmed: this
   * schema also validates every persisted cache entry, so accepting one would file a place under a spelling the
   * domain rejects, and every later read would map it — or fail to — depending on which layer looked first.
   */
  location: CollectionLocationSchema,
});

export const CollectionEventPayloadSchema = z.discriminatedUnion('collectionMode', [
  CurbsideEventSchema,
  MobileDropOffEventSchema,
]);

export type CollectionEventPayload = z.infer<typeof CollectionEventPayloadSchema>;

export const ScheduleProvenanceSchema = z.strictObject({
  providerName: z.string().min(1),
  sourceName: z.string().min(1),
  /**
   * Rendered as a link a person can click, so the scheme is decided here rather than where it is used.
   *
   * Validated on this boundary as well as at the HTTP one, because a cached entry written by an older build
   * passes back through this schema on every read — that is the one remaining path by which a `javascript:` or
   * `data:` link could still reach an `href`.
   */
  landingPageUrl: WebUrlSchema,
  attribution: z.string().min(1),
  /**
   * The zone the reminder day and every relative label are computed in.
   *
   * Validated here as well as at the HTTP boundary, because a cached entry written by an older build passes
   * back through this schema on every read — that is the one path by which an unusable zone could still
   * reach the reminder, where a throw would be invisible.
   */
  timeZone: TimeZoneSchema,
  locality: z.string().min(1),
  areaName: z.string().min(1),
  /** The last *successful* retrieval, preserved across a failed refresh. */
  retrievedAt: z.iso.datetime(),
  freshness: z.enum(['fresh', 'stale']),
  /** The source's own declaration, never inferred from the events returned. */
  coverage: z.array(WasteTypeSchema),
  validity: SourceWindowSchema,
});

export type ScheduleProvenance = z.infer<typeof ScheduleProvenanceSchema>;

/**
 * A schedule, with the coverage declaration and the events it accompanies required to agree.
 *
 * The same relation the transport boundary enforces, restated here because **this** schema is what validates every
 * persisted cache entry on every read. An entry written by an older build, or by a build before the transport check
 * existed, comes back through here — and that is the one remaining path by which a schedule containing a collection
 * its own provenance says the source does not publish could still reach the dashboard or, worse, a reminder.
 *
 * Reported at the offending event's own path, and one offending event withholds the whole entry: coverage is a claim
 * about the entire schedule, so a contradicting one cannot be partially trusted. A withheld entry is evicted by the
 * cache's ordinary validation pass rather than re-rejected on every read.
 */
export const SchedulePayloadSchema = z
  .strictObject({
    events: z.array(CollectionEventPayloadSchema),
    provenance: ScheduleProvenanceSchema,
    /** The range the API filtered on and served. */
    servedRange: SourceWindowSchema,
  })
  .superRefine((payload, ctx) => {
    const declared = new Set(payload.provenance.coverage);

    payload.events.forEach((event, index) => {
      if (declared.has(event.wasteType)) {
        return;
      }

      ctx.addIssue({
        code: 'custom',
        path: ['events', index, 'wasteType'],
        message: 'The event carries a waste type the source does not declare it publishes.',
      });
    });
  });

export type SchedulePayload = z.infer<typeof SchedulePayloadSchema>;

/**
 * A schedule restored from the cache.
 *
 * `coverage` and `displayRange` are explicit rather than implied by a filtered array: without them, a
 * partial intersection would be indistinguishable from coverage of the whole requested window, and an
 * uncovered tail would render as "no collection scheduled".
 */
export const RestoredSchedulePayloadSchema = z.strictObject({
  schedule: SchedulePayloadSchema,
  coverage: z.enum(['full', 'partial']),
  displayRange: SourceWindowSchema,
  /** When this client stored the entry, distinct from the server's `retrievedAt`. */
  storedAt: z.iso.datetime(),
  /** The window derived from the entry's own capability snapshot. */
  requestedRange: SourceWindowSchema,
});

export type RestoredSchedulePayload = z.infer<typeof RestoredSchedulePayloadSchema>;

/**
 * What a collection-events request answers with.
 *
 * Normally the response that was just retrieved. But a successful refresh can return a response **older**
 * than the entry already stored — the API serves a stale-if-error result whose `retrievedAt` predates the
 * cached one — and that response may neither displace the newer entry nor be presented as the current
 * answer. In that case the worker answers with the stored entry, restored through the ordinary intersection
 * so its coverage and display range describe the range that was actually requested.
 *
 * A discriminated payload rather than a bare schedule is what makes that expressible: the popup cannot label
 * a restored entry as a live response, because the two are different members.
 */
export const CollectionEventsPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('live'), schedule: SchedulePayloadSchema }),
  z.strictObject({ kind: z.literal('cached'), restored: RestoredSchedulePayloadSchema }),
]);

export type CollectionEventsPayload = z.infer<typeof CollectionEventsPayloadSchema>;

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * The failure union, matching ADR 0004's table member for member.
 *
 * `requestId` exists on `problem` alone, because a failure that never reached a server has no identifier
 * to carry and a fabricated one would match nothing in any server log.
 */
export const ProblemFailureSchema = z.strictObject({
  kind: z.literal('problem'),
  operation: OperationSchema,
  status: z.number().int(),
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
  /** The configured deadline, never a measured elapsed duration. */
  timeoutMs: z.number().int().positive(),
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
 * Carries its `kind` and nothing else.
 *
 * It is the one failure raised *before* anything about the request is known to be valid: the inbound
 * message failed envelope validation, so there is no trustworthy operation to name. `operation: 'unknown'`
 * is deliberately absent — it would manufacture a value that reads like a real operation while describing
 * nothing, and push every consumer into handling a sentinel. Echoing the refused kind is worse still:
 * that string is untrusted input, and refusing the message is the point.
 *
 * Because the union is discriminated, reaching for `operation` on this branch is a type error rather than
 * a convention.
 */
export const UnsupportedMessageFailureSchema = z.strictObject({
  kind: z.literal('unsupported_message'),
});

export const GatewayFailureSchema = z.discriminatedUnion('kind', [
  ProblemFailureSchema,
  NetworkFailureSchema,
  TimeoutFailureSchema,
  CancelledFailureSchema,
  InvalidResponseFailureSchema,
  UnsupportedMessageFailureSchema,
]);

export type GatewayFailure = z.infer<typeof GatewayFailureSchema>;

export type GatewayFailureKind = GatewayFailure['kind'];

export const UNSUPPORTED_MESSAGE: GatewayFailure = { kind: 'unsupported_message' };

/**
 * Everything a failure *says*, as one primitive value.
 *
 * It exists so an effect can depend on a failure's content rather than on the object carrying it. A
 * failure is rebuilt on every render that derives one, so depending on the object meant a render with
 * nothing new in it still re-ran the effect — which is how a schedule state update ended up superseding
 * the attempt that produced it and issuing the same two requests again.
 *
 * Every member is spelled out, including every field, so a failure that changed in a way a reader would
 * see is never mistaken for the failure already on screen. The switch is exhaustive, so a new member or a
 * new field is a compile error here rather than a dependency that silently stops noticing it.
 */
export const failureSignature = (failure: GatewayFailure): string => {
  switch (failure.kind) {
    case 'problem':
      return `problem:${failure.operation}:${failure.status}:${failure.code}:${failure.requestId}`;
    case 'network':
      return `network:${failure.operation}`;
    case 'timeout':
      return `timeout:${failure.operation}:${failure.timeoutMs}`;
    case 'cancelled':
      return `cancelled:${failure.operation}`;
    case 'invalid_response':
      return `invalid_response:${failure.operation}:${failure.status}`;
    case 'unsupported_message':
      return 'unsupported_message';
  }
};

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

const failureEnvelope = () =>
  z.strictObject({ ok: z.literal(false), failure: GatewayFailureSchema });

const successEnvelope = <Schema extends z.ZodType>(data: Schema) =>
  z.strictObject({ ok: z.literal(true), data });

export const ProvidersResponseSchema = z.union([
  successEnvelope(z.array(ProviderSummarySchema)),
  failureEnvelope(),
]);

export const ServiceAreasResponseSchema = z.union([
  successEnvelope(z.array(ServiceAreaSummarySchema)),
  failureEnvelope(),
]);

export const ScheduleResponseSchema = z.union([
  successEnvelope(CollectionEventsPayloadSchema),
  failureEnvelope(),
]);

/**
 * `null` means no usable entry: none stored, or one that failed validation, expired, belonged to another
 * origin, or does not overlap the window being requested. It is not a failure — there is simply nothing
 * cached to show.
 */
export const RestoredScheduleResponseSchema = z.union([
  successEnvelope(RestoredSchedulePayloadSchema.nullable()),
  failureEnvelope(),
]);

/**
 * Why a cache invalidation could not be completed.
 *
 * Its **own** family, for the same reason the settings commands have theirs: dropping a stored entry performs no
 * HTTP request, so it has no operation, no status and no request identifier, and reporting an `invalid_response`
 * attributed to `listCollectionEvents` would send anyone reading a log looking for a request that was never made.
 *
 * Kind-only. The underlying rejection is the storage API's and could name an internal path.
 */
export const CacheFailureSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cache_storage') }),
  UnsupportedMessageFailureSchema,
]);

export type CacheFailure = z.infer<typeof CacheFailureSchema>;

export const CACHE_STORAGE_UNAVAILABLE: CacheFailure = { kind: 'cache_storage' };

/**
 * Carries no data on success: the entry is gone, and there is nothing about it left to report.
 *
 * A missing entry answers the same way as one that was dropped, because "nothing is cached for this area" is the
 * outcome either way. What is **not** the same is storage refusing the delete: the entry is then still there, and
 * a caller that treated that as success would go on to clear the persisted selection — leaving a stored schedule
 * for an area with nothing left to re-validate it against, and no selection to rediscover the problem. So the
 * refusal is reported, and the popup turns it into its own recoverable state.
 */
export const InvalidatedScheduleResponseSchema = z.union([
  successEnvelope(z.null()),
  z.strictObject({ ok: z.literal(false), failure: CacheFailureSchema }),
]);

/**
 * Why a settings command could not be carried out.
 *
 * Its own family, deliberately **not** part of `GatewayFailure`. A settings command performs no HTTP request at
 * all, so every member of that union is wrong for it: `operation` names an API operation, `status` names an HTTP
 * status, and `requestId` names an entry in a server log. Reporting a refused storage write as
 * `invalid_response` with `operation: 'listProviders'` invented all three — it claimed a request had been made,
 * attributed it to a read that never happened, and would have sent anyone reading a log line looking for a
 * provider-catalogue failure that does not exist.
 *
 * `settings_storage` therefore carries its kind and nothing else. There is nothing else that is both true and
 * safe: the underlying rejection could name an internal storage path or carry a stack, and no field of it tells
 * a person or an operator anything they can act on beyond "the stored settings could not be reached".
 *
 * `unsupported_message` is included because the envelope validation happens before dispatch, so a malformed
 * settings message is refused with that failure — and it, too, is kind-only.
 */
export const SettingsFailureSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('settings_storage') }),
  /**
   * The stored value was written by a **newer** build of this extension.
   *
   * Kind-only for the same reason as the others, and for one more: the newer build's object is not this build's to
   * describe. Nothing about its contents may cross into a message, because this build has no names for whatever it
   * holds and reporting a guess would be worse than reporting nothing.
   *
   * Its own member rather than reusing `settings_storage`, because the two need completely different words: one
   * says storage could not be reached and is worth retrying, the other says the data is intact and this build must
   * not touch it.
   */
  z.strictObject({ kind: z.literal('unsupported_version') }),
  UnsupportedMessageFailureSchema,
]);

export type SettingsFailure = z.infer<typeof SettingsFailureSchema>;

export const SETTINGS_STORAGE_UNAVAILABLE: SettingsFailure = { kind: 'settings_storage' };

export const SETTINGS_UNSUPPORTED_VERSION: SettingsFailure = { kind: 'unsupported_version' };

/** The envelope every settings command answers with: its own data, or its own failure family. */
const settingsFailureEnvelope = () =>
  z.strictObject({ ok: z.literal(false), failure: SettingsFailureSchema });

/** The settings the worker holds, after migration. Every popup read goes through this. */
export const SettingsResponseSchema = z.union([
  successEnvelope(AppSettingsSchema),
  settingsFailureEnvelope(),
]);

/**
 * What a settings write decided, alongside the settings that are now stored.
 *
 * The outcome vocabulary is the repository's own, so a surface reads the same three answers whichever write
 * intent it sent — and **only** those three. A save cannot report a compare-and-clear's outcome, which is why
 * that operation has its own envelope below rather than widening this one.
 */
export const SettingsWriteResponseSchema = z.union([
  successEnvelope(
    z.strictObject({
      outcome: z.enum([
        'persisted',
        'conflict',
        'rejected_unavailable',
        'rejected_unknown_capability',
      ]),
      /**
       * What is stored now.
       *
       * On `persisted` it is what was just written; on every refusal — `conflict` included — it is the value that
       * survived, so the surface adopts the authoritative state instead of re-reading and racing again.
       */
      settings: AppSettingsSchema,
    }),
  ),
  settingsFailureEnvelope(),
]);

/**
 * What a compare-and-clear decided.
 *
 * `superseded` is not a failure: somebody chose differently, so there was nothing of the sender's left to clear
 * and the newer choice is returned untouched. Separate from the write envelope because no other operation can
 * produce it, and a surface reading one should not have to handle the other's outcomes.
 */
export const SelectionInvalidationResponseSchema = z.union([
  successEnvelope(
    z.strictObject({
      outcome: z.enum(['invalidated', 'superseded']),
      settings: AppSettingsSchema,
    }),
  ),
  settingsFailureEnvelope(),
]);

/**
 * What confirming or changing a selection decided.
 *
 * Narrower than the draft-save envelope on purpose: a selection intent carries no draft, so it cannot be stale and
 * `conflict` would be a member no path can produce. Keeping them apart means a surface reading this one does not
 * have to handle an outcome it can never receive.
 */
export const SelectionWriteResponseSchema = z.union([
  successEnvelope(
    z.strictObject({
      outcome: z.enum(['persisted', 'rejected_unavailable', 'rejected_unknown_capability']),
      settings: AppSettingsSchema,
    }),
  ),
  settingsFailureEnvelope(),
]);

export type SelectionWriteResponse = z.infer<typeof SelectionWriteResponseSchema>;

export type SelectionWritePayload = Extract<SelectionWriteResponse, { ok: true }>['data'];

export type SelectionWriteOutcomeKind = SelectionWritePayload['outcome'];

export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

export type SettingsWriteResponse = z.infer<typeof SettingsWriteResponseSchema>;

export type SettingsWritePayload = Extract<SettingsWriteResponse, { ok: true }>['data'];

export type SettingsWriteOutcomeKind = SettingsWritePayload['outcome'];

export type SelectionInvalidationResponse = z.infer<typeof SelectionInvalidationResponseSchema>;

export type SelectionInvalidationPayload = Extract<
  SelectionInvalidationResponse,
  { ok: true }
>['data'];

export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;

export type ServiceAreasResponse = z.infer<typeof ServiceAreasResponseSchema>;

export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;

export type RestoredScheduleResponse = z.infer<typeof RestoredScheduleResponseSchema>;

export type InvalidatedScheduleResponse = z.infer<typeof InvalidatedScheduleResponseSchema>;

/**
 * What the worker tells an open popup after it has changed the stored settings.
 *
 * **Kind-only, and deliberately empty of everything else.** It carries no settings, no rejected input, and nothing
 * derived from an upstream response: a notification is pushed rather than asked for, so a popup cannot have
 * validated what produced it. What it means is only "what you hold is out of date" — the popup then re-reads
 * through the same request/response boundary it always uses, where the value is validated as usual.
 *
 * It exists because the worker owns the settings outright and can change them with no popup involved: an alarm
 * discovering an area was withdrawn compare-and-clears the selection, and an open popup went on presenting the
 * dashboard for an area nothing could serve until someone closed and reopened it.
 *
 * Strict, so a message that merely looks like this one is refused rather than acted on.
 */
export const SettingsChangedNotificationSchema = z.strictObject({
  kind: z.literal('settings_changed'),
});

export type SettingsChangedNotification = z.infer<typeof SettingsChangedNotificationSchema>;

export const SETTINGS_CHANGED_NOTIFICATION: SettingsChangedNotification = {
  kind: 'settings_changed',
};

/** Every envelope a handler may answer with, for the handler's own return type. */
export const GatewayResponseSchema = z.union([
  ProvidersResponseSchema,
  ServiceAreasResponseSchema,
  ScheduleResponseSchema,
  RestoredScheduleResponseSchema,
  InvalidatedScheduleResponseSchema,
  SettingsResponseSchema,
  SettingsWriteResponseSchema,
  SelectionWriteResponseSchema,
  SelectionInvalidationResponseSchema,
]);

export type GatewayResponse = z.infer<typeof GatewayResponseSchema>;

/** Maps a request kind onto the operation it performs, for logging and failure reporting. */
export const OPERATION_BY_REQUEST_KIND = {
  list_providers: 'listProviders',
  list_service_areas: 'listServiceAreas',
  list_collection_events: 'listCollectionEvents',
} as const satisfies Record<string, MessageOperation>;

/**
 * The settings request kinds, so a caller can tell a settings intent from an API read.
 *
 * They perform no HTTP request at all, which is why they are named here rather than mapped onto a
 * `MessageOperation`: attributing a storage write to `listProviders` would put a fabricated operation in a log
 * line and in a failure a person might be shown.
 */
export const SETTINGS_REQUEST_KINDS = [
  'read_settings',
  'select_service_area',
  'save_settings',
  'invalidate_selection_if_matches',
] as const;

export type SettingsRequestKind = (typeof SETTINGS_REQUEST_KINDS)[number];

export const isSettingsRequest = (
  request: GatewayRequest,
): request is Extract<GatewayRequest, { kind: SettingsRequestKind }> =>
  (SETTINGS_REQUEST_KINDS as readonly string[]).includes(request.kind);
