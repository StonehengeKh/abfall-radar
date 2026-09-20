import type { CollectionEvent } from '@abfall-radar/domain';
import { WasteIcon } from '@abfall-radar/ui';
import { useEffect, useState } from 'react';
import { useLocale } from '@/src/i18n/context';
import {
  dayUnitLabel,
  formatCalendarDate,
  formatCompactDate,
  formatDayCount,
  formatInstant,
  formatLongWeekday,
  formatNameList,
  formatRelativeDay,
  formatWeekday,
  formatWeekdayCalendarDate,
  isNumericRelativeDay,
  isRelativeDay,
} from '@/src/i18n/format';
import type { Messages } from '@/src/i18n/messages';
import {
  type CountdownTarget,
  isCollectionInProgress,
  nextCountdownTarget,
} from '@/src/schedule/collection-day';
import { formatCollectionWindow } from '@/src/schedule/collection-window';
import { daysBetween, isUpcoming } from '@/src/schedule/source-day';
import type { AcceptedSchedule } from '@/src/schedule/view-state';

/**
 * The accepted schedule: what is coming next, then everything else in order, then where it came from.
 *
 * Every normalized event gets its own row: one upstream appointment can normalize into a `hazardous`
 * and a `small_electronics` event sharing date, window, zone, and location, and they are never merged.
 * Provenance renders whenever the response carries it, including for a successful empty schedule.
 *
 * Source-authored text — the operator's name, attribution, source page, and the drop-off addresses —
 * is reproduced exactly as published, in every language.
 */

/**
 * The next collection, and how many days away it is.
 *
 * Derived from the same source-local date every row uses, so the highlight can never disagree with the
 * list under it. `null` when nothing is upcoming, which is what keeps the panel from inventing a count.
 */
const nextCollection = (schedule: AcceptedSchedule): CollectionEvent | null =>
  schedule.events.find((event) => isUpcoming(event.date, schedule.sourceToday)) ?? null;

/**
 * A circular badge showing whole days until the collection.
 *
 * The number is `daysBetween` on the same two source-local dates every other label uses — not a
 * percentage, not a proportion of anything, and nothing invented to fill a ring. The ring is a plain
 * border, so there is no progress value for it to misrepresent.
 */
const DaysBadge = ({ days }: { readonly days: number }) => {
  const { locale, messages } = useLocale();

  return (
    <div
      // Stacked digits and a unit read poorly character by character, so the whole phrase is given once.
      aria-label={days === 0 ? messages.schedule.today : formatDayCount(locale, days)}
      className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-full border-2 border-ar-brand bg-ar-surface text-ar-text"
      data-testid="days-badge"
      role="img"
    >
      {days === 0 ? (
        <span className="px-1 text-center text-xs font-semibold leading-tight">
          {messages.schedule.today}
        </span>
      ) : (
        <>
          <span className="text-xl font-semibold leading-none">{days}</span>
          {/* The unit form agrees with the number: "1 Tag", "2 Tage", "5 днів". */}
          <span className="text-[0.65rem] text-ar-text-muted">{dayUnitLabel(locale, days)}</span>
        </>
      )}
    </div>
  );
};

