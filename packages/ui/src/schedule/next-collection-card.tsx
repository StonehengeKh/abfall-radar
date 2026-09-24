import {
  daysBetween,
  dayUnitLabel,
  featuredCollection,
  formatCalendarDate,
  formatCollectionWindow,
  formatDayCount,
  formatRelativeDay,
  formatWeekdayCalendarDate,
  isCollectionInProgress,
  isRelativeDay,
} from '@abfall-radar/schedule-format';
import { WasteIcon } from '../waste-icon';
import { CalculatedBadge } from './calculated-badge';
import type { ScheduleCopy, ScheduleView } from './types';

/**
 * A circular badge showing whole days until the collection.
 *
 * The number is `daysBetween` on the same two source-local dates every other label uses — not a
 * percentage, not a proportion of anything, and nothing invented to fill a ring. The ring is a plain
 * border, so there is no progress value for it to misrepresent.
 */
const DaysBadge = ({ days, locale, messages }: { readonly days: number } & ScheduleCopy) => {
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

/**
 * The featured collection: the next one on or after the source's today.
 *
 * On the collection day of an all-day collection the day count gives way to the collection-day status,
 * a calendar statement rather than vehicle tracking. A published drop-off window keeps its count.
 */
export const NextCollectionCard = ({
  view,
  locale,
  messages,
  className = '',
}: {
  readonly view: ScheduleView;
  readonly className?: string;
} & ScheduleCopy) => {
  const event = featuredCollection(view.events, view.sourceToday);

  if (event === null) {
    return null;
  }

  const days = daysBetween(view.sourceToday, event.date);
  /*
   * The collection day itself replaces the count, not the card: what is due stays where it was, and only
   * the indicator changes from "how far away" to "under way". A count of zero days and a badge reading
   * "today" say less than the status does, and a published window keeps its own count.
   */
  const inProgress = isCollectionInProgress(event, view.sourceToday);
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
      {inProgress ? null : <DaysBadge days={days} locale={locale} messages={messages} />}
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
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <WasteIcon type={event.type} />
          <span className="min-w-0 text-lg font-semibold text-ar-text wrap-anywhere">
            {messages.waste[event.type]}
          </span>
          {/* The same mark the rows carry: featured or not, a calculated collection says so. */}
          {event.source === 'user_rule' ? <CalculatedBadge messages={messages} /> : null}
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
              {formatRelativeDay(locale, event.date, view.sourceToday)} ·{' '}
              {isRelativeDay(event.date, view.sourceToday)
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
