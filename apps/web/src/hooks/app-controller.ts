import type { CollectionEvent } from '@abfall-radar/domain';
import { deriveSourceToday, type IsoDate, orderEvents } from '@abfall-radar/schedule-format';
import { toDomainCollectionEvent } from '@/src/adapters/collection-event';
import {
  type ConfirmedSelectionStore,
  noConfirmedSelectionStore,
  type StoredConfirmedSelection,
} from '@/src/adapters/confirmed-selection-store';
import type {
  ApiResult,
  City,
  CollectionEventListResponse,
  Provider,
  ScheduleGateway,
  ServiceArea,
} from '@/src/adapters/schedule-gateway';
import type { Clock, DocumentLifecycle, LifecycleSignal, TimerApi } from '@/src/schedule/lifecycle';
import {
  RangeRecoveryCoordinator,
  type RecoveryOutcome,
} from '@/src/schedule/range-recovery-coordinator';
import {
  checkEventResponse,
  checkProviderUniqueness,
  checkServiceAreaUniqueness,
  localInvalidResponse,
  type RequestingCapability,
} from '@/src/schedule/response-invariants';
import { deriveTargetRange } from '@/src/schedule/schedule-range';
import { SourceDateWatchdog } from '@/src/schedule/source-date-watchdog';
import {
  type AppViewState,
  type AreasState,
  announcementIdentity,
  type CatalogueState,
  type ControllerState,
  deriveViewState,
  type ErrorContext,
  type ExactRangeProblem,
  isExactRangeProblem,
  isProviderNotFoundProblem,
  type RecoveryFailure,
  type ScheduleFailure,
  type ScheduleState,
  type Selection,
} from '@/src/schedule/view-state';

/**
 * The application's request owners and lifecycle, outside React.
 *
 * Every phase — provider catalogue, service areas, the confirmed-selection schedule pipeline with its
 * one shared reconciliation budget, and range recovery — assigns its `FailureContext` when the attempt
 * starts, holds an attempt token and an `AbortController`, and re-checks ownership after every `await`.
 * Phase is never reconstructed afterwards from an operation name or from a retained selection.
 *
 * The gateway, clock, timers, and document lifecycle are injected, so every race in the test matrix is
 * reachable without a network, a real clock, or a debug control in the product.
 */

export type FocusTarget =
  | 'city-step'
  | 'city-choice'
  | 'provider-step'
  | 'area-step'
  | 'provider-choice'
  | 'schedule-heading'
  | 'state-heading';

/**
 * Where focus goes next.
 *
 * `provider-choice` carries the provider it means. Naming the target alone left the shell to pick the
 * first rendered choice, so returning from the area step of the second provider moved focus to the
 * first one instead of to the control the step was opened from.
 */
export type FocusRequest =
  | { readonly target: Exclude<FocusTarget, 'provider-choice' | 'city-choice'> }
  | { readonly target: 'provider-choice'; readonly providerId: string }
  | { readonly target: 'city-choice'; readonly cityId: string };

export interface Snapshot {
  readonly state: ControllerState;
  readonly view: AppViewState;
  /**
   * What the polite live region announces, as the derived identity of the current view plus a counter.
   *
   * The words live in the app layer; only their identity is tracked here. The counter advances whenever
   * that identity changes, so the same message after an intervening state is announced again.
   */
  readonly announcement: { readonly identity: string; readonly seq: number };
  readonly focus: (FocusRequest & { readonly seq: number }) | null;
}

export interface ControllerEnvironment {
  /** `null` when the browser-origin resolver rejected the context: no client is ever constructed. */
  readonly gateway: ScheduleGateway | null;
  readonly clock: Clock;
  readonly timers: TimerApi;
  readonly lifecycle: DocumentLifecycle;
  /**
   * Where the confirmed selection is remembered between visits. Omitted, nothing is remembered and
   * every run starts at the city step, which is what the tests that predate persistence expect.
   */
  readonly selectionStore?: ConfirmedSelectionStore;
}

/** Qualifying entry evidence: the fresh authoritative reads a producing flow completed. */
interface EntryEvidence {
  readonly providersRead: true;
  readonly providerValidated: true;
  readonly areasRead: true;
  readonly areaValidated: true;
  readonly capability: RequestingCapability;
}

const isAvailable = (
  area: ServiceArea,
): area is ServiceArea & {
  collectionEvents: {
    availability: 'available';
    timeZone: string;
    validity: { from: string; to: string };
  };
} => area.collectionEvents.availability === 'available';

const officialProviders = (providers: readonly Provider[]): Provider[] =>
  providers.filter((provider) => provider.sourceKind !== 'demo');

export class AppController {
  #state: ControllerState;
  #announcement: Snapshot['announcement'] | undefined;
  #focus: Snapshot['focus'] = null;
  #sequence = 0;
  #listeners = new Set<() => void>();
  #snapshot: Snapshot;

  #selectionToken = 0;
  #scheduleToken = 0;
  #selectionController: AbortController | undefined;
  #scheduleController: AbortController | undefined;
  #watchdog: SourceDateWatchdog | undefined;
  #coordinator: RangeRecoveryCoordinator | undefined;
  #unsubscribeLifecycle: (() => void) | undefined;
  /** False between `stop()` and the next `start()`; a stopped run publishes nothing. */
  #running = false;
  /**
   * The city catalogue the most recent current attempt loaded.
   *
   * Kept outside the selecting state because schedule mode has no city slice, and an authoritative
   * invalidation that fires from the schedule pipeline or range recovery must return the user to a
   * usable choice inside the city they were in — not to a city spinner no request will ever end.
   */
  #knownCities: readonly City[] | undefined;
  /**
   * The identity of the running reopen-selection operation.
   *
   * Nested reads each own a selection attempt of their own, so the selection token cannot name the
   * operation as a whole. Every user selection action advances this, and the reopen checks it after
   * each `await`, so a superseded reopen can neither restore the old confirmed pair over a newer draft
   * nor issue another request.
   */
  #reopenOwner = 0;
  readonly #selectionStore: ConfirmedSelectionStore;
  /**
   * The schedule attempt that must not move focus: the one a remembered selection restored on load.
   *
   * Held as the attempt's own token, so the suppression cannot outlive it — a later reconciliation, a
   * retry, or a user's own confirmation each start a new attempt and direct focus as they always have.
   */
  #silentScheduleToken: number | undefined;
  /**
   * The remembered selection a restore is still trying to reach.
   *
   * A restore that fails on a read has not been contradicted — the catalogue was never seen — so the
   * intent survives the error surface and `retry()` resumes it rather than dropping the person at the
   * city step with their district still remembered. Every user selection action clears it through
   * `#supersedeReopen`, so an intent can never outlive a choice the person made themselves.
   */
  #pendingRestore: StoredConfirmedSelection | undefined;

