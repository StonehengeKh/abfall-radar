/**
 * A `matchMedia` jsdom does not implement, backed by one width the tests can set.
 *
 * Only width queries are supported, which is all the application asks: `(min-width: 640px)` and
 * `(prefers-reduced-motion: reduce)`. Setting a width dispatches a real `change` event to every list
 * that cares, so a component subscribed through `useSyncExternalStore` sees a resize exactly as it would
 * in a browser — which is what makes the breakpoint handover testable at all.
 */

const MIN_WIDTH = /^\(min-width:\s*(\d+)px\)$/;

/** A desktop-width default, so a test that says nothing about width gets the roomy layout. */
export const DEFAULT_TEST_WIDTH = 1280;

let width = DEFAULT_TEST_WIDTH;

interface Registered {
  readonly query: string;
  readonly listeners: Set<(event: MediaQueryListEvent) => void>;
}

const registered: Registered[] = [];

const evaluate = (query: string): boolean => {
  const match = MIN_WIDTH.exec(query);

  return match === null ? false : width >= Number(match[1]);
};

export const installMatchMedia = (): void => {
  // Some suites run in the node environment, where there is no window and nothing to install into.
  if (typeof window === 'undefined') {
    return;
  }

  window.matchMedia = ((query: string) => {
    const entry: Registered = { query, listeners: new Set() };

    registered.push(entry);

    const list = {
      get matches() {
        return evaluate(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        entry.listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        entry.listeners.delete(listener);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };

    return list as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
};

/** Resizes the notional viewport and notifies every subscriber whose answer changed. */
export const setViewportWidth = (next: number): void => {
  const before = registered.map((entry) => evaluate(entry.query));

  width = next;

  registered.forEach((entry, index) => {
    if (before[index] === evaluate(entry.query)) {
      return;
    }

    for (const listener of entry.listeners) {
      listener({ matches: evaluate(entry.query), media: entry.query } as MediaQueryListEvent);
    }
  });

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('resize'));
  }
};

export const resetViewport = (): void => {
  setViewportWidth(DEFAULT_TEST_WIDTH);
  registered.length = 0;
};
