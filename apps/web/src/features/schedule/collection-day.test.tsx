import { formatWeekdayCalendarDate } from '@abfall-radar/schedule-format';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/src/app/app';
import { LocaleProvider } from '@/src/i18n/context';
import type { Locale } from '@/src/i18n/locale';
import { MESSAGES } from '@/src/i18n/messages';
import { SOURCE_DATE_WATCH_INTERVAL_MS } from '@/src/schedule/source-date-watchdog';
import {
  AREA_ID,
  area,
  areas,
  CATALOGUE_SINGLE,
  CITY_ID,
  curbside,
  dropOff,
  events,
} from '@/src/test/fixtures';
import { createHarness, FakeClock, type Harness, ok } from '@/src/test/harness';

/**
 * The collection day itself: what the featured card says while it is under way, and what the countdown
 * counts once it can no longer count that day.
 *
 * Every instant here is one a device in another zone would read as a different date, because the day
 * that decides both answers is the source's. `Date` alone is faked, so the panel's own minute clock runs
 * on the real timer API exactly as it does in a browser.
 */

const ZONE_DAY_START = '2026-09-17T22:00:00Z';

const renderAt = (
  instant: string,
  scripted: (harness: Harness) => void,
  locale: Locale = 'de',
): Harness => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(instant) });

  const harness = createHarness({ clock: new FakeClock(instant) });

  harness.gateway.queueProviders(ok(CATALOGUE_SINGLE)).queueAreas(ok(areas(area())));
  scripted(harness);

  const tree = (
    <LocaleProvider initial={locale}>
      <AppShell controller={harness.controller} snapshot={harness.snapshot()} />
    </LocaleProvider>
  );
  const view = render(tree);

  harness.controller.subscribe(() => {
    view.rerender(
      <LocaleProvider initial={locale}>
        <AppShell controller={harness.controller} snapshot={harness.snapshot()} />
      </LocaleProvider>,
    );
  });

  return harness;
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

const text = (testId: string): string => screen.getByTestId(testId).textContent ?? '';

const countdownValues = (): string[] =>
  Array.from(screen.getByTestId('countdown-panel').querySelectorAll('.tabular-nums')).map(
    (node) => node.textContent ?? '',
  );

const rowTitles = (): string[] =>
  screen.queryAllByTestId('event-row-title').map((node) => node.textContent ?? '');

afterEach(() => {
  vi.useRealTimers();
});

