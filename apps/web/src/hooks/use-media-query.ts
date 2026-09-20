import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query, so a component can answer available space the way CSS does.
 *
 * This is a **layout** decision, not device detection: the query is a width, the browser evaluates it,
 * and a resize is an ordinary change event. It exists because a segmented control and a menu are
 * genuinely different widgets — one cannot be the other with a class — and because the switch has to be
 * observable in React to hand focus over when it happens.
 *
 * `useSyncExternalStore` rather than `useEffect` + state: the first paint already reads the real value,
 * so nothing renders the wrong control for a frame. The server snapshot is `false`, the narrow layout,
 * which is also what a browser without `matchMedia` gets.
 */
export const useMediaQuery = (query: string): boolean => {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const list = window.matchMedia?.(query);

      if (list === undefined) {
        return () => {};
      }

      list.addEventListener('change', onStoreChange);

      return () => list.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const snapshot = useCallback(() => window.matchMedia?.(query).matches ?? false, [query]);

  return useSyncExternalStore(subscribe, snapshot, () => false);
};

/** Tailwind's `sm` breakpoint, where the header has room for the segmented appearance control. */
export const WIDE_HEADER_QUERY = '(min-width: 640px)';
