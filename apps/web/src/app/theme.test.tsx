import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIRMED_SELECTION_STORAGE_KEY,
  CONFIRMED_SELECTION_VERSION,
  createConfirmedSelectionStore,
} from '@/src/adapters/confirmed-selection-store';
import { AppShell } from '@/src/app/app';
import {
  readStoredTheme,
  THEME_STORAGE_KEY,
  ThemeProvider,
  writeStoredTheme,
} from '@/src/app/theme';
import { LocaleProvider } from '@/src/i18n/context';
import { MESSAGES } from '@/src/i18n/messages';
import {
  AREA_ID,
  area,
  areas,
  CATALOGUE_SINGLE,
  CITY_ID,
  curbside,
  dropOff,
  events,
  PROVIDER_ID,
} from '@/src/test/fixtures';
import { createHarness, type Harness, ok } from '@/src/test/harness';

/**
 * The appearance preference: what it stamps on the document, what it remembers, and what it must not
 * disturb. Colour itself is a stylesheet concern and is not asserted here — jsdom performs no cascade,
 * so a test claiming a contrast ratio or a rendered colour would be claiming something it cannot see.
 */

const renderApp = (harness: Harness) => {
  const tree = () => (
    <LocaleProvider initial="de">
      <ThemeProvider>
        <AppShell controller={harness.controller} snapshot={harness.snapshot()} />
      </ThemeProvider>
    </LocaleProvider>
  );
  const view = render(tree());

  harness.controller.subscribe(() => view.rerender(tree()));
};

const reachSchedule = async (harness: Harness): Promise<void> => {
  harness.gateway
    .queueProviders(ok(CATALOGUE_SINGLE))
    .queueAreas(ok(areas(area())))
    .queueEvents(ok(events([curbside(), dropOff()])));
  harness.controller.start();
  await harness.flush();
  harness.controller.selectCity(CITY_ID);
  await harness.flush();
  harness.controller.selectArea(AREA_ID);
  harness.controller.confirm();
  await harness.flush();
};

const memoryStorage = (): Storage => {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  try {
    window.localStorage.clear();
  } catch {
    // Nothing to clear when storage is unavailable.
  }
});

/**
 * Choosing an appearance, the way a person does: the control is collapsed to the current preference and
 * opens a popover of the three choices.
 */
const chooseAppearance = async (choice: 'system' | 'light' | 'dark'): Promise<void> => {
  await userEvent.click(screen.getByTestId('theme-control'));
  await userEvent.click(
    screen.getByRole('menuitemradio', { name: MESSAGES.de.appearance[choice] }),
  );
};

