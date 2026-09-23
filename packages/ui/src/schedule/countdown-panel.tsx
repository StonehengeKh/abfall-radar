import {
  type CountdownTarget,
  dayUnitLabel,
  formatNameList,
  formatWeekdayCalendarDate,
  nextCountdownTarget,
} from '@abfall-radar/schedule-format';
import { useEffect, useState } from 'react';
import type { ScheduleCopy, ScheduleView } from './types';

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
export const useMinuteClock = (): Date => {
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
export const CountdownPanel = (
  props: {
    readonly view: ScheduleView;
    readonly className?: string;
  } & ScheduleCopy,
) => {
  const now = useMinuteClock();

  return <CountdownPanelAt {...props} now={now} />;
};

/**
 * The same panel, read at an instant the caller supplies instead of from a clock of its own.
 *
 * For a surface that already runs one minute clock for other reasons — the extension derives the source's
 * today from it, so its featured card turns over at midnight too — and must not run a second.
 */
export const CountdownPanelAt = ({
  view,
  locale,
  messages,
  now,
  className = '',
}: {
  readonly view: ScheduleView;
  readonly now: Date;
  readonly className?: string;
} & ScheduleCopy) => {
  const outcome = nextCountdownTarget(view.events, view.sourceToday, view.timeZone, now);

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
        <CountdownToTarget locale={locale} messages={messages} now={now} target={outcome.target} />
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
  locale,
  messages,
}: {
  readonly target: CountdownTarget;
  readonly now: Date;
} & ScheduleCopy) => {
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
