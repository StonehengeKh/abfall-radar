import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/src/app/app';
import { ThemeProvider } from '@/src/app/theme';
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
} from '@/src/test/fixtures';
import { createHarness, FakeClock, type Harness, ok } from '@/src/test/harness';
import { setViewportWidth } from '@/src/test/viewport';

/**
 * Where the schedule's four parts sit, and how many of them exist.
 *
 * Order is asserted from the DOM, because the single-column arrangement *is* the DOM order; the
 * two-column arrangement is CSS placement on the same elements, so what is asserted there is that the
 * placement classes are on the right ones. The count matters as much as the order: a second countdown
 * would be a second minute timer.
 */

const at = '2026-08-12T22:30:00Z';

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
  harness.controller.start();
  await harness.flush();
  harness.controller.selectCity(CITY_ID);
  await harness.flush();
  harness.controller.selectArea(AREA_ID);
  harness.controller.confirm();
  await harness.flush();
};

const scheduled = async (width: number): Promise<Harness> => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) });
  act(() => setViewportWidth(width));

  const harness = createHarness({ clock: new FakeClock(at) });

  harness.gateway
    .queueProviders(ok(CATALOGUE_SINGLE))
    .queueAreas(ok(areas(area())))
    .queueEvents(ok(events([curbside({ date: '2026-08-14' }), dropOff()])));
  renderApp(harness);
  await reachSchedule(harness);

  return harness;
};

