/**
 * The locales this application ships, how one is chosen, and how an explicit choice is remembered.
 *
 * Presentation only. The source-local date is derived from the **provider's** time zone with a fixed
 * internal formatter, so nothing here can move a collection to a different day.
 */

export const SUPPORTED_LOCALES = ['de', 'en', 'uk', 'ru'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** German: the product's data, its official names, and its first audience are all German. */
export const DEFAULT_LOCALE: Locale = 'de';

const isSupported = (value: string): value is Locale =>
  (SUPPORTED_LOCALES as readonly string[]).includes(value);

export const STORAGE_KEY = 'abfall-radar.locale';

/**
 * Reads and writes the explicit choice, and works when storage does not.
 *
 * Every access is guarded: a private window, blocked site data, or a full quota makes `localStorage`
 * throw on access rather than return nothing. A failure means the preference is not remembered — never
 * that the application stops working — so each operation degrades to "no stored choice".
 *
 * This module stores the language preference alone. The confirmed selection is remembered separately,
 * as identifiers only, by `@/src/adapters/confirmed-selection-store`; no schedule is ever stored.
 */
export const readStoredLocale = (storage: Storage | undefined): Locale | null => {
  try {
    const stored = storage?.getItem(STORAGE_KEY) ?? null;

    return stored !== null && isSupported(stored) ? stored : null;
  } catch {
    return null;
  }
};

export const writeStoredLocale = (storage: Storage | undefined, locale: Locale): void => {
  try {
    storage?.setItem(STORAGE_KEY, locale);
  } catch {
    // Remembering the choice is a convenience; losing it must never break the current session.
  }
};

/**
 * The initial locale: a valid explicit earlier choice, and German otherwise.
 *
 * The browser's own language list is deliberately **not** consulted. This product serves German
 * municipalities and shows German source data — official area names, attribution, and the operator's
 * own wording — so German is what the first screen should be written in whatever the device is set to.
 * The other three languages are there for the person to choose, and that choice is what is remembered.
 *
 * Every failure path lands on German: no stored value, a value that is not a supported locale, and
 * storage that throws on access all resolve the same way.
 */
export const resolveInitialLocale = (storage: Storage | undefined): Locale =>
  readStoredLocale(storage) ?? DEFAULT_LOCALE;
