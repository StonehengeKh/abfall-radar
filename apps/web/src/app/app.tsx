import { BrandMark, BrandName } from '@abfall-radar/ui';
import { ArrowUp, MapPin } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { announcementMessage, failureMessage, supportIdentifier } from '@/src/app/copy';
import { useFloatingControlClearance } from '@/src/app/floating-control';
import { PageHeadingRow } from '@/src/app/page-heading';
import { PAGE_INTRO } from '@/src/app/typography';
import { AppearanceControl, LanguageControl } from '@/src/features/appearance/appearance-controls';
import { HouseholdPanel } from '@/src/features/household/household-panel';
import { ScheduleSurface } from '@/src/features/schedule/schedule-surface';
import { SelectionSurface } from '@/src/features/selection/selection-surface';
import type {
  AppController,
  FocusRequest,
  FocusTarget,
  Snapshot,
} from '@/src/hooks/app-controller';
import { resolveGateway, useAppController } from '@/src/hooks/use-app-controller';
import { useHouseholdSchedule } from '@/src/hooks/use-household-schedule';
import { useLocale } from '@/src/i18n/context';
import type { Messages } from '@/src/i18n/messages';
import type { AppViewState, RecoveryFailure } from '@/src/schedule/view-state';

/**
 * The application shell: one live region, one focus manager, and one surface per top-level state.
 *
 * Mobile-first and fluid from 320 px. No component decides a state — each renders the one the
 * controller published — and no component decides a date: the schedule surface is handed one that was
 * already derived in the provider's zone.
 */

const CONTROL = 'min-h-11 min-w-11 rounded-ar-md px-4 py-2 transition-colors';

const PRIMARY = `${CONTROL} bg-ar-brand text-ar-on-brand hover:bg-ar-brand-strong`;

const SECONDARY = `${CONTROL} border border-ar-border bg-ar-surface text-ar-text hover:bg-ar-surface-muted`;

const FOCUS_SELECTOR: Record<Exclude<FocusTarget, 'provider-choice' | 'city-choice'>, string> = {
  'city-step': '#city-heading',
  'provider-step': '#provider-heading',
  'area-step': '#area-heading',
  'schedule-heading': '#main-heading',
  'state-heading': '#main-heading',
};

/** Matches one rendered choice by its own identity, never by position in the list. */
const choiceWithIdentity = (testId: string, attribute: string, value: string): Element | null =>
  Array.from(document.querySelectorAll(`[data-testid="${testId}"]`)).find(
    (choice) => choice.getAttribute(attribute) === value,
  ) ?? null;

const focusElement = (focus: FocusRequest): Element | null => {
  if (focus.target === 'provider-choice') {
    return choiceWithIdentity('provider-choice', 'data-provider-id', focus.providerId);
  }

  if (focus.target === 'city-choice') {
    return choiceWithIdentity('city-choice', 'data-city-id', focus.cityId);
  }

  return document.querySelector(FOCUS_SELECTOR[focus.target]);
};

/** Moves focus to the destination the controller named, never onto an unmounted element. */
const useFocusManagement = (focus: Snapshot['focus']): void => {
  const applied = useRef(-1);

  useEffect(() => {
    if (focus === null || applied.current === focus.seq) {
      return;
    }

    applied.current = focus.seq;
    const target = focusElement(focus);

    if (target instanceof HTMLElement && !target.hasAttribute('disabled')) {
      target.focus();
    }
  }, [focus]);
};

const Diagnostic = ({
  label,
  identifier,
}: {
  readonly label: string;
  readonly identifier: string | null;
}) =>
  identifier === null ? null : (
    <p className="text-sm text-ar-text-muted">
      {label}: <code>{identifier}</code>
    </p>
  );

const RecoveryDiagnostic = ({
  failure,
  messages,
}: {
  readonly failure: RecoveryFailure;
  readonly messages: Messages;
}) => (
  <>
    <p className="text-ar-text-muted">
      {messages.diagnostics.lastRecoveryFailed}: {failureMessage(messages, failure.failure)}
    </p>
    <Diagnostic
      identifier={supportIdentifier(failure.failure)}
      label={messages.diagnostics.recoveryIdentifier}
    />
  </>
);

