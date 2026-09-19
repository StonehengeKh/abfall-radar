import { ArrowLeft, Check } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { City, Provider, ServiceArea } from '@/src/adapters/schedule-gateway';
import { PageHeadingRow } from '@/src/app/page-heading';
import { PAGE_INTRO } from '@/src/app/typography';
import { CityIllustration } from '@/src/features/selection/city-illustration';
import type { AppController } from '@/src/hooks/app-controller';
import { useLocale } from '@/src/i18n/context';
import type { NeedsSelectionStep } from '@/src/schedule/view-state';

/**
 * The two explicit selection steps.
 *
 * Nothing is preselected, an unavailable area is a **native disabled** control — skipped by sequential
 * `Tab`, inert to click, Enter, and Space — and no area request confirms anything on the person's
 * behalf. Every control meets the 44 by 44 CSS pixel target.
 */

const CONTROL = 'min-h-11 min-w-11 rounded-ar-md px-4 py-2 text-left transition-colors';

/** A generous, full-width row: the whole strip is the target, not a label inside it. */
const CHOICE =
  'flex min-h-12 w-full items-center justify-between gap-3 rounded-ar-md border border-ar-border bg-ar-surface px-4 py-2.5 text-start text-ar-text transition-colors motion-reduce:transition-none';

/** The city and provider steps are short lists, so their rows keep the plain hover treatment. */
const ROW = `${CHOICE} hover:border-ar-brand hover:bg-ar-surface-muted`;

/**
 * Secondary navigation, at the start of the content rather than after it.
 *
 * Restrained on purpose: an arrow and a word, no filled surface. It is the same `controller.back()` the
 * step has always called — only its position changed — so draft handling, cancellation and the focus
 * the controller restores are untouched.
 */
const BackAction = ({ onBack, label }: { readonly onBack: () => void; readonly label: string }) => (
  <button
    className={`${CONTROL} inline-flex min-h-11 items-center gap-1.5 border border-ar-border bg-ar-surface px-3 text-sm text-ar-text-muted hover:bg-ar-surface-muted hover:text-ar-text motion-reduce:transition-none`}
    data-testid="back-action"
    onClick={onBack}
    type="button"
  >
    <ArrowLeft aria-hidden="true" size={16} />
    {label}
  </button>
);

const Spinner = ({ label }: { readonly label: string }) => (
  <p className="text-ar-text-muted" role="status">
    {label}
  </p>
);

export const SelectionSurface = ({
  selection,
  notice,
  canReturnToSchedule,
  controller,
}: {
  readonly selection: NeedsSelectionStep;
  readonly notice: 'provider_invalidated' | 'area_unavailable' | null;
  readonly canReturnToSchedule: boolean;
  readonly controller: AppController;
}) => {
  const { messages } = useLocale();

  return (
    <section className="flex flex-col gap-4">
      {/*
        Back rides the heading row, exactly as "change selection" does on the schedule. The provider
        step has one too — while it loads and while it asks for a new choice after a recovery — because
        the city is the step before it and there is no other way back to it.
      */}
      <PageHeadingRow
        action={
          selection.step === 'area' || selection.step === 'provider' ? (
            <BackAction label={messages.actions.back} onBack={() => controller.back()} />
          ) : undefined
        }
        heading={messages.states.needs_selection.heading}
        id="selection-heading"
      />
      <p className={PAGE_INTRO}>{messages.states.needs_selection.body}</p>

      {notice === null ? null : (
        <p className="rounded-ar-md border border-ar-border bg-ar-surface-muted p-3 text-ar-text">
          {messages.notices[notice]}
        </p>
      )}

      {selection.step === 'city' ? (
        <CityStep cities={selection.cities} controller={controller} />
      ) : selection.step === 'provider' ? (
        <ProviderStep catalogue={selection.catalogue} controller={controller} />
      ) : (
        <AreaStep step={selection} controller={controller} />
      )}

      {canReturnToSchedule ? (
        <p className="text-sm text-ar-text-muted">{messages.steps.retained}</p>
      ) : null}
    </section>
  );
};

