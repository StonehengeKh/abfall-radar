import { Check, Loader2, MapPin, RotateCcw } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { AreaStatePanel } from '@/src/features/areas/area-state-panel';
import {
  type AreaCatalogueState,
  areaStateProviderId,
  areasOf,
  type CityCatalogueState,
  officialProvidersOf,
  type ProviderCatalogueState,
} from '@/src/hooks/use-catalogue';
import { useCopy } from '@/src/i18n/copy';
import type { CitySummary, ServiceAreaSummary } from '@/src/messaging/contract';

/**
 * Choosing a district: the city, then the operator only when the city has more than one, then the district.
 *
 * Shared by onboarding and Settings, so both ask the same questions in the same order with the same states.
 * The website asks them in this order too; the popup keeps its own compact form of it.
 *
 * Nothing here writes, and nothing here decides what a choice means: the surface around it owns the draft,
 * the confirmation and the save. This owns the two intermediate answers — which city, which operator — that
 * are never stored, because a saved selection is `{ providerId, serviceAreaId }` and the city is derived from
 * it.
 *
 * The operator step follows the same rule as every other provider request in the popup: an operator is offered
 * only when the city lists it **and** a successful provider catalogue offers it as official. When exactly one
 * does, it is taken without asking, because a question with one answer is not a choice; it is still named, so a
 * person can see whose calendar they are choosing from.
 */

export interface AreaPickerProps {
  readonly cities: CityCatalogueState;
  readonly catalogue: ProviderCatalogueState;
  /**
   * The district list of one operator.
   *
   * A lookup rather than a value, because this component decides which operator it is asking about — from the
   * chosen city — and so is the only place that can say whose answer it needs.
   */
  readonly areaStateFor: (providerId: string | null) => AreaCatalogueState;
  /**
   * The city and operator to start from — Settings passes the saved selection's, once derived — or `null`.
   *
   * Adopted until the person changes either field themselves, so a derivation that answers after the surface
   * opened still fills them in, and one that answers late can never undo a choice already made.
   */
  readonly initialCityId: string | null;
  readonly initialProviderId: string | null;
  /** The district currently chosen by the surrounding surface, if any. */
  readonly chosenAreaId: string | null;
  readonly onChooseArea: (area: ServiceAreaSummary) => void;
  /** Called when the city or operator changes, so no district is carried across either. */
  readonly onResetArea: () => void;
  readonly onRetryCities: () => void;
  readonly onRetryCatalogue: () => void;
  /** Loads the areas of a provider, once. Reads only; it persists nothing. */
  readonly onRequestAreas: (providerId: string) => void;
  readonly onRetryAreas: (providerId: string) => void;
  /** Rendered under the district list, inside the same section — the surface's confirm control, for example. */
  readonly children?: ReactNode;
}

const FIELD =
  'mt-2 min-h-11 w-full rounded-ar-md border border-ar-border bg-ar-surface-muted px-3.5 py-3 text-sm font-medium text-ar-text outline-none transition focus:border-ar-brand focus:ring-3 focus:ring-ar-brand-soft motion-reduce:transition-none';

const RETRY =
  'mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-ar-md border border-ar-border bg-ar-surface px-3.5 py-2 text-sm font-semibold text-ar-text transition hover:border-ar-text-muted focus-visible:outline-ar-focus motion-reduce:transition-none';

const Pending = ({ children }: { readonly children: ReactNode }) => (
  <p className="mt-2 flex items-center gap-2 text-sm text-ar-text-muted">
    <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
    {children}
  </p>
);

const Failed = ({
  message,
  retryLabel,
  onRetry,
}: {
  readonly message: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}) => (
  <>
    <p className="mt-2 text-sm text-ar-danger" role="alert">
      {message}
    </p>
    <button type="button" className={RETRY} onClick={onRetry}>
      <RotateCcw size={15} aria-hidden="true" />
      {retryLabel}
    </button>
  </>
);