/**
 * The header location's typography, stated once and applied in both states.
 *
 * Every property the two states could differ on is written out — size, weight, line height, tracking —
 * because they *did* differ: an unlayered `button { font: inherit }` in the shared stylesheet was
 * beating the utilities on the interactive one, so the same label rendered at 12 px as a `<span>` and at
 * 16 px as a `<button>`. That reset now lives in `@layer base`, and this constant keeps the two from
 * drifting apart again for any other reason.
 */
const PLACE_TEXT = 'text-xs leading-snug font-normal tracking-normal text-ar-text-muted';

/**
 * The location row's **geometry**, shared by the static label and the interactive one.
 *
 * Both variants need the same box, not just the same type: when only one of them carried padding, the
 * whole brand group — mark, wordmark and location — changed height at the moment a district was
 * confirmed, and the header visibly jumped.
 *
 * The box hugs its text with symmetric padding and no minimum height. A minimum height here used to add
 * 11.5 px of dead space *below* the text inside a top-aligned box, which centred the wrapper while
 * leaving the words themselves 7.5 px above the header's middle. The 44 px touch target comes from the
 * `::after` overlay on the interactive variant instead, which adds nothing to the layout.
 */
const PLACE_ROW = `-ms-1.5 flex min-w-0 items-start gap-1 rounded-ar-sm px-1.5 py-1 text-start ${PLACE_TEXT}`;

const PLACE_ICON_SIZE = 13;

/** True when the current view still has a selection the person can change. */
const canChangeSelection = (view: AppViewState): boolean =>
  view.kind === 'loading' ||
  view.kind === 'live' ||
  view.kind === 'empty' ||
  view.kind === 'range_not_covered' ||
  (view.kind === 'error' && view.context.phase === 'schedule_pipeline');

const Actions = ({
  view,
  controller,
  messages,
}: {
  readonly view: AppViewState;
  readonly controller: AppController;
  readonly messages: Messages;
}) => {
  const retryable =
    view.kind === 'error' ||
    view.kind === 'range_not_covered' ||
    view.kind === 'no_official_providers' ||
    view.kind === 'no_service_areas';
  /*
   * Back wherever a chosen city stands behind the surface: an empty or failed district read, and the
   * provider step's own empty and failed presentations. Without a city there is nothing to go back to,
   * so a failed or empty *city* read offers Retry alone.
   */
  const showBack =
    view.kind === 'no_service_areas' ||
    (view.kind === 'no_official_providers' && view.draftCityId !== null) ||
    (view.kind === 'error' && view.context.phase === 'selection_areas') ||
    (view.kind === 'error' &&
      view.context.phase === 'selection_providers' &&
      view.context.failure.operation === 'listProviders');

  if (!retryable && !showBack) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {retryable ? (
        <button className={PRIMARY} onClick={() => controller.retry()} type="button">
          {messages.actions.retry}
        </button>
      ) : null}
      {showBack ? (
        <button className={SECONDARY} onClick={() => controller.back()} type="button">
          {messages.actions.back}
        </button>
      ) : null}
    </div>
  );
};

/** The city and district the current view is about, when the view knows them. */
const currentPlace = (
  view: AppViewState,
): { readonly city: string; readonly area: string | null } | null => {
  if (view.kind === 'live' || view.kind === 'empty') {
    return {
      city: view.schedule.meta.serviceArea.locality,
      area: view.schedule.meta.serviceArea.name,
    };
  }

  if (view.kind === 'loading') {
    return { city: view.label.city, area: view.label.area };
  }

  if (view.kind === 'needs_selection' && view.selection.step !== 'city') {
    return { city: view.selection.city.name, area: null };
  }

  if (view.kind === 'no_service_areas') {
    return { city: view.city.name, area: null };
  }

  return null;
};

