import type { CollectionEvent, WasteType } from '@abfall-radar/domain';
import {
  deriveSourceToday,
  featuredCollection,
  formatCalendarDate,
  formatInstant,
  formatNameList,
  type HouseholdScheduleResult,
  listedCollections,
  orderEvents,
  toCollectionEvent,
} from '@abfall-radar/schedule-format';
import {
  CountdownPanelAt,
  EventRow,
  NextCollectionCard,
  ProvenanceCard,
  type ScheduleView as SharedScheduleView,
  useMinuteClock,
} from '@abfall-radar/ui';
import {
  AlertTriangle,
  CalendarOff,
  CircleSlash,
  CloudOff,
  History,
  Loader2,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { PopupHeader } from '@/src/features/shell/popup-header';
import { useCopy } from '@/src/i18n/copy';
import type { Messages } from '@/src/i18n/messages';
import type { SourceWindow } from '@/src/schedule/capability';
import {
  type CachedReason,
  type ScheduleView,
  undeclaredWasteTypes,
  visibleEvents,
} from '@/src/schedule/view-state';

/**
 * The schedule, as the popup presents it.
 *
 * The featured collection, the countdown, the event rows and the source details are the website's own
 * components from `@abfall-radar/ui`, fed from the extension's schedule, so a collection is worded, dated,
 * coloured and ordered the same in both places. What is the popup's own is everything around them: its
 * single-column layout for a 392 px window, and the states only an offline-capable extension has — a
 * restored schedule, why it is being shown, and which part of the requested period it actually covers.
 */

export interface DashboardViewProps {
  readonly view: ScheduleView;
  readonly visibleWasteTypes: WasteType[];
  readonly onOpenSettings: () => void;
  readonly onRetry: () => void;
  /**
   * The calculated household collections, when somebody has switched them on and the rules could be read.
   *
   * `null` in every other case — off, unreadable, or a transcription the operator has moved on from — and
   * the schedule then renders exactly as it did before them.
   */
  readonly household?: HouseholdScheduleResult | null;
  /**
   * What the popup must say about those calculated collections, or `null` when there is nothing to say.
   *
   * Built by the composition root, which holds the rules: where the published rules stop, whether they
   * could be checked, and whether the operator has moved on from the transcription. Shown beside the
   * schedule rather than buried in Settings, because it qualifies the dates on this screen.
   */
  readonly householdNotice?: string | null;
  /**
   * What is known about the *checking* of those rules, shown whenever the rules were read at all.
   *
   * Deliberately not restricted to the states that went wrong. A calculated date is only as good as two
   * separate things — an automatic check of the published documents, and a person reading the operator's
   * later announcements — and somebody looking at a schedule that is working needs both facts exactly as
   * much as somebody looking at one that is not. Withholding them while everything succeeded would leave
   * the successful state as the one state that never says what it is standing on.
   *
   * The composition root builds the lines, because it is what holds the rules.
   */
  readonly householdProvenance?: readonly string[];
  /** A fixed instant, for tests. Omitted, the popup's minute clock is used. */
  readonly referenceDate?: Date;
  /**
   * The main region, exposed so a caller can move focus here after a screen transition.
   *
   * Attached to `<main>` in **every** state this view can render, because the state on arrival is whichever
   * one the schedule happens to be in — usually still loading — and a focus target that existed in only some
   * of them would work or not depending on timing.
   */
  readonly mainRef?: Ref<HTMLElement> | undefined;
  /**
   * The control that opens Settings, exposed so focus can be returned to it.
   *
   * Leaving Settings unmounts everything a person could have been focused on, so focus falls back to `<body>`
   * unless something puts it back. The button they pressed to get there is where they were, which is what makes
   * the return journey continue rather than restart.
   */
  readonly settingsButtonRef?: Ref<HTMLButtonElement> | undefined;
}

interface ShellProps {
  readonly children: ReactNode;
  readonly onOpenSettings: () => void;
  readonly announcement: string;
  readonly place: string | null;
  readonly mainRef?: Ref<HTMLElement> | undefined;
  readonly settingsButtonRef?: Ref<HTMLButtonElement> | undefined;
}

const Shell = ({
  children,
  onOpenSettings,
  announcement,
  place,
  mainRef,
  settingsButtonRef,
}: ShellProps) => {
  const { messages } = useCopy();

  return (
    /**
     * `tabIndex={-1}` makes this programmatically focusable without adding it to the tab order.
     *
     * A region is not focusable by default, so moving focus here after a screen transition would silently do
     * nothing and leave it on `<body>`. `-1` rather than `0`, because this must not become a stop a person has
     * to tab through on every pass.
     */
    <main
      ref={mainRef}
      tabIndex={-1}
      className="min-h-full px-4 pb-4 pt-4 text-ar-text outline-none"
    >
      <PopupHeader
        place={place}
        trailing={
          <button
            ref={settingsButtonRef}
            type="button"
            // The same 36 px surface as the two menus beside it, with the same 44 px target around it.
            className="relative flex h-9 min-w-9 items-center justify-center rounded-full border border-ar-border bg-ar-surface text-ar-text transition-colors after:absolute after:-inset-[5px] after:content-[''] hover:bg-ar-surface-muted focus-visible:outline-ar-focus motion-reduce:transition-none"
            aria-label={messages.header.openSettings}
            onClick={onOpenSettings}
          >
            <Settings2 aria-hidden="true" size={17} />
          </button>
        }
      />

      <h1 className="sr-only">{messages.dashboard.heading}</h1>

      {/* A polite live region, so a change from cached to fresh is not silent for a screen-reader user. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {children}
    </main>
  );
};

/** Text plus an icon, so no state is distinguishable by colour alone. */
const StatusLine = ({
  icon,
  children,
  tone = 'muted',
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly tone?: 'muted' | 'warning';
}) => (
  <p
    className={[
      'flex items-start gap-1.5 text-xs',
      tone === 'warning' ? 'text-ar-danger' : 'text-ar-text-muted',
    ].join(' ')}
  >
    <span className="mt-0.5 shrink-0" aria-hidden="true">
      {icon}
    </span>
    <span className="min-w-0 break-words">{children}</span>
  </p>
);

/**
 * The icon for each reason the cache is on screen.
 *
 * Exhaustive rather than "spinner if refreshing, otherwise a crossed-out cloud": that fallback gave
 * `retained_newer` the offline icon, so a refresh that had succeeded was pictured as no connection. The
 * spinner turns itself off under reduced motion, because it runs for as long as the refresh does.
 */
const CachedReasonIcon = ({ reason }: { readonly reason: CachedReason }) => {
  switch (reason) {
    case 'refreshing':
      return <RefreshCw size={13} className="animate-spin motion-reduce:animate-none" />;
    case 'offline':
    case 'refresh_failed':
      return <CloudOff size={13} />;
    case 'retained_newer':
      return <History size={13} />;
  }
};

/**
 * What a partial cache is missing, on whichever side it is missing it.
 *
 * An intersection can fall short at either end, so the two boundaries are compared separately and each
 * case gets its own sentence. Naming only the tail told a reader that data was missing *after* a date on the
 * ordinary day when what was missing were the days *before* it, which is a confident statement about the
 * wrong period.
 *
 * `undefined` means the entry covers the whole requested window, so there is nothing to warn about.
 */
const coverageGapCopy = (
  messages: Messages,
  locale: Parameters<typeof formatCalendarDate>[0],
  displayRange: SourceWindow,
  requestedRange: SourceWindow,
): string | undefined => {
  const headUncovered = requestedRange.from < displayRange.from;
  const tailUncovered = requestedRange.to > displayRange.to;
  const from = formatCalendarDate(locale, displayRange.from);
  const to = formatCalendarDate(locale, displayRange.to);

  if (headUncovered && tailUncovered) {
    return messages.status.coverageBoth(from, to);
  }

  if (headUncovered) {
    return messages.status.coverageHead(from);
  }

  if (tailUncovered) {
    return messages.status.coverageTail(to);
  }

  return undefined;
};

const announcementFor = (messages: Messages, view: ScheduleView): string => {
  switch (view.kind) {
    case 'needs_selection':
      return messages.announcements.needsSelection;
    case 'loading':
      return messages.announcements.loading;
    case 'live':
      return view.freshness === 'fresh'
        ? messages.announcements.liveFresh
        : messages.announcements.liveStale;
    case 'cached':
      return messages.announcements.cached[view.reason];
    case 'range_not_covered':
      return messages.announcements.rangeNotCovered;
    case 'error':
      return messages.announcements.error;
  }
};

/** An unrecognized code degrades to a generic message rather than showing a raw identifier. */
const failureMessage = (
  messages: Messages,
  view: Extract<ScheduleView, { kind: 'error' }>,
): string => {
  const { failure } = view;

  switch (failure.kind) {
    case 'network':
    case 'timeout':
    case 'cancelled':
    case 'invalid_response':
    case 'unsupported_message':
      return messages.failures[failure.kind];
    case 'problem':
      return (
        messages.failures.problems[failure.code as keyof Messages['failures']['problems']] ??
        messages.failures.generic
      );
  }
};

const EmptyPanel = ({
  title,
  description,
  icon,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
}) => (
  <section className="rounded-ar-xl border border-dashed border-ar-border bg-ar-surface p-6 text-center">
    <span className="mx-auto grid size-10 place-items-center text-ar-text-muted" aria-hidden="true">
      {icon}
    </span>
    <p className="mt-2 font-semibold">{title}</p>
    <p className="mt-1 text-sm text-ar-text-muted">{description}</p>
  </section>
);

export const DashboardView = ({
  view,
  visibleWasteTypes,
  onOpenSettings,
  onRetry,
  household = null,
  householdNotice = null,
  householdProvenance = [],
  referenceDate,
  mainRef,
  settingsButtonRef,
}: DashboardViewProps) => {
  const { locale, messages } = useCopy();
  /**
   * One minute clock for the whole schedule: the source's today is derived from it, and so is the countdown.
   * The featured card therefore turns over at source-local midnight while the popup stays open, and returning
   * to a backgrounded popup recalculates at once — with one timer, not two.
   */
  const clockNow = useMinuteClock();
  const now = referenceDate ?? clockNow;
  const announcement = announcementFor(messages, view);
  /**
   * The locality and the district as the schedule's own provenance names them — the operator's naming, from the
   * response that is on screen, never inferred from a display name elsewhere. Absent until a schedule is.
   */
  const place =
    view.kind === 'live' || view.kind === 'cached'
      ? `${view.provenance.locality} · ${view.provenance.areaName}`
      : null;
  const shell = (children: ReactNode) => (
    <Shell
      onOpenSettings={onOpenSettings}
      announcement={announcement}
      place={place}
      mainRef={mainRef}
      settingsButtonRef={settingsButtonRef}
    >
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </Shell>
  );

  if (view.kind === 'needs_selection' || view.kind === 'loading') {
    return shell(
      <EmptyPanel
        icon={<Loader2 size={22} className="animate-spin motion-reduce:animate-none" />}
        title={messages.dashboard.loadingTitle}
        description={messages.dashboard.loadingBody}
      />,
    );
  }

  if (view.kind === 'range_not_covered') {
    return shell(
      <EmptyPanel
        icon={<CalendarOff size={22} />}
        title={messages.dashboard.rangeNotCoveredTitle}
        description={messages.dashboard.rangeNotCoveredBody}
      />,
    );
  }

  const today = view.kind === 'error' ? null : deriveSourceToday(view.provenance.timeZone, now);

  if (view.kind === 'error' || today === null || !today.ok) {
    const failure =
      view.kind === 'error' ? failureMessage(messages, view) : messages.failures.generic;

    return shell(
      <section className="rounded-ar-xl border border-ar-border bg-ar-surface p-5">
        <p className="flex items-center gap-2 font-semibold">
          <AlertTriangle size={18} aria-hidden="true" />
          {messages.dashboard.errorTitle}
        </p>
        <p className="mt-2 text-sm text-ar-text-muted" role="alert">
          {failure}
        </p>
        {/*
          A support identifier is shown only when a validated Problem Details response supplied one.
          Every other failure never reached a server, so nothing exists that would match a server log,
          and a generated value would be worse than none.
        */}
        {view.kind === 'error' && view.failure.kind === 'problem' && (
          <p className="mt-2 text-xs text-ar-text-muted">
            {messages.dashboard.supportReference}{' '}
            <span className="tabular-nums">{view.failure.requestId}</span>
          </p>
        )}
        <button
          type="button"
          className="mt-4 min-h-11 w-full rounded-ar-md border border-ar-border bg-ar-surface px-4 py-3 text-sm font-semibold transition hover:border-ar-text-muted focus-visible:outline-ar-focus motion-reduce:transition-none"
          onClick={onRetry}
        >
          {messages.dashboard.retry}
        </button>
      </section>,
    );
  }

  const { provenance, displayRange } = view;
  const isCached = view.kind === 'cached';
  /**
   * Filtered to what was asked for, then put in the product's one total event order.
   *
   * `orderEvents` copies before sorting, so nothing here can reorder a transport array or a cached one — the
   * cache entry is the worker's. Every statement below reads from this one array: the featured collection,
   * the countdown, the rows after it, and the decision that there is nothing to show. Deriving any of them
   * separately is how the card and the list could disagree.
   */
  /*
   * The calculated collections, bounded by what this view is showing and filtered by the same waste-type
   * choice the official events are. They are never deduplicated against official events and never change
   * one: both kinds enter the single ordered list, each keeping its own `source`.
   */
  const calculated: readonly CollectionEvent[] =
    household === null
      ? []
      : household.collections
          .filter(
            (collection) =>
              collection.date >= displayRange.from && collection.date <= displayRange.to,
          )
          .map((collection) => toCollectionEvent(collection, provenance.areaName));
  const ordered = orderEvents([
    ...visibleEvents(view.events, visibleWasteTypes),
    ...visibleEvents(calculated, visibleWasteTypes),
  ]);
  const schedule: SharedScheduleView = {
    events: ordered,
    sourceToday: today.date,
    timeZone: provenance.timeZone,
    range: displayRange,
    source: {
      name: provenance.sourceName,
      attribution: provenance.attribution,
      landingPageUrl: provenance.landingPageUrl,
      retrievedAt: provenance.retrievedAt,
      /*
       * A restored entry makes neither of the source's claims: it is not "current", whatever it was when stored,
       * and "the source reports stale data" would blame the source for the popup being offline. The cached
       * notice above says what it is instead.
       */
      freshness: isCached ? null : view.freshness,
      publishedWasteTypes: provenance.coverage,
    },
  };
  const featured = featuredCollection(ordered, today.date);
  const listed = listedCollections(ordered, featured);
  const undeclared = undeclaredWasteTypes(provenance, visibleWasteTypes);
  // Only a cache can fall short of the requested window; a live response served the range it reports.
  const coverageGap = isCached
    ? coverageGapCopy(messages, locale, displayRange, view.requestedRange)
    : undefined;

  return shell(
    <>
      {/*
        Why a restored schedule is on screen, and what it covers — before the schedule, so nobody reads a
        stored calendar as a current one. Text and an icon together, never colour alone.
      */}
      {isCached ? (
        <section
          className="flex flex-col gap-1.5 rounded-ar-md border border-ar-border bg-ar-surface p-3"
          data-testid="cached-notice"
        >
          <StatusLine icon={<CachedReasonIcon reason={view.reason} />}>
            {messages.status.cachedReason[view.reason]}{' '}
            {messages.status.storedAt(`${formatInstant(locale, view.storedAt)} UTC`)}
          </StatusLine>
          {coverageGap === undefined ? null : (
            <StatusLine icon={<AlertTriangle size={13} />} tone="warning">
              {coverageGap}
            </StatusLine>
          )}
        </section>
      ) : null}

      <CountdownPanelAt locale={locale} messages={messages} now={now} view={schedule} />

      {featured === null ? (
        <EmptyPanel
          icon={<CircleSlash size={22} />}
          title={messages.dashboard.emptyTitle}
          // "No collection in this period" is a statement about the calendar inside a covered range, which
          // is a different thing from a waste type the source does not publish at all.
          description={messages.dashboard.emptyBody(
            formatCalendarDate(locale, displayRange.from),
            formatCalendarDate(locale, displayRange.to),
          )}
        />
      ) : (
        <NextCollectionCard locale={locale} messages={messages} view={schedule} />
      )}

      {listed.length > 0 && (
        <section aria-labelledby="later-heading" className="flex flex-col gap-1.5">
          <h2 className="text-sm font-semibold text-ar-text" id="later-heading">
            {messages.dashboard.listHeading}
          </h2>
          <ul className="flex flex-col gap-1.5">
            {listed.map((event) => (
              <EventRow
                event={event}
                key={event.id}
                locale={locale}
                messages={messages}
                sourceToday={today.date}
              />
            ))}
          </ul>
        </section>
      )}

      <ProvenanceCard locale={locale} messages={messages} view={schedule} />

      {householdNotice !== null && (
        <StatusLine icon={<CircleSlash size={13} />}>{householdNotice}</StatusLine>
      )}

      {householdProvenance.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="household-provenance">
          {/*
            One line per fact, each wrapping on its own. At 320 px these are the longest strings on the
            screen, and a single run-on paragraph is where a narrow popup starts truncating.
          */}
          {householdProvenance.map((line) => (
            <StatusLine icon={<ShieldCheck size={13} />} key={line}>
              {line}
            </StatusLine>
          ))}
        </div>
      )}

      {undeclared.length > 0 && (
        <StatusLine icon={<CircleSlash size={13} />}>
          {messages.status.undeclared(
            formatNameList(
              locale,
              undeclared.map((type) => messages.waste[type]),
            ),
          )}
        </StatusLine>
      )}
    </>,
  );
};
