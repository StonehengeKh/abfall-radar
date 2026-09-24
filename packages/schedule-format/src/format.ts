import type { Locale } from './locale';
import { daysBetween, type IsoDate, RELATIVE_LABEL_WINDOW_DAYS } from './source-day';

/**
 * Locale-aware presentation of dates the application already decided on.
 *
 * Presentation only, and deliberately downstream of every decision: which day an event belongs to and
 * which day is "today" in the provider's zone are derived elsewhere, from the source time zone, with a
 * fixed internal formatter. Changing the interface language changes wording, never a date.
 *
 * `Intl` does the counting. `Intl.RelativeTimeFormat` with `numeric: 'auto'` produces "heute",
 * "tomorrow", "через 2 дні", "через 5 дней" — each locale's own plural form — where concatenating a
 * number to a noun would be wrong in Ukrainian and Russian, which have three.
 */

/** An event's calendar day is already source-local, so it is formatted in UTC to keep it that day. */
const dateFormatter = (locale: Locale): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' });

const weekdayFormatter = (locale: Locale): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

/** The retrieval instant is a real moment, shown in UTC so it never claims a zone it was not read in. */
const instantFormatter = (locale: Locale): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

export const formatCalendarDate = (locale: Locale, date: IsoDate): string =>
  dateFormatter(locale).format(new Date(`${date}T00:00:00Z`));

/**
 * A formatted value that is about to end a sentence, given exactly one full stop.
 *
 * Ukrainian and Russian medium dates carry the year abbreviation's own period — `23 вер. 2026 р.` and
 * `23 сент. 2026 г.` — so a template writing `${date}.` renders `р..` and `г..`. German
 * (`23. Sept. 2026`) and English (`Sep 23, 2026`) end in a digit and must still gain one.
 *
 * The period therefore belongs to the **value**, not to the template. Nothing about `formatCalendarDate`
 * changes: the same date in the middle of a sentence must not acquire a period, so this is applied where
 * a sentence actually ends rather than by trimming the formatter's output everywhere.
 */
export const withSentencePeriod = (formatted: string): string =>
  /[.!?…]$/u.test(formatted) ? formatted : `${formatted}.`;

/**
 * `18.09.2026` — the same numeric form in every interface language.
 *
 * A deliberate exception to localized presentation, and only in the schedule list, where a date sits in
 * a narrow fixed column beside every row. The localized medium forms are the wrong tool there: they run
 * from `14 Aug 2026` to `14 серп. 2026 р.`, so the column either wraps, shrinks, or ends in a trailing
 * era word that carries no information at this size. The prominent next-collection card still shows the
 * localized date, where there is room for it to be read as a sentence.
 *
 * `de-DE` is the formatter, not the locale: it is the shortest unambiguous numeric spelling with a
 * four-digit year and no trailing word. `timeZone: 'UTC'` keeps the already-source-local day on its own
 * day, exactly as `formatCalendarDate` does.
 */
const compactDateFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export const formatCompactDate = (date: IsoDate): string =>
  compactDateFormatter.format(new Date(`${date}T00:00:00Z`));

export const formatInstant = (locale: Locale, isoInstant: string): string =>
  instantFormatter(locale).format(new Date(isoInstant));

/**
 * `today`, `tomorrow`, `in N days`, or the absolute date once the relative window has passed.
 *
 * The window is the same in every locale, because it is a product decision about when a relative label
 * stops being clearer than a date — not a language one.
 */
const relativeFormatter = (locale: Locale): Intl.RelativeTimeFormat =>
  new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

export const formatRelativeDay = (
  locale: Locale,
  eventDate: IsoDate,
  sourceToday: IsoDate,
): string => {
  if (isRelativeDay(eventDate, sourceToday)) {
    return relativeFormatter(locale).format(daysBetween(sourceToday, eventDate), 'day');
  }

  return weekdayFormatter(locale).format(new Date(`${eventDate}T00:00:00Z`));
};

/**
 * Whether `formatRelativeDay` answers with a relative label — today, tomorrow, in N days — rather than
 * its absolute fallback.
 *
 * The fallback already names the weekday, so a caller adding one beside a relative label asks this
 * first and never says it twice. One rule, used by both, so the two cannot disagree about the window.
 */
export const isRelativeDay = (eventDate: IsoDate, sourceToday: IsoDate): boolean => {
  const difference = daysBetween(sourceToday, eventDate);

  return difference >= 0 && difference < RELATIVE_LABEL_WINDOW_DAYS;
};