const NextCollection = ({
  schedule,
  className = '',
}: {
  readonly schedule: AcceptedSchedule;
  readonly className?: string;
}) => {
  const { locale, messages } = useLocale();
  const event = nextCollection(schedule);

  if (event === null) {
    return null;
  }

  const days = daysBetween(schedule.sourceToday, event.date);
  /*
   * The collection day itself replaces the count, not the card: what is due stays where it was, and only
   * the indicator changes from "how far away" to "under way". A count of zero days and a badge reading
   * "today" say less than the status does, and a published window keeps its own count.
   */
  const inProgress = isCollectionInProgress(event, schedule.sourceToday);
  const window =
    event.collectionMode === 'mobile_drop_off'
      ? formatCollectionWindow(event.timing, messages.window)
      : null;

  return (
    <section
      aria-labelledby="next-collection-heading"
      /*
       * Wrapping, not fixed: at 200% text zoom on a 320 px screen the badge and the label column no
       * longer fit on one line, and the card is allowed to become two rows rather than push the page
       * sideways.
       */
      className={`@container flex flex-wrap items-center gap-x-4 gap-y-3 rounded-ar-xl border border-ar-border bg-ar-brand-soft p-4 sm:p-5 ${className}`}
      data-testid="next-collection"
    >
      {/* The day count keeps the leading slot; today's status is a separate area at the end of the card. */}
      {inProgress ? null : <DaysBadge days={days} />}
      {/*
        The content column carries a `rem` basis rather than `flex-1`: a zero basis would never let the
        line overflow, so the status would be squeezed into a sliver beside it instead of wrapping. With
        a basis that grows with the text size, a narrow or enlarged card puts the status on its own row.
      */}
      <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1">
        {/*
          One step up the existing scale on the collection day — `text-sm` here and `text-base` on the
          date below — so the three rows hold their side of a card whose other side carries the stamp.
          Both stay under the waste type's `text-lg` and keep the muted colour, so the type is still the
          primary line and these are still secondary. Any other day the card is unchanged.
        */}
        <h3
          className={`${inProgress ? 'text-sm' : 'text-xs'} font-medium break-words uppercase tracking-wide text-ar-text-muted`}
          id="next-collection-heading"
        >
          {messages.provenance.nextCollection}
        </h3>
        <div className="flex min-w-0 items-center gap-2">
          <WasteIcon type={event.type} />
          <span className="min-w-0 break-words text-lg font-semibold text-ar-text">
            {messages.waste[event.type]}
          </span>
        </div>
        {/*
          A relative label says how far away the day is, not which day it is, so the weekday joins the
          date beside it. Past the relative window the first part is already the weekday-bearing
          fallback, and the date stays as it was rather than naming the weekday twice.

          On the collection day there is no relative label at all: the status above has already said
          today, so the weekday and the date stand on their own instead of repeating it.
        */}
        <span
          className={`${inProgress ? 'text-base' : 'text-sm'} text-ar-text-muted`}
          data-testid="next-collection-date"
        >
          {inProgress ? (
            formatWeekdayCalendarDate(locale, event.date)
          ) : (
            <>
              {formatRelativeDay(locale, event.date, schedule.sourceToday)} ·{' '}
              {isRelativeDay(event.date, schedule.sourceToday)
                ? formatWeekdayCalendarDate(locale, event.date)
                : formatCalendarDate(locale, event.date)}
            </>
          )}
        </span>
        {/*
          The published window and place, because this event no longer has a row below to carry them.
          Removing the duplicate row must not remove information that only the row used to show.
        */}
        {window === null ? null : (
          <span className="text-sm break-words text-ar-text-muted">
            <span aria-hidden="true">{window.text}</span>
            <span className="sr-only">{window.accessibleLabel}</span>
          </span>
        )}
        {event.collectionMode === 'mobile_drop_off' ? (
          <span className="text-sm break-words text-ar-text-muted">{event.location.name}</span>
        ) : null}
      </div>
      {/*
        The status area: at the end of the card, centred against the collection beside it, and read after
        it. One text node, in the interface language, given a stamp's treatment rather than a second copy
        of itself — the outline, the wash and the tilt are all presentation, so what a screen reader
        reads is the same sentence at every size.

        The three steps are **container** queries in `rem`, not viewport breakpoints, because what
        decides whether a stamp fits is the card's width measured against the text size. At 320 and
        390 px, and at any width with 200 % text — where the card offers its content as little as 190 px
        and `Вивезення` alone measures 165 px — none of the thresholds is met and the status stays plain,
        upright text that wraps between its words. A viewport breakpoint would have put a 36 px stamp
        into a 272 px card at 1280 px with enlarged text.
      */}
      {inProgress ? (
        <p
          className="ms-auto max-w-full text-end text-lg font-semibold break-words text-ar-text @min-[26rem]:-rotate-3 @min-[26rem]:rounded-ar-md @min-[26rem]:border-2 @min-[26rem]:border-ar-brand @min-[26rem]:bg-ar-brand/10 @min-[26rem]:px-4 @min-[26rem]:py-2 @min-[26rem]:text-center @min-[26rem]:text-2xl @min-[38rem]:-rotate-[5deg] @min-[38rem]:px-6 @min-[38rem]:py-3 @min-[38rem]:text-4xl @min-[38rem]:tracking-wide"
          data-testid="collection-status"
        >
          {messages.schedule.inProgress}
        </p>
      ) : null}
    </section>
  );
};

interface Remaining {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
}

/** Whole units, floored, so nothing is ever rounded up into a day that has not arrived. */
const splitRemaining = (milliseconds: number): Remaining => {
  const minutesTotal = Math.floor(milliseconds / 60_000);

  return {
    days: Math.floor(minutesTotal / (60 * 24)),
    hours: Math.floor(minutesTotal / 60) % 24,
    minutes: minutesTotal % 60,
  };
};

