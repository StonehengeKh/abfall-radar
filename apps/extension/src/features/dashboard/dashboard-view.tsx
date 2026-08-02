import {
  type MobileDropOffCollectionEvent,
  type WasteType,
  wasteDescriptions,
  wasteLabels,
} from '@abfall-radar/domain';
import { BrandMark, WasteIcon } from '@abfall-radar/ui';
import {
  AlertTriangle,
  Archive,
  Bell,
  CalendarOff,
  ChevronRight,
  CircleSlash,
  Clock3,
  CloudOff,
  ExternalLink,
  History,
  Loader2,
  MapPin,
  RefreshCw,
  Settings2,
  Sparkles,
} from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import type { SourceWindow } from '@/src/schedule/capability';
import { formatCollectionWindow } from '@/src/schedule/collection-window';
import { daysBetween, deriveLocalDate } from '@/src/schedule/schedule-range';
import {
  byDisplayOrder,
  type CachedReason,
  type ScheduleView,
  undeclaredWasteTypes,
  visibleEvents,
} from '@/src/schedule/view-state';

/**
 * The schedule surface.
 *
 * Every state it can render comes from one pure function, and every claim it makes is bounded by that
 * state's `displayRange`. Provenance and freshness are always conveyed by **text and an icon**, never by
 * colour alone.
 */

export interface DashboardViewProps {
  readonly view: ScheduleView;
  readonly visibleWasteTypes: WasteType[];
  readonly onOpenSettings: () => void;
  readonly onRetry: () => void;
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

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * Pinned to UTC, because a `YYYY-MM-DD` is a calendar date rather than an instant.
 *
 * `formatDay` reads the value as UTC midnight, so formatting it in the device zone would render that
 * midnight in local time and shift the date backwards for every zone west of UTC — `2026-03-01` would
 * appear as 28 February in New York. The zone here and the zone in `formatDay` have to agree, and UTC is
 * the pair that leaves a calendar date alone on every device.
 */
const DAY_FORMATTER = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'UTC' });

/**
 * A timestamp is a real instant, so it is deliberately **not** pinned: a retrieval time is most useful
 * shown in the reader's own zone.
 */
const formatTimestamp = (value: string): string => TIMESTAMP_FORMATTER.format(new Date(value));

/** Read as UTC midnight and formatted in UTC, so a calendar date is never shifted by the device zone. */
const formatDay = (value: string): string => DAY_FORMATTER.format(new Date(`${value}T00:00:00Z`));

/** Pinned to UTC for the same reason as `DAY_FORMATTER`: the input is a calendar date. */
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/**
 * "Heute", "Morgen", or a short date — relative to today **in the source's zone**.
 *
 * The domain helper compares against the device's calendar day, which is the wrong question for an official
 * collection date: at 23:30 UTC a reader in New York is still on the previous day while Berlin has already
 * moved on, so the same collection would be labelled "Morgen" for one and "Heute" for the other. The zone the
 * source publishes in decides, exactly as it does for the requested range and the reminder.
 *
 * Both operands are `YYYY-MM-DD`, so the comparison is calendar arithmetic with no instant involved.
 */
const relativeDayLabel = (date: string, today: string): string => {
  const difference = daysBetween(today, date);

  if (difference === 0) {
    return 'Heute';
  }

  if (difference === 1) {
    return 'Morgen';
  }

  if (difference > 1 && difference < 7) {
    return `In ${difference} Tagen`;
  }

  return WEEKDAY_FORMATTER.format(new Date(`${date}T00:00:00Z`));
};

/**
 * The window, the zone, and the place of a mobile drop-off.
 *
 * **One** renderer, used by the hero event and by every later row alike. A drop-off is only actionable with
 * all three: a row saying "Schadstoffe, in 5 Tagen" tells a reader an event exists while withholding
 * everything needed to attend it — no time to be there and no address to go to — which is worse than not
 * listing it, because it reads as complete. The later rows previously rendered exactly that.
 *
 * Two callers means two chances to omit a field, so the fields are not a caller's decision. `tone` is the only
 * parameter, covering the two surfaces this appears on — the brand-coloured hero and the plain list — and
 * nothing about *what* is shown varies with it.
 *
 * A curbside collection is never passed here: there is nowhere to go and no window to keep, so showing an
 * empty one would invent a constraint the source never stated. The type makes that structural rather than
 * remembered.
 */
