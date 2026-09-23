import type { CollectionEvent } from '@abfall-radar/domain';
import {
  formatCollectionWindow,
  formatCompactDate,
  formatLongWeekday,
  formatRelativeDay,
  formatWeekday,
  isNumericRelativeDay,
  isRelativeDay,
} from '@abfall-radar/schedule-format';
import { WasteIcon } from '../waste-icon';
import type { ScheduleCopy } from './types';

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
export const EventRow = ({
  event,
  sourceToday,
  locale,
  messages,
}: {
  readonly event: CollectionEvent;
  readonly sourceToday: string;
} & ScheduleCopy) => {
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
