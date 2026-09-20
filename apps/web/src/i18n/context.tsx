import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import {
  DEFAULT_LOCALE,
  type Locale,
  resolveInitialLocale,
  writeStoredLocale,
} from '@/src/i18n/locale';
import { MESSAGES, type Messages } from '@/src/i18n/messages';

/**
 * The selected locale and its messages, held beside the controller rather than inside it.
 *
 * That separation is the point. The controller owns requests, tokens, and lifecycle; this owns words.
 * Changing the language re-renders the tree with different strings and touches neither — no controller
 * is rebuilt, no attempt token moves, no request is issued, and the confirmed selection and the
 * accepted schedule are exactly where they were.
 */

interface LocaleContextValue {
  readonly locale: Locale;
  readonly messages: Messages;
  readonly setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

const storage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // Site data can be blocked outright, which throws on access rather than returning nothing.
    return undefined;
  }
};

export const LocaleProvider = ({
  children,
  initial,
}: {
  readonly children: ReactNode;
  /** Supplied by tests; production reads any remembered choice and starts in German otherwise. */
  readonly initial?: Locale | undefined;
}) => {
  const [locale, setLocaleState] = useState<Locale>(
    () => initial ?? resolveInitialLocale(storage()),
  );

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(storage(), next);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, messages: MESSAGES[locale], setLocale }),
    [locale, setLocale],
  );

  // The document language is part of the page, not of one component: assistive technology and the
  // browser's own hyphenation read it. Set during render rather than in an effect so the very first
  // paint is already announced in the language it is written in.
  if (typeof document !== 'undefined' && document.documentElement.lang !== locale) {
    document.documentElement.lang = locale;
  }

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
};

/** Falls back to German rather than throwing, so no surface can fail to render for want of a provider. */
export const useLocale = (): LocaleContextValue => {
  const value = useContext(LocaleContext);

  return (
    value ?? { locale: DEFAULT_LOCALE, messages: MESSAGES[DEFAULT_LOCALE], setLocale: () => {} }
  );
};

export const useMessages = (): Messages => useLocale().messages;
