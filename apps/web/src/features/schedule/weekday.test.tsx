import { formatCalendarDate } from '@abfall-radar/schedule-format';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from '@/src/app/app';
import { ThemeProvider } from '@/src/app/theme';
import { LocaleProvider } from '@/src/i18n/context';
import { type Locale, SUPPORTED_LOCALES } from '@/src/i18n/locale';
import {
  AREA_ID,
  area,
  areas,
  CATALOGUE_SINGLE,
  CITY_ID,
  curbside,
  events,
} from '@/src/test/fixtures';
import { createHarness, FakeClock, type Harness, ok } from '@/src/test/harness';

/**
 * The weekday beside a relative date.
 *
 * "tomorrow" and "in 5 days" say how far away a collection is but not which day it falls on; the weekday
 * answers that. In the featured card the absolute fallback past the relative window already names the
 * weekday, so nothing is added there; in a list card the numeric date is already on the line above, so
 * past the window the secondary line is the weekday alone. Expectations are built from independent `Intl` calls, because ICU versions
 * differ on details such as the period in `Fr.`, and a hard-coded string would test the ICU build.
 */

// 2026-09-17 in Berlin, a Thursday.
const NOW = '2026-09-17T08:00:00Z';
const TODAY = '2026-09-17';

/** The weekday as written inside a date — the same CLDR context the product uses (`Do.`, not `Do`). */
const weekday = (locale: Locale, date: string): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .formatToParts(new Date(`${date}T00:00:00Z`))
    .find((part) => part.type === 'weekday')?.value ?? '';

/** The full weekday, from an independent `Intl` call. */
const longWeekday = (locale: Locale, date: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long' }).format(
    new Date(`${date}T00:00:00Z`),
  );

const relative = (locale: Locale, days: number): string =>
  new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day');

const renderSchedule = async (
  dates: readonly string[],
  locale: Locale = 'de',
): Promise<Harness> => {
  const harness = createHarness({ clock: new FakeClock(NOW) });

  harness.gateway
    .queueProviders(ok(CATALOGUE_SINGLE))
    .queueAreas(ok(areas(area())))
    .queueEvents(
      ok(events(dates.map((date, index) => curbside({ id: `paper-${index}-${date}`, date })))),
    );

  const tree = () => (
    <LocaleProvider initial={locale}>
      <ThemeProvider>
        <AppShell controller={harness.controller} snapshot={harness.snapshot()} />
      </ThemeProvider>
    </LocaleProvider>
  );
  const view = render(tree());

  harness.controller.subscribe(() => view.rerender(tree()));
  harness.controller.start();
  await harness.flush();
  harness.controller.selectCity(CITY_ID);
  await harness.flush();
  harness.controller.selectArea(AREA_ID);
  harness.controller.confirm();
  await harness.flush();

  return harness;
};

const cardDate = (): string => screen.getByTestId('next-collection-date').textContent ?? '';

const rowDay = (index: number): string =>
  screen.getAllByTestId('event-row-day')[index]?.textContent ?? '';

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe('the featured card', () => {
  it.each([
    ['tomorrow', '2026-09-18', 1],
    ['in 5 days', '2026-09-22', 5],
  ] as const)('adds the weekday to the date when the label is %s', async (_label, date, days) => {
    await renderSchedule([date]);

    expect(cardDate()).toBe(
      `${relative('de', days)} · ${weekday('de', date)}, ${formatCalendarDate('de', date)}`,
    );
    expect(occurrences(cardDate(), weekday('de', date))).toBe(1);
  });

  it('writes the weekday and date alone on the collection day, where the status says today', async () => {
    await renderSchedule([TODAY]);

    // No relative label in front of it: "Abholung läuft" above the line has already said today.
    expect(cardDate()).toBe(`${weekday('de', TODAY)}, ${formatCalendarDate('de', TODAY)}`);
    expect(cardDate()).not.toContain(relative('de', 0));
    expect(occurrences(cardDate(), weekday('de', TODAY))).toBe(1);
  });

  it('keeps the absolute fallback as it was, without naming the weekday twice', async () => {
    // Twelve days away: past the relative window, so the label already is the weekday form.
    await renderSchedule(['2026-09-29']);

    const text = cardDate();

    expect(occurrences(text, weekday('de', '2026-09-29'))).toBe(1);
    expect(text.endsWith(` · ${formatCalendarDate('de', '2026-09-29')}`)).toBe(true);
  });

  it.each(SUPPORTED_LOCALES)('adds the localized weekday in %s', async (locale) => {
    await renderSchedule(['2026-09-18'], locale);

    expect(cardDate()).toContain(relative(locale, 1));
    expect(cardDate()).toContain(weekday(locale, '2026-09-18'));
    // The card's own localized date policy is kept: the medium date follows, unchanged.
    expect(cardDate().endsWith(formatCalendarDate(locale, '2026-09-18'))).toBe(true);
  });
});