/**
 * A minute-precision clock that costs one timer and no requests.
 *
 * It ticks on the **next minute boundary** rather than every sixty seconds from mount, so the display
 * changes when the minute does. A backgrounded tab throttles timers, so returning to the page
 * recalculates immediately instead of showing whatever was last painted. Nothing here touches the
 * controller, the gateway, or the schedule.
 */
const useMinuteClock = (): Date => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const schedule = (): void => {
      const current = new Date();

      setNow(current);
      timer = setTimeout(schedule, 60_000 - (current.getTime() % 60_000));
    };

    schedule();

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        schedule();
      }
    };

    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return now;
};

const CountdownUnit = ({ value, label }: { readonly value: number; readonly label: string }) => (
  <div className="flex min-w-14 flex-col items-center rounded-ar-md bg-ar-surface-muted px-2 py-1.5">
    <span className="text-lg font-semibold leading-none text-ar-text tabular-nums">{value}</span>
    <span className="text-[0.65rem] text-ar-text-muted">{label}</span>
  </div>
);

/**
 * The countdown to the next collection that is still ahead.
 *
 * Its target is derived from the ordered schedule independently of the featured card, so on a collection
 * day the card keeps today's collection while this counts to the next one. What it is counting to is
 * named here — the waste types and the day — because that is no longer, by definition, the card above.
 *
 * Hidden only when the target instant cannot be derived. Nothing further published is a statement the
 * panel makes in words; it is never a row of zeros, and no pickup time is invented for a day the source
 * gave no time for.
 */
export const CountdownPanel = ({
  schedule,
  className = '',
}: {
  readonly schedule: AcceptedSchedule;
  readonly className?: string;
}) => {
  const { messages } = useLocale();
  const now = useMinuteClock();
  const outcome = nextCountdownTarget(
    schedule.events,
    schedule.sourceToday,
    schedule.meta.source.timeZone,
    now,
  );

  if (outcome.kind === 'undeterminable') {
    return null;
  }

  return (
    <section
      aria-labelledby="countdown-heading"
      className={`flex flex-col gap-2 rounded-ar-xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm ${className}`}
      data-testid="countdown-panel"
    >
      <h3
        className="text-xs font-semibold uppercase tracking-wide text-ar-text-muted"
        id="countdown-heading"
      >
        {messages.countdown.heading}
      </h3>
      {outcome.kind === 'no_future_collection' ? (
        <p className="text-sm break-words text-ar-text" data-testid="countdown-none">
          {messages.countdown.noFurtherDates}
        </p>
      ) : (
        <CountdownToTarget now={now} target={outcome.target} />
      )}
    </section>
  );
};

/**
 * The remaining time, and what it is remaining until.
 *
 * The target is clamped at zero rather than allowed to go negative: the source date can turn over a
 * moment before the watchdog republishes it, and a count of "-1 min" would be the only wrong thing on
 * the screen in that second.
 */
const CountdownToTarget = ({
  target,
  now,
}: {
  readonly target: CountdownTarget;
  readonly now: Date;
}) => {
  const { locale, messages } = useLocale();
  const { days, hours, minutes } = splitRemaining(Math.max(target.at.getTime() - now.getTime(), 0));
  /*
   * One date, one countdown, however many bins go out on it: the types are named together in the
   * language's own list form. Repeated types are named once — two collections of one type on a single
   * day are one answer to "what is next", not two.
   */
  const names = formatNameList(locale, [
    ...new Set(target.events.map((event) => messages.waste[event.type])),
  ]);

  return (
    <>
      <p className="text-sm break-words text-ar-text" data-testid="countdown-target">
        <span className="font-semibold">{names}</span>
        <span className="text-ar-text-muted">
          {' · '}
          {formatWeekdayCalendarDate(locale, target.events[0].date)}
        </span>
      </p>
      {/*
        Wrapping, so three fixed-width units cannot become a floor the page has to widen for: at
        200% text zoom on a 320 px screen they occupy more than the column and break onto a
        second line instead.
      */}
      <div className="flex flex-wrap items-stretch gap-2">
        {/* The day label agrees with its own number here too: "1 Tag", "2 Tage", "5 днів". */}
        <CountdownUnit label={dayUnitLabel(locale, days)} value={days} />
        <CountdownUnit label={messages.countdown.hours} value={hours} />
        <CountdownUnit label={messages.countdown.minutes} value={minutes} />
      </div>
      <p className="text-xs text-ar-text-muted">
        {target.dateOnly ? messages.countdown.untilDayStarts : messages.countdown.untilStart}
      </p>
    </>
  );
};

