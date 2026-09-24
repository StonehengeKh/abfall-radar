import {
  type CollectionEvent,
  type HouseholdBinSetup,
  type HouseholdCollectionRules,
  type IsoWeekday,
  type WasteType,
  wasteLabels,
} from '@abfall-radar/domain';
import { addCalendarDays, type IsoDate } from './source-day';

/**
 * Calculating the two household bins the municipality publishes no calendar for.
 *
 * Pure arithmetic over published rules: no request, no parsing, no storage, no clock. The rules arrive
 * from the server, the weekday from the person, and the range from the surface asking — so the same
 * three inputs produce the same dates in the popup, on the website and in a reminder.
 *
 * What makes this honest rather than plausible is where it **stops**. The municipality publishes the
 * holiday replacements one year at a time; past the end of that table nobody can say whether a week is
 * moved. This reports that boundary instead of extrapolating across it, because a generated date is
 * indistinguishable from a transcribed one once it is on screen.
 */

/** The ISO week number and its year, which is not always the calendar year of the date. */
interface IsoWeek {
  readonly year: number;
  readonly week: number;
  readonly weekday: IsoWeekday;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parses `YYYY-MM-DD` into UTC midnight.
 *
 * UTC deliberately: these are calendar dates, and the moment a date becomes a local `Date` the device's
 * zone can move it a day. Every calculation below is on calendar dates alone.
 */
const toUtcDate = (date: IsoDate): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);

  if (match === null) {
    return null;
  }

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));

  // Rejects a date that does not exist — `2026-02-30` would otherwise roll into March.
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? parsed
    : null;
};

const toIsoDate = (value: Date): IsoDate => value.toISOString().slice(0, 10);

/** Calendar dates compare lexicographically, so the later and earlier of two are plain comparisons. */
const maxOf = (left: IsoDate, right: IsoDate): IsoDate => (left > right ? left : right);

const minOf = (left: IsoDate, right: IsoDate): IsoDate => (left < right ? left : right);

/**
 * The ISO-8601 week of a calendar date.
 *
 * The standard definition, computed rather than formatted: the week a date belongs to is the week of
 * the Thursday in that date's Monday-to-Sunday week, and week 1 is the week containing 4 January. That
 * is why the ISO year can differ from the calendar year — 2026-12-28 is in ISO week 53 of 2026, while
 * 2027-01-01 is in that same week.
 *
 * `Intl` is not used here: it formats, and a week number is arithmetic that must not depend on a
 * locale's idea of when a week starts.
 */
export const isoWeekOf = (date: IsoDate): IsoWeek | null => {
  const parsed = toUtcDate(date);

  if (parsed === null) {
    return null;
  }

  // `getUTCDay()` counts Sunday as 0; ISO counts Monday as 1 and Sunday as 7.
  const weekday = ((parsed.getUTCDay() + 6) % 7) + 1;
  const thursday = new Date(parsed.getTime() + (4 - weekday) * MILLISECONDS_PER_DAY);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstWeekday = ((firstThursday.getUTCDay() + 6) % 7) + 1;
  const week1Monday = new Date(firstThursday.getTime() - (firstWeekday - 1) * MILLISECONDS_PER_DAY);
  const week =
    Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * MILLISECONDS_PER_DAY)) + 1;

  return { year, week, weekday: weekday as IsoWeekday };
};

/** The bin the parity rule assigns to a week, or `null` when the date cannot be read. */
export const wasteTypeForDate = (
  rules: Pick<HouseholdCollectionRules, 'parity'>,
  date: IsoDate,
): WasteType | null => {
  const isoWeek = isoWeekOf(date);

  return isoWeek === null ? null : isoWeek.week % 2 === 0 ? rules.parity.even : rules.parity.odd;
};

/**
 * The nominal collection dates for a weekday, from `from` through `to` inclusive.
 *
 * Nominal means "before the municipality moves it": the parity rule and the household's weekday decide
 * these, and only then does the published table replace individual dates.
 */
