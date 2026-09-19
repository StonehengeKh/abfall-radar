import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

/**
 * The appearance preference: light, dark, or whatever the operating system asks for.
 *
 * Only the preference is stored. No schedule, no confirmed selection, and nothing a source published —
 * AR-005's no-persistence rule is about product data, and a display choice is not product data.
 *
 * `system` is the default and stays a live preference rather than being resolved once: the stylesheet
 * reads `prefers-color-scheme` whenever no explicit choice is stamped on the document, so a person who
 * never chooses follows their system for as long as the page is open.
 */

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_STORAGE_KEY = 'abfall-radar.theme';

const isPreference = (value: string): value is ThemePreference =>
  (THEME_PREFERENCES as readonly string[]).includes(value);

const storage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export const readStoredTheme = (store: Storage | undefined): ThemePreference | null => {
  try {
    const stored = store?.getItem(THEME_STORAGE_KEY) ?? null;

    return stored !== null && isPreference(stored) ? stored : null;
  } catch {
    return null;
  }
};

export const writeStoredTheme = (store: Storage | undefined, preference: ThemePreference): void => {
  try {
    if (preference === 'system') {
      store?.removeItem(THEME_STORAGE_KEY);
      return;
    }

    store?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Remembering the choice is a convenience; losing it must never break the current session.
  }
};

interface ThemeContextValue {
  readonly preference: ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** `system` leaves the attribute off entirely, so only the media query decides. */
const applyPreference = (preference: ThemePreference): void => {
  if (typeof document === 'undefined') {
    return;
  }

  if (preference === 'system') {
    document.documentElement.removeAttribute('data-theme');
    return;
  }

  document.documentElement.setAttribute('data-theme', preference);
};

export const ThemeProvider = ({
  children,
  initial,
}: {
  readonly children: ReactNode;
  readonly initial?: ThemePreference | undefined;
}) => {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => initial ?? readStoredTheme(storage()) ?? 'system',
  );

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeStoredTheme(storage(), next);
  }, []);

  applyPreference(preference);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, setPreference }),
    [preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const value = useContext(ThemeContext);

  return value ?? { preference: 'system', setPreference: () => {} };
};