describe("today's collection in the featured card", () => {
  it('shows the status, keeps the type, weekday and date, and counts the next collection instead', async () => {
    // 08:00 in Berlin on 2026-09-18, a Friday. The device would read 06:00 UTC and, further west, the 17th.
    const harness = renderAt('2026-09-18T06:00:00Z', (created) => {
      created.gateway.queueEvents(
        ok(
          events(
            [
              curbside({ id: 'paper-today', date: '2026-09-18' }),
              curbside({ id: 'yellow-next', date: '2026-09-22', wasteType: 'yellow_bag' }),
            ],
            { range: { from: '2026-09-01', to: '2026-10-31' } },
          ),
        ),
      );
    });

    await reachSchedule(harness);

    // The card keeps today's collection, with the status in place of the day count.
    expect(text('collection-status')).toBe(MESSAGES.de.schedule.inProgress);
    expect(screen.queryByTestId('days-badge')).toBeNull();
    expect(text('next-collection')).toContain(MESSAGES.de.waste.paper);
    expect(text('next-collection-date')).toBe(formatWeekdayCalendarDate('de', '2026-09-18'));

    // The countdown names what it counts, and counts the next date rather than the one under way.
    expect(text('countdown-target')).toContain(MESSAGES.de.waste.yellow_bag);
    expect(text('countdown-target')).toContain(formatWeekdayCalendarDate('de', '2026-09-22'));
    // 2026-09-22 starts at 2026-09-21T22:00:00Z in Berlin: 3 days and 16 hours from 06:00 UTC.
    expect(countdownValues()).toEqual(['3', '16', '0']);
    expect(text('countdown-panel')).toContain(MESSAGES.de.countdown.untilDayStarts);
  });

  it('keeps every other collection on the same day in the list, and features only one', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', (created) => {
      created.gateway.queueEvents(
        ok(
          events(
            [
              curbside({ id: 'paper-today', date: '2026-09-18' }),
              curbside({ id: 'yellow-today', date: '2026-09-18', wasteType: 'yellow_bag' }),
              curbside({ id: 'green-today', date: '2026-09-18', wasteType: 'green_waste' }),
            ],
            { range: { from: '2026-09-01', to: '2026-10-31' } },
          ),
        ),
      );
    });

    await reachSchedule(harness);

    expect(screen.getAllByTestId('collection-status')).toHaveLength(1);
    // The schedule's own order decides which one is featured: one date, so the id tie-break does.
    expect(text('next-collection')).toContain(MESSAGES.de.waste.green_waste);
    // Only that one leaves the list; the other two collections today keep their rows, in order.
    expect(rowTitles()).toEqual([MESSAGES.de.waste.paper, MESSAGES.de.waste.yellow_bag]);
    // Nothing published after today, and not one of today's collections dressed up as a future target.
    expect(text('countdown-none')).toBe(MESSAGES.de.countdown.noFurtherDates);
  });

  it('names every waste type sharing the next collection date under one countdown', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', (created) => {
      created.gateway.queueEvents(
        ok(
          events(
            [
              curbside({ id: 'paper-today', date: '2026-09-18' }),
              curbside({ id: 'yellow-next', date: '2026-09-22', wasteType: 'yellow_bag' }),
              curbside({ id: 'green-next', date: '2026-09-22', wasteType: 'green_waste' }),
            ],
            { range: { from: '2026-09-01', to: '2026-10-31' } },
          ),
        ),
      );
    });

    await reachSchedule(harness);

    const target = text('countdown-target');

    expect(target).toContain(MESSAGES.de.waste.yellow_bag);
    expect(target).toContain(MESSAGES.de.waste.green_waste);
    // Joined the way German joins a list, and still one countdown rather than two panels.
    expect(target).toContain('und');
    expect(screen.getAllByTestId('countdown-panel')).toHaveLength(1);
    expect(countdownValues()).toEqual(['3', '16', '0']);
  });

  it('leaves a published window on its own day a timed appointment, not a status', async () => {
    // A drop-off published for today, 10:00–12:00 in Berlin, read four hours before it opens.
    const harness = renderAt('2026-09-18T04:00:00Z', (created) => {
      created.gateway.queueEvents(
        ok(
          events(
            [
              dropOff({
                id: 'hazardous-today',
                date: '2026-09-18',
                timing: {
                  kind: 'time_window',
                  startsAt: '2026-09-18T08:00:00Z',
                  endsAt: '2026-09-18T10:00:00Z',
                  timeZone: 'Europe/Berlin',
                },
              }),
            ],
            { range: { from: '2026-09-01', to: '2026-10-31' } },
          ),
        ),
      );
    });

    await reachSchedule(harness);

    expect(screen.queryByTestId('collection-status')).toBeNull();
    expect(text('days-badge')).toBe(MESSAGES.de.schedule.today);
    // Counted to the hour the source published, and described as a wait for the collection itself.
    expect(countdownValues()).toEqual(['0', '4', '0']);
    expect(text('countdown-panel')).toContain(MESSAGES.de.countdown.untilStart);
  });
});

