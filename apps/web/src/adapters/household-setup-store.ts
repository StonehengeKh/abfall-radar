/**
 * The household's own setting for the two bins the operator publishes no calendar for.
 *
 * One weekday, remembered against the district it was confirmed for. Nothing else: no dates, no rules,
 * no schedule. The rules come from the API on every visit, so a year-old holiday table can never be
 * served from a previous session, and the weekday is the only part the API cannot know.
 *
 * **Bound to the location, deliberately.** A weekday is a fact about one address on one operator's
 * route. Carrying it to another district — or to another municipality entirely — would produce dates
 * that look exactly as confident as the right ones, so a stored setup that does not name the current
 * selection is ignored rather than reused. Changing district therefore switches the household bins off
 * until the person confirms a weekday for the new one.
 *
 * Read as untrusted input on every visit, like the confirmed selection beside it: a record written by
 * another version, edited by hand, or handed back malformed is discarded rather than repaired.
 */

/** Bumped whenever the shape changes; an older or newer record is discarded, never migrated in place. */
export const HOUSEHOLD_SETUP_VERSION = 1;

export const HOUSEHOLD_SETUP_STORAGE_KEY = 'abfall-radar.household-setup';

/** ISO weekday numbering, 1 Monday through 7 Sunday, matching every other calculation. */
export type StoredWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface StoredHouseholdSetup {
  readonly version: number;
  readonly providerId: string;
  readonly serviceAreaId: string;
  readonly weekday: StoredWeekday;
}

export interface HouseholdSetupStore {
  read(): StoredHouseholdSetup | null;
  write(setup: Omit<StoredHouseholdSetup, 'version'>): void;
  clear(): void;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isWeekday = (value: unknown): value is StoredWeekday =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;

export const parseHouseholdSetup = (raw: string | null): StoredHouseholdSetup | null => {
  if (raw === null) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (record.version !== HOUSEHOLD_SETUP_VERSION) {
    return null;
  }

  const { providerId, serviceAreaId, weekday } = record;

  // All three together or nothing: a weekday without the district it belongs to is not a setup, it is a
  // number that would be applied to whichever district happens to be selected.
  if (!isNonEmptyString(providerId) || !isNonEmptyString(serviceAreaId) || !isWeekday(weekday)) {
    return null;
  }

  return { version: HOUSEHOLD_SETUP_VERSION, providerId, serviceAreaId, weekday };
};

/**
 * The setup, but only when it belongs to the district currently selected.
 *
 * The comparison is the whole point of storing the identifiers, and it is why switching district
 * silently disables the calculated bins instead of silently recalculating them for a route nobody
 * confirmed.
 */
export const setupFor = (
  stored: StoredHouseholdSetup | null,
  selection: { readonly providerId: string; readonly serviceAreaId: string } | null,
): StoredHouseholdSetup | null =>
  stored !== null &&
  selection !== null &&
  stored.providerId === selection.providerId &&
  stored.serviceAreaId === selection.serviceAreaId
    ? stored
    : null;

/**
 * The browser implementation. Every access is guarded: a private window, blocked site data, or a full
 * quota makes `localStorage` throw, and none of that is a reason for the application to fail.
 */
export const browserHouseholdSetupStore: HouseholdSetupStore = {
  read() {
    try {
      return parseHouseholdSetup(window.localStorage.getItem(HOUSEHOLD_SETUP_STORAGE_KEY));
    } catch {
      return null;
    }
  },
  write(setup) {
    try {
      window.localStorage.setItem(
        HOUSEHOLD_SETUP_STORAGE_KEY,
        JSON.stringify({ version: HOUSEHOLD_SETUP_VERSION, ...setup }),
      );
    } catch {
      // The setting is a convenience; failing to remember it must never fail the visit.
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(HOUSEHOLD_SETUP_STORAGE_KEY);
    } catch {
      // As above.
    }
  },
};
