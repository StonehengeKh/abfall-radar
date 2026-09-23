import { DEFAULT_LOCALE, type Locale } from '@abfall-radar/schedule-format';
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo } from 'react';
import type { Appearance } from '@/src/storage/settings';
import { MESSAGES, type Messages } from './messages';

/**
 * The language and appearance the popup is rendered in, the copy for that language, and the two choices.
 *
 * Driven by the stored settings rather than owning them: the language and appearance live in the extension's
 * settings, which the worker reads and writes, so this only reflects them and reports a choice. Until settings
 * have been read, the popup renders in German with the system appearance — the product's defaults — rather
 * than guessing from the device.
 */
interface Presentation {
  readonly locale: Locale;
  readonly messages: Messages;
  readonly appearance: Appearance;
  readonly chooseLocale: (locale: Locale) => void;
  readonly chooseAppearance: (appearance: Appearance) => void;
}

const ignore = (): void => undefined;

const PresentationContext = createContext<Presentation>({
  locale: DEFAULT_LOCALE,
  messages: MESSAGES[DEFAULT_LOCALE],
  appearance: 'system',
  chooseLocale: ignore,
  chooseAppearance: ignore,
});

export const PresentationProvider = ({
  locale,
  appearance,
  onChooseLocale = ignore,
  onChooseAppearance = ignore,
  children,
}: {
  readonly locale: Locale;
  readonly appearance: Appearance;
  readonly onChooseLocale?: (locale: Locale) => void;
  readonly onChooseAppearance?: (appearance: Appearance) => void;
  readonly children: ReactNode;
}) => {
  const value = useMemo(
    () => ({
      locale,
      messages: MESSAGES[locale],
      appearance,
      chooseLocale: onChooseLocale,
      chooseAppearance: onChooseAppearance,
    }),
    [locale, appearance, onChooseLocale, onChooseAppearance],
  );

  useDocumentPresentation(locale, appearance);

  return <PresentationContext.Provider value={value}>{children}</PresentationContext.Provider>;
};

/** The language and its copy. */
export const useCopy = (): Pick<Presentation, 'locale' | 'messages'> =>
  useContext(PresentationContext);

/** The current language and appearance, and the handlers that change them. */
export const usePresentation = (): Presentation => useContext(PresentationContext);

/**
 * Puts the language and the appearance on the popup's document.
 *
 * The same rules as the website: `lang` follows the interface language, and `system` leaves `data-theme` off
 * entirely so the shared tokens follow the device's colour scheme, while an explicit choice sets it. Applied
 * in a layout effect, so the first paint after a change is already in the new appearance.
 */
const useDocumentPresentation = (locale: Locale, appearance: Appearance): void => {
  useLayoutEffect(() => {
    const root = document.documentElement;

    root.lang = locale;

    if (appearance === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', appearance);
    }
  }, [locale, appearance]);
};
