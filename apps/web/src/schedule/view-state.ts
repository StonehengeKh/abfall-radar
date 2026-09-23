import type { CollectionEvent } from '@abfall-radar/domain';
import type { IsoDate } from '@abfall-radar/schedule-format';
import type {
  ApiFailure,
  City,
  CollectionEventMeta,
  ProblemFailure,
  Provider,
  ScheduleRange,
  ServiceArea,
} from '@/src/adapters/schedule-gateway';

/**
 * The application's state types and the one pure function that turns controller state into what is
 * rendered. No component decides a state or reconstructs a request phase on its own.
 */

export interface Selection {
  readonly providerId: string;
  readonly serviceAreaId: string;
}

// ---------------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------------

/**
 * Web-owned and never from the wire: `deriveSourceToday` could not produce a source-local date. It
 * carries no `operation`, `status`, or `requestId`, because no HTTP request failed.
 */
export interface SourceDateUnavailable {
  readonly kind: 'source_date_unavailable';
  /** The validated capability zone that could not be used. Never `RangeError` text. */
  readonly timeZone: string;
}

/**
 * Only the two phases that derive a source date admit the local failure. Selection phases never call
 * `deriveSourceToday`, so their `failure` stays exactly `ApiFailure`.
 */
export type ScheduleFailure = ApiFailure | SourceDateUnavailable;

/** Cancellation never reaches a surface, whatever the phase. */
export type Renderable<Failure> = Exclude<Failure, { readonly kind: 'cancelled' }>;

export type RenderableApiFailure = Renderable<ApiFailure>;

export type FailureContext =
  | { readonly phase: 'selection_providers'; readonly failure: ApiFailure }
  | {
      readonly phase: 'selection_areas';
      readonly draftProviderId: string;
      readonly failure: ApiFailure;
    }
  | {
      readonly phase: 'schedule_pipeline';
      readonly stage: 'initial' | 'reconciliation';
      readonly confirmedSelection: Selection;
      readonly failure: ScheduleFailure;
    }
  | {
      readonly phase: 'range_recovery';
      readonly confirmedSelection: Selection;
      readonly failure: ScheduleFailure;
    };

/** Maps each context's own `failure`, so the phase constraint survives the mapping. */
export type WithRenderableFailure<Context> = Context extends { readonly failure: infer Failure }
  ? Omit<Context, 'failure'> & { readonly failure: Renderable<Failure> }
  : never;

export type ErrorContext = WithRenderableFailure<
  Exclude<FailureContext, { readonly phase: 'range_recovery' }>
>;

export type ProvidersFailure = WithRenderableFailure<
  Extract<FailureContext, { readonly phase: 'selection_providers' }>
>;

export type AreasFailure = WithRenderableFailure<
  Extract<FailureContext, { readonly phase: 'selection_areas' }>
>;

export type RecoveryFailure = WithRenderableFailure<
  Extract<FailureContext, { readonly phase: 'range_recovery' }>
>;

/** A narrowing of the exported `ProblemFailure`, not a new interface. */
export type ExactRangeProblem = ProblemFailure & {
  readonly operation: 'listCollectionEvents';
  readonly status: 422;
  readonly code: 'SCHEDULE_RANGE_NOT_COVERED';
};

/** A narrowing of the exported `ProblemFailure`: the areas route's provider-not-found answer. */
export type ProviderNotFoundProblem = ProblemFailure & {
  readonly operation: 'listServiceAreas';
  readonly status: 404;
  readonly code: 'PROVIDER_NOT_FOUND';
};

export const isExactRangeProblem = (failure: ApiFailure): failure is ExactRangeProblem =>
  failure.kind === 'problem' &&
  failure.operation === 'listCollectionEvents' &&
  failure.status === 422 &&
  failure.code === 'SCHEDULE_RANGE_NOT_COVERED';

export const isProviderNotFoundProblem = (
  failure: ApiFailure,
): failure is ProviderNotFoundProblem =>
  failure.kind === 'problem' &&
  failure.operation === 'listServiceAreas' &&
  failure.status === 404 &&
  failure.code === 'PROVIDER_NOT_FOUND';

// ---------------------------------------------------------------------------------------------------
// Controller state
// ---------------------------------------------------------------------------------------------------

/**
 * The city catalogue: the first read the selection flow performs.
 *
 * A failure here is reported in `selection_providers`, because a city read and a provider read answer
 * the same question — which official service can be chosen — and Retry must re-read exactly that. The
 * `operation` on the failure stays the truthful transport one.
 */
export type CitiesState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly cities: readonly City[] }
  | { readonly status: 'empty' }
  | { readonly status: 'failed'; readonly context: ProvidersFailure };