export const Provenance = ({
  schedule,
  className = '',
}: {
  readonly schedule: AcceptedSchedule;
  readonly className?: string;
}) => {
  const { locale, messages } = useLocale();
  const { meta } = schedule;

  /*
   * An ordinary section, not a disclosure. Where a schedule came from, how fresh it is, and which waste
   * types the source actually publishes are qualifications on the schedule above — somebody who has to
   * open something to find them can act on the data without ever seeing them.
   */
  return (
    <section
      aria-labelledby="provenance-heading"
      className={`flex flex-col gap-1 rounded-ar-xl border border-ar-border bg-ar-surface p-4 text-sm shadow-ar-sm ${className}`}
      data-testid="provenance"
    >
      <h3
        className="text-xs font-semibold uppercase tracking-wide text-ar-text-muted"
        id="provenance-heading"
      >
        {messages.provenance.details}
      </h3>
      <p className="font-medium text-ar-text">{meta.source.name}</p>
      <p className="text-ar-text-muted">{meta.source.attribution}</p>
      <p>
        <a
          className="text-ar-brand underline"
          href={meta.source.landingPageUrl}
          rel="noreferrer noopener"
          target="_blank"
        >
          {messages.provenance.openSource}
        </a>
      </p>
      <p className="text-ar-text-muted">
        {messages.provenance.retrieved}: {formatInstant(locale, meta.retrievedAt)} UTC ·{' '}
        {meta.freshness === 'stale' ? messages.provenance.stale : messages.provenance.fresh}
      </p>
      <p className="text-ar-text-muted">
        {messages.provenance.shownPeriod}: {formatCalendarDate(locale, schedule.range.from)} –{' '}
        {formatCalendarDate(locale, schedule.range.to)}
      </p>
      <p className="text-ar-text-muted">
        {messages.provenance.publishedWasteTypes}:{' '}
        {meta.coverage.wasteTypes.map((type) => messages.waste[type]).join(', ')}
      </p>
    </section>
  );
};

/**
 * One collection in the list.
 *
 * A grid, not a wrapping flex row. The earlier row top-aligned everything (`items-start`), which put a
 * one-line title 8 px above the card's centre beside the taller icon, and it wrapped (`flex-wrap`), and
 * because flex items wrap before they shrink, a long localized title dropped the whole icon-and-title
 * group underneath the date instead of wrapping inside its own column. Here the date, the icon and the
 * title share one row track and are centred on it, and the title's column is `minmax(0, 1fr)`, so a long
 * title wraps inside that column and nothing ever moves under the date.
 *
 * A drop-off's published window and place sit in a second track under the title, in the same column, so
 * the icon stays level with the title rather than with the middle of the whole block.
 *
 * The three-column arrangement is a **container** query in `rem`. Text zoom scales `rem`, so at 200 % on
 * a narrow screen — where a date column, an icon and a title no longer fit side by side — the date moves
 * to its own line above the icon and title instead of pushing the card sideways.
 */