const nominalDates = (weekday: IsoWeekday, from: IsoDate, to: IsoDate): IsoDate[] => {
  const start = toUtcDate(from);
  const end = toUtcDate(to);

  if (start === null || end === null || start.getTime() > end.getTime()) {
    return [];
  }

  const startWeekday = ((start.getUTCDay() + 6) % 7) + 1;
  const offset = (weekday - startWeekday + 7) % 7;
  const dates: IsoDate[] = [];

  for (
    let current = new Date(start.getTime() + offset * MILLISECONDS_PER_DAY);
    current.getTime() <= end.getTime();
    current = new Date(current.getTime() + 7 * MILLISECONDS_PER_DAY)
  ) {
    dates.push(toIsoDate(current));
  }

  return dates;
};

/**
 * A calculated household collection.
 *
 * `nominalDate` travels with it because it is what the waste type was decided from, and because a
 * surface explaining a moved collection has to be able to say what it was moved from. `movedFrom` is
 * the same value, present only when the date really was replaced, so a caller can say "moved" without
 * comparing two fields itself.
 */
export interface HouseholdCollection {
  readonly id: string;
  readonly date: IsoDate;
  readonly type: WasteType;
  readonly nominalDate: IsoDate;
  readonly movedFrom: IsoDate | null;
  /** The holiday the operator named for the replacement, when there was one. */
  readonly reason: string | null;
}

/**
 * What a range can produce.
 *
 * `collections` holds the ones whose **actual** date falls inside the requested range — the date the
 * operator collects, not the one the regular rule would have produced. That distinction is the whole
 * point: Easter moves a Monday collection onto the Saturday before, so a surface asking about that
 * Saturday must be given it, and a surface asking about the Monday must not.
 *
 * `covered` and `uncovered` are stated separately rather than clipped silently: a surface that asked
 * for three months and got six weeks has to be able to say why the rest is missing, and "no collection"
 * and "no published rule" are different statements about the same empty space.
 */
export interface HouseholdScheduleResult {
  readonly collections: readonly HouseholdCollection[];
  /** The part of the requested range the rules actually cover, or `null` when none of it is covered. */
  readonly coveredRange: { readonly from: IsoDate; readonly to: IsoDate } | null;
  /** True when the request reached past the published rules. */
  readonly limitedCoverage: boolean;
}

/**
 * A stable identity for a calculated collection.
 *
 * Built from the household's own identifiers and the **nominal** date, so a collection keeps its
 * identity when the municipality moves it: the same collection on a new date is the same collection,
 * and a surface that re-renders after the rules refresh does not see one vanish and another appear.
 *
 * `calculated:` leads the identifier so it can never be mistaken for an official event's id — the two
 * live in one ordered list, and an id is what deduplication and reminders key on.
 */
const identityFor = (setup: HouseholdBinSetup, nominalDate: IsoDate, type: WasteType): string =>
  `calculated:${setup.providerId}:${setup.serviceAreaId}:${nominalDate}:${type}`;

/**
 * The household's collections in a range, from published rules and a confirmed weekday.
 *
 * The order of operations is the municipality's own: assign the bin from the nominal week, **then**
 * apply at most one published replacement to the date. A replacement never changes the waste type, so a
 * Bioabfall collection moved from an even week into an odd one is still Bioabfall — which is exactly
 * what the operator's notices say happens at Easter.
 *
 * The search runs over a **widened** nominal window before the results are cut back to the requested
 * range by their actual dates. Without that, a collection the operator moved *into* the range would be
 * missed: asking about Saturday 2026-03-28 alone would find no Monday to move, and the Easter
 * Vorverlegung — the one case the operator publishes a notice about — would silently produce nothing.
 * The widening is the largest displacement the rules themselves contain, so it is bounded by the data
 * rather than by a guess.
 */