describe('the featured card while a collection is under way', () => {
  const featuredToday = (created: Harness): void => {
    created.gateway.queueEvents(
      ok(
        events(
          [
            curbside({ id: 'paper-today', date: '2026-09-18' }),
            curbside({ id: 'yellow-next', date: '2026-09-22', wasteType: 'yellow_bag' }),
          ],
          { range: { from: '2026-09-01', to: '2026-10-31' } },
        ),
      ),
    );
  };

  it('keeps the collection on the left and puts the status after it, at the end of the card', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', featuredToday);

    await reachSchedule(harness);

    const card = screen.getByTestId('next-collection');
    const heading = screen.getByRole('heading', { name: MESSAGES.de.provenance.nextCollection });
    const status = screen.getByTestId('collection-status');

    // The label, the icon, the type and the date keep the order they have on any other day.
    expect(heading.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByTestId('next-collection-date').compareDocumentPosition(status) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Its own area at the end of the card, not a badge in the leading slot.
    expect(card.lastElementChild).toBe(status);
    expect(status.className).toContain('ms-auto');
    expect(status.className).toContain('text-end');
    expect(screen.queryByTestId('days-badge')).toBeNull();
  });

  it('names the waste type, the weekday and the date exactly once between them', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', featuredToday);

    await reachSchedule(harness);

    const card = screen.getByTestId('next-collection').textContent ?? '';
    const occurrences = (part: string): number => card.split(part).length - 1;

    expect(occurrences(MESSAGES.de.waste.paper)).toBe(1);
    expect(occurrences(formatWeekdayCalendarDate('de', '2026-09-18'))).toBe(1);
    // The status is the only thing added, and it says nothing the lines above already said.
    expect(occurrences(MESSAGES.de.schedule.inProgress)).toBe(1);
    expect(card).not.toContain(MESSAGES.de.schedule.today);
  });

  it('is plain text in the accessibility tree, with no live region announcing every tick', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', featuredToday);

    await reachSchedule(harness);

    const status = screen.getByTestId('collection-status');

    expect(status.textContent).toBe(MESSAGES.de.schedule.inProgress);
    expect(status).not.toHaveAttribute('aria-live');
    expect(status).not.toHaveAttribute('role');
    expect(status.closest('[aria-live]')).toBeNull();
    // One heading for the card, unchanged, and the status is not a second one.
    expect(status.tagName).toBe('P');
    expect(
      screen.getByRole('heading', { name: MESSAGES.de.provenance.nextCollection }).tagName,
    ).toBe('H3');
  });

  it('lets the status wrap to its own row instead of being squeezed beside the collection', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', featuredToday);

    await reachSchedule(harness);

    const card = screen.getByTestId('next-collection');
    const column = screen.getByTestId('next-collection-date').parentElement;

    expect(card.className).toContain('flex-wrap');
    /*
     * A `rem` basis, not `flex-1`: with a zero basis the line could never overflow, so the status would
     * be shrunk into a sliver beside a long waste type rather than wrapping under it. Measured in Chrome,
     * the status sits at the end of the card from 768 px up and takes its own row at 320 and 390 px.
     */
    expect(column?.className).toContain('flex-[1_1_12rem]');
    expect(column?.className).not.toMatch(/\bflex-1\b/);
  });

  it('lifts the label and the date one step, still under the waste type and still muted', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', featuredToday);

    await reachSchedule(harness);

    const label = screen.getByRole('heading', { name: MESSAGES.de.provenance.nextCollection });
    const date = screen.getByTestId('next-collection-date');
    const type = date.previousElementSibling?.querySelector('span');

    expect(label.className).toContain('text-sm');
    expect(date.className).toContain('text-base');
    // The waste type stays the largest line, and both of these stay the secondary colour.
    expect(type?.className).toContain('text-lg');
    expect(label.className).toContain('text-ar-text-muted');
    expect(date.className).toContain('text-ar-text-muted');
    // One date element, said once.
    expect(screen.getAllByTestId('next-collection-date')).toHaveLength(1);
  });

  it('leaves the card of any other day at its accepted sizes', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', (created) => {
      created.gateway.queueEvents(
        ok(
          events([curbside({ id: 'paper-later', date: '2026-09-22' })], {
            range: { from: '2026-09-01', to: '2026-10-31' },
          }),
        ),
      );
    });

    await reachSchedule(harness);

    expect(screen.queryByTestId('collection-status')).toBeNull();
    expect(
      screen.getByRole('heading', { name: MESSAGES.de.provenance.nextCollection }).className,
    ).toContain('text-xs');
    expect(screen.getByTestId('next-collection-date').className).toContain('text-sm');
  });

  it('stamps one text node, and only where the card is wide enough for the treatment', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', featuredToday);

    await reachSchedule(harness);

    const card = screen.getByTestId('next-collection');
    const status = screen.getByTestId('collection-status');

    // One semantic node carries the sentence: the stamp is presentation, never a second copy of it.
    expect(status.childNodes).toHaveLength(1);
    expect(status.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(screen.getAllByText(MESSAGES.de.schedule.inProgress)).toHaveLength(1);

    // The outline, the wash and the tilt are container-query steps, so a small or enlarged card keeps
    // the plain upright text; nothing in the base class list paints or rotates a stamp.
    expect(card.className).toContain('@container');

    const base = status.className
      .split(' ')
      .filter((name) => !name.startsWith('@min-['))
      .join(' ');

    expect(base).not.toMatch(/rotate|border|bg-/);
    expect(status.className).toContain('@min-[26rem]:border-2');
    expect(status.className).toContain('@min-[38rem]:-rotate-[5deg]');
    // A static treatment: nothing here animates, so reduced motion has nothing to suppress.
    expect(status.className).not.toMatch(/transition|animate/);
  });

  it('shares the first grid row with the countdown, both stretched to one height', async () => {
    const harness = renderAt('2026-09-18T06:00:00Z', featuredToday);

    await reachSchedule(harness);

    // jsdom lays nothing out; the rendered equality was measured in Chrome and is in the report.
    for (const testId of ['next-collection', 'countdown-panel']) {
      const panel = screen.getByTestId(testId);

      expect(panel.className).toContain('xl:row-start-1');
      expect(panel.className).toContain('xl:self-stretch');
    }

    // The source panel below keeps its own height rather than being stretched to the list beside it.
    expect(screen.getByTestId('provenance').className).not.toContain('self-stretch');
  });
});