const MobileDropOffDetails = ({
  event,
  tone,
}: {
  readonly event: MobileDropOffCollectionEvent;
  readonly tone: 'on_brand' | 'muted';
}) => {
  /**
   * Shared with the reminder, so the popup and the notification never word the same window differently.
   *
   * `null` means it could not be formatted at all, which is a defect rather than an expected state. The row is
   * then dropped rather than rendered empty: a clock icon beside nothing reads as a window the source did not
   * publish, and the place — which is still known — stays visible on its own line.
   */
  const window = formatCollectionWindow(event.timing);

  return (
    <div
      className={[
        'mt-2 space-y-1',
        tone === 'on_brand' ? 'text-sm text-ar-on-brand/85' : 'text-xs text-ar-text-muted',
      ].join(' ')}
    >
      {window !== null && (
        <p className="flex items-center gap-1.5">
          <Clock3 size={13} className="shrink-0" aria-hidden="true" />
          {/* The window and its zone in one string, because a time without its zone is not actionable. */}
          <span className="tabular-nums">{window}</span>
        </p>
      )}
      <p className="flex items-start gap-1.5">
        <MapPin size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{event.location.name}</span>
      </p>
    </div>
  );
};

interface StatusLineProps {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly tone?: 'muted' | 'warning';
}

/** Text plus an icon, so no state is distinguishable by colour alone. */
const StatusLine = ({ icon, children, tone = 'muted' }: StatusLineProps) => (
  <p
    className={[
      'mt-2 flex items-start gap-1.5 text-xs',
      tone === 'warning' ? 'text-ar-danger' : 'text-ar-text-muted',
    ].join(' ')}
  >
    <span className="mt-0.5 shrink-0" aria-hidden="true">
      {icon}
    </span>
    <span className="min-w-0">{children}</span>
  </p>
);