export const AreaPicker = ({
  cities,
  catalogue,
  areaStateFor,
  initialCityId,
  initialProviderId,
  chosenAreaId,
  onChooseArea,
  onResetArea,
  onRetryCities,
  onRetryCatalogue,
  onRequestAreas,
  onRetryAreas,
  children,
}: AreaPickerProps) => {
  const { messages } = useCopy();
  const copy = messages.onboarding;
  const cityFieldId = useId();
  const providerFieldId = useId();
  const areaLabelId = useId();
  const unavailableHintId = useId();
  /** `true` once the person has changed a field, after which a late initial value is no longer adopted. */
  const [touched, setTouched] = useState(false);
  const [cityId, setCityId] = useState<string | null>(initialCityId);
  const [chosenProviderId, setChosenProviderId] = useState<string | null>(initialProviderId);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!touched) {
      setCityId(initialCityId);
      setChosenProviderId(initialProviderId);
    }
  }, [initialCityId, initialProviderId, touched]);

  const cityList: readonly CitySummary[] = cities.kind === 'loaded' ? cities.cities : [];
  const city = cityList.find((candidate) => candidate.id === cityId) ?? null;
  const providers = city === null ? [] : officialProvidersOf(city, catalogue);
  /**
   * The operator whose districts are shown: the only one, or the one chosen among several — and only ever one
   * the chosen city lists, so an identifier is never carried from one city into another.
   */
  const providerId =
    providers.length === 1
      ? (providers[0]?.id ?? null)
      : (providers.find((provider) => provider.id === chosenProviderId)?.id ?? null);
  /**
   * The chosen city's districts of that operator. An operator can serve more than one city, so its list is
   * narrowed by the city identifier the API gives each district — never by a locality's display name.
   */
  const areaState = areaStateFor(providerId);
  const areas = areasOf(areaState, providerId).filter((area) => area.cityId === cityId);

  /**
   * Asks for the operator's districts whenever the state on hand is about someone else.
   *
   * It cannot loop: once asked, the state names this operator whatever the answer, and a failure is retried only
   * by the person, through the panel's own control.
   */
  useEffect(() => {
    if (providerId !== null && areaStateProviderId(areaState) !== providerId) {
      onRequestAreas(providerId);
    }
  }, [areaState, providerId, onRequestAreas]);

  /**
   * The one option `Tab` reaches: the chosen district, or the first selectable one before anything is chosen.
   *
   * Computed from the rendered list rather than held in state, so it cannot disagree with what is on screen
   * after the districts change — a different city, a retry that answered, a filtered list.
   */
  const tabStopIndex = (() => {
    const chosen = areas.findIndex((area) => area.id === chosenAreaId);

    if (chosen !== -1) {
      return chosen;
    }

    return areas.findIndex((area) => area.collectionEvents.availability !== 'unavailable');
  })();

  /**
   * The arrow keys, `Home` and `End` inside the list.
   *
   * Moves focus over the options that are actually focusable — a `disabled` option is skipped by the DOM query
   * itself rather than by a rule repeated here — and stops at both ends instead of wrapping, so holding an
   * arrow key cannot carry someone from the last district back to the first without them noticing.
   */
  const moveWithinList = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];

    if (!keys.includes(event.key)) {
      return;
    }

    const options = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
    ];
    const current = options.indexOf(document.activeElement as HTMLButtonElement);

    if (options.length === 0) {
      return;
    }

    const next = (() => {
      switch (event.key) {
        case 'Home':
          return 0;
        case 'End':
          return options.length - 1;
        case 'ArrowUp':
        case 'ArrowLeft':
          return Math.max(0, current - 1);
        default:
          return current === -1 ? 0 : Math.min(options.length - 1, current + 1);
      }
    })();

    // Only once the move is real: the page must keep its own scrolling when focus is already at the end.
    if (next === current) {
      return;
    }

    event.preventDefault();
    options[next]?.focus();
  };

  const chooseCity = (next: string) => {
    setTouched(true);
    setCityId(next === '' ? null : next);
    setChosenProviderId(null);
    onResetArea();
  };

  const chooseProvider = (next: string) => {
    setTouched(true);
    setChosenProviderId(next === '' ? null : next);
    onResetArea();
  };

  const providerStep = (): ReactNode => {
    if (city === null) {
      return null;
    }

    if (catalogue.kind === 'loading') {
      return <Pending>{copy.providersLoading}</Pending>;
    }

    if (catalogue.kind === 'failed') {
      return (
        <Failed
          message={copy.providersFailed}
          retryLabel={copy.retryProviders}
          onRetry={onRetryCatalogue}
        />
      );
    }

    if (providers.length === 0) {
      return <p className="mt-3 text-sm text-ar-text-muted">{copy.noProviders}</p>;
    }

    if (providers.length === 1) {
      return (
        <p className="mt-3 text-sm text-ar-text-muted" data-testid="single-provider">
          {copy.provider}: <span className="font-medium text-ar-text">{providers[0]?.name}</span>
        </p>
      );
    }

    return (
      <>
        <label className="mt-4 block text-sm font-semibold" htmlFor={providerFieldId}>
          {copy.provider}
        </label>
        <select
          id={providerFieldId}
          className={FIELD}
          value={providerId ?? ''}
          onChange={(event) => chooseProvider(event.target.value)}
        >
          <option value="" disabled>
            {copy.choose}
          </option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
      </>
    );
  };

  return (
    <section className="mt-4 rounded-ar-xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
      <label className="flex items-center gap-2 text-sm font-semibold" htmlFor={cityFieldId}>
        <MapPin size={17} className="text-ar-brand" aria-hidden="true" />
        {copy.city}
      </label>
      <select
        id={cityFieldId}
        className={FIELD}
        value={city?.id ?? ''}
        disabled={cityList.length === 0}
        onChange={(event) => chooseCity(event.target.value)}
      >
        <option value="" disabled>
          {copy.choose}
        </option>
        {cityList.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.name}
          </option>
        ))}
      </select>

      {cities.kind === 'loading' && <Pending>{copy.citiesLoading}</Pending>}
      {cities.kind === 'failed' && (
        <Failed message={copy.citiesFailed} retryLabel={copy.retryCities} onRetry={onRetryCities} />
      )}
      {cities.kind === 'loaded' && cityList.length === 0 && (
        <p className="mt-2 text-sm text-ar-text-muted">{copy.noCities}</p>
      )}

      {providerStep()}

      {providerId !== null && (
        <>
          {/* Every district-request state, including the failure and its retry. */}
          <AreaStatePanel
            state={areaState}
            providerId={providerId}
            shownCount={areas.length}
            onRetry={onRetryAreas}
          />

          {areas.length > 0 && (
            <>
              <p className="mt-4 text-sm font-semibold" id={areaLabelId}>
                {copy.district}
              </p>
              <p className="sr-only" id={unavailableHintId}>
                {messages.districts.unavailableHint}
              </p>
              {/*
                One tab stop for the whole list, and the arrow keys to move inside it.

                An operator publishes thirty-four districts. As a list of ordinary buttons, every one of them
                was a tab stop, so choosing the first district and then reaching the confirmation below meant
                pressing Tab past the thirty-two that were left. The list is a single choice, so it is a
                listbox: `Tab` enters it once — at the chosen district, or at the first one when nothing is
                chosen yet — the arrows, `Home` and `End` move within it, and the next `Tab` leaves it for the
                action that acts on the choice.

                Focus moves; it does not choose. Selection stays something a person does with `Enter`, `Space`
                or a pointer, because arrowing past a district is looking at it rather than picking it. The
                options are still real `disabled` buttons, so an unavailable district is inert to pointer and
                keyboard alike and the arrows step over it.
              */}
              {/*
                A `div`, not a `ul`: `role="listbox"` replaces list semantics anyway, and the options are
                the group's own children rather than list items wrapped in a role that says nothing.
              */}
              <div
                className="mt-2 flex flex-col gap-2"
                aria-labelledby={areaLabelId}
                onKeyDown={moveWithinList}
                ref={listRef}
                role="listbox"
              >
                {areas.map((area, index) => {
                  const isUnavailable = area.collectionEvents.availability === 'unavailable';
                  const isChosen = area.id === chosenAreaId;

                  return (
                    <button
                      key={area.id}
                      type="button"
                      // Genuinely disabled: not operable by pointer or keyboard, out of the tab order, and
                      // announced as unavailable. Appearance is never the mechanism.
                      disabled={isUnavailable}
                      role="option"
                      aria-selected={isChosen}
                      aria-describedby={isUnavailable ? unavailableHintId : undefined}
                      /*
                        The roving tab stop. Exactly one option is reachable by `Tab`, and `scroll-mb`
                        keeps a focused option clear of the sticky action area a surface may put below.
                      */
                      tabIndex={index === tabStopIndex ? 0 : -1}
                      className={[
                        'flex min-h-11 w-full scroll-mb-28 items-start gap-2 rounded-ar-md border px-3.5 py-3 text-start transition focus-visible:outline-ar-focus motion-reduce:transition-none',
                        isChosen
                          ? 'border-ar-brand bg-ar-brand-soft text-ar-text'
                          : 'border-ar-border bg-ar-surface text-ar-text',
                        isUnavailable ? 'cursor-not-allowed opacity-70' : '',
                      ].join(' ')}
                      onClick={() => onChooseArea(area)}
                    >
                      {isChosen && (
                        <Check size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1">
                        {/* Whole and wrapping: districts are often told apart only at the end. */}
                        <span className="block break-words text-sm font-semibold">{area.name}</span>
                        {isUnavailable && (
                          // Visible and explanatory rather than hidden: hiding it would imply the
                          // municipality does not serve the district, which is a different claim.
                          <span className="mt-0.5 block text-xs text-ar-text-muted">
                            {messages.districts.unavailable}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {children}
    </section>
  );
};