const precedes = (first: Element, second: Element): boolean =>
  (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(() => {
  vi.useRealTimers();
});

describe('the schedule arrangement', () => {
  it.each([320, 390, 768, 1024])(
    'reads countdown, next collection, events, source at %ipx',
    async (width) => {
      await scheduled(width);

      const countdown = screen.getByTestId('countdown-panel');
      const hero = screen.getByTestId('next-collection');
      const list = screen.getAllByTestId('event-row')[0]?.closest('ul') as Element;
      const source = screen.getByTestId('provenance');

      expect(precedes(countdown, hero)).toBe(true);
      expect(precedes(hero, list)).toBe(true);
      expect(precedes(list, source)).toBe(true);
    },
  );

  it('keeps the days badge in the hero, which is a different thing from the countdown', async () => {
    await scheduled(390);

    const hero = screen.getByTestId('next-collection');

    expect(hero.contains(screen.getByTestId('days-badge'))).toBe(true);
    expect(screen.getByTestId('countdown-panel').contains(screen.getByTestId('days-badge'))).toBe(
      false,
    );
  });

  it('places the countdown back beside the source from the desktop breakpoint', async () => {
    await scheduled(1280);

    // 1280 is Tailwind's `xl`, so the two-column placement starts there and 1024 stays stacked.
    expect(screen.getByTestId('countdown-panel').className).toContain('xl:col-start-2');
    expect(screen.getByTestId('countdown-panel').className).toContain('xl:row-start-1');
    expect(screen.getByTestId('provenance').className).toContain('xl:col-start-2');
    expect(screen.getByTestId('next-collection').className).toContain('xl:col-start-1');
  });

  it.each([390, 1280])(
    'mounts exactly one countdown at %ipx, whatever the width',
    async (width) => {
      await scheduled(width);

      expect(screen.getAllByTestId('countdown-panel')).toHaveLength(1);
      expect(screen.getAllByTestId('provenance')).toHaveLength(1);
      expect(screen.getAllByTestId('next-collection')).toHaveLength(1);
    },
  );

  it('keeps one countdown, and one timer, across a resize', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');

    await scheduled(390);

    const before = timers.mock.calls.length;

    act(() => setViewportWidth(1280));

    expect(screen.getAllByTestId('countdown-panel')).toHaveLength(1);
    // The panel is not remounted by a width change, so it schedules nothing new.
    expect(timers.mock.calls.length).toBe(before);
    // And it still shows the same remaining time it derived from the source zone.
    expect(
      Array.from(screen.getByTestId('countdown-panel').querySelectorAll('.tabular-nums')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['0', '23', '30']);

    timers.mockRestore();
  });
});

describe('the featured collection appears exactly once', () => {
  const scheduledWith = async (
    data: ReadonlyArray<Record<string, unknown>>,
    width = 390,
  ): Promise<Harness> => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) });
    act(() => setViewportWidth(width));

    const harness = createHarness({ clock: new FakeClock(at) });

    harness.gateway
      .queueProviders(ok(CATALOGUE_SINGLE))
      .queueAreas(ok(areas(area())))
      .queueEvents(ok(events(data)));
    renderApp(harness);
    await reachSchedule(harness);

    return harness;
  };

  const rowText = (): string[] =>
    screen.queryAllByTestId('event-row').map((row) => row.textContent ?? '');

  it('shows the featured event in the hero and not again in the list', async () => {
    await scheduledWith([
      curbside({ id: 'paper-2026-08-14', date: '2026-08-14' }),
      curbside({ id: 'yellow-2026-08-20', date: '2026-08-20', wasteType: 'yellow_bag' }),
    ]);

    expect(screen.getByTestId('next-collection')).toHaveTextContent('14.08.2026');
    expect(rowText()).toHaveLength(1);
    expect(rowText()[0]).toContain('20.08.2026');
    expect(rowText()[0]).not.toContain('14.08.2026');
  });

  it('keeps a different event that shares the featured date', async () => {
    await scheduledWith([
      curbside({ id: 'paper-2026-08-14', date: '2026-08-14' }),
      curbside({ id: 'yellow-2026-08-14', date: '2026-08-14', wasteType: 'yellow_bag' }),
    ]);

    // Same day, different collection: excluded by identity, never by date.
    expect(rowText()).toHaveLength(1);
    expect(rowText()[0]).toContain('14.08.2026');
    expect(screen.getAllByTestId('event-row')[0]).toHaveTextContent(MESSAGES.de.waste.yellow_bag);
  });

  it('keeps a later event of the same waste type', async () => {
    await scheduledWith([
      curbside({ id: 'paper-2026-08-14', date: '2026-08-14' }),
      curbside({ id: 'paper-2026-09-11', date: '2026-09-11' }),
    ]);

    expect(rowText()).toHaveLength(1);
    expect(rowText()[0]).toContain('11.09.2026');
  });

  it('preserves the order of everything that remains', async () => {
    await scheduledWith([
      curbside({ id: 'paper-2026-08-14', date: '2026-08-14' }),
      curbside({ id: 'yellow-2026-08-20', date: '2026-08-20', wasteType: 'yellow_bag' }),
      curbside({ id: 'green-2026-09-01', date: '2026-09-01', wasteType: 'green_waste' }),
      dropOff(),
    ]);

    expect(rowText().map((text) => text.slice(0, 10))).toEqual([
      '20.08.2026',
      '01.09.2026',
      '07.11.2026',
    ]);
  });

  it('carries the featured drop-off’s published window and location into the hero', async () => {
    // The drop-off is the only event, so its row is gone: the hero has to carry everything it had.
    await scheduledWith([dropOff()]);

    const hero = screen.getByTestId('next-collection');

    expect(hero).toHaveTextContent('11:00 UTC+01:00–13:00 UTC+01:00 (Europe/Berlin)');
    expect(hero).toHaveTextContent('Rizzastraße Ecke Südallee');
    // And the spoken form is still beside the compact one.
    expect(within(hero).getByText(/Von 11:00/)).toHaveClass('sr-only');
  });

  it('renders no empty list container when the featured event is the only one', async () => {
    await scheduledWith([curbside({ date: '2026-08-14' })]);

    expect(screen.getByTestId('next-collection')).toBeInTheDocument();
    expect(screen.queryAllByTestId('event-row')).toHaveLength(0);
    expect(document.querySelector('main ul')).toBeNull();
    // The supporting panels stay, and nothing claims there are no collections.
    expect(screen.getByTestId('countdown-panel')).toBeInTheDocument();
    expect(screen.getByTestId('provenance')).toBeInTheDocument();
    expect(screen.queryByText(MESSAGES.de.states.empty.heading)).not.toBeInTheDocument();
  });

  it('discards nothing when there is no upcoming event to feature', async () => {
    // Every event is in the past for this source day, so the hero renders nothing.
    await scheduledWith([
      curbside({ id: 'paper-2026-07-10', date: '2026-07-10' }),
      curbside({ id: 'yellow-2026-07-24', date: '2026-07-24', wasteType: 'yellow_bag' }),
    ]);

    expect(screen.queryByTestId('next-collection')).not.toBeInTheDocument();
    expect(rowText()).toHaveLength(2);
  });

  it('leaves the schedule, its counts and the countdown untouched', async () => {
    const harness = await scheduledWith([
      curbside({ id: 'paper-2026-08-14', date: '2026-08-14' }),
      curbside({ id: 'yellow-2026-08-20', date: '2026-08-20', wasteType: 'yellow_bag' }),
    ]);
    const view = harness.view();

    // The underlying schedule still holds both events; only the rendering of one of them moved.
    expect(view.kind === 'live' && view.schedule.events).toHaveLength(2);
    expect(view.kind === 'live' && view.schedule.events.map((event) => event.id)).toEqual([
      'paper-2026-08-14',
      'yellow-2026-08-20',
    ]);
    // The countdown still counts the featured event, from the same source-zone day start.
    expect(
      Array.from(screen.getByTestId('countdown-panel').querySelectorAll('.tabular-nums')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['0', '23', '30']);
  });
});