export type CatalogueState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly providers: readonly Provider[] }
  | { readonly status: 'empty' }
  | { readonly status: 'failed'; readonly context: ProvidersFailure };

export type AreasState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly providerId: string }
  | {
      readonly status: 'loaded';
      readonly providerId: string;
      readonly areas: readonly ServiceArea[];
    }
  | { readonly status: 'empty'; readonly providerId: string }
  | { readonly status: 'failed'; readonly context: AreasFailure };

export interface AcceptedSchedule {
  readonly selection: Selection;
  readonly sourceToday: IsoDate;
  readonly range: ScheduleRange;
  readonly meta: CollectionEventMeta;
  /** Ordered by the total event order. */
  readonly events: readonly CollectionEvent[];
}

export type ScheduleState =
  | { readonly status: 'loading' }
  | { readonly status: 'accepted'; readonly schedule: AcceptedSchedule }
  | {
      readonly status: 'range_not_covered';
      readonly triggeringRangeProblem?: ExactRangeProblem;
      readonly lastRecoveryFailure?: RecoveryFailure;
      readonly recovering: boolean;
    }
  | { readonly status: 'error'; readonly context: ErrorContext };

export type ControllerState =
  | { readonly mode: 'configuration_error' }
  | {
      readonly mode: 'selecting';
      readonly cities: CitiesState;
      readonly catalogue: CatalogueState;
      readonly areas: AreasState;
      readonly draft: {
        readonly cityId: string | null;
        readonly providerId: string | null;
        readonly serviceAreaId: string | null;
      };
      /** Retained but inactive while `Auswahl ändern` edits a draft. */
      readonly confirmed: Selection | null;
      readonly notice: 'provider_invalidated' | 'area_unavailable' | null;
    }
  | {
      readonly mode: 'schedule';
      readonly confirmed: Selection;
      /** The city the confirmed area belongs to, so editing the selection can return to it. */
      readonly cityId: string;
      readonly schedule: ScheduleState;
      /** The confirmed pair's names, for the heading. */
      readonly label: {
        readonly city: string;
        readonly provider: string;
        readonly area: string;
      };
    };

// ---------------------------------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------------------------------

export type NeedsSelectionStep =
  | { readonly step: 'city'; readonly cities: 'loading' | readonly City[] }
  | {
      readonly step: 'provider';
      readonly city: City;
      readonly catalogue: 'loading' | readonly Provider[];
    }
  | {
      readonly step: 'area';
      readonly city: City;
      readonly provider: Provider;
      readonly areas: 'loading' | readonly ServiceArea[];
      readonly draftAreaId: string | null;
    };

export type AppViewState =
  | { readonly kind: 'configuration_error' }
  | {
      readonly kind: 'needs_selection';
      readonly selection: NeedsSelectionStep;
      readonly draftCityId: string | null;
      readonly draftProviderId: string | null;
      readonly notice: 'provider_invalidated' | 'area_unavailable' | null;
      readonly canReturnToSchedule: boolean;
    }
  | {
      readonly kind: 'no_official_providers';
      /** `null` when no city was chosen yet, so Retry re-reads the city catalogue instead. */
      readonly draftCityId: string | null;
    }
  | { readonly kind: 'no_service_areas'; readonly city: City; readonly provider: Provider }
  | {
      readonly kind: 'loading';
      readonly label: { readonly city: string; readonly provider: string; readonly area: string };
    }
  | {
      readonly kind: 'live';
      readonly freshness: 'fresh' | 'upstream_stale';
      readonly schedule: AcceptedSchedule;
    }
  | { readonly kind: 'empty'; readonly schedule: AcceptedSchedule }
  | {
      readonly kind: 'range_not_covered';
      readonly triggeringRangeProblem?: ExactRangeProblem;
      readonly lastRecoveryFailure?: RecoveryFailure;
      readonly recovering: boolean;
    }
  | { readonly kind: 'error'; readonly context: ErrorContext };

export type AppViewKind = AppViewState['kind'];

/** Every member, so exhaustive copy and announcement tests can iterate the union. */
export const APP_VIEW_KINDS = [
  'configuration_error',
  'needs_selection',
  'no_official_providers',
  'no_service_areas',
  'loading',
  'live',
  'empty',
  'range_not_covered',
  'error',
] as const satisfies readonly AppViewKind[];

const failureIdentity = (
  failure: RenderableApiFailure | SourceDateUnavailable | undefined,
): string =>
  failure === undefined
    ? 'none'
    : failure.kind === 'problem'
      ? `problem:${failure.code}`
      : failure.kind;