/**
 * Where the person is, and the way back to changing it.
 *
 * The place is source-authored text — the operator's own city and district naming — so it is reproduced
 * as published in every language, in full. It is never truncated to an ellipsis: a district is how
 * somebody confirms they are looking at their own schedule, and "Karthause 1" and "Karthause 2" differ
 * in the character an ellipsis would eat first. It wraps instead.
 *
 * When the selection can be changed it **is** the existing change-selection action rather than a new
 * one — the same `controller.changeSelection()` the button below the schedule calls — and when it
 * cannot, it stays plain text instead of offering an action that would do nothing.
 */
const HeaderPlace = ({
  place,
  view,
  controller,
}: {
  readonly place: { readonly city: string; readonly area: string | null };
  readonly view: AppViewState;
  readonly controller: AppController;
}) => {
  const { messages } = useLocale();
  const label = place.area === null ? place.city : `${place.city} · ${place.area}`;
  /*
   * City and district are two facts, so the line breaks between them before it breaks inside either:
   * the city keeps its separator on one line, and only the district wraps — by word where it can, and
   * inside a word only when a single word is wider than the column, which is what `break-words` means.
   */
  const content = (
    <>
      <MapPin aria-hidden="true" className="mt-px shrink-0" size={PLACE_ICON_SIZE} />
      <span className="min-w-0 break-words">
        {place.area === null ? (
          place.city
        ) : (
          <>
            <span className="whitespace-nowrap">{place.city} ·</span> <span>{place.area}</span>
          </>
        )}
      </span>
    </>
  );

  if (!canChangeSelection(view)) {
    return (
      <span className={PLACE_ROW} data-testid="header-place">
        {content}
      </span>
    );
  }

  return (
    <button
      aria-label={`${messages.actions.changeSelection}: ${label}`}
      /*
       * Compact in the header, full-size to a finger: the visible line is one text row under the
       * wordmark — 24.5 px with its padding — and a `::after` overlay adds 10 px above and below for a
       * 44 px target. It grows vertically only, and the two header controls are far to the right, so no
       * two targets meet.
       *
       * `inset-x-0` is not optional. An absolutely positioned pseudo-element with no content and only
       * `inset-block` set shrinks to zero width, so without it the overlay existed, measured 44 px tall,
       * and caught no clicks at all — which only real hit-testing revealed.
       */
      className={`relative transition-colors after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] hover:bg-ar-surface-muted hover:text-ar-text motion-reduce:transition-none ${PLACE_ROW}`}
      data-testid="header-place"
      onClick={() => controller.changeSelection()}
      type="button"
    >
      {content}
    </button>
  );
};

/**
 * The wordmark.
 *
 * One brand name, set in the product font, with the second half carrying the accent: "Radar" is what the
 * product does, and the accent is the theme's own brand colour, which both palettes already hold to AA
 * against the canvas. The two spans are adjacent with no whitespace between them, so the accessible name
 * stays the single word "AbfallRadar" rather than two.
 */
const Wordmark = () => (
  <h1
    /*
     * `py-1` mirrors the location row below it, and `leading-snug` gives this line the same
     * proportional half-leading that one has. Both together are what put the *ink* — not just the
     * boxes — in the middle of the header: with `leading-none` here the glyphs sat 1.75 px high,
     * because only the line below reserved space above and under its own characters.
     */
    className="py-1 text-[0.95rem] font-semibold leading-snug tracking-tight text-ar-text"
    id="app-title"
    tabIndex={-1}
  >
    <BrandName />
  </h1>
);

/**
 * The header: the mark, the name with where the person is under it, and the two controls.
 *
 * One row at every width. The brand group is the only flexible column, so the controls sit against the
 * far right edge of the same 1120 px container on every screen — including the first one, where there is
 * no place yet. Nothing is invented to fill that space: the group simply carries one line instead of two.
 */
/**
 * The largest share of the viewport height a sticky header may take.
 *
 * Above it the header stops being sticky and scrolls away with the page, so enlarged text can never leave
 * the schedule underneath a header that fills the screen. At normal text size a phone header is well
 * inside this — the longest published district name at 320 px measures under a fifth of the height.
 */
