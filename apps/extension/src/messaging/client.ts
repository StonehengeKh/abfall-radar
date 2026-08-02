import type { ServiceAreaCapabilityEvidence } from '@/src/schedule/capability';
import type { AppSettings, ServiceAreaSelection } from '@/src/storage/settings';
import {
  type CacheFailure,
  type CollectionEventsPayload,
  type GatewayFailure,
  type GatewayRequest,
  InvalidatedScheduleResponseSchema,
  type ProviderSummary,
  ProvidersResponseSchema,
  type RestoredSchedulePayload,
  RestoredScheduleResponseSchema,
  ScheduleResponseSchema,
  type ServiceAreaSummary,
  ServiceAreasResponseSchema,
  type SelectionInvalidationPayload,
  SelectionInvalidationResponseSchema,
  type SelectionWritePayload,
  SelectionWriteResponseSchema,
  type SettingsFailure,
  SettingsResponseSchema,
  type SettingsWritePayload,
  SettingsWriteResponseSchema,
} from './contract';

/**
 * The messaging client UI code uses.
 *
 * It never touches `@abfall-radar/api-client`: all HTTP lives in the background worker, and an
 * import-graph test proves the popup entry cannot reach the transport package.
 *
 * A reply crosses a process boundary, so it is validated here even though the worker produced it. A
 * malformed reply becomes an explicit failure rather than a partially trusted object.
 */

export type MessagingResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly failure: GatewayFailure };

/**
 * What a settings command answers with.
 *
 * Its own result type, because its failures are its own: a settings command performs no HTTP request, so nothing
 * in `GatewayFailure` describes it truthfully. Keeping the two apart is what stops a storage rejection being
 * reported with an `operation` and a `status` it never had.
 */
export type SettingsResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly failure: SettingsFailure };

/**
 * What a cache invalidation answers with.
 *
 * Its own family for the same reason: dropping a stored entry performs no HTTP request, so nothing in
 * `GatewayFailure` describes a refused delete truthfully.
 */
export type CacheResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly failure: CacheFailure };

export type SendMessage = (message: GatewayRequest) => Promise<unknown>;

const defaultSend: SendMessage = (message) => browser.runtime.sendMessage(message);

/**
 * A reply that does not satisfy the contract, or a `sendMessage` that rejected because no worker was
 * listening, is reported as `unsupported_message`: nothing usable came back, and there is no operation or
 * request identifier to attribute it to.
 */
const MALFORMED_REPLY: GatewayFailure = { kind: 'unsupported_message' };

interface SendOptions<Data> {
  readonly request: GatewayRequest;
  readonly parse: (reply: unknown) => MessagingResult<Data> | undefined;
  readonly send: SendMessage;
}

/**
 * Sends a command whose failures are its **own** family rather than the API's.
 *
 * Generic over that family instead of duplicated per family: the settings commands and the cache invalidation
 * differ only in which failures they can report, and a second copy of this body is how the two would drift into
 * treating a malformed reply differently. `unsupported_message` is the one member every family shares, which is
 * what lets the fallback below stay common — a reply that does not satisfy the contract, or a `sendMessage` that
 * rejected because no worker was listening, means the same thing whoever asked.
 */
const sendLocal = async <Data, Failure extends { readonly kind: string }>({
  request,
  parse,
  send: sendImpl,
}: {
  readonly request: GatewayRequest;
  readonly parse: (
    reply: unknown,
  ) =>
    | { readonly ok: true; readonly data: Data }
    | { readonly ok: false; readonly failure: Failure }
    | undefined;
  readonly send: SendMessage;
}): Promise<
  { readonly ok: true; readonly data: Data } | { readonly ok: false; readonly failure: Failure }
> => {
  const unsupported = { ok: false, failure: { kind: 'unsupported_message' } as Failure } as const;

  let reply: unknown;

  try {
    reply = await sendImpl(request);
  } catch {
    // Nothing about the error crosses into a message: it could name an internal path.
    return unsupported;
  }

  return parse(reply) ?? unsupported;
};

const send = async <Data>({
  request,
  parse,
  send: sendImpl,
}: SendOptions<Data>): Promise<MessagingResult<Data>> => {
  let reply: unknown;

  try {
    reply = await sendImpl(request);
  } catch {
    // Nothing about the error crosses into a message: it could name an internal path.
    return { ok: false, failure: MALFORMED_REPLY };
  }

  return parse(reply) ?? { ok: false, failure: MALFORMED_REPLY };
};

