import { addCalendarDays, type IsoDate } from '@abfall-radar/schedule-format';
import type { ScheduleRange } from '@/src/adapters/schedule-gateway';

/** A product choice, not a contract constraint. */
export const TARGET_WINDOW_DAYS = 90;

export type TargetRange =
  | { readonly kind: 'requestable'; readonly range: ScheduleRange }
  /** Source-local today lies past the declared validity: the source publishes nothing for now. */
  | { readonly kind: 'past_validity' }
  /** Clamping into the declared window leaves no requestable intersection. */
  | { readonly kind: 'no_intersection' };

/**
 * The range to request: 90 calendar days from `sourceToday`, clamped into the declared validity.
 *
 * Calendar arithmetic only. It takes an already-derived source date and has no clock, no zone, and no
 * time-zone failure of its own — those belong to `deriveSourceToday`, and when that fails this is never
 * called.
 */
export const deriveTargetRange = (
  sourceToday: IsoDate,
  validity: { readonly from: IsoDate; readonly to: IsoDate },
): TargetRange => {
  if (sourceToday > validity.to) {
    return { kind: 'past_validity' };
  }

  const windowEnd = addCalendarDays(sourceToday, TARGET_WINDOW_DAYS);
  const from = sourceToday > validity.from ? sourceToday : validity.from;
  const to = windowEnd < validity.to ? windowEnd : validity.to;

  if (from > to) {
    return { kind: 'no_intersection' };
  }

  return { kind: 'requestable', range: { from, to } };
};
