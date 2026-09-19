import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/src/app/app';
import { LocaleProvider } from '@/src/i18n/context';
import {
  dayUnitLabel,
  formatCalendarDate,
  formatDayCount,
  formatRelativeDay,
  formatLongWeekday,
  formatWeekday,
  formatWeekdayCalendarDate,
  isNumericRelativeDay,
  isRelativeDay,
} from '@/src/i18n/format';
import {
  DEFAULT_LOCALE,
  readStoredLocale,
  resolveInitialLocale,
  STORAGE_KEY,
  SUPPORTED_LOCALES,
  writeStoredLocale,
} from '@/src/i18n/locale';
import { MESSAGES } from '@/src/i18n/messages';
import {
  AREA_ID,
  area,
  areas,
  CITY_ID,
  CATALOGUE_SINGLE,
  curbside,
  dropOff,
  events,
  KOBLENZ_CITY,
} from '@/src/test/fixtures';
import { createHarness, type Harness, ok } from '@/src/test/harness';

/**
 * Localization as a whole: which locale is chosen, how it is remembered, what it changes on screen,
 * and — the part that matters most — everything it must leave alone.
 */

/**
 * Renders the shell inside the locale provider.
 *
 * The starting locale is stated rather than negotiated, because jsdom's `navigator.languages` is
 * `en-US` — negotiating here would test the environment instead of the application. Negotiation has its
 * own cases above, against explicit preference lists.
 */
const renderApp = (
  harness: Harness,
  initial: Parameters<typeof LocaleProvider>[0]['initial'] = 'de',
) => {
  const tree = (
    <LocaleProvider initial={initial}>
      <AppShell controller={harness.controller} snapshot={harness.snapshot()} />
    </LocaleProvider>
  );
  const view = render(tree);
  const rerender = (): void => {
    view.rerender(
      <LocaleProvider initial={initial}>
        <AppShell controller={harness.controller} snapshot={harness.snapshot()} />
      </LocaleProvider>,
    );
  };

  harness.controller.subscribe(rerender);

  return { rerender };
};

/** Opens the language menu and picks one, which is how a person changes language. */
const chooseLanguage = async (locale: (typeof SUPPORTED_LOCALES)[number]): Promise<void> => {
  await userEvent.click(screen.getByTestId('language-control'));
  await userEvent.click(screen.getByRole('menuitemradio', { name: MESSAGES[locale].languageName }));
};