describe('the source-local midnight', () => {
  it('turns tomorrow into today, and moves the countdown on, without a reload', async () => {
    // 23:30 in Berlin on 2026-09-17: tomorrow's collection is half an hour away.
    const harness = renderAt('2026-09-17T21:30:00Z', (created) => {
      created.gateway.queueEvents(
        ok(
          events(
            [
              curbside({ id: 'paper-tomorrow', date: '2026-09-18' }),
              curbside({ id: 'yellow-next', date: '2026-09-22', wasteType: 'yellow_bag' }),
            ],
            { range: { from: '2026-09-01', to: '2026-10-31' } },
          ),
        ),
      );
    });

    await reachSchedule(harness);

    expect(screen.queryByTestId('collection-status')).toBeNull();
    expect(countdownValues()).toEqual(['0', '0', '30']);

    /*
     * Midnight at the municipality. The device clock and the controller's clock both move, the schedule
     * is re-read for the new source day, and the watchdog's next check is what notices the date changed.
     */
    harness.gateway.queueEvents(
      ok(
        events(
          [
            curbside({ id: 'paper-tomorrow', date: '2026-09-18' }),
            curbside({ id: 'yellow-next', date: '2026-09-22', wasteType: 'yellow_bag' }),
          ],
          { range: { from: '2026-09-01', to: '2026-10-31' } },
        ),
      ),
    );
    vi.setSystemTime(new Date(ZONE_DAY_START));
    harness.clock.set(ZONE_DAY_START);
    harness.timers.fire(SOURCE_DATE_WATCH_INTERVAL_MS);
    await harness.flush();

    // The card keeps the same collection and now says it is under way.
    expect(text('collection-status')).toBe(MESSAGES.de.schedule.inProgress);
    expect(text('next-collection')).toContain(MESSAGES.de.waste.paper);
    // And the countdown has moved to the next published date instead of counting zero or a negative.
    expect(text('countdown-target')).toContain(MESSAGES.de.waste.yellow_bag);
    expect(countdownValues()).toEqual(['4', '0', '0']);
    expect(text('countdown-panel')).not.toMatch(/-\d/);
  });
});