describe('the list rows', () => {
  it('abbreviates the weekday only beside a numeric label, and writes it out otherwise', async () => {
    // Today is featured; the rows are tomorrow, in 5 days and — past the window — in 12 days.
    await renderSchedule([TODAY, '2026-09-18', '2026-09-22', '2026-09-29']);

    const rows = screen.getAllByTestId('event-row');

    expect(within(rows[0] as HTMLElement).getByText('18.09.2026').tagName).toBe('TIME');
    // A word ("morgen"): the weekday is written out.
    expect(rowDay(0)).toBe(`${longWeekday('de', '2026-09-18')} · ${relative('de', 1)}`);
    expect(rowDay(0)).toBe('Freitag · morgen');
    // A number ("in 5 Tagen"): the weekday is abbreviated.
    expect(rowDay(1)).toBe(`${weekday('de', '2026-09-22')} · ${relative('de', 5)}`);
    // Past the window: the full weekday alone. The day and month are already the numeric date above
    // it, so the absolute fallback ("Di., 29. Sept.") is not repeated underneath.
    expect(rowDay(2)).toBe(longWeekday('de', '2026-09-29'));
    expect(rowDay(2)).toBe('Dienstag');
    expect(rowDay(2)).not.toMatch(/29|Sept/);
    expect(
      within(screen.getAllByTestId('event-row')[2] as HTMLElement).getByText('29.09.2026').tagName,
    ).toBe('TIME');
  });

  it.each(SUPPORTED_LOCALES)(
    'shows only the full weekday past the relative window in %s, never the day and month again',
    async (locale) => {
      // Featured today; the only row is twelve days away.
      await renderSchedule([TODAY, '2026-09-29'], locale);

      expect(rowDay(0)).toBe(longWeekday(locale, '2026-09-29'));
      expect(rowDay(0)).not.toContain('29');
      expect(screen.getAllByTestId('event-row')[0]?.querySelector('time')?.textContent).toBe(
        '29.09.2026',
      );
    },
  );

  it('shows the date exactly once per card, whatever the distance', async () => {
    await renderSchedule([TODAY, '2026-09-18', '2026-09-22', '2026-09-29', '2026-10-09']);

    for (const row of screen.getAllByTestId('event-row')) {
      const iso = row.querySelector('time')?.getAttribute('datetime') ?? '';
      const [, month = '', day = ''] = iso.split('-');

      // The numeric date appears once, and the secondary line never names the day of the month.
      expect(occurrences(row.textContent ?? '', `${day}.${month}.`)).toBe(1);
      expect(row.querySelector('[data-testid="event-row-day"]')?.textContent).not.toContain(
        String(Number(day)),
      );
    }
  });

  it('keeps the numeric date on one line and lets only the secondary line wrap', async () => {
    await renderSchedule([TODAY, '2026-09-22'], 'uk');

    const row = screen.getAllByTestId('event-row')[0] as HTMLElement;
    const time = row.querySelector('time');

    expect(time?.className).toContain('whitespace-nowrap');
    expect(time).toHaveAttribute('datetime', '2026-09-22');
    // Two unbreakable pieces: the line can break between them, never inside either.
    const pieces = Array.from(
      screen.getAllByTestId('event-row-day')[0]?.querySelectorAll('.whitespace-nowrap') ?? [],
    ).map((piece) => piece.textContent);

    expect(pieces).toEqual([`${weekday('uk', '2026-09-22')} ·`, relative('uk', 5)]);
  });

  it.each(SUPPORTED_LOCALES)(
    'uses the localized weekday and relative wording in %s',
    async (locale) => {
      await renderSchedule([TODAY, '2026-09-20'], locale);

      expect(rowDay(0)).toBe(`${weekday(locale, '2026-09-20')} · ${relative(locale, 3)}`);
    },
  );

  it.each([
    // Two days away is a word in German, Ukrainian and Russian, but a number in English — which is
    // exactly why the rule asks `Intl` for an integer part instead of counting days.
    ['de', false],
    ['en', true],
    ['uk', false],
    ['ru', false],
  ] as const)(
    'decides the weekday form for "two days away" from Intl in %s (numeric: %s)',
    async (locale, numeric) => {
      await renderSchedule([TODAY, '2026-09-19'], locale);

      const form = numeric ? weekday(locale, '2026-09-19') : longWeekday(locale, '2026-09-19');

      expect(rowDay(0)).toBe(`${form} · ${relative(locale, 2)}`);
    },
  );

  it('writes out the weekday beside "today" when another collection shares the featured day', async () => {
    // Two collections today: the first is featured, the second keeps its row.
    await renderSchedule([TODAY, TODAY]);

    expect(rowDay(0)).toBe(`${longWeekday('de', TODAY)} · ${relative('de', 0)}`);
    expect(rowDay(0)).toBe('Donnerstag · heute');
  });

  it.each(SUPPORTED_LOCALES)('writes out the weekday beside "tomorrow" in %s', async (locale) => {
    await renderSchedule([TODAY, '2026-09-18'], locale);

    expect(rowDay(0)).toBe(`${longWeekday(locale, '2026-09-18')} · ${relative(locale, 1)}`);
  });

  it('leaves the featured event out of the list and the order of the rest intact', async () => {
    await renderSchedule([TODAY, '2026-09-18', '2026-09-22']);

    expect(screen.getAllByTestId('event-row')).toHaveLength(2);
    expect(
      screen.getAllByTestId('event-row').map((row) => row.querySelector('time')?.textContent),
    ).toEqual(['18.09.2026', '22.09.2026']);
  });
});