export interface MessagingClient {
  listProviders(): Promise<MessagingResult<ProviderSummary[]>>;
  listServiceAreas(providerId: string): Promise<MessagingResult<ServiceAreaSummary[]>>;
  /**
   * The live read, which answers with the **discriminated** collection-events payload.
   *
   * Deliberately not a bare schedule: a successful refresh can return a response older than the entry
   * already stored, and the worker then answers with that stored entry instead. Typing this as a schedule
   * flattened the two together, so a restored entry could be labelled with a live response's freshness —
   * the one thing this boundary exists to prevent. The caller has to narrow on `kind`.
   */
  listCollectionEvents(input: {
    readonly providerId: string;
    readonly serviceAreaId: string;
    readonly from: string;
    readonly to: string;
  }): Promise<MessagingResult<CollectionEventsPayload>>;
  /** The local restore: no request is issued, so `null` means nothing trustworthy is cached. */
  restoreCachedSchedule(input: {
    readonly providerId: string;
    readonly serviceAreaId: string;
  }): Promise<MessagingResult<RestoredSchedulePayload | null>>;
  /**
   * Asks the worker to discard the cached schedule for one area. No request is issued.
   *
   * This is how a UI surface acts on an authoritative `unavailable`: the cache belongs to the worker, so the
   * popup asks rather than reaching into that storage item itself.
   */
  invalidateCachedSchedule(input: {
    readonly providerId: string;
    readonly serviceAreaId: string;
  }): Promise<CacheResult<null>>;
  /**
   * The settings operations, every one of which crosses into the service worker.
   *
   * The worker owns the settings item outright, so nothing here touches storage. That is what makes the
   * serialization real: the popup and the worker are separate module instances, and a queue held in a module
   * variable serializes each context against itself and neither against the other — so two contexts
   * read-modify-writing one key that way lose whichever write landed first.
   *
   * Each write sends the change a person asked for rather than a settings snapshot, so a value observed before
   * the request was sent can never be written back over somebody else's concurrent change.
   */
  readSettings(): Promise<SettingsResult<AppSettings>>;
  selectServiceArea(input: {
    readonly selection: ServiceAreaSelection;
    /** Identity-bound, so a confirmation cannot be made on another area's availability. */
    readonly evidence: ServiceAreaCapabilityEvidence;
  }): Promise<SettingsResult<SelectionWritePayload>>;
  saveSettings(input: {
    /** The selection stored when the draft was created, so a stale draft is refused rather than applied. */
    readonly expectedSelection: ServiceAreaSelection | null;
    readonly selection: ServiceAreaSelection | null;
    readonly remindersEnabled: boolean;
    readonly reminderDaysBefore: number;
    readonly reminderTime: string;
    readonly visibleWasteTypes: readonly AppSettings['visibleWasteTypes'][number][];
    readonly evidence?: ServiceAreaCapabilityEvidence | undefined;
  }): Promise<SettingsResult<SettingsWritePayload>>;
  invalidateSelectionIfMatches(
    expectedSelection: ServiceAreaSelection,
  ): Promise<SettingsResult<SelectionInvalidationPayload>>;
}

export const createMessagingClient = (sendImpl: SendMessage = defaultSend): MessagingClient => ({
  async listProviders() {
    return send({
      request: { kind: 'list_providers' },
      send: sendImpl,
      parse: (reply) => {
        const parsed = ProvidersResponseSchema.safeParse(reply);

        return parsed.success ? parsed.data : undefined;
      },
    });
  },

  async listServiceAreas(providerId) {
    return send({
      request: { kind: 'list_service_areas', providerId },
      send: sendImpl,
      parse: (reply) => {
        const parsed = ServiceAreasResponseSchema.safeParse(reply);

        return parsed.success ? parsed.data : undefined;
      },
    });
  },

  async listCollectionEvents({ providerId, serviceAreaId, from, to }) {
    return send({
      request: { kind: 'list_collection_events', providerId, serviceAreaId, from, to },
      send: sendImpl,
      parse: (reply) => {
        const parsed = ScheduleResponseSchema.safeParse(reply);

        return parsed.success ? parsed.data : undefined;
      },
    });
  },

  async restoreCachedSchedule({ providerId, serviceAreaId }) {
    return send({
      request: { kind: 'restore_cached_schedule', providerId, serviceAreaId },
      send: sendImpl,
      parse: (reply) => {
        const parsed = RestoredScheduleResponseSchema.safeParse(reply);

        return parsed.success ? parsed.data : undefined;
      },
    });
  },

  async invalidateCachedSchedule({ providerId, serviceAreaId }) {
    return sendLocal({
      request: { kind: 'invalidate_cached_schedule', providerId, serviceAreaId },
      send: sendImpl,
      parse: (reply) => {
        const parsed = InvalidatedScheduleResponseSchema.safeParse(reply);

        return parsed.success ? parsed.data : undefined;
      },
    });
  },

  async readSettings() {
    return sendLocal({
      request: { kind: 'read_settings' },
      send: sendImpl,
      parse: (reply) => {
        const parsed = SettingsResponseSchema.safeParse(reply);

        return parsed.success ? parsed.data : undefined;
      },
    });
  },

  async selectServiceArea({ selection, evidence }) {
    return sendLocal({
      request: { kind: 'select_service_area', selection, evidence },
      send: sendImpl,
      parse: (reply) => {
        const parsed = SelectionWriteResponseSchema.safeParse(reply);

        return parsed.success ? parsed.data : undefined;
      },
    });
  },

  async saveSettings({ evidence, visibleWasteTypes, ...preferences }) {
    return sendLocal({
      request: {
        kind: 'save_settings',
        ...preferences,
        visibleWasteTypes: [...visibleWasteTypes],
        ...(evidence === undefined ? {} : { evidence }),
      },
      send: sendImpl,
      parse: (reply) => {
        const parsed = SettingsWriteResponseSchema.safeParse(reply);

        return parsed.success ? parsed.data : undefined;
      },
    });
  },

  async invalidateSelectionIfMatches(expectedSelection) {
    return sendLocal({
      request: { kind: 'invalidate_selection_if_matches', expectedSelection },
      send: sendImpl,
      parse: (reply) => {
        const parsed = SelectionInvalidationResponseSchema.safeParse(reply);

        return parsed.success ? parsed.data : undefined;
      },
    });
  },
});