const STICKY_HEADER_MAX_SHARE = 1 / 3;

/**
 * Whether the header is still small enough to stay pinned while the page scrolls.
 *
 * Measured, not inferred from a breakpoint: what makes a header too tall is the combination of text size,
 * name length, width and viewport height, and none of them alone predicts it. Switching between sticky
 * and static does not change the header's own height, so the measurement cannot oscillate.
 */
const useHeaderFitsSticky = (header: React.RefObject<HTMLElement | null>): boolean => {
  const [fits, setFits] = useState(true);

  useLayoutEffect(() => {
    const element = header.current;

    if (element === null) {
      return;
    }

    const root = document.documentElement;

    const measure = (): void => {
      const pinned = element.offsetHeight <= window.innerHeight * STICKY_HEADER_MAX_SHARE;

      setFits(pinned);
      /*
       * While pinned, the header covers the top of the viewport, and a control focused with Shift+Tab
       * would be scrolled into view underneath it. Its height is published for `scroll-padding-top`
       * (see `styles.css`) — and only while it is pinned, because a header that scrolls away hides
       * nothing.
       */
      root.style.setProperty('--ar-sticky-header', pinned ? `${element.offsetHeight}px` : '0px');
    };

    measure();
    window.addEventListener('resize', measure);

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);

    observer?.observe(element);

    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      root.style.removeProperty('--ar-sticky-header');
    };
  }, [header]);

  return fits;
};

const Header = ({
  view,
  controller,
}: {
  readonly view: AppViewState;
  readonly controller: AppController;
}) => {
  const place = currentPlace(view);
  const headerRef = useRef<HTMLElement>(null);
  const sticky = useHeaderFitsSticky(headerRef);

  return (
    <header
      className={`${sticky ? 'sticky top-0' : 'relative'} z-20 border-b border-ar-border bg-ar-canvas/95 px-4 py-2.5 backdrop-blur sm:px-6`}
      data-sticky={sticky}
      ref={headerRef}
    >
      {/*
        `flex-wrap` is the release valve for enlarged text: when the brand group can no longer keep its
        usable width beside the two controls, the controls drop to a second line — right-aligned, still in
        the same container — instead of squeezing the group or pushing the page sideways.
      */}
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-2.5 gap-y-2 sm:gap-x-3">
        {/*
          The mark and its text travel as one unit with their own, tighter 8 px gap, so the name reads as
          belonging to the logo while the wider row gap still separates the brand from the controls.

          Both flexible parts have a basis in `rem`, which is what makes them respond to text size. At
          normal size neither basis is reached — the unit (11 rem) and its text column (9 rem) simply grow
          into the free space, exactly as before — so nothing moves. With enlarged text the bases outgrow
          the line: first the controls wrap below the unit, then the text column wraps below the mark,
          and a long district keeps whole words per line instead of collapsing to single characters.
        */}
        <div className="flex min-w-0 flex-[1_1_11rem] flex-wrap items-center gap-2">
          <BrandMark />

          {/*
            Name over location. No gap between the two lines: each carries its own symmetric padding,
            which is what keeps the group's visible text centred in its box rather than merely its
            wrapper.
          */}
          <div className="flex min-w-0 flex-[1_1_9rem] flex-col">
            <Wordmark />
            {place === null ? null : (
              <HeaderPlace controller={controller} place={place} view={view} />
            )}
          </div>
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-2">
          <LanguageControl />
          <AppearanceControl />
        </div>
      </div>
    </header>
  );
};

