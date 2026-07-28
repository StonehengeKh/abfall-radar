import { differenceInCalendarDays, format, isBefore, parseISO, startOfDay } from 'date-fns';
import { de } from 'date-fns/locale';
import type { CollectionEvent } from './waste';

export const getUpcomingEvents = (
  events: CollectionEvent[],
  referenceDate = new Date(),
): CollectionEvent[] => {
  const today = startOfDay(referenceDate);

  return events
    .filter((event) => !isBefore(parseISO(event.date), today))
    .toSorted((left, right) => left.date.localeCompare(right.date));
};

export const getRelativeDateLabel = (date: string, referenceDate = new Date()): string => {
  const difference = differenceInCalendarDays(parseISO(date), startOfDay(referenceDate));

  if (difference === 0) {
    return 'Heute';
  }

  if (difference === 1) {
    return 'Morgen';
  }

  if (difference > 1 && difference < 7) {
    return `In ${difference} Tagen`;
  }

  return format(parseISO(date), 'EEE, d. MMM', { locale: de });
};

export const findReminderEvent = (
  events: CollectionEvent[],
  reminderDaysBefore: number,
  referenceDate = new Date(),
): CollectionEvent | undefined => {
  const candidates = getUpcomingEvents(events, referenceDate);

  return candidates.find(
    (event) =>
      differenceInCalendarDays(parseISO(event.date), startOfDay(referenceDate)) ===
      reminderDaysBefore,
  );
};