interface ShellProps {
  readonly children: ReactNode;
  readonly onOpenSettings: () => void;
  readonly announcement: string;
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

const Shell = ({
  children,
  onOpenSettings,
  announcement,
  mainRef,
  settingsButtonRef,
}: ShellProps) => (
  /**
   * `tabIndex={-1}` makes this programmatically focusable without adding it to the tab order.
   *
   * A region is not focusable by default, so moving focus here after a screen transition would silently do
   * nothing and leave it on `<body>`. `-1` rather than `0`, because this must not become a stop a person has
   * to tab through on every pass.
   */
  <main ref={mainRef} tabIndex={-1} className="min-h-full px-4 pb-4 pt-5 text-ar-text outline-none">
    <header className="flex items-center gap-3">
      <BrandMark />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-ar-brand">
          AbfallRadar
        </p>
        <h1 className="truncate text-lg font-semibold tracking-tight">Alles im Blick</h1>
      </div>
      <button
        ref={settingsButtonRef}
        type="button"
        className="grid size-11 place-items-center rounded-2xl border border-ar-border bg-ar-surface text-ar-text-muted shadow-ar-sm transition hover:border-ar-text-muted hover:text-ar-text focus-visible:outline-ar-focus"
        aria-label="Einstellungen öffnen"
        onClick={onOpenSettings}
      >
        <Settings2 size={19} />
      </button>
    </header>

    {/* A polite live region, so a change from cached to fresh is not silent for a screen-reader user. */}
    <p className="sr-only" role="status" aria-live="polite">
      {announcement}
    </p>

    {children}
  </main>
);

/**
 * Why the cache is on screen, in the reader's words.
 *
 * `refreshing` is deliberately worded as progress: it is the ordinary state for the first moments after the
 * popup opens, and calling it a failure there would be simply untrue.
 */
const cachedReasonCopy: Record<CachedReason, string> = {
  refreshing: 'Gespeicherte Termine, während die aktuellen Termine geladen werden.',
  offline: 'Gespeicherte Termine, weil die API nicht erreichbar ist.',
  refresh_failed: 'Gespeicherte Termine, weil die Aktualisierung fehlgeschlagen ist.',
  /**
   * Nothing failed here, and nothing is offline: the refresh answered, with a retrieval **older** than the
   * one already stored. So the wording says exactly that and stops short of calling the kept entry a current
   * response — it is the newer of the two, which is a different claim from being live.
   */
  retained_newer:
    'Gespeicherte Termine, weil die Aktualisierung einen älteren Abruf der Quelle geliefert hat. Der neuere gespeicherte Stand wurde beibehalten.',
};

/**
 * What a screen reader hears when the cache is on screen.
 *
 * `refreshing` is announced as progress. Announcing it as a failure would tell a screen-reader user
 * something had gone wrong every single time the popup opened, which is simply untrue.
 */
const cachedReasonAnnouncement: Record<CachedReason, string> = {
  refreshing: 'Gespeicherte Termine werden angezeigt. Aktualisierung läuft.',
  offline: 'Die API ist nicht erreichbar. Gespeicherte Termine werden angezeigt.',
  refresh_failed: 'Die Aktualisierung ist fehlgeschlagen. Gespeicherte Termine werden angezeigt.',
  retained_newer:
    'Die Aktualisierung hat einen älteren Abruf der Quelle geliefert. Der neuere gespeicherte Stand wird weiterhin angezeigt.',
};

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
 * case gets its own sentence. Naming only the tail — the single message this replaces — told a reader
 * that data was missing *after* a date on the ordinary day when what was missing were the days *before*
 * it, which is a confident statement about the wrong period.
 *
 * `undefined` means the entry covers the whole requested window, so there is nothing to warn about.
 */
const coverageGapCopy = (
  displayRange: SourceWindow,
  requestedRange: SourceWindow,
): ReactNode | undefined => {
  const headUncovered = requestedRange.from < displayRange.from;
  const tailUncovered = requestedRange.to > displayRange.to;

  if (headUncovered && tailUncovered) {
    return (
      <>
        Die gespeicherten Termine liegen nur vom{' '}
        <span className="tabular-nums">{formatDay(displayRange.from)}</span> bis zum{' '}
        <span className="tabular-nums">{formatDay(displayRange.to)}</span> vor. Für die Zeit davor
        und danach liegen offline keine Daten vor.
      </>
    );
  }

  if (headUncovered) {
    return (
      <>
        Die gespeicherten Termine liegen erst ab dem{' '}
        <span className="tabular-nums">{formatDay(displayRange.from)}</span> vor. Für die Zeit davor
        liegen offline keine Daten vor.
      </>
    );
  }

  if (tailUncovered) {
    return (
      <>
        Die gespeicherten Termine reichen nur bis zum{' '}
        <span className="tabular-nums">{formatDay(displayRange.to)}</span>. Für die Zeit danach
        liegen offline keine Daten vor.
      </>
    );
  }

  return undefined;
};

const announcementFor = (view: ScheduleView): string => {
  switch (view.kind) {
    case 'needs_selection':
      return 'Es ist noch kein Sammelgebiet gewählt.';
    case 'loading':
      return 'Termine werden geladen.';
    case 'live':
      return view.freshness === 'fresh'
        ? 'Aktuelle offizielle Termine geladen.'
        : 'Offizielle Termine geladen. Die Quelle konnte zuletzt nicht aktualisiert werden.';
    case 'cached':
      return cachedReasonAnnouncement[view.reason];
    case 'range_not_covered':
      return 'Für diesen Zeitraum veröffentlicht die Quelle keinen Kalender.';
    case 'error':
      return 'Die Termine konnten nicht geladen werden.';
  }
};

/** An unrecognized code degrades to a generic message rather than showing a raw identifier. */
const problemMessage = (code: string): string => {
  switch (code) {
    case 'PROVIDER_NOT_FOUND':
      return 'Dieser Entsorgungsbetrieb ist nicht mehr verfügbar. Bitte wähle ihn neu.';
    case 'SERVICE_AREA_NOT_FOUND':
      return 'Dieses Sammelgebiet ist nicht mehr verfügbar. Bitte wähle es neu.';
    case 'COLLECTION_EVENTS_NOT_AVAILABLE':
      return 'Für dieses Sammelgebiet veröffentlicht der Betrieb keinen offiziellen Kalender.';
    case 'UPSTREAM_SOURCE_UNAVAILABLE':
      return 'Die offizielle Quelle ist derzeit nicht erreichbar.';
    case 'UPSTREAM_SOURCE_INVALID':
      return 'Die offizielle Quelle konnte nicht ausgewertet werden.';
    default:
      return 'Die Termine konnten nicht geladen werden.';
  }
};

const failureMessage = (view: Extract<ScheduleView, { kind: 'error' }>): string => {
  switch (view.failure.kind) {
    case 'network':
      return 'Die AbfallRadar-API ist nicht erreichbar. Prüfe deine Verbindung.';
    case 'timeout':
      return 'Die Anfrage an die AbfallRadar-API hat zu lange gedauert.';
    case 'cancelled':
      return 'Die Anfrage wurde abgebrochen.';
    case 'invalid_response':
      return 'Die Antwort der AbfallRadar-API war unlesbar.';
    case 'unsupported_message':
      return 'Die Erweiterung konnte die Termine nicht abrufen.';
    case 'problem':
      return problemMessage(view.failure.code);
  }
};

interface EmptyPanelProps {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
}

const EmptyPanel = ({ title, description, icon }: EmptyPanelProps) => (
  <section className="mt-4 rounded-[28px] border border-dashed border-ar-border bg-ar-surface p-6 text-center">
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
  referenceDate = new Date(),
  mainRef,
  settingsButtonRef,
}: DashboardViewProps) => {
  const announcement = announcementFor(view);

  if (view.kind === 'needs_selection' || view.kind === 'loading') {
    return (
      <Shell
        onOpenSettings={onOpenSettings}
        announcement={announcement}
        mainRef={mainRef}
        settingsButtonRef={settingsButtonRef}
      >
        <EmptyPanel
          icon={<Loader2 size={22} className="animate-spin motion-reduce:animate-none" />}
          title="Termine werden geladen"
          description="Die offiziellen Termine werden abgerufen."
        />
      </Shell>
    );
  }

  if (view.kind === 'range_not_covered') {
    return (
      <Shell
        onOpenSettings={onOpenSettings}
        announcement={announcement}
        mainRef={mainRef}
        settingsButtonRef={settingsButtonRef}
      >
        <EmptyPanel
          icon={<CalendarOff size={22} />}
          title="Kein Kalender für diesen Zeitraum"
          description="Die offizielle Quelle veröffentlicht für den aktuellen Zeitraum keine Termine. Sobald der Betrieb den nächsten Zeitraum veröffentlicht, erscheinen die Termine hier."
        />
      </Shell>
    );
  }

  if (view.kind === 'error') {
    return (
      <Shell
        onOpenSettings={onOpenSettings}
        announcement={announcement}
        mainRef={mainRef}
        settingsButtonRef={settingsButtonRef}
      >
        <section className="mt-4 rounded-[28px] border border-ar-border bg-ar-surface p-5">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle size={18} aria-hidden="true" />
            Termine nicht verfügbar
          </p>
          <p className="mt-2 text-sm text-ar-text-muted" role="alert">
            {failureMessage(view)}
          </p>
          {/*
            A support identifier is shown only when a validated Problem Details response supplied one.
            Every other failure never reached a server, so nothing exists that would match a server log,
            and a generated value would be worse than none.
          */}
          {view.failure.kind === 'problem' && (
            <p className="mt-2 text-xs text-ar-text-muted">
              Referenz für den Support:{' '}
              <span className="tabular-nums">{view.failure.requestId}</span>
            </p>
          )}
          <button
            type="button"
            className="mt-4 min-h-11 w-full rounded-2xl border border-ar-border bg-ar-surface px-4 py-3 text-sm font-semibold transition hover:border-ar-text-muted focus-visible:outline-ar-focus"
            onClick={onRetry}
          >
            Erneut versuchen
          </button>
        </section>
      </Shell>
    );
  }

  const { provenance, displayRange } = view;
  // Today according to the source, which is what every relative label below is measured against.
  const sourceToday = deriveLocalDate(provenance.timeZone, referenceDate);
  /**
   * Filtered to what was asked for, then ordered.
   *
   * Copied before sorting, so nothing this surface does can reorder a transport array or a cached one — the
   * cache entry is the worker's, and reordering it in place would change what a later read returns. `sort`
   * mutates, so the copy is the mechanism rather than a precaution.
   *
   * Every statement below reads from this one array: the next collection, the rows after it, and the decision
   * that there is nothing to show. Deriving any of them separately is how the hero and the list could disagree.
   */
  const shown = [...visibleEvents(view.events, visibleWasteTypes)].sort(byDisplayOrder);
  const [nextEvent, ...laterEvents] = shown;
  const undeclared = undeclaredWasteTypes(provenance, visibleWasteTypes);
  const isCached = view.kind === 'cached';
  // Only a cache can fall short of the requested window; a live response served the range it reports.
  const coverageGap = isCached ? coverageGapCopy(displayRange, view.requestedRange) : undefined;

  return (
    <Shell
      onOpenSettings={onOpenSettings}
      announcement={announcement}
      mainRef={mainRef}
      settingsButtonRef={settingsButtonRef}
    >
      <div className="mt-5 inline-flex max-w-full items-center gap-2 rounded-full border border-ar-border bg-ar-surface px-3 py-1.5 text-xs font-medium text-ar-text-muted shadow-ar-sm">
        <MapPin size={14} className="shrink-0 text-ar-brand" aria-hidden="true" />
        <span className="truncate">
          {provenance.locality} · {provenance.areaName}
        </span>
      </div>

      {nextEvent ? (
        <section className="ar-hero relative mt-4 overflow-hidden rounded-[28px] p-5 text-ar-on-brand">
          <div className="absolute -right-10 -top-12 size-36 rounded-full border-[24px] border-ar-on-brand/[0.06]" />
          <div className="absolute -bottom-16 left-10 size-28 rounded-full bg-ar-brand-soft/10 blur-xl" />

          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-ar-on-brand/85">
                <Sparkles size={14} aria-hidden="true" />
                Nächste Abholung
              </div>
              <p className="mt-4 text-3xl font-semibold tracking-[-0.035em]">
                {relativeDayLabel(nextEvent.date, sourceToday)}
              </p>
              <p className="mt-1 text-sm tabular-nums text-ar-on-brand/80">{nextEvent.date}</p>
            </div>
            <WasteIcon type={nextEvent.type} inverted />
          </div>

          <div className="relative mt-7 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{wasteLabels[nextEvent.type]}</h2>
              <p className="mt-0.5 text-sm text-ar-on-brand/75">
                {wasteDescriptions[nextEvent.type]}
              </p>
              {nextEvent.collectionMode === 'mobile_drop_off' && (
                <MobileDropOffDetails event={nextEvent} tone="on_brand" />
              )}
            </div>
            <div className="flex items-center gap-1 rounded-full bg-ar-on-brand/12 px-2.5 py-1 text-[11px] font-semibold text-ar-on-brand backdrop-blur">
              <Bell size={12} aria-hidden="true" />
              18:00
            </div>
          </div>
        </section>
      ) : (
        <EmptyPanel
          icon={<CircleSlash size={22} />}
          title="Keine Abholung in diesem Zeitraum"
          // "No collection in this period" is a statement about the calendar inside a covered range, which
          // is a different thing from a waste type the source does not publish at all.
          description={`Die Quelle enthält für ${formatDay(displayRange.from)} bis ${formatDay(
            displayRange.to,
          )} keine passende Abholung.`}
        />
      )}

      {laterEvents.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ar-text">Danach</h2>

          <div className="mt-2 overflow-hidden rounded-3xl border border-ar-border bg-ar-surface shadow-ar-sm">
            {laterEvents.slice(0, 4).map((event, index) => (
              <div
                key={event.id}
                className={[
                  // `items-start`, because a drop-off row is taller than one line once its window and place
                  // are shown, and centring would then float the icon against the middle of the block.
                  'flex items-start gap-3 px-3.5 py-3',
                  index > 0 ? 'border-t border-ar-border' : '',
                ].join(' ')}
              >
                <WasteIcon type={event.type} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ar-text">
                    {wasteLabels[event.type]}
                  </p>
                  <p className="mt-0.5 text-xs tabular-nums text-ar-text-muted">
                    {relativeDayLabel(event.date, sourceToday)}
                  </p>
                  {/* The same details as the hero event: a later drop-off is no less something to attend. */}
                  {event.collectionMode === 'mobile_drop_off' && (
                    <MobileDropOffDetails event={event} tone="muted" />
                  )}
                </div>
                <ChevronRight
                  size={17}
                  className="mt-0.5 shrink-0 text-ar-text-muted/50"
                  aria-hidden="true"
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-4 rounded-3xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
        <h2 className="text-sm font-semibold">Datenquelle</h2>

        <p className="mt-2 text-sm text-ar-text">{provenance.sourceName}</p>
        <p className="mt-1 text-xs text-ar-text-muted">{provenance.attribution}</p>

        <a
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-ar-brand underline focus-visible:outline-ar-focus"
          href={provenance.landingPageUrl}
          target="_blank"
          rel="noreferrer"
        >
          Offizielle Seite des Betriebs
          <ExternalLink size={13} aria-hidden="true" />
        </a>

        {isCached ? (
          <>
            <StatusLine icon={<CachedReasonIcon reason={view.reason} />}>
              {cachedReasonCopy[view.reason]} Gespeichert am{' '}
              <span className="tabular-nums">{formatTimestamp(view.storedAt)}</span>.
            </StatusLine>
            <StatusLine icon={<Archive size={13} />}>
              Von der Quelle abgerufen am{' '}
              <span className="tabular-nums">{formatTimestamp(provenance.retrievedAt)}</span>.
            </StatusLine>
            {/*
              Never presented as coverage of the whole requested window: rendering an uncovered head or tail
              as "no collection scheduled" would be a confident claim about a period with no data behind it.
              Derived from the two boundaries themselves, so the sentence describes the side that is actually
              missing.
            */}
            {coverageGap !== undefined && (
              <StatusLine icon={<AlertTriangle size={13} />} tone="warning">
                {coverageGap}
              </StatusLine>
            )}
          </>
        ) : (
          <StatusLine icon={<Archive size={13} />}>
            {view.freshness === 'fresh'
              ? 'Aktuell abgerufen am '
              : 'Die Quelle konnte zuletzt nicht aktualisiert werden. Stand vom '}
            <span className="tabular-nums">{formatTimestamp(provenance.retrievedAt)}</span>.
          </StatusLine>
        )}

        <StatusLine icon={<Clock3 size={13} />}>
          Zeitraum <span className="tabular-nums">{formatDay(displayRange.from)}</span> bis{' '}
          <span className="tabular-nums">{formatDay(displayRange.to)}</span>.
        </StatusLine>

        {undeclared.length > 0 && (
          <StatusLine icon={<CircleSlash size={13} />}>
            Diese Quelle veröffentlicht keine Termine für{' '}
            {undeclared.map((type) => wasteLabels[type]).join(', ')}.
          </StatusLine>
        )}
      </section>
    </Shell>
  );
};
