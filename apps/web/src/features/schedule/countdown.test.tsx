import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/src/app/app';
import { LocaleProvider } from '@/src/i18n/context';
import type { Locale } from '@/src/i18n/locale';
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

/**
 * The countdown panel and the days badge: two places where a number is put on screen.
 *
 * Both are derived, never invented. The target instant for a date-only collection is the start of that
 * calendar day **in the source's zone**, which is why every case here is written against instants the
 * device zone would answer differently — including both German daylight-saving transitions, where a day
 * is 23 or 25 hours long and an assumed 24-hour offset is wrong by an hour.
 *
 * `Date` alone is faked. The real timer API keeps working, so the panel's minute clock behaves as it
 * does in a browser instead of being driven by hand.
 */

const renderAt = (
  instant: string,
  scripted: (harness: Harness) => void,
  locale: Locale = 'de',
): Harness => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(instant) });

  const harness = createHarness({ clock: new FakeClock(instant) });

  harness.gateway.queueProviders(ok(CATALOGUE_SINGLE)).queueAreas(ok(areas(area())));
  scripted(harness);

  const view = render(
    <LocaleProvider initial={locale}>
      <AppShell controller={harness.controller} snapshot={harness.snapshot()} />
    </LocaleProvider>,
  );

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

/** The three countdown numbers, in the order they are rendered. */
const countdownValues = (): string[] =>
  Array.from(screen.getByTestId('countdown-panel').querySelectorAll('.tabular-nums')).map(
    (node) => node.textContent ?? '',
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('the countdown to the next collection', () => {
  it('counts to the start of the collection day in the source zone, not to a UTC or device midnight', async () => {
    /*
     * 2026-08-13 00:30 in Berlin, which is still 2026-08-12 in UTC and earlier still further west. A
     * collection published for 2026-08-14 therefore starts 23 h 30 min later — 2026-08-13T22:00:00Z,
     * midnight at the municipality. Counting to a UTC midnight would answer 25 h 30 min, and counting
     * to the device's midnight would answer differently again on every machine that runs this suite.
     */
    const harness = renderAt('2026-08-12T22:30:00Z', (created) => {
      created.gateway.queueEvents(ok(events([curbside({ date: '2026-08-14' })])));
    });

    await reachSchedule(harness);

    expect(countdownValues()).toEqual(['0', '23', '30']);
    expect(screen.getByTestId('countdown-panel').textContent).toContain(
      MESSAGES.de.countdown.untilDayStarts,
    );
  });

  it('keeps a 25-hour day 25 hours long when the clocks go back', async () => {
    // 2026-10-25 is 25 hours long in Berlin. Its start is 2026-10-24T22:00:00Z, still summer time, so
    // an event that day is exactly 24 h away from 2026-10-23T22:00:00Z — one whole calendar day.
    const harness = renderAt('2026-10-23T22:00:00Z', (created) => {
      created.gateway.queueEvents(ok(events([curbside({ date: '2026-10-25' })])));
    });

    await reachSchedule(harness);

    expect(countdownValues()).toEqual(['1', '0', '0']);
  });

  it('keeps a 23-hour day 23 hours long when the clocks go forward', async () => {
    // The spring transition: 2026-03-29 begins at 2026-03-28T23:00:00Z in winter time. A fixed 24-hour
    // assumption from a UTC midnight would report an hour too many.
    const harness = renderAt('2026-03-27T23:00:00Z', (created) => {
      created.gateway.queueEvents(ok(events([curbside({ date: '2026-03-29' })])));
    });

    await reachSchedule(harness);

    expect(countdownValues()).toEqual(['1', '0', '0']);
  });

  it('counts to the published start when the source gives an exact time', async () => {
    const harness = renderAt('2026-11-07T08:45:00Z', (created) => {
      created.gateway.queueEvents(ok(events([dropOff()])));
    });

    await reachSchedule(harness);

    // 10:00 UTC is what the source published; 1 h 15 min away, and labelled as a wait for the
    // collection itself rather than for a day to begin.
    expect(countdownValues()).toEqual(['0', '1', '15']);
    const panel = screen.getByTestId('countdown-panel').textContent ?? '';
    expect(panel).toContain(MESSAGES.de.countdown.untilStart);
    expect(panel).not.toContain(MESSAGES.de.countdown.untilDayStarts);
  });

  it('moves on to the next collection once a date-only collection day has arrived', async () => {
    const harness = renderAt('2026-08-14T06:00:00Z', (created) => {
      created.gateway.queueEvents(
        ok(
          events([
            curbside({ date: '2026-08-14' }),
            curbside({ id: 'yellow-2026-08-15', date: '2026-08-15', wasteType: 'yellow_bag' }),
          ]),
        ),
      );
    });

    await reachSchedule(harness);

    // Today's collection keeps the card; the countdown counts the next day, not zero and not a negative.
    expect(screen.getByTestId('collection-status').textContent).toBe(
      MESSAGES.de.schedule.inProgress,
    );
    expect(screen.getByTestId('countdown-target').textContent).toContain(
      MESSAGES.de.waste.yellow_bag,
    );
    // 2026-08-15 begins at 2026-08-14T22:00:00Z in Berlin: 16 hours from 06:00 UTC.
    expect(countdownValues()).toEqual(['0', '16', '0']);
    expect(screen.getByTestId('countdown-panel').textContent).not.toMatch(/-\d/);
  });

  it('says that nothing further is published rather than counting to an invented target', async () => {
    const harness = renderAt('2026-12-15T10:00:00Z', (created) => {
      created.gateway.queueEvents(ok(events([curbside(), dropOff()])));
    });

    await reachSchedule(harness);

    expect(screen.getByTestId('countdown-none').textContent).toBe(
      MESSAGES.de.countdown.noFurtherDates,
    );
    expect(screen.queryByTestId('countdown-target')).toBeNull();
    expect(screen.getByTestId('countdown-panel').querySelectorAll('.tabular-nums')).toHaveLength(0);
    // The source section stays: where the schedule came from is true whether or not anything is due.
    expect(screen.getByTestId('provenance')).toBeInTheDocument();
  });

  it('counts the same event the highlighted card names, and sits directly above the source section', async () => {
    const harness = renderAt('2026-08-12T22:30:00Z', (created) => {
      created.gateway.queueEvents(
        ok(events([curbside({ date: '2026-08-14' }), dropOff({ date: '2026-11-07' })])),
      );
    });

    await reachSchedule(harness);

    // The nearer of the two upcoming events, in both places.
    expect(screen.getByTestId('next-collection').textContent).toContain(MESSAGES.de.waste.paper);
    expect(countdownValues()).toEqual(['0', '23', '30']);

    const countdown = screen.getByTestId('countdown-panel');
    const provenance = screen.getByTestId('provenance');

    expect(countdown.compareDocumentPosition(provenance)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING as number,
    );
  });

  it('makes no request of its own', async () => {
    const harness = renderAt('2026-08-12T22:30:00Z', (created) => {
      created.gateway.queueEvents(ok(events([curbside({ date: '2026-08-14' })])));
    });

    await reachSchedule(harness);
    const calls = harness.gateway.calls.length;

    vi.setSystemTime(new Date('2026-08-13T10:00:00Z'));
    await harness.flush();

    expect(harness.gateway.calls.length).toBe(calls);
  });
});

describe('the days badge', () => {
  const badge = (): string => screen.getByTestId('days-badge').textContent ?? '';

  it.each([
    ['de', 1, '1Tag'],
    ['de', 2, '2Tage'],
    ['en', 1, '1day'],
    ['en', 2, '2days'],
    ['uk', 2, '2дні'],
    ['uk', 5, '5днів'],
    ['ru', 2, '2дня'],
    ['ru', 5, '5дней'],
  ] as const)('agrees the unit with the number in %s: %i', async (locale, days, expected) => {
    // The source day at this instant is 2026-08-13, so the event date is chosen `days` ahead of it.
    const date = new Date(Date.UTC(2026, 7, 13 + days)).toISOString().slice(0, 10);
    const harness = renderAt(
      '2026-08-12T22:30:00Z',
      (created) => {
        created.gateway.queueEvents(ok(events([curbside({ date })])));
      },
      locale,
    );

    await reachSchedule(harness);

    expect(badge()).toBe(expected);
    // The whole phrase is also what an assistive technology is given, in one piece.
    expect(screen.getByTestId('days-badge')).toHaveAccessibleName(
      expected.replace(String(days), `${days} `),
    );
  });

  it('says "today" for a published window whose day has arrived, and is not shown at all for an all-day collection', async () => {
    const timed = renderAt('2026-11-07T06:00:00Z', (created) => {
      created.gateway.queueEvents(ok(events([dropOff()])));
    });

    await reachSchedule(timed);

    // A drop-off publishes its own hours, so its day is a count of zero days, not a status.
    expect(badge()).toBe(MESSAGES.de.schedule.today);
    expect(screen.queryByTestId('collection-status')).toBeNull();

    cleanup();

    const allDay = renderAt('2026-08-14T06:00:00Z', (created) => {
      created.gateway.queueEvents(ok(events([curbside({ date: '2026-08-14' })])));
    });

    await reachSchedule(allDay);

    expect(screen.queryByTestId('days-badge')).toBeNull();
    expect(screen.getByTestId('collection-status').textContent).toBe(
      MESSAGES.de.schedule.inProgress,
    );
  });
});