  constructor(private readonly environment: ControllerEnvironment) {
    this.#selectionStore = environment.selectionStore ?? noConfirmedSelectionStore();
    this.#state =
      environment.gateway === null
        ? { mode: 'configuration_error' }
        : {
            mode: 'selecting',
            cities: { status: 'loading' },
            catalogue: { status: 'loading' },
            areas: { status: 'idle' },
            draft: { cityId: null, providerId: null, serviceAreaId: null },
            confirmed: null,
            notice: null,
          };
    this.#snapshot = this.#buildSnapshot();
  }

  // -------------------------------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): Snapshot => this.#snapshot;

  #buildSnapshot(): Snapshot {
    const view = deriveViewState(this.#state);
    const identity = announcementIdentity(view);

    if (this.#announcement === undefined || this.#announcement.identity !== identity) {
      this.#sequence += 1;
      this.#announcement = { identity, seq: this.#sequence };
    }

    return { state: this.#state, view, announcement: this.#announcement, focus: this.#focus };
  }

  #publish(state: ControllerState, options: { readonly focus?: FocusRequest } = {}): void {
    this.#state = state;

    if (options.focus !== undefined) {
      this.#sequence += 1;
      this.#focus = { ...options.focus, seq: this.#sequence };
    }

    this.#snapshot = this.#buildSnapshot();

    for (const listener of this.#listeners) {
      listener();
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------------

  /**
   * Begins a run: subscribes to the document lifecycle and bootstraps the catalogue.
   *
   * Idempotent, and restartable after `stop()`. React's Strict Mode double-invokes an effect as
   * setup → cleanup → setup, so a controller that could only be started once left the second setup
   * with a dead instance whose catalogue request was fetched and then discarded.
   */
  start(): void {
    if (this.environment.gateway === null || this.#running) {
      return;
    }

    this.#running = true;
    this.#unsubscribeLifecycle = this.environment.lifecycle.subscribe((signal) => {
      this.#onLifecycleSignal(signal);
    });

    /*
     * A remembered selection is revalidated rather than trusted: the same reads a person would have
     * made, in the same order, ending at the schedule only when the catalogue still offers all three
     * identifiers. Without one, this is the ordinary bootstrap and the city step is the entry state.
     */
    const remembered = this.#selectionStore.read();

    void (remembered === null ? this.#loadCities() : this.#restoreSelection(remembered));
  }

  /**
   * Ends the current run: aborts in-flight work, stops both lifecycle owners, and removes every
   * listener.
   *
   * The attempt tokens are advanced here, so a request from the stopped run can never publish even
   * though a later `start()` revives the controller — restarting is not the same as reviving stale
   * results.
   */
  stop(): void {
    this.#running = false;
    this.#supersedeReopen();
    this.#selectionToken += 1;
    this.#scheduleToken += 1;
    this.#selectionController?.abort();
    this.#selectionController = undefined;
    this.#scheduleController?.abort();
    this.#scheduleController = undefined;
    this.#stopWatchdog();
    this.#stopCoordinator();
    this.#unsubscribeLifecycle?.();
    this.#unsubscribeLifecycle = undefined;
  }

  /** Retained name for a permanent teardown; identical to `stop()` for this controller. */
  dispose(): void {
    this.stop();
  }

  #onLifecycleSignal(signal: LifecycleSignal): void {
    // At most one mechanism owns scheduled work for a confirmed selection; they never run together.
    this.#watchdog?.signal(signal);
    this.#coordinator?.signal(signal);
  }