/**
 * Whether the relative label is a **number** — "in 6 Tagen" — rather than a word such as "heute",
 * "morgen" or "übermorgen".
 *
 * Asked of `Intl` itself: a numeric label is exactly one that `formatToParts` returns with an `integer`
 * part. Neither the translated text nor a day count is consulted — the count would be wrong, because
 * German, Ukrainian and Russian have a word for two days away while English says "in 2 days".
 */
export const isNumericRelativeDay = (
  locale: Locale,
  eventDate: IsoDate,
  sourceToday: IsoDate,
): boolean =>
  isRelativeDay(eventDate, sourceToday) &&
  relativeFormatter(locale)
    .formatToParts(daysBetween(sourceToday, eventDate), 'day')
    .some((part) => part.type === 'integer');

/**
 * The short weekday of a source-local calendar day: `Fr.`, `Fri`, `пт`.
 *
 * Taken from the **same combined pattern** the absolute fallback uses (`Do., 8. Okt.`), not from a
 * standalone weekday format. CLDR abbreviates a weekday differently on its own than inside a date —
 * German gives `Do` alone but `Do.` in context — so reading it from the shared pattern is what keeps the
 * new label and the existing fallback spelling the same day the same way.
 *
 * Formatted in UTC from the date string, exactly as every other calendar day here is, so the weekday is
 * the municipality's and a device in another zone cannot move it to the day before or after.
 */
const weekdayParts = (locale: Locale, date: IsoDate): Intl.DateTimeFormatPart[] =>
  weekdayFormatter(locale).formatToParts(new Date(`${date}T00:00:00Z`));

export const formatWeekday = (locale: Locale, date: IsoDate): string =>
  weekdayParts(locale, date).find((part) => part.type === 'weekday')?.value ?? '';

/**
 * The locale's own joint between a weekday and the date that follows it, read from the same pattern
 * instead of assumed — the comma after `Fr.` is a convention of these locales, not of the application.
 */
const weekdayJoint = (locale: Locale, date: IsoDate): string => {
  const parts = weekdayParts(locale, date);
  const next = parts[parts.findIndex((part) => part.type === 'weekday') + 1];

  return next?.type === 'literal' ? next.value : ', ';
};

/**
 * The full weekday of a source-local calendar day: `Mittwoch`, `Wednesday`, `середа`, `среда`.
 *
 * In UTC from the date string, like every calendar day here. The standalone and in-date forms are
 * identical in all four shipped locales, so no combined pattern is needed for the long form.
 */
const longWeekdayFormatter = (locale: Locale): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long' });

export const formatLongWeekday = (locale: Locale, date: IsoDate): string =>
  longWeekdayFormatter(locale).format(new Date(`${date}T00:00:00Z`));

/**
 * The card's calendar date with its weekday in front — `Fr., 18.09.2026`, `Fri, Sep 18, 2026` — keeping
 * each locale's existing medium date exactly as it was and only adding what was missing.
 */
export const formatWeekdayCalendarDate = (locale: Locale, date: IsoDate): string =>
  `${formatWeekday(locale, date)}${weekdayJoint(locale, date)}${formatCalendarDate(locale, date)}`;

/**
 * A day count with the unit form that agrees with it.
 *
 * `Intl.NumberFormat` in unit style produces "1 Tag" and "2 Tage", "1 day" and "2 days", and the three
 * Ukrainian and Russian forms — which is why the number is never concatenated with one fixed plural
 * string. `formatToParts` separates the two so a badge can stack them, still grammatically agreed.
 */
const dayFormatter = (locale: Locale): Intl.NumberFormat =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: 'day', unitDisplay: 'long' });

export const formatDayCount = (locale: Locale, days: number): string =>
  dayFormatter(locale).format(days);

export const dayUnitLabel = (locale: Locale, days: number): string =>
  dayFormatter(locale)
    .formatToParts(days)
    .filter((part) => part.type === 'unit')
    .map((part) => part.value)
    .join('');

/**
 * Names joined the way the language joins them: `Gelber Sack und Altpapier`, `paper and bio`,
 * `папір і біовідходи`.
 *
 * `Intl.ListFormat`, not a comma and a hard-coded conjunction: the separator, the conjunction and
 * whether the last pair takes one differ per language, and the shipped locales do not agree on any of
 * them. A single name is returned unchanged, which is what the formatter does with a one-element list.
 */
const listFormatter = (locale: Locale): Intl.ListFormat =>
  new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });

export const formatNameList = (locale: Locale, names: readonly string[]): string =>
  listFormatter(locale).format(names);