const Surface = ({
  view,
  controller,
}: {
  readonly view: AppViewState;
  readonly controller: AppController;
}) => {
  const { messages } = useLocale();
  const copy = messages.states[view.kind];
  /*
   * The optional household bins, alongside the controller rather than inside it: they are an opt-in
   * extra whose failure must leave the official schedule exactly as it is, so they have their own
   * request and their own state. Resolved once, because the origin cannot change while mounted.
   */
  const gateway = useMemo(() => resolveGateway(), []);
  const accepted = view.kind === 'live' || view.kind === 'empty' ? view.schedule : null;
  const household = useHouseholdSchedule({
    selection: accepted?.selection ?? null,
    range: accepted?.range ?? null,
    gateway,
  });

  if (view.kind === 'needs_selection') {
    return (
      <SelectionSurface
        canReturnToSchedule={view.canReturnToSchedule}
        controller={controller}
        notice={view.notice}
        selection={view.selection}
      />
    );
  }

  const standalone = view.kind !== 'live' && view.kind !== 'empty';

  return (
    <section
      className={
        standalone
          ? 'flex flex-col gap-3 rounded-ar-xl border border-ar-border bg-ar-surface p-5 shadow-ar-sm sm:p-6'
          : 'flex flex-col gap-4'
      }
    >
      <PageHeadingRow
        action={
          canChangeSelection(view) ? (
            <button
              className={`${SECONDARY} text-sm`}
              data-testid="change-selection"
              onClick={() => controller.changeSelection()}
              type="button"
            >
              {messages.actions.changeSelection}
            </button>
          ) : undefined
        }
        heading={copy.heading}
        id="main-heading"
      />
      <p className={PAGE_INTRO}>{copy.body}</p>

      {view.kind === 'error' ? (
        <div className="flex flex-col gap-2 rounded-ar-lg border border-ar-border bg-ar-surface p-4">
          <p className="text-ar-text">{failureMessage(messages, view.context.failure)}</p>
          <Diagnostic
            identifier={supportIdentifier(view.context.failure)}
            label={messages.diagnostics.identifier}
          />
        </div>
      ) : null}

      {view.kind === 'range_not_covered' ? (
        <div className="flex flex-col gap-2 rounded-ar-lg border border-ar-border bg-ar-surface p-4">
          <Diagnostic
            identifier={view.triggeringRangeProblem?.requestId ?? null}
            label={messages.diagnostics.rangeIdentifier}
          />
          {view.lastRecoveryFailure === undefined ? null : (
            <RecoveryDiagnostic failure={view.lastRecoveryFailure} messages={messages} />
          )}
        </div>
      ) : null}

      {view.kind === 'live' || view.kind === 'empty' ? (
        <>
          <ScheduleSurface
            /*
             * A transcription the operator has moved on from produces no dates at all. `changed` is the
             * one verification state that means "these would be plausible and wrong", so the collections
             * are withheld and the panel below says why.
             */
            household={
              household.state.status === 'ready' && household.state.rules.verification !== 'changed'
                ? household.state.schedule
                : null
            }
            schedule={view.schedule}
          />
          <HouseholdPanel
            onDisable={household.disable}
            onEnable={household.enable}
            onRetry={household.retry}
            state={household.state}
          />
        </>
      ) : null}

      <Actions controller={controller} messages={messages} view={view} />
    </section>
  );
};

/**
 * When a discreet way back to the top is worth showing, and when it would be in the way.
 *
 * Three conditions, all measured from the document rather than assumed: the page has to be long enough
 * to get lost in, the reader has to have travelled far enough for the top to be out of reach, and the
 * footer must not already be on screen — that is where the confirm and change-selection actions sit, and
 * a floating button must never land on top of them.
 */
const LONG_PAGE_PX = 640;

const SCROLLED_ENOUGH_PX = 400;

const useScrollToTopOffer = (): boolean => {
  const [offer, setOffer] = useState(false);

  useEffect(() => {
    const root = document.documentElement;

    const measure = (): void => {
      const footer = document.querySelector('footer');
      const footerTop = footer?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;

      setOffer(
        root.scrollHeight - root.clientHeight > LONG_PAGE_PX &&
          window.scrollY > SCROLLED_ENOUGH_PX &&
          footerTop > root.clientHeight,
      );
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });

    // Content can change height under a still viewport — filtering the district grid does exactly that.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());

    observer?.observe(document.body);

    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, []);

  return offer;
};

/**
 * A floating way back to the top: icon only, and outside the footer.
 *
 * Icon-only, so it is named for assistive technology instead of labelled on screen, and 44 by 44 so it
 * is still a target. It sits inside the safe area on a phone with a home indicator or rounded corners,
 * and it scrolls without animation when the reader has asked for reduced motion.
 */
