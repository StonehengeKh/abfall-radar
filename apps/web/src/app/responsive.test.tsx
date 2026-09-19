import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/src/app/app';
import { ThemeProvider } from '@/src/app/theme';
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
import { createHarness, type Harness, ok } from '@/src/test/harness';
import { setViewportWidth } from '@/src/test/viewport';

/**
 * The responsive shell: which appearance control the width carries, what the header shows, what closes
 * the page, and what a resize must not leave behind.
 *
 * Width comes from `matchMedia`, the same question CSS asks, so these tests resize a notional viewport
 * and let the components answer it. jsdom has no layout, so nothing here asserts a rendered pixel —
 * measurements at 320, 390, 768 and 1280 were taken in a real browser and recorded in the report.
 */

const NARROW = 390;
const WIDE = 1280;

const renderApp = (harness: Harness, locale: Locale = 'de') => {
  const tree = () => (
    <LocaleProvider initial={locale}>
      <ThemeProvider>
        <AppShell controller={harness.controller} snapshot={harness.snapshot()} />
      </ThemeProvider>
    </LocaleProvider>
  );
  const view = render(tree());

  harness.controller.subscribe(() => view.rerender(tree()));

  return view;
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

const scheduled = (harness: Harness) =>
  harness.gateway
    .queueProviders(ok(CATALOGUE_SINGLE))
    .queueAreas(ok(areas(area())))
    .queueEvents(ok(events([curbside(), dropOff()])));

/** Resizing is an event the browser dispatches, so it happens inside `act` like any other. */
const resizeTo = (width: number): void => {
  act(() => setViewportWidth(width));
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('the appearance control across the breakpoint', () => {
  it('is a menu where the header is narrow and a segmented control where it is wide', async () => {
    const harness = createHarness();

    scheduled(harness);
    resizeTo(NARROW);
    renderApp(harness);
    await reachSchedule(harness);

    expect(screen.getByTestId('theme-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-control')).not.toBeInTheDocument();

    resizeTo(WIDE);

    expect(screen.getByTestId('theme-control')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-menu')).not.toBeInTheDocument();
  });

  it('names the current preference on the compact trigger, and offers all three choices', async () => {
    const harness = createHarness();

    scheduled(harness);
    resizeTo(NARROW);
    renderApp(harness);
    await reachSchedule(harness);

    const trigger = screen.getByTestId('theme-menu');

    expect(trigger).toHaveAccessibleName(
      `${MESSAGES.de.appearance.label}: ${MESSAGES.de.appearance.system}`,
    );

    await userEvent.click(trigger);

    const menu = screen.getByRole('menu');

    for (const option of ['light', 'dark', 'system'] as const) {
      expect(
        within(menu).getByRole('menuitemradio', { name: MESSAGES.de.appearance[option] }),
      ).toBeInTheDocument();
    }

    expect(
      within(menu).getByRole('menuitemradio', { name: MESSAGES.de.appearance.system }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('carries one preference across the switch, whichever control set it', async () => {
    const harness = createHarness();

    scheduled(harness);
    resizeTo(NARROW);
    renderApp(harness);
    await reachSchedule(harness);

    await userEvent.click(screen.getByTestId('theme-menu'));
    await userEvent.click(screen.getByRole('menuitemradio', { name: MESSAGES.de.appearance.dark }));

    expect(document.documentElement.dataset.theme).toBe('dark');

    resizeTo(WIDE);

    // The same preference, now shown by the other presentation — not a second, separate state.
    expect(screen.getByTestId('theme-control')).toHaveAccessibleName(
      `${MESSAGES.de.appearance.label}: ${MESSAGES.de.appearance.dark}`,
    );
    expect(document.documentElement.dataset.theme).toBe('dark');

    await userEvent.click(screen.getByTestId('theme-control'));
    await userEvent.click(
      screen.getByRole('menuitemradio', { name: MESSAGES.de.appearance.light }),
    );
    resizeTo(NARROW);

    expect(screen.getByTestId('theme-menu')).toHaveAccessibleName(
      `${MESSAGES.de.appearance.label}: ${MESSAGES.de.appearance.light}`,
    );
  });

  it('leaves no orphaned overlay, no lost focus and no scroll lock when the width changes', async () => {
    const harness = createHarness();

    scheduled(harness);
    resizeTo(NARROW);
    renderApp(harness);
    await reachSchedule(harness);

    await userEvent.click(screen.getByTestId('theme-menu'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(document.activeElement).toBe(
      screen.getByRole('menuitemradio', { name: MESSAGES.de.appearance.system }),
    );

    resizeTo(WIDE);

    // The popup went with the control that owned it.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // Focus is on something that exists, is reachable, and is in the header — never on `<body>`.
    const active = document.activeElement;

    expect(active).not.toBe(document.body);
    expect(active?.isConnected).toBe(true);
    expect(active?.closest('header')).not.toBeNull();
    expect(screen.getByTestId('theme-control').contains(active)).toBe(true);

    // Nothing ever locked scrolling, so nothing can be left locked.
    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('does not take focus from elsewhere on a resize nobody was interacting with', async () => {
    const harness = createHarness();

    scheduled(harness);
    resizeTo(NARROW);
    renderApp(harness);
    await reachSchedule(harness);

    const elsewhere = screen.getByRole('button', { name: MESSAGES.de.actions.changeSelection });

    elsewhere.focus();
    resizeTo(WIDE);

    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('the header place', () => {
  it('shows the full city and district, and is the existing change-selection action', async () => {
    const harness = createHarness();

    scheduled(harness);
    resizeTo(NARROW);
    renderApp(harness);
    await reachSchedule(harness);

    const place = screen.getByTestId('header-place');

    expect(place.tagName).toBe('BUTTON');
    expect(place).toHaveAccessibleName(
      `${MESSAGES.de.actions.changeSelection}: Koblenz · Stadtmitte`,
    );
    // Wrapping, not an ellipsis: the end of a district name is what distinguishes one from another.
    expect(place.className).not.toContain('truncate');
    expect(place.querySelector('.break-words')).not.toBeNull();

    await userEvent.click(place);

    expect(harness.view().kind).toBe('needs_selection');
  });

  it('stays plain text when there is no selection to change', async () => {
    const harness = createHarness();

    harness.gateway.queueProviders(ok(CATALOGUE_SINGLE)).queueAreas(ok(areas(area())));
    resizeTo(NARROW);
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    expect(screen.getByTestId('header-place').tagName).toBe('SPAN');
  });
});

describe('the page shell and footer', () => {
  it('puts the viewport minimum on the shell and leaves every child content-driven', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    await reachSchedule(harness);

    const main = document.querySelector('main');
    const shell = main?.parentElement;

    // The regression this guards: a viewport-tall `<main>` left dead space under short content.
    expect(shell?.className).toContain('min-h-dvh');
    expect(main?.className).not.toMatch(/min-h-/);
    expect(main?.className).toContain('flex-1');
    // And the footer is the last thing in the shell, in normal flow.
    expect(shell?.lastElementChild?.tagName).toBe('FOOTER');
    expect(shell?.lastElementChild?.className).not.toMatch(/fixed|absolute|sticky/);
  });

  it('describes the product and the city it is showing, in each language', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    await reachSchedule(harness);

    const footer = screen.getByRole('contentinfo');

    // The wordmark is one name even though its second half carries the accent colour.
    expect(footer.textContent).toContain('AbfallRadar');
    expect(within(footer).getByText(MESSAGES.de.footer.description('Koblenz'))).toBeInTheDocument();
    // Branding and description only: the way back to the top is no longer a button in here.
    expect(within(footer).queryByRole('button')).not.toBeInTheDocument();
    expect(MESSAGES.de.footer.description('Koblenz')).toBe('Abfuhrtermine für Koblenz');

    for (const locale of ['en', 'uk', 'ru'] as const) {
      expect(MESSAGES[locale].footer.description('Koblenz')).toContain('Koblenz');
      expect(MESSAGES[locale].footer.description(null)).not.toContain('Koblenz');
    }
  });

  it('offers a floating way back to the top only once the page is long and scrolled', async () => {
    const harness = createHarness();
    const scrollTo = vi.fn();

    vi.stubGlobal('scrollTo', scrollTo);
    scheduled(harness);
    renderApp(harness);
    await reachSchedule(harness);

    expect(screen.queryByTestId('back-to-top')).not.toBeInTheDocument();

    // jsdom lays nothing out, so the page is made long and scrolled the only way it can be.
    const page = (scrollY: number, footerTop: number): void => {
      vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(4000);
      vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
      Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
      vi.spyOn(screen.getByRole('contentinfo'), 'getBoundingClientRect').mockReturnValue({
        top: footerTop,
      } as DOMRect);
      act(() => window.dispatchEvent(new Event('scroll')));
    };

    // Near the top: nothing offered, however long the page is.
    page(120, 3000);
    expect(screen.queryByTestId('back-to-top')).not.toBeInTheDocument();

    // Scrolled well down, footer still below the fold: offered.
    page(1500, 3000);

    const button = screen.getByTestId('back-to-top');

    expect(button).toHaveAccessibleName(MESSAGES.de.footer.backToTop);
    // Icon only — the name is for assistive technology, not printed beside it.
    expect(button.textContent).toBe('');
    expect(button.className).toMatch(/h-11/);
    expect(button.className).toMatch(/w-11/);
    expect(button.className).toContain('fixed');
    // Outside the footer, so it can never cover its content.
    expect(button.closest('footer')).toBeNull();
    // Inside the safe area on a phone with a home indicator or rounded corners.
    expect(button.className).toContain('safe-area-inset-bottom');

    await userEvent.click(button);

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    expect(document.activeElement?.id).toBe('app-title');

    // Over text it is hidden but stays mounted in place, and it shows again as soon as the text scrolls clear.
    const lineBoxes: DOMRect[] = [];

    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      left: 330,
      right: 374,
      top: 780,
      bottom: 824,
      width: 44,
      height: 44,
    } as DOMRect);
    Range.prototype.getClientRects = () => lineBoxes as unknown as DOMRectList;
    lineBoxes.push({ left: 16, right: 374, top: 790, bottom: 814 } as DOMRect);
    page(1520, 3000);

    expect(button).toBe(screen.getByTestId('back-to-top'));
    expect(button.dataset.covering).toBe('true');
    expect(button.style.visibility).toBe('hidden');

    lineBoxes.length = 0;
    page(1540, 3000);

    expect(button.dataset.covering).toBe('false');
    expect(button.style.visibility).toBe('');
    Reflect.deleteProperty(Range.prototype, 'getClientRects');

    // Once the footer comes into view it gets out of the way of the actions that live above it.
    page(1500, 400);
    expect(screen.queryByTestId('back-to-top')).not.toBeInTheDocument();

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

describe('compact dates in the schedule list', () => {
  it.each(['de', 'en', 'uk', 'ru'] as const)(
    'writes the same numeric date in %s, with the source day in the element',
    async (locale) => {
      const harness = createHarness();

      scheduled(harness);
      renderApp(harness, locale);
      await reachSchedule(harness);

      // The first row is the drop-off: the curbside collection is the featured one, shown in the hero.
      const [row] = screen.getAllByTestId('event-row');
      const date = row?.querySelector('time');

      expect(date).not.toBeNull();
      expect(date?.textContent).toBe('07.11.2026');
      // The machine-readable value is the source calendar day, never a formatted string.
      expect(date).toHaveAttribute('datetime', '2026-11-07');
      // No trailing era word from any locale, and nothing that could wrap the column.
      expect(date?.textContent).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
      expect(date?.className).toContain('whitespace-nowrap');
    },
  );

  it('keeps the localized date in the prominent next-collection card', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness, 'en');
    await reachSchedule(harness);

    const card = screen.getByTestId('next-collection');

    // English medium style, not the compact numeric form the list rows use.
    expect(card).toHaveTextContent('Aug 14, 2026');
    expect(card).not.toHaveTextContent('14.08.2026');
  });
});

describe('the city introduction above the districts', () => {
  it('names the city, says what to do, and treats the artwork as decoration', async () => {
    const harness = createHarness();

    harness.gateway.queueProviders(ok(CATALOGUE_SINGLE)).queueAreas(ok(areas(area())));
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    const intro = screen.getByTestId('city-intro');

    expect(within(intro).getByRole('heading', { name: 'Koblenz' })).toBeInTheDocument();
    expect(within(intro).getByText(MESSAGES.de.steps.selectDistrict)).toBeInTheDocument();

    const artwork = intro.querySelector('svg');

    expect(artwork).toHaveAttribute('aria-hidden', 'true');
    expect(artwork).toHaveAttribute('focusable', 'false');
    // Decorative means no name of its own: the city beside it is what carries the meaning.
    expect(artwork?.querySelector('title')).toBeNull();
    // Local artwork: no external request, no image element.
    expect(intro.querySelector('img')).toBeNull();
  });
});

describe('the header composition', () => {
  /** The controls sit in their own group; this is the element that has to be pushed right. */
  const controlGroup = (): HTMLElement | null =>
    screen.getByTestId('language-control').closest('div')?.parentElement ?? null;

  it('keeps the controls at the far right on the very first screen, with no location yet', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    harness.controller.start();
    await harness.flush();

    // Nothing is selected, so there is deliberately no place — and no invented one to fill the row.
    expect(screen.queryByTestId('header-place')).not.toBeInTheDocument();

    const controls = controlGroup();

    expect(controls?.className).toContain('ms-auto');
    // Last in the header row, after the brand group, at this width and at every other.
    expect(controls?.parentElement?.lastElementChild).toBe(controls);

    resizeTo(NARROW);
    expect(controlGroup()?.className).toContain('ms-auto');
  });

  it('puts the location under the wordmark inside the brand group, not on a row of its own', async () => {
    const harness = createHarness();

    scheduled(harness);
    resizeTo(NARROW);
    renderApp(harness);
    await reachSchedule(harness);

    const wordmark = document.getElementById('app-title');
    const place = screen.getByTestId('header-place');
    const group = wordmark?.parentElement;

    // One group: name above, location below, both beside the mark.
    expect(group?.contains(place)).toBe(true);
    expect(group?.className).toContain('flex-col');
    // The group can shrink, which is what keeps a long district from pushing the controls off-screen.
    expect(group?.className).toContain('min-w-0');
    // And the location still wraps rather than losing the end of the district name.
    expect(place.querySelector('.break-words')).not.toBeNull();
    expect(place.className).not.toContain('truncate');
    // No full-width row: the location is not a direct child of the header row any more.
    expect(place.parentElement).toBe(group);
  });

  it('reads the wordmark as one brand name despite the accent on its second half', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    await reachSchedule(harness);

    const wordmark = screen.getByRole('heading', { level: 1 });

    expect(wordmark).toHaveAccessibleName('AbfallRadar');
    expect(wordmark.textContent).toBe('AbfallRadar');
    // The accent is the theme's own brand colour, not a new value.
    expect(wordmark.querySelector('.text-ar-brand')?.textContent).toBe('Radar');
  });

  it('gives every top-level surface the same heading scale under one site heading', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    await reachSchedule(harness);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    const heading = screen.getByRole('heading', {
      level: 2,
      name: MESSAGES.de.states.live.heading,
    });

    expect(heading.className).toContain('sm:text-2xl');
    expect(heading.className).toContain('font-semibold');
  });
});

describe('the city introduction', () => {
  it('sits on the page ground, with no card around it', async () => {
    const harness = createHarness();

    harness.gateway.queueProviders(ok(CATALOGUE_SINGLE)).queueAreas(ok(areas(area())));
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    const intro = screen.getByTestId('city-intro');

    expect(intro.className).not.toMatch(/border|bg-ar-surface|shadow|rounded/);
    // Still the same introduction, just unboxed.
    expect(within(intro).getByRole('heading', { name: 'Koblenz' })).toBeInTheDocument();
    expect(within(intro).getByText(MESSAGES.de.steps.selectDistrict)).toBeInTheDocument();
  });
});

describe('the collapsed desktop appearance control', () => {
  const open = async (): Promise<HTMLElement> => {
    await userEvent.click(screen.getByTestId('theme-control'));

    return screen.getByRole('menu');
  };

  const mounted = async (): Promise<Harness> => {
    const harness = createHarness();

    scheduled(harness);
    resizeTo(WIDE);
    renderApp(harness);
    await reachSchedule(harness);

    return harness;
  };

  it('shows only the current icon, on the same neutral surface as the language control', async () => {
    await mounted();

    const trigger = screen.getByTestId('theme-control');

    expect(trigger).toHaveAccessibleName(
      `${MESSAGES.de.appearance.label}: ${MESSAGES.de.appearance.system}`,
    );
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // One icon, no text, and no bright filled state on the collapsed control.
    expect(trigger.textContent).toBe('');
    expect(trigger.querySelectorAll('svg')).toHaveLength(1);
    expect(trigger.className).not.toContain('bg-ar-brand');
    expect(trigger.className).toContain('border-ar-border');
    expect(trigger.className).toContain('bg-ar-surface');
    // The same surface class the language trigger uses.
    expect(trigger.className).toBe(screen.getByTestId('language-control').className);
  });

  it('opens a horizontal popover of the three named choices, marking the current one', async () => {
    await mounted();

    const menu = await open();

    expect(menu).toHaveAttribute('aria-orientation', 'horizontal');
    expect(screen.getByTestId('theme-control')).toHaveAttribute('aria-expanded', 'true');

    const options = within(menu).getAllByRole('menuitemradio');

    expect(options).toHaveLength(3);
    // Icons, named for assistive technology rather than labelled on screen.
    for (const option of options) {
      expect(option.textContent).toBe('');
      expect(option.querySelectorAll('svg')).toHaveLength(1);
    }
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      MESSAGES.de.appearance.system,
      MESSAGES.de.appearance.light,
      MESSAGES.de.appearance.dark,
    ]);

    const current = within(menu).getByRole('menuitemradio', {
      name: MESSAGES.de.appearance.system,
      checked: true,
    });

    // Marked by emphasis, not by the filled background the collapsed trigger dropped. The emphasis is on
    // the visible 36 px circle; the option itself is the 44 px target, so its border cannot shrink it.
    const circle = current.firstElementChild as HTMLElement;

    expect(circle.className).toContain('border-ar-brand');
    expect(circle.className).toContain('text-ar-brand');
    expect(current.className).toContain('h-11');
    expect(current.className).toContain('w-11');
    // Every option has the same geometry: the unselected ones carry a transparent border.
    for (const option of options) {
      expect((option.firstElementChild as HTMLElement).className).toMatch(/\bborder\b/);
      expect(option).toHaveAttribute('tabindex', '-1');
    }
  });

  it('applies a choice and closes, without touching the schedule or the gateway', async () => {
    const harness = await mounted();
    const calls = harness.gateway.calls.length;

    await open();
    await userEvent.click(screen.getByRole('menuitemradio', { name: MESSAGES.de.appearance.dark }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('theme-control'));
    // A presentation change is not a data change.
    expect(harness.gateway.calls.length).toBe(calls);
    expect(harness.view().kind).toBe('live');
  });

  it('moves along the row with the arrow keys and closes on Escape, returning focus', async () => {
    await mounted();

    const menu = await open();
    const options = within(menu).getAllByRole('menuitemradio');

    expect(document.activeElement).toBe(options[0]);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(options[1]);

    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(options[0]);

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('theme-control'));
  });

  it('dismisses on a click outside', async () => {
    await mounted();
    await open();

    await userEvent.click(screen.getByRole('heading', { level: 1 }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('leaves no duplicate popover, no lost focus and no stale listener when the width changes', async () => {
    await mounted();
    await open();

    resizeTo(NARROW);

    expect(screen.queryAllByRole('menu')).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByTestId('theme-menu'));

    // The listener the open popover registered went with it: a click outside throws nothing and
    // leaves the replacement control alone.
    await userEvent.click(screen.getByRole('heading', { level: 1 }));

    expect(screen.queryAllByRole('menu')).toHaveLength(0);
    expect(screen.getByTestId('theme-menu')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('the header location keeps its geometry across confirmation', () => {
  it('gives the static and interactive variants the same row box', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    harness.controller.selectCity(CITY_ID);
    await harness.flush();

    const staticLabel = screen.getByTestId('header-place');

    expect(staticLabel.tagName).toBe('SPAN');

    const geometry = (element: Element): string[] =>
      element.className
        .split(' ')
        .filter((token) => /^(-?ms-|min-h-|px-|py-|items-|gap-|flex$)/.test(token))
        .sort();
    const staticGeometry = geometry(staticLabel);

    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();

    const control = screen.getByTestId('header-place');

    expect(control.tagName).toBe('BUTTON');
    // Same padding, same minimum height, same inset — so the brand group above it cannot change height
    // and the logo, wordmark and location cannot shift when a district is confirmed.
    expect(geometry(control)).toEqual(staticGeometry);
    expect(staticGeometry).toContain('py-1');
    // No minimum height: that was dead space under the text, and the 44 px target is the overlay's job.
    expect(staticGeometry.join(' ')).not.toContain('min-h-');
  });
});

describe('R8 — leaving a menu with the keyboard', () => {
  const mounted = async (width: number): Promise<Harness> => {
    const harness = createHarness();

    scheduled(harness);
    resizeTo(width);
    renderApp(harness);
    await reachSchedule(harness);

    return harness;
  };

  const cases = [
    ['the language menu', 'language-control', WIDE],
    ['the desktop appearance popover', 'theme-control', WIDE],
    ['the narrow appearance menu', 'theme-menu', NARROW],
  ] as const;

  it.each(cases)('keeps the items of %s out of the Tab sequence', async (_name, trigger, width) => {
    await mounted(width);
    await userEvent.click(screen.getByTestId(trigger));

    for (const item of within(screen.getByRole('menu')).getAllByRole('menuitemradio')) {
      expect(item).toHaveAttribute('tabindex', '-1');
    }
  });

  it.each(cases)(
    'closes %s on Tab and leaves focus on the next control, not the trigger',
    async (_name, trigger, width) => {
      await mounted(width);
      const opener = screen.getByTestId(trigger);

      await userEvent.click(opener);

      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.getByRole('menu').contains(document.activeElement)).toBe(true);

      await userEvent.tab();

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      // Focus went where Tab sends it: past the menu, not back to its trigger and not to the body.
      expect(document.activeElement).not.toBe(opener);
      expect(document.activeElement).not.toBe(document.body);
      expect(opener.compareDocumentPosition(document.activeElement as Node)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(opener).toHaveAttribute('aria-expanded', 'false');
    },
  );

  it.each(cases)(
    'closes %s on Shift+Tab, with focus on the control before its items',
    async (_name, trigger, width) => {
      await mounted(width);
      const opener = screen.getByTestId(trigger);

      await userEvent.click(opener);
      await userEvent.tab({ shift: true });

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      // The control before the menu's items is its own trigger: Shift+Tab landed there by itself.
      expect(document.activeElement).toBe(opener);
    },
  );

  it('tabs from the language menu straight to the appearance control, with the menu gone', async () => {
    await mounted(WIDE);
    await userEvent.click(screen.getByTestId('language-control'));
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.tab();

    expect(document.activeElement).toBe(screen.getByTestId('theme-control'));
    expect(screen.queryAllByRole('menu')).toHaveLength(0);

    // Escape on the control focus moved to has nothing left to dismiss, and opening it works normally.
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('theme-control'));

    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it('still closes and reopens with a click on the trigger while the menu has focus', async () => {
    await mounted(WIDE);
    const opener = screen.getByTestId('language-control');

    await userEvent.click(opener);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    // The press moves focus out of the menu first; that must not close it only for the click to reopen.
    await userEvent.click(opener);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await userEvent.click(opener);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('R3 — the header under enlarged text', () => {
  it('stays sticky while it fits, and scrolls away once it would take over a third of the viewport', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    await reachSchedule(harness);

    const header = screen.getByRole('banner');

    // jsdom lays nothing out, so the two measurements the rule reads are set directly.
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    const height = vi.spyOn(header, 'offsetHeight', 'get').mockReturnValue(90);

    act(() => window.dispatchEvent(new Event('resize')));

    expect(header).toHaveAttribute('data-sticky', 'true');
    expect(header.className).toContain('sticky');

    // Enlarged text: the same header now needs 398 px of a 900 px viewport.
    height.mockReturnValue(398);
    act(() => window.dispatchEvent(new Event('resize')));

    expect(header).toHaveAttribute('data-sticky', 'false');
    expect(header.className).not.toContain('sticky');

    // Exactly a third still fits; the rule is "at most".
    height.mockReturnValue(300);
    act(() => window.dispatchEvent(new Event('resize')));

    expect(header).toHaveAttribute('data-sticky', 'true');

    height.mockRestore();
  });

  it('reserves its pinned height for focus scrolling, and nothing once it scrolls away', async () => {
    const harness = createHarness();

    scheduled(harness);
    const view = renderApp(harness);
    await reachSchedule(harness);

    const header = screen.getByRole('banner');
    const root = document.documentElement;

    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    const height = vi.spyOn(header, 'offsetHeight', 'get').mockReturnValue(90);

    act(() => window.dispatchEvent(new Event('resize')));

    // Pinned: a control focused with Shift+Tab must be scrolled clear of the header's 90 px.
    expect(root.style.getPropertyValue('--ar-sticky-header')).toBe('90px');

    height.mockReturnValue(398);
    act(() => window.dispatchEvent(new Event('resize')));

    // Not pinned: it covers nothing, so nothing is reserved.
    expect(root.style.getPropertyValue('--ar-sticky-header')).toBe('0px');

    height.mockRestore();
    view.unmount();

    expect(root.style.getPropertyValue('--ar-sticky-header')).toBe('');
  });

  it('gives the brand unit and its text column a basis in rem, so enlarged text reflows before it collapses', async () => {
    const harness = createHarness();

    scheduled(harness);
    renderApp(harness);
    await reachSchedule(harness);

    const textColumn = document.getElementById('app-title')?.parentElement as HTMLElement;
    const brandUnit = textColumn.parentElement as HTMLElement;

    // Rendered sizes are measured in the browser; this pins the rule that produces them.
    expect(brandUnit.className).toContain('flex-[1_1_11rem]');
    expect(brandUnit.className).toContain('flex-wrap');
    expect(textColumn.className).toContain('flex-[1_1_9rem]');
    expect(textColumn.className).toContain('min-w-0');
  });
});
