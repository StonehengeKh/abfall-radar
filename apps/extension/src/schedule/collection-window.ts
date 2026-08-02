import type { MobileDropOffCollectionEvent } from '@abfall-radar/domain';

/**
 * How a mobile drop-off window is written, in one place.
 *
 * Two surfaces state this window — the dashboard renders it, and the reminder puts it in a notification — and
 * they must not word or localize it differently. A person reading "10:00–14:00" on the popup and something else
 * in the notification about the same drop-off has to work out which one to trust, and only one of them is
 * unprompted and telling them to be somewhere.
 *
 * It lives here rather than beside either caller because the worker must not import popup UI: a notification is
 * built in the service worker, and reaching into a React module for a string would pull the whole surface into
 * that bundle.
 *
 * The zone is the **source's**, never the device's. A drop-off is an appointment at a place, so the time a person
 * has to be there is the operator's local time; formatting it in the device zone would name an hour to travel by
 * that is wrong for anyone whose device is set elsewhere. The identifier is part of the string for the same
 * reason: a time without its zone is not actionable.
 */

export type CollectionWindow = MobileDropOffCollectionEvent['timing'];

/**
 * The two ends of a window, each formatted on its own.
 *
 * `hour` and `minute` are named explicitly rather than asking for a `timeStyle`: the parts wanted here are exactly
 * an hour and a minute, and a style is a request for whatever the locale considers short — which is free to
 * include a second, or a zone abbreviation, in a future ICU. Naming the fields keeps the string this produces
 * decided here instead of by the runtime's idea of brevity.
 *
 * The formatted values are never taken apart again. Nothing here parses `Intl` output: the window is assembled
 * from two formatted ends and the zone identifier, so no assumption is made about what the locale put between an
 * hour and a minute or in which order.
 */
const windowFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone });

/**
 * `HH:MM–HH:MM (Zone)` in the zone the source published, or `null` when it cannot be produced.
 *
 * Both boundaries an event can arrive through — the transport client and the worker message contract — validate
 * the timing zone with the usable-zone check, so a validated event formats. `null` is therefore not an expected
 * outcome but a **defect** outcome, and it exists because the two callers must not deal with a defect the same
 * way: a dashboard row can omit a line, while a notification that lost its window and place would be reduced to
 * telling someone to act with nothing to act on.
 *
 * Returning it rather than throwing is what lets each caller decide. A throw from here would escape into a React
 * render on one side and into an alarm handler on the other, and in an alarm handler a rejection is invisible.
 */
export const formatCollectionWindow = (timing: CollectionWindow): string | null => {
  try {
    const time = windowFormatter(timing.timeZone);
    const startsAt = new Date(timing.startsAt);
    const endsAt = new Date(timing.endsAt);

    // Checked rather than left to the `catch`: `Intl.format` does throw a `RangeError` on an invalid instant, so
    // the guard below would also cover it, but an unparsable window is a decision this function makes rather than
    // an exception it recovers from — and stating it here is what keeps the two ends symmetrical.
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return null;
    }

    return `${time.format(startsAt)}–${time.format(endsAt)} (${timing.timeZone})`;
  } catch {
    // A zone `Intl` refuses. Nothing about the rejection is surfaced: it is the runtime's message about data this
    // build already validated, so it says nothing a caller could act on.
    return null;
  }
};