const ScrollToTop = () => {
  const { messages } = useLocale();
  const offer = useScrollToTopOffer();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Offered or not follows the rules above; while offered, it also steps out of the way of anything it
  // would cover — visible text, a graphic, or the focused control and its focus ring.
  useFloatingControlClearance(buttonRef, offer);

  if (!offer) {
    return null;
  }

  const toTop = (): void => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    // Scrolling moves the page; focus has to follow it, or the next Tab resumes from the bottom.
    document.getElementById('app-title')?.focus();
  };

  return (
    <button
      aria-label={messages.footer.backToTop}
      /*
       * Above the district confirmation bar when there is one: that bar publishes its measured height as
       * `--ar-action-bar` while it is mounted, and removes the property when it goes, so this falls back
       * to the plain inset on every other screen without either of them knowing about the other.
       */
      className="fixed end-[calc(1rem+env(safe-area-inset-right,0px))] bottom-[calc(1rem+env(safe-area-inset-bottom,0px)+var(--ar-action-bar,0px))] z-30 flex h-11 w-11 items-center justify-center rounded-full border border-ar-border bg-ar-surface text-ar-text-muted shadow-ar-md transition-colors hover:bg-ar-surface-muted hover:text-ar-text motion-reduce:transition-none"
      data-testid="back-to-top"
      onClick={toTop}
      ref={buttonRef}
      title={messages.footer.backToTop}
      type="button"
    >
      <ArrowUp aria-hidden="true" size={18} />
    </button>
  );
};

/**
 * The page footer: who this is and what it does.
 *
 * In normal flow at the end of the shell, never fixed. On a page shorter than the viewport the shell's
 * flex column leaves it at the bottom; on a longer one it simply follows the content.
 */
const Footer = ({ view }: { readonly view: AppViewState }) => {
  const { messages } = useLocale();
  const place = currentPlace(view);

  return (
    <footer className="border-t border-ar-border px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight text-ar-text">
            Abfall<span className="text-ar-brand">Radar</span>
          </span>
        </div>
        <p className="min-w-0 break-words text-sm text-ar-text-muted">
          {messages.footer.description(place?.city ?? null)}
        </p>
      </div>
    </footer>
  );
};

/**
 * The shell: one viewport-height flex column, and content-driven children inside it.
 *
 * The viewport minimum lives **here**, on the outer shell, and nowhere else. It used to sit on `<main>`,
 * which made a content child viewport-tall: once the district grid reflowed from one column to three,
 * the content ended hundreds of pixels above the bottom of that box and the remainder read as dead
 * scrollable space below the cards. `flex-1` on `<main>` produces the same "fills a short page" effect
 * without giving any child a height of its own, and the footer now closes the page instead of nothing.
 */
export const AppShell = ({
  snapshot,
  controller,
}: {
  readonly snapshot: Snapshot;
  readonly controller: AppController;
}) => {
  const { messages } = useLocale();

  useFocusManagement(snapshot.focus);

  return (
    <div className="flex min-h-dvh flex-col">
      <Header controller={controller} view={snapshot.view} />

      {/*
        One polite live region announces every state change. The region element itself is stable, so an
        assistive technology observes it before anything changes; the inner node is keyed by the
        announcement sequence, so a message identical to the previous one is still a DOM change and is
        announced again rather than silently re-rendered.
      */}
      <p aria-live="polite" className="sr-only" data-testid="live-region">
        <span key={snapshot.announcement.seq}>{announcementMessage(messages, snapshot.view)}</span>
      </p>

      <main className="mx-auto w-full max-w-[1120px] flex-1 px-4 pb-8 pt-4 sm:px-6">
        <Surface controller={controller} view={snapshot.view} />
      </main>

      <Footer view={snapshot.view} />
      <ScrollToTop />
    </div>
  );
};

export const App = () => {
  const { snapshot, controller } = useAppController();

  return <AppShell controller={controller} snapshot={snapshot} />;
};
