/**
 * The interface languages the product ships, shared by every application that renders a schedule.
 *
 * Presentation only. The source-local date is derived from the **provider's** time zone with a fixed
 * internal formatter, so nothing here can move a collection to a different day. How a choice is
 * remembered is each application's own concern — a web page and an extension keep preferences in
 * different storage — so no storage lives here.
 */

export const SUPPORTED_LOCALES = ['de', 'en', 'uk', 'ru'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** German: the product's data, its official names, and its first audience are all German. */
export const DEFAULT_LOCALE: Locale = 'de';

export const isSupportedLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