const reachSchedule = async (harness: Harness): Promise<void> => {
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

/** Storage that throws on every access, as a private window or blocked site data does. */
const hostileStorage = (): Storage =>
  new Proxy({} as Storage, {
    get() {
      throw new Error('storage is blocked');
    },
  });

afterEach(() => {
  document.documentElement.removeAttribute('lang');
  // Choosing a language writes it to the real jsdom storage, which outlives one test.
  try {
    window.localStorage.clear();
  } catch {
    // Nothing to clear when storage is unavailable.
  }
});

describe('the initial locale', () => {
  it('starts in German when nothing has been chosen, whatever the device asks for', () => {
    // The browser's language list is deliberately not consulted: this product shows German source data
    // and German official naming, so the first screen is German until somebody says otherwise.
    expect(resolveInitialLocale(memoryStorage())).toBe('de');
    expect(resolveInitialLocale(undefined)).toBe('de');
    expect(DEFAULT_LOCALE).toBe('de');
  });

  it.each(SUPPORTED_LOCALES)('restores a valid saved preference: %s', (locale) => {
    const storage = memoryStorage();

    writeStoredLocale(storage, locale);

    expect(storage.getItem(STORAGE_KEY)).toBe(locale);
    expect(resolveInitialLocale(storage)).toBe(locale);
  });

  it.each([
    ['a language this application does not ship', 'klingon'],
    ['a regional tag rather than a stored choice', 'de-AT'],
    ['an empty value', ''],
  ])('falls back to German for %s', (_reason, stored) => {
    const storage = memoryStorage();

    storage.setItem(STORAGE_KEY, stored);

    expect(readStoredLocale(storage)).toBeNull();
    expect(resolveInitialLocale(storage)).toBe('de');
  });

  it('falls back to German when storage throws on every access', () => {
    const storage = hostileStorage();

    expect(readStoredLocale(storage)).toBeNull();
    expect(() => writeStoredLocale(storage, 'en')).not.toThrow();
    expect(resolveInitialLocale(storage)).toBe('de');
  });

  it('renders the first screen in German without a stored choice', async () => {
    const harness = createHarness();

    harness.gateway.queueProviders(ok(CATALOGUE_SINGLE)).queueAreas(ok(areas(area())));
    render(
      <LocaleProvider>
        <AppShell controller={harness.controller} snapshot={harness.snapshot()} />
      </LocaleProvider>,
    );
    harness.controller.start();
    await harness.flush();

    expect(document.documentElement.lang).toBe('de');
    expect(screen.getByRole('button', { name: /Sprache: Deutsch/ })).toBeInTheDocument();
  });
});

describe('locale-aware formatting', () => {
  it('names the same day in each locale without moving it', () => {
    // One source-local date, four languages: the wording changes and the day does not.
    const rendered = SUPPORTED_LOCALES.map((locale) => formatCalendarDate(locale, '2026-11-07'));

    expect(new Set(rendered).size).toBeGreaterThan(1);
    for (const text of rendered) {
      expect(text).toContain('2026');
    }
  });

  it('uses each locale’s own plural and relative forms', () => {
    const today = '2026-09-16';

    expect(formatRelativeDay('de', today, today)).toBe('heute');
    expect(formatRelativeDay('en', today, today)).toBe('today');
    expect(formatRelativeDay('en', '2026-09-17', today)).toBe('tomorrow');

    // Two, three and five days apart take different plural forms in Ukrainian and Russian; `Intl`
    // chooses them, which is exactly why no message here concatenates a number to a noun.
    const ukrainian = ['2026-09-18', '2026-09-19', '2026-09-21'].map((date) =>
      formatRelativeDay('uk', date, today),
    );

    // Ukrainian has a word for "the day after tomorrow" and plural forms beyond it; all three differ,
    // and none is this application concatenating a number to a noun.
    expect(new Set(ukrainian).size).toBe(3);
    expect(formatRelativeDay('uk', '2026-09-21', today)).toMatch(/5/);
  });

  it('agrees a day unit with its number in every locale, rather than appending one fixed word', () => {
    // German and English have two forms; Ukrainian and Russian have three, and pick different ones for
    // 2 and 5. `Intl` chooses them, so no message here ever concatenates a number to a noun.
    expect([1, 2, 5].map((days) => formatDayCount('de', days))).toEqual([
      '1 Tag',
      '2 Tage',
      '5 Tage',
    ]);
    expect([1, 2, 5].map((days) => formatDayCount('en', days))).toEqual([
      '1 day',
      '2 days',
      '5 days',
    ]);
    expect([1, 2, 5].map((days) => dayUnitLabel('uk', days))).toEqual(['день', 'дні', 'днів']);
    expect([1, 2, 5].map((days) => dayUnitLabel('ru', days))).toEqual(['день', 'дня', 'дней']);

    // The stacked badge splits the same phrase, so the unit it shows is the one the number agrees with.
    for (const locale of SUPPORTED_LOCALES) {
      for (const days of [1, 2, 3, 5, 11, 21]) {
        expect(formatDayCount(locale, days)).toContain(dayUnitLabel(locale, days));
      }
    }
  });

  it('counts districts without a hard-coded total', () => {
    // The total is whatever the catalogue answered with; nothing here assumes 34 districts.
    for (const locale of SUPPORTED_LOCALES) {
      const label = MESSAGES[locale].schedule.districtCount(3, 12);

      expect(label).toContain('3');
      expect(label).toContain('12');
    }
  });

  it('knows exactly when a relative label applies, sharing the window with the label itself', () => {
    const today = '2026-09-17';

    expect(isRelativeDay(today, today)).toBe(true);
    expect(isRelativeDay('2026-09-18', today)).toBe(true);
    expect(isRelativeDay('2026-09-23', today)).toBe(true);
    // Seven days on, the label becomes the weekday-bearing absolute fallback.
    expect(isRelativeDay('2026-09-24', today)).toBe(false);
    expect(isRelativeDay('2026-09-16', today)).toBe(false);

    // And the two never disagree: relative exactly when the label is not the fallback.
    for (const offset of [0, 1, 5, 6, 7, 12]) {
      const date = new Date(Date.UTC(2026, 8, 17 + offset)).toISOString().slice(0, 10);
      const fallback = new Intl.DateTimeFormat('de', {
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }).format(new Date(`${date}T00:00:00Z`));

      expect(formatRelativeDay('de', date, today) === fallback).toBe(!isRelativeDay(date, today));
    }
  });

  it.each(SUPPORTED_LOCALES)(
    'puts the weekday in front of the unchanged medium date in %s',
    (locale) => {
      // The weekday as written inside a date, which is the context the product reads it from.
      const weekday =
        new Intl.DateTimeFormat(locale, {
          timeZone: 'UTC',
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        })
          .formatToParts(new Date('2026-09-18T00:00:00Z'))
          .find((part) => part.type === 'weekday')?.value ?? '';
      const composed = formatWeekdayCalendarDate(locale, '2026-09-18');

      expect(formatWeekday(locale, '2026-09-18')).toBe(weekday);
      // The weekday leads, and the existing localized date follows it verbatim — nothing reformatted.
      expect(composed.startsWith(weekday)).toBe(true);
      expect(composed.endsWith(formatCalendarDate(locale, '2026-09-18'))).toBe(true);
    },
  );

  it('tells a numeric relative label from a word by asking Intl, not by reading the text', () => {
    const today = '2026-09-17';

    // Today and tomorrow are words everywhere.
    for (const locale of SUPPORTED_LOCALES) {
      expect(isNumericRelativeDay(locale, today, today)).toBe(false);
      expect(isNumericRelativeDay(locale, '2026-09-18', today)).toBe(false);
      expect(isNumericRelativeDay(locale, '2026-09-23', today)).toBe(true);
      // Past the window there is no relative label at all.
      expect(isNumericRelativeDay(locale, '2026-09-29', today)).toBe(false);
    }

    // Two days away: "übermorgen", "післязавтра", "послезавтра" — but "in 2 days".
    expect(isNumericRelativeDay('de', '2026-09-19', today)).toBe(false);
    expect(isNumericRelativeDay('uk', '2026-09-19', today)).toBe(false);
    expect(isNumericRelativeDay('ru', '2026-09-19', today)).toBe(false);
    expect(isNumericRelativeDay('en', '2026-09-19', today)).toBe(true);
  });

  it('writes the full weekday of the source day in each locale', () => {
    expect(formatLongWeekday('de', '2026-09-16')).toBe('Mittwoch');
    expect(formatLongWeekday('en', '2026-09-16')).toBe('Wednesday');
    expect(formatLongWeekday('uk', '2026-09-16')).toBe('середа');
    expect(formatLongWeekday('ru', '2026-09-16')).toBe('среда');
  });

  it('spells the weekday the same way the existing absolute fallback does', () => {
    // Both read the weekday from one pattern, so "Fr." beside a relative label and "Fr., 25. Sept." in
    // the fallback can never drift into two abbreviations of the same day.
    const inFallback = formatRelativeDay('de', '2026-09-25', '2026-09-17');

    expect(inFallback.startsWith(formatWeekday('de', '2026-09-25'))).toBe(true);
  });

  it('matches the German example shape for tomorrow', () => {
    expect(
      `${formatRelativeDay('de', '2026-09-18', '2026-09-17')} · ${formatWeekdayCalendarDate('de', '2026-09-18')}`,
    ).toMatch(/^morgen · Fr\.?, 18\.09\.2026$/);
  });

  it('falls back to an absolute date once the relative window has passed', () => {
    const label = formatRelativeDay('de', '2026-10-30', '2026-09-16');

    expect(label).not.toMatch(/Tag/);
    expect(label).toMatch(/Okt/);
  });
});

describe('switching the language', () => {
  const scheduled = (harness: Harness) =>
    harness.gateway
      .queueProviders(ok(CATALOGUE_SINGLE))
      .queueAreas(ok(areas(area())))
      .queueEvents(ok(events([curbside(), dropOff()])));

  it('translates every application-owned surface without touching the schedule', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    await reachSchedule(harness);

    expect(
      screen.getByRole('heading', { name: MESSAGES.de.states.live.heading }),
    ).toBeInTheDocument();

    const requestsBefore = harness.gateway.calls.length;

    await chooseLanguage('uk');

    // Translated: heading, controls, and the live-region announcement.
    expect(
      screen.getByRole('heading', { name: MESSAGES.uk.states.live.heading }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: MESSAGES.uk.actions.changeSelection }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('live-region').textContent).toBe(
      MESSAGES.uk.states.live.announcement,
    );

    // Untouched: no request, no lost selection, and the same accepted schedule underneath.
    expect(harness.gateway.calls.length).toBe(requestsBefore);
    expect(harness.view().kind).toBe('live');
    expect(harness.controller.lifecycleOwners).toEqual({ watchdog: true, coordinator: false });
    // Two events, one of them featured in the hero, so one row remains.
    expect(screen.getAllByTestId('event-row')).toHaveLength(1);
  });

  it('keeps the city, the district, and the source-authored text as published', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    await reachSchedule(harness);

    for (const locale of SUPPORTED_LOCALES) {
      await chooseLanguage(locale);

      // The operator's own naming and attribution are reproduced, never translated.
      expect(screen.getByTestId('header-place').textContent).toBe('Koblenz · Stadtmitte');
      expect(screen.getByText('Kommunaler Servicebetrieb, Koblenz')).toBeInTheDocument();
      expect(screen.getByText('Rizzastraße Ecke Südallee')).toBeInTheDocument();
    }
  });

  it('updates the document language so assistive technology reads the right one', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    harness.controller.start();
    await harness.flush();

    expect(document.documentElement.lang).toBe('de');

    await chooseLanguage('ru');

    expect(document.documentElement.lang).toBe('ru');
  });

  it('translates a failure surface, its identifier label, and its announcement', async () => {
    const harness = createHarness();

    harness.gateway.queueProviders(ok(CATALOGUE_SINGLE)).queueAreas(ok(areas(area())));
    harness.gateway.replaceEvents({
      ok: false,
      failure: {
        kind: 'problem',
        operation: 'listCollectionEvents',
        status: 500,
        code: 'UPSTREAM_SOURCE_INVALID',
        requestId: 'req-42',
      },
    });
    renderApp(harness);
    await reachSchedule(harness);

    expect(screen.getByText(MESSAGES.de.problemCodes.UPSTREAM_SOURCE_INVALID)).toBeInTheDocument();

    await chooseLanguage('en');

    expect(screen.getByText(MESSAGES.en.problemCodes.UPSTREAM_SOURCE_INVALID)).toBeInTheDocument();
    expect(screen.getByText(`${MESSAGES.en.diagnostics.identifier}:`)).toBeInTheDocument();
    // The validated identifier is data, so it survives translation unchanged.
    expect(screen.getByText('req-42')).toBeInTheDocument();
    expect(screen.getByTestId('live-region').textContent).toContain(
      MESSAGES.en.states.error.announcement,
    );
  });

  it('remembers the choice for the next visit', async () => {
    const harness = createHarness();
    const storage = memoryStorage();

    vi.stubGlobal('localStorage', storage);
    scheduled(harness);
    renderApp(harness);
    harness.controller.start();
    await harness.flush();

    await chooseLanguage('en');

    expect(readStoredLocale(storage)).toBe('en');
    vi.unstubAllGlobals();
  });
});