const CityStep = ({
  cities,
  controller,
}: {
  readonly cities: 'loading' | readonly City[];
  readonly controller: AppController;
}) => {
  const { messages } = useLocale();

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium text-ar-text" id="city-heading" tabIndex={-1}>
        {messages.steps.city}
      </h3>
      {cities === 'loading' ? (
        <Spinner label={messages.steps.cityLoading} />
      ) : (
        <ul className="flex flex-col gap-2">
          {cities.map((city) => (
            <li key={city.id}>
              <button
                className={ROW}
                data-city-id={city.id}
                data-testid="city-choice"
                onClick={() => controller.selectCity(city.id)}
                type="button"
              >
                {city.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const ProviderStep = ({
  catalogue,
  controller,
}: {
  readonly catalogue: 'loading' | readonly Provider[];
  readonly controller: AppController;
}) => {
  const { messages } = useLocale();

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium text-ar-text" id="provider-heading" tabIndex={-1}>
        {messages.steps.provider}
      </h3>
      {catalogue === 'loading' ? (
        <Spinner label={messages.steps.providerLoading} />
      ) : (
        <ul className="flex flex-col gap-2">
          {catalogue.map((provider) => (
            <li key={provider.id}>
              <button
                className={ROW}
                data-provider-id={provider.id}
                data-testid="provider-choice"
                onClick={() => controller.selectProvider(provider.id)}
                type="button"
              >
                {provider.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const AreaStep = ({
  step,
  controller,
}: {
  readonly step: Extract<NeedsSelectionStep, { step: 'area' }>;
  readonly controller: AppController;
}) => {
  const { messages } = useLocale();
  const [query, setQuery] = useState('');
  const searchId = useId();
  const areas = step.areas === 'loading' ? [] : step.areas;
  /*
   * Search appears only when a list is long enough to need it. The operator publishes 34 districts for
   * Koblenz, which is well past scanning; a city with a handful would only gain a control to ignore.
   */
  const searchable = areas.length > 8;
  const needle = query.trim().toLocaleLowerCase();
  const shown =
    needle === '' ? areas : areas.filter((area) => area.name.toLocaleLowerCase().includes(needle));

  return (
    <div className="flex flex-col gap-3">
      {/*
        The city, before the districts. It answers "where am I choosing in" without a person having to
        infer it from the district names, and it is the catalogue's own name for the city — the
        illustration beside it is decoration and carries no meaning of its own.

        No card around it: it introduces the search and the grid below rather than being another thing
        beside them, so it sits directly on the page ground and lines up with their left edge.
      */}
      <div className="flex items-center gap-3 sm:gap-4" data-testid="city-intro">
        <CityIllustration className="h-12 w-20 shrink-0 text-ar-brand sm:h-14 sm:w-24" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3
            className="text-lg leading-tight font-semibold break-words tracking-tight text-ar-text sm:text-xl"
            id="area-heading"
            tabIndex={-1}
          >
            {step.city.name}
          </h3>
          <p className="text-sm break-words text-ar-text-muted">{messages.steps.selectDistrict}</p>
          <p className="text-xs break-words text-ar-text-muted">
            {messages.steps.area(step.provider.name)}
          </p>
        </div>
      </div>

      {step.areas === 'loading' ? (
        <Spinner label={messages.steps.areaLoading} />
      ) : (
        <>
          {searchable ? (
            <div className="flex flex-col gap-1">
              <label className="sr-only" htmlFor={searchId}>
                {messages.schedule.searchDistricts}
              </label>
              <input
                autoComplete="off"
                className="min-h-11 rounded-ar-md border border-ar-border bg-ar-surface px-3 text-ar-text placeholder:text-ar-text-muted"
                id={searchId}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={messages.schedule.searchDistricts}
                type="search"
                value={query}
              />
            </div>
          ) : null}
          {/*
            The count is a live status: it is what tells someone typing in the search field that the
            grid below changed, and by how much, without them having to count cards.
          */}
          <p className="text-xs text-ar-text-muted" data-testid="district-count" role="status">
            {messages.schedule.districtCount(shown.length, areas.length)}
          </p>

          {shown.length === 0 ? (
            <p className="text-sm text-ar-text-muted">{messages.schedule.noMatches}</p>
          ) : (
            /*
             * A responsive grid, not a fixed-height scroll box. One column on a narrow phone, two from
             * the small breakpoint and three from the large one, and the page itself scrolls — a nested
             * scroller hides how many districts there are and traps a trackpad gesture inside a card
             * list that is not the main content.
             */
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((area) => (
                <AreaChoice
                  area={area}
                  key={area.id}
                  onConfirm={() => controller.confirmArea(area.id)}
                  onSelect={() => controller.selectArea(area.id)}
                  selected={step.draftAreaId === area.id}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmBar
        /* The draft, not whatever the search happens to show: filtering never unselects anything. */
        draft={areas.find((candidate) => candidate.id === step.draftAreaId) ?? null}
        onConfirm={() => controller.confirm()}
      />
    </div>
  );
};

/**
 * The confirmation bar: what is selected, and the one control that acts on it.
 *
 * `position: sticky` rather than `fixed`, which is what keeps the page honest. The bar holds its own
 * place at the end of the list, so the last district, its explanation and the footer are never hidden
 * behind it once the page is scrolled to the bottom — it simply rides the viewport edge on the way
 * there. Natural page scrolling is untouched and nothing reserves space that has to be cleaned up.
 *
 * It publishes its measured height so the floating scroll-to-top button can sit above it instead of on
 * top of the confirm button, and it takes that back when it unmounts.
 */
const ConfirmBar = ({
  draft,
  onConfirm,
}: {
  readonly draft: ServiceArea | null;
  readonly onConfirm: () => void;
}) => {
  const { messages } = useLocale();
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;

    if (bar === null) {
      return;
    }

    const publish = (): void => {
      document.documentElement.style.setProperty('--ar-action-bar', `${bar.offsetHeight}px`);
    };

    publish();

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);

    observer?.observe(bar);

    return () => {
      observer?.disconnect();
      document.documentElement.style.removeProperty('--ar-action-bar');
    };
  }, []);

  return (
    <div
      className="sticky bottom-0 z-20 -mx-4 mt-1 border-t border-ar-border bg-ar-canvas/95 px-4 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom,0px))] backdrop-blur sm:-mx-6 sm:px-6"
      data-testid="confirm-bar"
      ref={barRef}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 text-sm" data-testid="confirm-summary">
          {draft === null ? (
            <span className="text-ar-text-muted">{messages.steps.noneSelected}</span>
          ) : (
            <>
              <span className="text-ar-text-muted">{messages.steps.selected}: </span>
              <span className="font-medium break-words text-ar-text">{draft.name}</span>
            </>
          )}
        </p>
        {/* Full width when the row has to stack, which is a narrow screen or a long translation. */}
        <button
          className={`${CONTROL} w-full grow bg-ar-brand text-center text-ar-on-brand hover:bg-ar-brand-strong disabled:opacity-60 sm:w-auto sm:grow-0`}
          data-testid="confirm-selection"
          disabled={draft === null}
          onClick={onConfirm}
          type="button"
        >
          {messages.actions.confirm}
        </button>
      </div>
    </div>
  );
};

const AreaChoice = ({
  area,
  onSelect,
  onConfirm,
  selected,
}: {
  readonly area: ServiceArea;
  readonly onSelect: () => void;
  /** The double-click shortcut: optional, and never the only way to confirm. */
  readonly onConfirm: () => void;
  readonly selected: boolean;
}) => {
  const { messages } = useLocale();
  const unavailable = area.collectionEvents.availability === 'unavailable';
  const explanationId = `${area.id}-explanation`;

  return (
    <li className="flex flex-col">
      <button
        aria-describedby={unavailable ? explanationId : undefined}
        aria-pressed={selected}
        className={`${CHOICE} ${
          selected
            ? 'border-ar-brand bg-ar-brand-soft font-medium'
            : 'hover:border-ar-brand hover:bg-ar-surface-muted'
        } disabled:cursor-not-allowed disabled:border-dashed disabled:bg-ar-surface disabled:text-ar-text-muted disabled:hover:border-dashed disabled:hover:border-ar-border disabled:hover:bg-ar-surface`}
        data-testid="area-choice"
        // Native `disabled`: skipped by sequential Tab, exposed to the accessibility tree, and inert.
        disabled={unavailable}
        onClick={onSelect}
        // A shortcut for a pointer, never a requirement: the visible confirm button below stays the
        // documented path, and keyboard and touch use it unchanged.
        onDoubleClick={onConfirm}
        type="button"
      >
        <span className="min-w-0 truncate">{area.name}</span>
        {selected ? (
          <Check aria-hidden="true" className="shrink-0 text-ar-brand" size={17} />
        ) : null}
      </button>
      {unavailable ? (
        <p className="px-4 pt-1 text-xs text-ar-text-muted" id={explanationId}>
          {messages.steps.areaUnavailable}
        </p>
      ) : null}
    </li>
  );
};