describe('the list card structure', () => {
  const scheduledWith = async (data: ReadonlyArray<Record<string, unknown>>): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) });
    act(() => setViewportWidth(390));

    const harness = createHarness({ clock: new FakeClock(at) });

    harness.gateway
      .queueProviders(ok(CATALOGUE_SINGLE))
      .queueAreas(ok(areas(area())))
      .queueEvents(ok(events(data)));
    renderApp(harness);
    await reachSchedule(harness);
  };

  it('centres the date, the icon and the title on one row, with the title in its own column', async () => {
    await scheduledWith([
      curbside({ date: '2026-08-14' }),
      curbside({ id: 'b', date: '2026-08-20' }),
    ]);

    const row = screen.getAllByTestId('event-row')[0] as HTMLElement;
    const grid = row.firstElementChild as HTMLElement;
    const title = within(row).getByTestId('event-row-title');

    // Placement is verified in the browser; what is asserted here is the rule that produces it.
    expect(grid.className).toContain('grid');
    expect(grid.className).toContain('items-center');
    expect(grid.className).not.toContain('flex-wrap');
    // The title's track can shrink, so a long title wraps inside it rather than moving under the date.
    expect(grid.className).toContain('minmax(0,1fr)');
    expect(title.className).toContain('min-w-0');
    /*
     * `wrap-anywhere`, not `break-words`: only the former lowers the title's min-content width, which is
     * what lets a long single-word title wrap inside the column instead of widening the card.
     */
    expect(title.className).toContain('wrap-anywhere');
  });

  it('keeps a drop-off’s title and published details together, details after the title', async () => {
    await scheduledWith([curbside({ date: '2026-08-14' }), dropOff()]);

    const row = screen.getAllByTestId('event-row')[0] as HTMLElement;
    const title = within(row).getByTestId('event-row-title');
    const details = within(row).getByTestId('event-row-details');

    // One content group in the document, title first.
    expect(title.parentElement).toBe(details.parentElement);
    expect(title.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Every published detail is still there, with the spoken form of the window beside the compact one.
    expect(details).toHaveTextContent('11:00 UTC+01:00–13:00 UTC+01:00 (Europe/Berlin)');
    expect(details).toHaveTextContent('Rizzastraße Ecke Südallee');
    expect(within(details).getByText(/Von 11:00/)).toHaveClass('sr-only');
    // The icon sits on the title's track, the details on the next one.
    expect(title.className).toContain('@min-[14rem]:row-start-1');
    expect(details.className).toContain('@min-[14rem]:row-start-2');
  });

  it('gives an ordinary collection no details block at all', async () => {
    await scheduledWith([
      curbside({ date: '2026-08-14' }),
      curbside({ id: 'b', date: '2026-08-20' }),
    ]);

    expect(
      within(screen.getAllByTestId('event-row')[0] as HTMLElement).queryByTestId(
        'event-row-details',
      ),
    ).toBeNull();
  });
});