  #stopWatchdog(): void {
    this.#watchdog?.dispose();
    this.#watchdog = undefined;
  }

  #stopCoordinator(): void {
    this.#coordinator?.dispose();
    this.#coordinator = undefined;
  }

  /** Test seam: the pending lifecycle owners, so a test can assert at-most-one ownership. */
  get lifecycleOwners(): { readonly watchdog: boolean; readonly coordinator: boolean } {
    return { watchdog: this.#watchdog !== undefined, coordinator: this.#coordinator !== undefined };
  }

  get watchdogHasPendingTimer(): boolean {
    return this.#watchdog?.hasPendingTimer ?? false;
  }

  // -------------------------------------------------------------------------------------------------
  // Selection flow
  // -------------------------------------------------------------------------------------------------

  #selecting(): Extract<ControllerState, { mode: 'selecting' }> {
    return this.#state.mode === 'selecting'
      ? this.#state
      : {
          mode: 'selecting',
          cities: { status: 'loading' },
          catalogue: { status: 'loading' },
          areas: { status: 'idle' },
          draft: { cityId: null, providerId: null, serviceAreaId: null },
          confirmed: null,
          notice: null,
        };
  }

  #newSelectionAttempt(): { readonly token: number; readonly signal: AbortSignal } {
    this.#selectionController?.abort();
    this.#selectionToken += 1;
    const controller = new AbortController();
    this.#selectionController = controller;

    return { token: this.#selectionToken, signal: controller.signal };
  }

  /** Supersedes any running reopen-selection operation, and any restore intent; see `#reopenOwner`. */
  #supersedeReopen(): void {
    this.#reopenOwner += 1;
    this.#pendingRestore = undefined;
  }

  #selectionIsCurrent(token: number): boolean {
    return this.#running && this.#selectionToken === token && this.#state.mode === 'selecting';
  }

  /**
   * Reads the city catalogue: the first choice a person makes.
   *
   * Reported in `selection_providers`, because a city read and a provider read answer the same
   * question — which official service can be chosen — so Retry must re-read exactly that. The failure
   * keeps `listCities` as its truthful transport operation.
   *
   * `userInitiated` is a Retry, or an invalidation that has to rebuild the city context. The surface the
   * user was on unmounts the moment loading starts, so focus is given an explicit destination at every
   * step: the city heading while loading and once loaded, the state heading if it fails again. The first
   * bootstrap passes nothing and still never moves focus. Only a current attempt publishes, so a stale
   * retry cannot move focus after a newer action.
   */
  async #loadCities(
    options: { readonly focus?: FocusRequest; readonly userInitiated?: boolean } = {},
  ): Promise<void> {
    const gateway = this.environment.gateway;

    if (gateway === null) {
      return;
    }

    const { token, signal } = this.#newSelectionAttempt();
    const base = this.#selecting();

    this.#publish(
      {
        ...base,
        cities: { status: 'loading' },
        catalogue: { status: 'loading' },
        areas: { status: 'idle' },
        draft: { cityId: null, providerId: null, serviceAreaId: null },
        notice: null,
      },
      options.userInitiated === true
        ? { focus: { target: 'city-step' } }
        : options.focus === undefined
          ? {}
          : { focus: options.focus },
    );

    const result = await gateway.listCities(signal);

    if (!this.#selectionIsCurrent(token)) {
      return;
    }

    const current = this.#selecting();

    if (!result.ok) {
      if (result.failure.kind === 'cancelled') {
        return;
      }

      this.#publish(
        {
          ...current,
          cities: {
            status: 'failed',
            context: { phase: 'selection_providers', failure: result.failure },
          },
        },
        options.userInitiated === true
          ? { focus: { target: 'state-heading' } }
          : this.#replacementFocus(),
      );
      return;
    }

    const cities = result.data.data;

    if (cities.length === 0) {
      this.#publish(
        { ...current, cities: { status: 'empty' } },
        options.userInitiated === true
          ? { focus: { target: 'state-heading' } }
          : this.#replacementFocus(),
      );
      return;
    }

    this.#knownCities = cities;
    this.#publish(
      {
        ...current,
        cities: { status: 'loaded', cities },
        // A city is never chosen for the user, even when only one is offered: the choice is the step.
        draft: { cityId: null, providerId: null, serviceAreaId: null },
      },
      options.userInitiated === true ? { focus: { target: 'city-step' } } : {},
    );
  }

  /**
   * Chooses a city and opens what follows it.
   *
   * The providers behind a city arrive with the city itself, so this issues no request of its own; the
   * provider catalogue is then re-read for that city, which is what keeps a provider that disappeared
   * between the two reads out of the flow.
   */
  selectCity(cityId: string): void {
    const state = this.#state;

    if (state.mode !== 'selecting' || state.cities.status !== 'loaded') {
      return;
    }

    if (!state.cities.cities.some((city) => city.id === cityId)) {
      return;
    }

    this.#supersedeReopen();

    // Changing the city drops the previous district and any schedule request still in flight.
    this.#publish({
      ...state,
      catalogue: { status: 'loading' },
      areas: { status: 'idle' },
      draft: { cityId, providerId: null, serviceAreaId: null },
      notice: null,
    });
    void this.#loadProviders();
  }

  async #loadProviders(
    options: {
      readonly notice?: 'provider_invalidated';
      readonly focus?: FocusRequest;
      /**
       * The confirmed pair a reopen wants back, and the reopen that wants it. The provider is restored
       * only while that reopen still owns the operation and the fresh catalogue still offers it, and its
       * district is then restored through the one area read below — never a second.
       */
      readonly preferred?: { readonly selection: Selection; readonly owner: number };
      /**
       * A restore on a fresh run: the steps it passes through are not surfaces the person navigated to,
       * so none of them takes focus. A step it *stops* at still does — that one has to be used.
       */
      readonly silent?: boolean;
    } = {},
  ): Promise<void> {
    const gateway = this.environment.gateway;

    if (gateway === null) {
      return;
    }

    const { token, signal } = this.#newSelectionAttempt();
    const base = this.#selecting();

    this.#publish(
      {
        ...base,
        catalogue: { status: 'loading' },
        areas: { status: 'idle' },
        draft:
          options.notice === 'provider_invalidated'
            ? { cityId: base.draft.cityId, providerId: null, serviceAreaId: null }
            : base.draft,
        notice: options.notice ?? base.notice,
      },
      options.focus === undefined ? {} : { focus: options.focus },
    );

    const result = await gateway.listProviders(signal);

    if (!this.#selectionIsCurrent(token)) {
      return;
    }

    const current = this.#selecting();

    if (!result.ok) {
      if (result.failure.kind === 'cancelled') {
        return;
      }

      this.#publish(
        {
          ...current,
          catalogue: {
            status: 'failed',
            context: { phase: 'selection_providers', failure: result.failure },
          },
        },
        this.#replacementFocus(),
      );
      return;
    }

    // Response-wide uniqueness runs before demo filtering, so a duplicate cannot hide behind an entry
    // the surface never shows.
    const duplicate = checkProviderUniqueness(result.data.data);

    if (duplicate !== undefined) {
      this.#publish(
        {
          ...current,
          catalogue: {
            status: 'failed',
            context: { phase: 'selection_providers', failure: duplicate },
          },
        },
        this.#replacementFocus(),
      );
      return;
    }

    // Only what the selected city actually offers. A provider the city does not list is not part of
    // this flow, whatever the catalogue route returns.
    const city =
      current.cities.status === 'loaded' && current.draft.cityId !== null
        ? current.cities.cities.find((candidate) => candidate.id === current.draft.cityId)
        : undefined;
    const offeredByCity = new Set(city?.providers.map((provider) => provider.id) ?? []);
    const offered = officialProviders(result.data.data).filter((provider) =>
      city === undefined ? true : offeredByCity.has(provider.id),
    );

    /*
     * A city served by exactly one provider needs no provider screen, but the provider's identity is
     * still what every request, the provenance, and the schedule are made of — so it is selected here
     * rather than left implicit. With more than one, nothing is preselected.
     *
     * Never after an invalidation: the areas read that reported `PROVIDER_NOT_FOUND` is what refreshed
     * this catalogue, so selecting the same provider again would ask for its areas again, and answer
     * the same way, without end. Recovery therefore always waits for an explicit choice.
     */
    const lone =
      options.notice === 'provider_invalidated' || offered.length !== 1 ? undefined : offered[0];
    // Recovery never resumes a provider: an invalidation always ends at an explicit choice.
    const preferred =
      options.notice === undefined &&
      options.preferred !== undefined &&
      options.preferred.owner === this.#reopenOwner
        ? offered.find((provider) => provider.id === options.preferred?.selection.providerId)
        : undefined;
    const chosen = preferred ?? lone;

    this.#publish(
      {
        ...current,
        catalogue:
          offered.length === 0 ? { status: 'empty' } : { status: 'loaded', providers: offered },
        draft: {
          cityId: current.draft.cityId,
          providerId: chosen?.id ?? null,
          serviceAreaId: null,
        },
        areas: { status: 'idle' },
      },
      // An empty catalogue replaces the provider step with a state surface of its own; a loaded one
      // keeps the same step heading mounted and must not steal focus from the user's position.
      offered.length === 0 ? this.#replacementFocus() : {},
    );

    if (chosen !== undefined) {
      await this.#loadAreas(
        chosen.id,
        preferred === undefined ? undefined : options.preferred?.selection.serviceAreaId,
        { silent: options.silent === true },
      );
    }
  }

  /**
   * The focus request for a surface that replaces one the controller had directed focus to.
   *
   * The provider step's heading is unmounted by every terminal `#loadProviders` outcome that renders a
   * different surface — a transport or duplicate-id failure, and an empty catalogue. After a provider
   * invalidation moved focus onto that heading, a failing refresh left keyboard focus on `body`, so the
   * result was announced but unreachable.
   *
   * Nothing is published before the application has taken focus at least once: on a first load the
   * page must not pull focus away from wherever the browser put it.
   */
  #replacementFocus(): { readonly focus?: FocusRequest } {
    return this.#focus === null ? {} : { focus: { target: 'state-heading' } };
  }

  selectProvider(providerId: string): void {
    const state = this.#state;

    // The gate is mechanical: only a provider verified against a successful catalogue may be selected.
    if (state.mode !== 'selecting' || state.catalogue.status !== 'loaded') {
      return;
    }

    if (!state.catalogue.providers.some((provider) => provider.id === providerId)) {
      return;
    }

    this.#supersedeReopen();

    // Changing the provider clears the draft area.
    this.#publish({
      ...state,
      draft: { cityId: state.draft.cityId, providerId, serviceAreaId: null },
      notice: null,
    });
    void this.#loadAreas(providerId);
  }

  /**
   * Reads the service areas for one provider.
   *
   * `preferredAreaId` is the area an existing confirmed pair already uses. It is restored as the draft
   * only when the fresh response still lists it as available, so editing a selection does not make the
   * user pick the same area again, while a newly chosen provider still auto-selects nothing.
   */
  async #loadAreas(
    providerId: string,
    preferredAreaId?: string,
    options: { readonly silent?: boolean } = {},
  ): Promise<void> {
    const gateway = this.environment.gateway;

    if (gateway === null) {
      return;
    }

    const { token, signal } = this.#newSelectionAttempt();

    this.#publish(
      { ...this.#selecting(), areas: { status: 'loading', providerId } },
      options.silent === true ? {} : { focus: { target: 'area-step' } },
    );

    const result = await gateway.listServiceAreas(providerId, signal);

    if (!this.#selectionIsCurrent(token)) {
      return;
    }

    const current = this.#selecting();

    if (!result.ok) {
      if (result.failure.kind === 'cancelled') {
        return;
      }

      // An invalidated draft provider is recovered, not retried: retrying would call the same missing
      // provider again. The failed request keeps its own phase and transport metadata.
      if (isProviderNotFoundProblem(result.failure)) {
        void this.#loadProviders({
          notice: 'provider_invalidated',
          focus: { target: 'provider-step' },
        });
        return;
      }

      this.#publish(
        {
          ...current,
          areas: {
            status: 'failed',
            context: {
              phase: 'selection_areas',
              draftProviderId: providerId,
              failure: result.failure,
            },
          },
        },
        { focus: { target: 'state-heading' } },
      );
      return;
    }

    const duplicate = checkServiceAreaUniqueness(result.data.data);

    if (duplicate !== undefined) {
      this.#publish(
        {
          ...current,
          areas: {
            status: 'failed',
            context: { phase: 'selection_areas', draftProviderId: providerId, failure: duplicate },
          },
        },
        { focus: { target: 'state-heading' } },
      );
      return;
    }

    /*
     * Uniqueness above ran over the provider's complete response; only now is it narrowed to the city
     * the user chose. A provider can serve more than one city, and a district from another city must
     * neither be offered under this city's heading nor be restored as the draft.
     */
    const cityId = current.draft.cityId;
    const scoped =
      cityId === null
        ? result.data.data
        : result.data.data.filter((candidate) => candidate.cityId === cityId);
    const empty = scoped.length === 0;
    const preferred = scoped.find((candidate) => candidate.id === preferredAreaId);
    const restored = preferred !== undefined && isAvailable(preferred) ? preferred.id : null;

    this.#publish(
      {
        ...current,
        areas: empty
          ? { status: 'empty', providerId }
          : { status: 'loaded', providerId, areas: scoped },
        // A successful area response auto-selects nothing, even with exactly one available area; the
        // only value carried over is a still-available area the user had already confirmed.
        draft: { ...current.draft, serviceAreaId: restored },
      },
      // An empty list replaces the area step with a state surface of its own, so the heading focus was
      // moved to during loading no longer exists. The loaded case keeps the same heading mounted.
      empty ? { focus: { target: 'state-heading' } } : {},
    );
  }

  selectArea(serviceAreaId: string): void {
    const state = this.#state;

    if (state.mode !== 'selecting' || state.areas.status !== 'loaded') {
      return;
    }

    const area = state.areas.areas.find((candidate) => candidate.id === serviceAreaId);

    // Only an available area can become the draft; an unavailable one is inert, and so is one that
    // belongs to a different city than the one chosen.
    if (area === undefined || !isAvailable(area) || !this.#inDraftCity(state, area)) {
      return;
    }

    this.#supersedeReopen();
    this.#publish({ ...state, draft: { ...state.draft, serviceAreaId } });
  }

  /** A district may only be drafted or confirmed inside the city the user chose. */
  #inDraftCity(state: Extract<ControllerState, { mode: 'selecting' }>, area: ServiceArea): boolean {
    return state.draft.cityId !== null && area.cityId === state.draft.cityId;
  }

  back(): void {
    const state = this.#state;

    if (state.mode !== 'selecting') {
      return;
    }

    this.#supersedeReopen();

    const step = this.#snapshot.view;
    const onAreaStep =
      step.kind === 'needs_selection'
        ? step.selection.step === 'area'
        : step.kind === 'no_service_areas';
    const openedBy = state.draft.providerId;
    const cityId = state.draft.cityId;

    // Supersedes and aborts the active attempt; its late completion is discarded by the token.
    this.#newSelectionAttempt();

    /*
     * One step back, never two. From the area step the user returns to whatever opened it — the
     * provider choice, or the city choice when the city offered a single provider and no provider
     * screen was shown. From the provider step the user returns to the city step.
     */
    const offeredOneProvider =
      state.catalogue.status === 'loaded' && state.catalogue.providers.length === 1;

    if (onAreaStep && !offeredOneProvider && openedBy !== null) {
      this.#publish(
        {
          ...state,
          areas: { status: 'idle' },
          draft: { ...state.draft, serviceAreaId: null },
          notice: null,
        },
        { focus: { target: 'provider-choice', providerId: openedBy } },
      );
      return;
    }

    this.#publish(
      {
        ...state,
        catalogue: { status: 'loading' },
        areas: { status: 'idle' },
        draft: { cityId: null, providerId: null, serviceAreaId: null },
        notice: null,
      },
      {
        focus: cityId === null ? { target: 'city-step' } : { target: 'city-choice', cityId },
      },
    );
  }

  /**
   * Selects one district and confirms it in the same step: the double-click shortcut.
   *
   * It names the district rather than confirming whatever the draft happens to hold, so a quick second
   * click on a *different* row cannot confirm the row the first click left behind. Everything else is
   * unchanged — `selectArea` still refuses an unavailable area, and confirmation still runs the one
   * documented pipeline. This is a shortcut through the same gate, not a second way in.
   *
   * A stray later click cannot start a second pipeline: once confirmed the controller is in schedule
   * mode, and both steps below require the selecting mode.
   */
  confirmArea(serviceAreaId: string): void {
    this.selectArea(serviceAreaId);

    const state = this.#state;

    if (state.mode === 'selecting' && state.draft.serviceAreaId === serviceAreaId) {
      this.confirm();
    }
  }

  confirm(): void {
    this.#confirmDraft({ takeFocus: true });
  }

  /**
   * Confirms the current draft, if it is still a complete and available choice.
   *
   * `takeFocus` is false only for a restored selection: the page has just loaded, the person has not
   * acted, and moving focus would take it from wherever the browser put it. Every user confirmation
   * still directs focus to the schedule heading.
   */
  #confirmDraft(options: { readonly takeFocus: boolean }): void {
    const state = this.#state;

    if (
      state.mode !== 'selecting' ||
      state.areas.status !== 'loaded' ||
      state.draft.providerId === null
    ) {
      return;
    }

    const { providerId, serviceAreaId } = state.draft;
    const area = state.areas.areas.find((candidate) => candidate.id === serviceAreaId);
    const provider =
      state.catalogue.status === 'loaded'
        ? state.catalogue.providers.find((candidate) => candidate.id === providerId)
        : undefined;

    if (
      serviceAreaId === null ||
      area === undefined ||
      provider === undefined ||
      !isAvailable(area) ||
      !this.#inDraftCity(state, area)
    ) {
      return;
    }

    this.#supersedeReopen();
    this.#startScheduleAttempt(
      { providerId, serviceAreaId },
      area.cityId,
      { city: area.locality, provider: provider.name, area: area.name },
      options,
    );
  }

  changeSelection(): void {
    const state = this.#state;

    if (state.mode !== 'schedule') {
      return;
    }

    this.#scheduleToken += 1;
    this.#scheduleController?.abort();
    this.#stopWatchdog();
    this.#stopCoordinator();
    this.#supersedeReopen();

    this.#publish(
      {
        mode: 'selecting',
        cities: { status: 'loading' },
        catalogue: { status: 'loading' },
        areas: { status: 'idle' },
        // The confirmed selection becomes the visible default while it stays inactive.
        draft: {
          cityId: state.cityId,
          providerId: state.confirmed.providerId,
          serviceAreaId: state.confirmed.serviceAreaId,
        },
        confirmed: state.confirmed,
        notice: null,
      },
      { focus: { target: 'provider-step' } },
    );

    void this.#reopenSelection(state.cityId, state.confirmed);
  }

  /**
   * Restarts only the reads needed to reconstruct the area step for the confirmed pair.
   *
   * Each value is restored only after a fresh read still offers it: the city, then the provider, then
   * the area. Anything that disappeared meanwhile leaves the user at the step where the choice has to
   * be made again, rather than at a step built on a value that no longer exists.
   *
   * The whole operation has one owner. It is checked after the city read — the only point where this
   * method itself continues after an `await` — and handed to the provider read, which restores the
   * confirmed provider and its district through a single area read. Nothing follows that call: a
   * `PROVIDER_NOT_FOUND` recovery it triggers ends at an explicit choice, and a newer user action that
   * superseded the reopen is never overwritten by the confirmed pair.
   */
  async #reopenSelection(cityId: string, confirmed: Selection): Promise<void> {
    this.#supersedeReopen();
    const owner = this.#reopenOwner;

    await this.#loadCities();

    const afterCities = this.#state;

    if (
      !this.#running ||
      this.#reopenOwner !== owner ||
      afterCities.mode !== 'selecting' ||
      afterCities.cities.status !== 'loaded' ||
      !afterCities.cities.cities.some((city) => city.id === cityId)
    ) {
      return;
    }

    this.#publish({ ...afterCities, draft: { cityId, providerId: null, serviceAreaId: null } });
    await this.#loadProviders({ preferred: { selection: confirmed, owner } });
  }

  /**
   * Reopens a remembered selection on a fresh run, and confirms it when it is still real.
   *
   * The same reads as a person's own flow — cities, then that city's providers, then that provider's
   * districts in that city — and the same validation at every step, so a remembered district cannot
   * survive its city, its provider, or its own availability. Exactly one read per step, ending in the
   * one schedule request the confirmation issues; nothing here re-reads what a step already loaded.
   *
   * A transport failure leaves the record alone: a catalogue that could not be read says nothing about
   * whether the selection still exists, and the user retries from the failure surface as usual. Only a
   * successful read that no longer offers the city, the provider or the district forgets it, and the
   * step the user is left on is the one that read published — a usable choice, never a spinner.
   */
  async #restoreSelection(remembered: StoredConfirmedSelection): Promise<void> {
    this.#supersedeReopen();
    const owner = this.#reopenOwner;
    // Set after the supersede above, which clears it: this is the intent that call is establishing.
    this.#pendingRestore = remembered;
    const confirmed: Selection = {
      providerId: remembered.providerId,
      serviceAreaId: remembered.serviceAreaId,
    };

    await this.#loadCities();

    const afterCities = this.#state;

    if (!this.#running || this.#reopenOwner !== owner || afterCities.mode !== 'selecting') {
      return;
    }

    if (afterCities.cities.status !== 'loaded') {
      /*
       * The surface for that outcome is already published and the record stands either way. A failed
       * read keeps the intent, because nothing about the selection was learned; an empty catalogue is
       * an answer, so there is nothing left to resume.
       */
      if (afterCities.cities.status !== 'failed') {
        this.#pendingRestore = undefined;
      }

      return;
    }

    if (!afterCities.cities.cities.some((city) => city.id === remembered.cityId)) {
      this.#pendingRestore = undefined;
      this.#forgetSelection();
      return;
    }

    this.#publish({
      ...afterCities,
      draft: { cityId: remembered.cityId, providerId: null, serviceAreaId: null },
    });
    await this.#loadProviders({ preferred: { selection: confirmed, owner }, silent: true });

    const afterAreas = this.#state;

    if (!this.#running || this.#reopenOwner !== owner || afterAreas.mode !== 'selecting') {
      return;
    }

    const intact =
      afterAreas.areas.status === 'loaded' &&
      afterAreas.draft.cityId === remembered.cityId &&
      afterAreas.draft.providerId === remembered.providerId &&
      afterAreas.draft.serviceAreaId === remembered.serviceAreaId;

    if (!intact) {
      /*
       * The provider or the district is gone. The reads above already left the user on the step that
       * has to be decided again, with whatever city context still holds, and no choice is made for
       * them here — a different district is never substituted for the one that was confirmed.
       */
      this.#pendingRestore = undefined;
      this.#forgetSelection();
      return;
    }

    // `#confirmDraft` supersedes the reopen owner, which is what clears the intent it just fulfilled.
    this.#confirmDraft({ takeFocus: false });
  }

  /** Forgets the remembered selection. Only ever called for one that a fresh read contradicted. */
  #forgetSelection(): void {
    this.#selectionStore.clear();
  }

  retry(): void {
    const view = this.#snapshot.view;
    // Read before superseding, which is what clears it.
    const resume = this.#pendingRestore;

    this.#supersedeReopen();

    /*
     * A restore interrupted by a failed read is resumed rather than abandoned: the same revalidation
     * from the top, so the city, the provider and the district are each confirmed by a fresh response
     * before the schedule is requested. A record the catalogue then contradicts still ends at the step
     * that has to be decided again, and one that no longer exists at the city step.
     */
    if (resume !== undefined && view.kind === 'error') {
      void this.#restoreSelection(resume);
      return;
    }

    if (view.kind === 'error') {
      const { context } = view;

      if (context.phase === 'selection_providers') {
        // The city read and the provider read share this phase; retry whichever one is outstanding.
        void (context.failure.operation === 'listCities'
          ? this.#loadCities({ userInitiated: true })
          : this.#loadProviders());
      } else if (context.phase === 'selection_areas') {
        void this.#loadAreas(context.draftProviderId);
      } else {
        this.#restartSchedulePipeline();
      }

      return;
    }

    if (view.kind === 'no_official_providers') {
      void (view.draftCityId === null
        ? this.#loadCities({ userInitiated: true })
        : this.#loadProviders());
      return;
    }

    if (view.kind === 'no_service_areas') {
      void this.#loadAreas(view.provider.id);
      return;
    }

    if (view.kind === 'range_not_covered') {
      this.#coordinator?.retry();
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Schedule pipeline
  // -------------------------------------------------------------------------------------------------

  #scheduleIsCurrent(token: number, selection: Selection): boolean {
    return (
      this.#running &&
      this.#scheduleToken === token &&
      this.#state.mode === 'schedule' &&
      this.#state.confirmed.providerId === selection.providerId &&
      this.#state.confirmed.serviceAreaId === selection.serviceAreaId
    );
  }

  #publishSchedule(schedule: ScheduleState, options: { readonly focus?: FocusRequest } = {}): void {
    const state = this.#state;

    if (state.mode !== 'schedule') {
      return;
    }

    this.#publish({ ...state, schedule }, options);
  }

  #startScheduleAttempt(
    selection: Selection,
    cityId: string,
    label: { readonly city: string; readonly provider: string; readonly area: string },
    options: { readonly takeFocus?: boolean } = {},
  ): void {
    this.#stopWatchdog();
    this.#stopCoordinator();
    this.#scheduleController?.abort();
    this.#scheduleToken += 1;
    const token = this.#scheduleToken;
    const controller = new AbortController();
    this.#scheduleController = controller;

    this.#silentScheduleToken = options.takeFocus === false ? token : undefined;
    this.#publish(
      { mode: 'schedule', confirmed: selection, cityId, schedule: { status: 'loading' }, label },
      options.takeFocus === false ? {} : { focus: { target: 'schedule-heading' } },
    );

    void this.#runPipeline({
      token,
      signal: controller.signal,
      selection,
      stage: 'initial',
      budget: 1,
    });
  }

  #restartSchedulePipeline(): void {
    const state = this.#state;

    if (state.mode !== 'schedule') {
      return;
    }

    this.#startScheduleAttempt(state.confirmed, state.cityId, state.label);
  }

  #failSchedule(
    stage: 'initial' | 'reconciliation',
    selection: Selection,
    failure: Exclude<ScheduleFailure, { kind: 'cancelled' }>,
  ): void {
    const context: ErrorContext = {
      phase: 'schedule_pipeline',
      stage,
      confirmedSelection: selection,
      failure,
    };

    this.#stopWatchdog();
    this.#stopCoordinator();
    this.#publishSchedule({ status: 'error', context }, { focus: { target: 'state-heading' } });
  }

  /**
   * The authoritative pipeline: fresh providers → fresh areas → clock → clamped range → conditional
   * events → every acceptance check → the final source-date gate.
   *
   * `stage` is `'reconciliation'` when the one shared budget has already been consumed; the sequence is
   * otherwise identical, which is exactly what the canonical reconciliation contract requires.
   */
  async #runPipeline(attempt: {
    readonly token: number;
    readonly signal: AbortSignal;
    readonly selection: Selection;
    readonly stage: 'initial' | 'reconciliation';
    readonly budget: 1 | 0;
  }): Promise<void> {
    const gateway = this.environment.gateway;

    if (gateway === null) {
      return;
    }

    const { token, signal, selection, stage } = attempt;
    const fail = (failure: Exclude<ScheduleFailure, { kind: 'cancelled' }>): void =>
      this.#failSchedule(stage, selection, failure);

    const providers = await gateway.listProviders(signal);

    if (!this.#scheduleIsCurrent(token, selection)) {
      return;
    }

    if (!this.#unwrap(providers, fail)) {
      return;
    }

    const duplicateProviders = checkProviderUniqueness(providers.data.data);

    if (duplicateProviders !== undefined) {
      fail(duplicateProviders);
      return;
    }

    const provider = officialProviders(providers.data.data).find(
      (candidate) => candidate.id === selection.providerId,
    );

    if (provider === undefined) {
      this.#invalidateSelection(officialProviders(providers.data.data), 'provider_removed');
      return;
    }

    const areas = await gateway.listServiceAreas(selection.providerId, signal);

    if (!this.#scheduleIsCurrent(token, selection)) {
      return;
    }

    if (!this.#unwrap(areas, fail)) {
      return;
    }

    const duplicateAreas = checkServiceAreaUniqueness(areas.data.data);

    if (duplicateAreas !== undefined) {
      fail(duplicateAreas);
      return;
    }

    const area = this.#confirmedArea(areas.data.data, selection);

    if (area === undefined || !isAvailable(area)) {
      this.#invalidateSelection(
        officialProviders(providers.data.data),
        area === undefined ? 'area_removed' : 'area_unavailable',
        {
          providerId: selection.providerId,
          areas: areas.data.data,
        },
      );
      return;
    }

    const capability: RequestingCapability = {
      timeZone: area.collectionEvents.timeZone,
      validity: area.collectionEvents.validity,
    };
    const evidence: EntryEvidence = {
      providersRead: true,
      providerValidated: true,
      areasRead: true,
      areaValidated: true,
      capability,
    };

    // Preflight derivation: its failure prevents only the events request whose range it would produce.
    const sourceToday = deriveSourceToday(capability.timeZone, this.environment.clock.now());

    if (!sourceToday.ok) {
      fail({ kind: 'source_date_unavailable', timeZone: capability.timeZone });
      return;
    }

    const target = deriveTargetRange(sourceToday.date, capability.validity);

    if (target.kind !== 'requestable') {
      // A local capability-derived entry carries no triggering problem.
      this.#enterRangeNotCovered(selection, { evidence });
      return;
    }

    const events = await gateway.listCollectionEvents(
      {
        providerId: selection.providerId,
        serviceAreaId: selection.serviceAreaId,
        range: target.range,
      },
      signal,
    );

    if (!this.#scheduleIsCurrent(token, selection)) {
      return;
    }

    if (!events.ok) {
      if (events.failure.kind === 'cancelled') {
        return;
      }

      if (isExactRangeProblem(events.failure)) {
        if (attempt.budget === 1) {
          // The first exact range problem consumes the one shared budget and reconciles.
          void this.#runPipeline({ ...attempt, stage: 'reconciliation', budget: 0 });
          return;
        }

        this.#enterRangeNotCovered(selection, { evidence, triggeringRangeProblem: events.failure });
        return;
      }

      fail(events.failure);
      return;
    }

    const check = checkEventResponse(events.data, capability);

    if (check.kind === 'metadata_mismatch') {
      if (attempt.budget === 1) {
        void this.#runPipeline({ ...attempt, stage: 'reconciliation', budget: 0 });
        return;
      }

      fail(localInvalidResponse('listCollectionEvents'));
      return;
    }

    if (check.kind === 'invalid') {
      fail(check.failure);
      return;
    }

    const mapped = this.#toDomainEvents(events.data);

    if (mapped === undefined) {
      fail(localInvalidResponse('listCollectionEvents'));
      return;
    }

    this.#applyPublicationGate({
      token,
      selection,
      capability,
      snapshot: sourceToday.date,
      onFailure: fail,
      onChanged: () => {
        this.#restartSchedulePipeline();
      },
      onPublish: () => {
        this.#acceptSchedule(selection, {
          selection,
          sourceToday: sourceToday.date,
          range: target.range,
          meta: events.data.meta,
          events: mapped,
        });
      },
    });
  }

  /**
   * The confirmed district in a fresh area response — only while it still belongs to the confirmed
   * city. A district that moved to another city is, for this schedule, a district that was removed:
   * accepting it would silently change the city the schedule is for.
   */
  #confirmedArea(areas: readonly ServiceArea[], selection: Selection): ServiceArea | undefined {
    const cityId = this.#state.mode === 'schedule' ? this.#state.cityId : undefined;

    return areas.find(
      (candidate) => candidate.id === selection.serviceAreaId && candidate.cityId === cityId,
    );
  }

  /** Reports a transport failure and returns whether the result may be used. */
  #unwrap<Data>(
    result: ApiResult<Data>,
    fail: (failure: Exclude<ScheduleFailure, { kind: 'cancelled' }>) => void,
  ): result is { ok: true; data: Data } {
    if (result.ok) {
      return true;
    }

    if (result.failure.kind !== 'cancelled') {
      fail(result.failure);
    }

    return false;
  }

  #toDomainEvents(response: CollectionEventListResponse): CollectionEvent[] | undefined {
    const mapped: CollectionEvent[] = [];

    for (const event of response.data) {
      const domain = toDomainCollectionEvent(event);

      if (domain === undefined) {
        return undefined;
      }

      mapped.push(domain);
    }

    return orderEvents(mapped);
  }

  /**
   * The final source-date gate. From the ownership check through publication there is no `await`, so a
   * request that outlived source midnight cannot be published as current.
   */
  #applyPublicationGate(options: {
    readonly token: number;
    readonly selection: Selection;
    readonly capability: RequestingCapability;
    readonly snapshot: IsoDate;
    readonly onFailure: (failure: Exclude<ScheduleFailure, { kind: 'cancelled' }>) => void;
    readonly onChanged: () => void;
    readonly onPublish: () => void;
  }): void {
    if (!this.#scheduleIsCurrent(options.token, options.selection)) {
      return;
    }

    const derived = deriveSourceToday(options.capability.timeZone, this.environment.clock.now());

    if (!derived.ok) {
      options.onFailure({ kind: 'source_date_unavailable', timeZone: options.capability.timeZone });
      return;
    }

    // Inequality, not "later than": a backward change is still a change. Never a range-bounds comparison.
    if (derived.date !== options.snapshot) {
      options.onChanged();
      return;
    }

    options.onPublish();
  }

  #acceptSchedule(
    selection: Selection,
    schedule: import('@/src/schedule/view-state').AcceptedSchedule,
  ): void {
    this.#stopCoordinator();
    this.#stopWatchdog();
    this.#publishSchedule(
      { status: 'accepted', schedule },
      this.#scheduleToken === this.#silentScheduleToken
        ? {}
        : { focus: { target: 'schedule-heading' } },
    );

    /*
     * Remembered here and nowhere else: a selection becomes persistent when its schedule is accepted,
     * so a draft, an abandoned reopen and a failed confirmation all leave the previous record intact,
     * and confirming a new district replaces it in one write once the new schedule is real.
     */
    const published = this.#state;

    if (published.mode === 'schedule') {
      this.#selectionStore.write({
        cityId: published.cityId,
        providerId: selection.providerId,
        serviceAreaId: selection.serviceAreaId,
      });
    }

    this.#startWatchdog(selection, schedule.meta.source.timeZone, schedule.sourceToday);
  }

  #startWatchdog(selection: Selection, timeZone: string, sourceToday: IsoDate): void {
    const watchdog = new SourceDateWatchdog({
      timers: this.environment.timers,
      clock: this.environment.clock,
      isVisible: this.environment.lifecycle.isVisible,
      timeZone,
      sourceToday,
      onChanged: () => {
        if (this.#watchdog === watchdog) {
          this.#watchdog = undefined;
          this.#restartSchedulePipeline();
        }
      },
      onDerivationFailed: () => {
        if (this.#watchdog === watchdog) {
          this.#watchdog = undefined;
          // Withdraw the accepted schedule, retain the pair, invent no transport operation.
          this.#failSchedule('initial', selection, { kind: 'source_date_unavailable', timeZone });
        }
      },
    });

    this.#watchdog = watchdog;
    watchdog.start();
  }

  // -------------------------------------------------------------------------------------------------
  // Authoritative invalidation
  // -------------------------------------------------------------------------------------------------

  /**
   * Returns an invalidated confirmed selection to a usable choice.
   *
   * Schedule mode keeps no city slice, so the city context comes from the catalogue this run last
   * loaded. With it, the user lands on the step that has to be decided again — the city's remaining
   * providers, or the provider's districts in that city — with focus on that step, or on the state
   * heading when nothing is left to choose. Without it, the city catalogue is re-read under a new
   * owner, so the spinner that follows always has a request behind it.
   */
  #invalidateSelection(
    providers: readonly Provider[],
    reason: 'provider_removed' | 'area_removed' | 'area_unavailable',
    areaData?: { readonly providerId: string; readonly areas: readonly ServiceArea[] },
  ): void {
    // Read before publishing: the city the invalidated pair belonged to is what the user returns to.
    const previous = this.#state;
    const cityId = previous.mode === 'schedule' ? previous.cityId : this.#selecting().draft.cityId;

    this.#stopWatchdog();
    this.#stopCoordinator();
    this.#scheduleToken += 1;
    this.#scheduleController?.abort();
    this.#supersedeReopen();
    // The confirmed pair no longer exists upstream, so the record of it is not worth restoring.
    this.#forgetSelection();

    const knownCities = this.#knownCities;
    const city =
      cityId === null ? undefined : knownCities?.find((candidate) => candidate.id === cityId);

    if (knownCities === undefined || city === undefined) {
      void this.#loadCities({ userInitiated: true });
      return;
    }

    // Supersede any selection attempt: this publication is the current owner of the surface.
    this.#newSelectionAttempt();

    // Only what this city offers, exactly as a fresh provider read would narrow it.
    const offeredByCity = new Set(city.providers.map((provider) => provider.id));
    const offered = providers.filter((provider) => offeredByCity.has(provider.id));
    const catalogue: CatalogueState =
      offered.length === 0 ? { status: 'empty' } : { status: 'loaded', providers: offered };
    const cityAreas = areaData?.areas.filter((candidate) => candidate.cityId === city.id);
    const areas: AreasState =
      areaData === undefined || cityAreas === undefined || reason === 'provider_removed'
        ? { status: 'idle' }
        : cityAreas.length === 0
          ? { status: 'empty', providerId: areaData.providerId }
          : { status: 'loaded', providerId: areaData.providerId, areas: cityAreas };

    const next: ControllerState = {
      mode: 'selecting',
      cities: { status: 'loaded', cities: knownCities },
      catalogue,
      areas,
      draft: {
        cityId: city.id,
        providerId: reason === 'provider_removed' ? null : (areaData?.providerId ?? null),
        serviceAreaId: null,
      },
      confirmed: null,
      notice: reason === 'area_unavailable' ? 'area_unavailable' : null,
    };

    // Focus follows what is actually rendered, so the destination is always mounted.
    const view = deriveViewState(next);
    const focus: FocusRequest =
      view.kind !== 'needs_selection'
        ? { target: 'state-heading' }
        : view.selection.step === 'area'
          ? { target: 'area-step' }
          : view.selection.step === 'provider'
            ? { target: 'provider-step' }
            : { target: 'city-step' };

    this.#publish(next, { focus });
  }

  // -------------------------------------------------------------------------------------------------
  // Range recovery
  // -------------------------------------------------------------------------------------------------

  #enterRangeNotCovered(
    selection: Selection,
    options: {
      readonly evidence?: EntryEvidence;
      readonly triggeringRangeProblem?: ExactRangeProblem;
    },
  ): void {
    // The accepted schedule and its relative labels are removed before the state is presented.
    this.#stopWatchdog();
    this.#stopCoordinator();

    this.#publishSchedule(
      {
        status: 'range_not_covered',
        recovering: false,
        ...(options.triggeringRangeProblem === undefined
          ? {}
          : { triggeringRangeProblem: options.triggeringRangeProblem }),
      },
      { focus: { target: 'state-heading' } },
    );

    const coordinator = new RangeRecoveryCoordinator({
      timers: this.environment.timers,
      isVisible: this.environment.lifecycle.isVisible,
      runCycle: (cycle) => this.#runRecoveryCycle(selection, cycle),
    });

    this.#coordinator = coordinator;
    // Qualifying evidence means the producing flow's completed reads count as the initial cycle.
    coordinator.start({ reuseEntryRevalidation: options.evidence !== undefined });
  }

  #recoveryState(): Extract<ScheduleState, { status: 'range_not_covered' }> | undefined {
    const state = this.#state;

    return state.mode === 'schedule' && state.schedule.status === 'range_not_covered'
      ? state.schedule
      : undefined;
  }

  #setRecoveryFailure(
    selection: Selection,
    failure: Exclude<ScheduleFailure, { kind: 'cancelled' }>,
  ): void {
    const current = this.#recoveryState();

    if (current === undefined) {
      return;
    }

    const nested: RecoveryFailure = {
      phase: 'range_recovery',
      confirmedSelection: selection,
      failure,
    };

    this.#publishSchedule({ ...current, recovering: false, lastRecoveryFailure: nested });
  }

  /**
   * One recovery cycle: fresh providers → fresh areas → clock → range → events only when requestable.
   *
   * It never builds a request from the expired capability snapshot, and it never renders a schedule
   * before the final source-date gate passes.
   */
  async #runRecoveryCycle(
    selection: Selection,
    cycle: { readonly signal: AbortSignal; readonly isCurrent: () => boolean },
  ): Promise<RecoveryOutcome> {
    const gateway = this.environment.gateway;
    const entry = this.#recoveryState();

    if (gateway === null || entry === undefined) {
      return 'finished';
    }

    // A new cycle begins: the previous cycle's nested diagnostic is cleared before it runs.
    const { lastRecoveryFailure: _cleared, ...withoutFailure } = entry;
    this.#publishSchedule({ ...withoutFailure, recovering: true });

    const alive = (): boolean =>
      cycle.isCurrent() && this.#running && this.#recoveryState() !== undefined;
    const settle = (failure: Exclude<ScheduleFailure, { kind: 'cancelled' }>): RecoveryOutcome => {
      this.#setRecoveryFailure(selection, failure);
      return 'uncovered';
    };

    const providers = await gateway.listProviders(cycle.signal);

    if (!alive()) {
      return 'finished';
    }

    if (!providers.ok) {
      return providers.failure.kind === 'cancelled' ? 'finished' : settle(providers.failure);
    }

    const duplicateProviders = checkProviderUniqueness(providers.data.data);

    if (duplicateProviders !== undefined) {
      return settle(duplicateProviders);
    }

    const offered = officialProviders(providers.data.data);
    const provider = offered.find((candidate) => candidate.id === selection.providerId);

    if (provider === undefined) {
      this.#invalidateSelection(offered, 'provider_removed');
      return 'finished';
    }

    const areas = await gateway.listServiceAreas(selection.providerId, cycle.signal);

    if (!alive()) {
      return 'finished';
    }

    if (!areas.ok) {
      return areas.failure.kind === 'cancelled' ? 'finished' : settle(areas.failure);
    }

    const duplicateAreas = checkServiceAreaUniqueness(areas.data.data);

    if (duplicateAreas !== undefined) {
      return settle(duplicateAreas);
    }

    const area = this.#confirmedArea(areas.data.data, selection);

    if (area === undefined || !isAvailable(area)) {
      this.#invalidateSelection(offered, area === undefined ? 'area_removed' : 'area_unavailable', {
        providerId: selection.providerId,
        areas: areas.data.data,
      });
      return 'finished';
    }

    const capability: RequestingCapability = {
      timeZone: area.collectionEvents.timeZone,
      validity: area.collectionEvents.validity,
    };
    const sourceToday = deriveSourceToday(capability.timeZone, this.environment.clock.now());

    if (!sourceToday.ok) {
      return settle({ kind: 'source_date_unavailable', timeZone: capability.timeZone });
    }

    const target = deriveTargetRange(sourceToday.date, capability.validity);

    if (target.kind !== 'requestable') {
      // Still uncovered: no events request, no schedule, and the next attempt is scheduled.
      const current = this.#recoveryState();

      if (current !== undefined) {
        this.#publishSchedule({ ...current, recovering: false });
      }

      return 'uncovered';
    }

    const events = await gateway.listCollectionEvents(
      {
        providerId: selection.providerId,
        serviceAreaId: selection.serviceAreaId,
        range: target.range,
      },
      cycle.signal,
    );

    if (!alive()) {
      return 'finished';
    }

    if (!events.ok) {
      return events.failure.kind === 'cancelled' ? 'finished' : settle(events.failure);
    }

    const check = checkEventResponse(events.data, capability);

    if (check.kind !== 'accepted') {
      return settle(
        check.kind === 'invalid' ? check.failure : localInvalidResponse('listCollectionEvents'),
      );
    }

    const mapped = this.#toDomainEvents(events.data);

    if (mapped === undefined) {
      return settle(localInvalidResponse('listCollectionEvents'));
    }

    const derived = deriveSourceToday(capability.timeZone, this.environment.clock.now());

    if (!derived.ok) {
      return settle({ kind: 'source_date_unavailable', timeZone: capability.timeZone });
    }

    if (derived.date !== sourceToday.date) {
      // The candidate is discarded; the same coordinator runs one immediate replacement cycle.
      return 'replace';
    }

    this.#acceptSchedule(selection, {
      selection,
      sourceToday: sourceToday.date,
      range: target.range,
      meta: events.data.meta,
      events: mapped,
    });

    return 'finished';
  }
}