export const householdCollectionsIn = (
  rules: HouseholdCollectionRules,
  setup: HouseholdBinSetup,
  range: { readonly from: IsoDate; readonly to: IsoDate },
): HouseholdScheduleResult => {
  const empty: HouseholdScheduleResult = {
    collections: [],
    coveredRange: null,
    limitedCoverage: true,
  };

  if (rules.providerId !== setup.providerId) {
    // A weekday is a fact about one address under one operator. Another operator's rules cannot be
    // applied to it, however similar they look.
    return empty;
  }

  const from = range.from > rules.coverage.from ? range.from : rules.coverage.from;
  const to = range.to < rules.coverage.to ? range.to : rules.coverage.to;

  if (from > to) {
    return empty;
  }

  /**
   * How far any published replacement moves a collection, in days.
   *
   * Read from the rules rather than assumed: a municipality that moved a collection by a week would be
   * handled without changing this, and one that never moves anything costs nothing.
   */
  const maxDisplacement = rules.replacements.reduce((widest, replacement) => {
    const nominal = toUtcDate(replacement.nominalDate);
    const actual = toUtcDate(replacement.actualDate);

    if (nominal === null || actual === null) {
      return widest;
    }

    const days = Math.abs(actual.getTime() - nominal.getTime()) / MILLISECONDS_PER_DAY;

    return days > widest ? days : widest;
  }, 0);

  // Widened for the search, then clipped back to what the rules cover: a nominal date outside the
  // published period is not a collection, however close its replacement would land.
  const searchFrom = maxOf(addCalendarDays(from, -maxDisplacement), rules.coverage.from);
  const searchTo = minOf(addCalendarDays(to, maxDisplacement), rules.coverage.to);

  /**
   * Keyed by nominal date, which is what makes "apply once" structural.
   *
   * A cascade — Thursday moved to Friday, Friday moved to Saturday — is two entries with two different
   * nominal dates. Looking up by nominal date can therefore never follow the second entry after the
   * first, and no loop can walk a chain of them.
   */
  const byNominalDate = new Map(
    rules.replacements.map((replacement) => [replacement.nominalDate, replacement]),
  );

  const collections = nominalDates(
    setup.weekday,
    searchFrom,
    searchTo,
  ).flatMap<HouseholdCollection>((nominalDate) => {
    const type = wasteTypeForDate(rules, nominalDate);

    if (type === null) {
      return [];
    }

    const replacement = byNominalDate.get(nominalDate);
    const date = replacement?.actualDate ?? nominalDate;

    return [
      {
        id: identityFor(setup, nominalDate, type),
        date,
        type,
        nominalDate,
        movedFrom: replacement === undefined ? null : nominalDate,
        reason: replacement?.reason ?? null,
      },
    ];
  });

  return {
    /*
     * Cut back to the requested range by the date the collection actually happens on, and sorted by it:
     * a Vorverlegung can move a collection before one that was nominally earlier. Ties keep the nominal
     * order, which is stable.
     */
    collections: collections
      .filter((collection) => collection.date >= from && collection.date <= to)
      .sort((left, right) =>
        left.date === right.date
          ? left.nominalDate.localeCompare(right.nominalDate)
          : left.date.localeCompare(right.date),
      ),
    coveredRange: { from, to },
    limitedCoverage: range.from < rules.coverage.from || range.to > rules.coverage.to,
  };
};

/**
 * A calculated collection as a domain event, so one ordered list can hold both kinds.
 *
 * All-day by construction: the municipality publishes a day for these bins and nothing finer. The
 * caller keeps the distinction between calculated and published — this only makes the two comparable.
 */
export const toCollectionEvent = (
  collection: HouseholdCollection,
  districtId: string,
): CollectionEvent => ({
  id: collection.id,
  districtId,
  type: collection.type,
  date: collection.date,
  title: wasteLabels[collection.type],
  /*
   * `user_rule`, which the domain already distinguishes from `municipal_ics`. That one field is what
   * carries the difference between a transcribed rule applied to a confirmed weekday and a date the
   * operator published, all the way through ordering, caching and reminders.
   */
  source: 'user_rule',
  collectionMode: 'curbside',
  timing: { kind: 'all_day' },
});

/** The day after the covered period, for a surface that says where its knowledge stops. */
export const coverageEndsAfter = (rules: HouseholdCollectionRules): IsoDate =>
  addCalendarDays(rules.coverage.to, 1);