const EventRow = ({
  event,
  sourceToday,
  locale,
  messages,
}: {
  readonly event: CollectionEvent;
  readonly sourceToday: string;
  readonly locale: Parameters<typeof formatCalendarDate>[0];
  readonly messages: Messages;
}) => {
  const window =
    event.collectionMode === 'mobile_drop_off'
      ? formatCollectionWindow(event.timing, messages.window)
      : null;

  return (
    <li
      className="@container rounded-ar-md border border-ar-border bg-ar-surface px-3 py-2.5"
      data-testid="event-row"
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 @min-[14rem]:grid-cols-[5.5rem_auto_minmax(0,1fr)]">
        {/*
          The date, once: the numeric day on its own line, and under it the weekday — with the relative
          label only while it says something the date does not (today, tomorrow, in N days). Past that
          window the weekday stands alone; the day and month are already the line above.
        */}
        <div className="col-span-2 row-start-1 flex min-w-0 flex-col @min-[14rem]:col-span-1">
          <time
            className="whitespace-nowrap text-sm font-medium text-ar-text tabular-nums"
            dateTime={event.date}
          >
            {formatCompactDate(event.date)}
          </time>
          {/*
            Weekday and relative label as two unbreakable pieces, so a narrow column wraps between them
            ("Di. ·" / "in 5 Tagen") rather than inside either — and never touches the numeric date above.
          */}
          {/*
            The weekday is abbreviated only beside a numeric label ("Mi. · in 6 Tagen"), where the line
            is already long; beside a word ("Mittwoch · morgen") or on its own ("Mittwoch") it is
            written out.
          */}
          <span className="text-xs text-ar-text-muted" data-testid="event-row-day">
            {isRelativeDay(event.date, sourceToday) ? (
              <>
                <span className="whitespace-nowrap">
                  {isNumericRelativeDay(locale, event.date, sourceToday)
                    ? formatWeekday(locale, event.date)
                    : formatLongWeekday(locale, event.date)}{' '}
                  ·
                </span>{' '}
                <span className="whitespace-nowrap">
                  {formatRelativeDay(locale, event.date, sourceToday)}
                </span>
              </>
            ) : (
              <span className="whitespace-nowrap">{formatLongWeekday(locale, event.date)}</span>
            )}
          </span>
        </div>

        <div className="col-start-1 row-start-2 @min-[14rem]:col-start-2 @min-[14rem]:row-start-1">
          <WasteIcon type={event.type} />
        </div>

        {/*
          The title and a drop-off's details as one content group. `contents` keeps them one element in
          the document while letting the grid place the title level with the icon and the details under it.
        */}
        <div className="contents">
          <span
            className="col-start-2 row-start-2 min-w-0 break-words font-medium text-ar-text @min-[14rem]:col-start-3 @min-[14rem]:row-start-1"
            data-testid="event-row-title"
          >
            {messages.waste[event.type]}
          </span>

          {event.collectionMode === 'mobile_drop_off' ? (
            <div
              className="col-start-2 row-start-3 flex min-w-0 flex-col gap-0.5 self-start text-sm break-words text-ar-text-muted @min-[14rem]:col-start-3 @min-[14rem]:row-start-2"
              data-testid="event-row-details"
            >
              {window === null ? null : (
                <p>
                  {/* The compact form for sighted readers, and an unambiguous spoken form beside it. */}
                  <span aria-hidden="true">{window.text}</span>
                  <span className="sr-only">{window.accessibleLabel}</span>
                </p>
              )}
              <p>{event.location.name}</p>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
};

/**
 * The schedule and its secondary information.
 *
 * Two columns from `lg` upward — the schedule leads, the countdown and the source sit beside it — and
 * one column below that, with the countdown directly above the source section under the schedule. The
 * source section is always visible: what the source does and does not publish qualifies the schedule
 * above it, so it is not something to hide behind a disclosure.
 */
/**
 * The schedule and its secondary information.
 *
 * One grid, one DOM order, and one mounted countdown. Below 1280 px it is a single column reading
 * countdown → next collection → the list → the source, so the time remaining is the first thing a phone
 * or a tablet shows; from 1280 px the same four elements are placed into two columns, with the countdown
 * back above the source on the right. Placement is CSS, never a second copy of the panel: a duplicate
 * would mean a duplicate minute timer, and hiding one with `display: none` would still run it.
 *
 * `grid-flow-dense` covers the case where the countdown has nothing to count — the source card then
 * backfills the top of the right column instead of leaving a hole above itself.
 */
export const ScheduleSurface = ({ schedule }: { readonly schedule: AcceptedSchedule }) => {
  const { locale, messages } = useLocale();
  const featured = nextCollection(schedule);
  /*
   * The list is everything the hero is not showing.
   *
   * Filtered by the featured event's own identifier, so another collection on the same day or of the
   * same type keeps its row, and the order of what remains is the order the schedule already had. The
   * schedule itself is untouched — this is a second reading of the same array, which is what keeps the
   * countdown, the counts and the source metadata working from the original.
   */
  const rest =
    featured === null
      ? schedule.events
      : schedule.events.filter((event) => event.id !== featured.id);

  return (
    <div className="grid gap-3 xl:grid-flow-row-dense xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start xl:gap-4">
      {/*
        `self-stretch` on the two panels of the first row, not `items-stretch` on the grid: the row below
        pairs the event list with the source panel, and stretching that one would leave the source card
        as tall as the whole schedule. Stretched, the pair shares the taller natural height, and the
        featured card centres its own content within it.
      */}
      <CountdownPanel
        className="min-w-0 xl:col-start-2 xl:row-start-1 xl:self-stretch"
        schedule={schedule}
      />

      <NextCollection
        className="min-w-0 xl:col-start-1 xl:row-start-1 xl:self-stretch"
        schedule={schedule}
      />

      {/* No empty container when the featured collection was the only one the source published. */}
      {rest.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col gap-1.5 xl:col-start-1 xl:row-start-2">
          {rest.map((event) => (
            <EventRow
              event={event}
              key={event.id}
              locale={locale}
              messages={messages}
              sourceToday={schedule.sourceToday}
            />
          ))}
        </ul>
      )}

      <Provenance className="min-w-0 xl:col-start-2" schedule={schedule} />
    </div>
  );
};