/**
 * What the polite announcement for a view depends on, as a comparable string.
 *
 * The announcement is derived from the current view rather than stored when a transition happens. A
 * stored message outlived its state: after `PROVIDER_NOT_FOUND` the live region went on reporting an
 * unavailable provider through the next successful schedule. Deriving also makes the nested cases
 * audible — a recovery failure under `range_not_covered`, and each distinct pipeline failure.
 *
 * The identity changes exactly when the announced text does, which is what advances the sequence the
 * live region is keyed by, so an identical message after an intervening state announces again.
 */
export const announcementIdentity = (view: AppViewState): string => {
  switch (view.kind) {
    case 'needs_selection':
      return `needs_selection:${view.selection.step}:${view.notice ?? 'none'}`;
    case 'live':
      return `live:${view.freshness}`;
    case 'range_not_covered':
      return `range_not_covered:${view.recovering ? 'recovering' : 'idle'}:${failureIdentity(
        view.lastRecoveryFailure?.failure,
      )}`;
    case 'error':
      return `error:${view.context.phase}:${failureIdentity(view.context.failure)}`;
    default:
      return view.kind;
  }
};

const findProvider = (
  catalogue: CatalogueState,
  providerId: string | null,
): Provider | undefined =>
  catalogue.status === 'loaded' && providerId !== null
    ? catalogue.providers.find((provider) => provider.id === providerId)
    : undefined;

export const deriveViewState = (state: ControllerState): AppViewState => {
  if (state.mode === 'configuration_error') {
    return { kind: 'configuration_error' };
  }

  if (state.mode === 'schedule') {
    const { schedule } = state;

    switch (schedule.status) {
      case 'loading':
        return { kind: 'loading', label: state.label };
      case 'accepted':
        return schedule.schedule.events.length === 0
          ? { kind: 'empty', schedule: schedule.schedule }
          : {
              kind: 'live',
              freshness: schedule.schedule.meta.freshness === 'stale' ? 'upstream_stale' : 'fresh',
              schedule: schedule.schedule,
            };
      case 'range_not_covered':
        return {
          kind: 'range_not_covered',
          recovering: schedule.recovering,
          ...(schedule.triggeringRangeProblem === undefined
            ? {}
            : { triggeringRangeProblem: schedule.triggeringRangeProblem }),
          ...(schedule.lastRecoveryFailure === undefined
            ? {}
            : { lastRecoveryFailure: schedule.lastRecoveryFailure }),
        };
      case 'error':
        return { kind: 'error', context: schedule.context };
    }
  }

  const { cities, catalogue, areas, draft } = state;

  // The city read answers the same question as the provider read — which official service can be
  // chosen — so its failure and its empty result render the same two surfaces.
  if (cities.status === 'failed') {
    return { kind: 'error', context: cities.context };
  }

  if (cities.status === 'empty') {
    return { kind: 'no_official_providers', draftCityId: null };
  }

  const common = {
    draftCityId: draft.cityId,
    draftProviderId: draft.providerId,
    notice: state.notice,
    canReturnToSchedule: state.confirmed !== null,
  };

  const city =
    cities.status === 'loaded' && draft.cityId !== null
      ? cities.cities.find((candidate) => candidate.id === draft.cityId)
      : undefined;

  if (city === undefined) {
    return {
      kind: 'needs_selection',
      selection: {
        step: 'city',
        cities: cities.status === 'loading' ? 'loading' : cities.cities,
      },
      ...common,
    };
  }

  if (catalogue.status === 'failed') {
    return { kind: 'error', context: catalogue.context };
  }

  if (catalogue.status === 'empty') {
    return { kind: 'no_official_providers', draftCityId: draft.cityId };
  }

  const provider = findProvider(catalogue, draft.providerId);

  // `idle` areas mean the area step is not open: `Zurück` returns here, keeping the provider highlighted.
  if (catalogue.status === 'loading' || provider === undefined || areas.status === 'idle') {
    return {
      kind: 'needs_selection',
      selection: {
        step: 'provider',
        city,
        catalogue: catalogue.status === 'loading' ? 'loading' : catalogue.providers,
      },
      ...common,
    };
  }

  if (areas.status === 'failed') {
    return { kind: 'error', context: areas.context };
  }

  if (areas.status === 'empty' && areas.providerId === provider.id) {
    return { kind: 'no_service_areas', city, provider };
  }

  if (areas.status === 'loaded' && areas.providerId === provider.id) {
    return {
      kind: 'needs_selection',
      selection: {
        step: 'area',
        city,
        provider,
        areas: areas.areas,
        draftAreaId: draft.serviceAreaId,
      },
      ...common,
    };
  }

  return {
    kind: 'needs_selection',
    selection: { step: 'area', city, provider, areas: 'loading', draftAreaId: draft.serviceAreaId },
    ...common,
  };
};