describe('the appearance preference', () => {
  it('stamps nothing by default, so the system preference decides', async () => {
    const harness = createHarness();

    renderApp(harness);
    harness.controller.start();
    await harness.flush();

    // No attribute at all: the stylesheet's `prefers-color-scheme` block is then the only thing that
    // applies, which is what keeps "system" a live preference rather than a resolved snapshot.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    // Collapsed, the control still says which preference is in force.
    expect(screen.getByTestId('theme-control')).toHaveAccessibleName(
      `${MESSAGES.de.appearance.label}: ${MESSAGES.de.appearance.system}`,
    );

    await userEvent.click(screen.getByTestId('theme-control'));

    expect(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: MESSAGES.de.appearance.system,
        checked: true,
      }),
    ).toBeInTheDocument();
  });

  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
  ] as const)('stamps an explicit %s choice on the document', async (choice, expected) => {
    const harness = createHarness();

    renderApp(harness);
    harness.controller.start();
    await harness.flush();

    await chooseAppearance(choice);

    expect(document.documentElement.getAttribute('data-theme')).toBe(expected);
    // Choosing closes the popover, and the collapsed trigger now names the new preference.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('theme-control')).toHaveAccessibleName(
      `${MESSAGES.de.appearance.label}: ${MESSAGES.de.appearance[choice]}`,
    );
  });

  it('returns to the system preference and stops stamping', async () => {
    const harness = createHarness();

    renderApp(harness);
    harness.controller.start();
    await harness.flush();

    await chooseAppearance('dark');
    await chooseAppearance('system');

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('remembers an explicit choice and forgets it again on system', () => {
    const storage = memoryStorage();

    writeStoredTheme(storage, 'dark');

    expect(readStoredTheme(storage)).toBe('dark');

    // `system` is the absence of a choice, so it removes the entry rather than storing a third value.
    writeStoredTheme(storage, 'system');

    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readStoredTheme(storage)).toBeNull();
  });

  it('ignores a stored value that is not a preference, and survives hostile storage', () => {
    const storage = memoryStorage();

    storage.setItem(THEME_STORAGE_KEY, 'neon');

    expect(readStoredTheme(storage)).toBeNull();

    const hostile = new Proxy({} as Storage, {
      get() {
        throw new Error('storage is blocked');
      },
    });

    expect(readStoredTheme(hostile)).toBeNull();
    expect(() => writeStoredTheme(hostile, 'dark')).not.toThrow();
    expect(readStoredTheme(undefined)).toBeNull();
  });

  it('keeps the schedule, the selection, and the language when appearance changes', async () => {
    const harness = createHarness();

    renderApp(harness);
    await reachSchedule(harness);

    const requestsBefore = harness.gateway.calls.length;

    await chooseAppearance('dark');

    // A presentation change issues no request and moves no state.
    expect(harness.gateway.calls.length).toBe(requestsBefore);
    expect(harness.view().kind).toBe('live');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: true, coordinator: false });
    expect(screen.getByTestId('header-place').textContent).toBe('Koblenz · Stadtmitte');
    expect(
      screen.getByRole('heading', { name: MESSAGES.de.states.live.heading }),
    ).toBeInTheDocument();
    // Two events, one featured in the hero card, so the list keeps the other.
    expect(screen.getAllByTestId('event-row')).toHaveLength(1);
  });

  it('writes the appearance and the confirmed selection, and no schedule', async () => {
    /*
     * The real store over the real `localStorage`, not the harness default, which remembers nothing:
     * the contract under test is what the composition root writes, and a no-op substitute would make
     * this pass while observing none of it.
     */
    const harness = createHarness({
      selectionStore: createConfirmedSelectionStore(window.localStorage),
    });

    renderApp(harness);
    await reachSchedule(harness);
    await chooseAppearance('dark');

    const stored = Object.fromEntries(
      Array.from({ length: window.localStorage.length }, (_, index) => {
        const key = window.localStorage.key(index) ?? '';

        return [key, window.localStorage.getItem(key) ?? ''];
      }),
    );

    // Two keys, and no third: the appearance preference and the confirmed selection context.
    expect(Object.keys(stored).toSorted()).toEqual([
      CONFIRMED_SELECTION_STORAGE_KEY,
      THEME_STORAGE_KEY,
    ]);
    expect(stored[THEME_STORAGE_KEY]).toBe('dark');

    // Identity and a version, and nothing else — no locality, no provider name, no label.
    expect(JSON.parse(stored[CONFIRMED_SELECTION_STORAGE_KEY] ?? 'null')).toEqual({
      version: CONFIRMED_SELECTION_VERSION,
      cityId: CITY_ID,
      providerId: PROVIDER_ID,
      serviceAreaId: AREA_ID,
    });

    const everything = JSON.stringify(stored);

    // No schedule: not an event, not a date, not a waste type, not the source or its retrieval instant.
    expect(everything).not.toContain('2026-08-14');
    expect(everything).not.toContain('paper');
    expect(everything).not.toContain('Altpapier');
    expect(everything).not.toContain('Kommunaler Servicebetrieb');
    expect(everything).not.toContain('collectionEvents');
    // And nothing transient: no draft, no request state, no menu, no scroll position.
    for (const transient of ['draft', 'loading', 'error', 'menu', 'scroll', 'focus']) {
      expect(everything).not.toContain(transient);
    }
  });

  it('writes nothing for a district that was drafted but never confirmed', async () => {
    const harness = createHarness({
      selectionStore: createConfirmedSelectionStore(window.localStorage),
    });

    harness.gateway.queueProviders(ok(CATALOGUE_SINGLE)).queueAreas(ok(areas(area())));
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    await harness.flush();

    expect(window.localStorage.getItem(CONFIRMED_SELECTION_STORAGE_KEY)).toBeNull();
  });
});
