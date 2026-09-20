import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
import { createHarness, type Harness, ok } from '@/src/test/harness';

/**
 * Where the secondary actions live, and what confirms a district.
 *
 * Placement is verified in the browser; what is asserted here is the part that must not regress when
 * something moves — DOM order, one control per action, the same controller calls, and exactly one
 * schedule pipeline however the confirmation was reached.
 */

const DE = MESSAGES.de;

const MANY = areas(
  area(),
  ...[
    'Neuendorf',
    'Karthause 1',
    'Karthause 2',
    'Lützel',
    'Metternich 1',
    'Güls 1',
    'Lay',
    'Vorstadt',
  ].map((name, index) => area({ id: `koblenz-${index}`, name })),
);

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

/** Bootstraps to the district step through the UI, as a person reaches it. */
const reachDistricts = async (harness: Harness): Promise<void> => {
  harness.gateway
    .queueProviders(ok(CATALOGUE_SINGLE))
    .queueAreas(ok(MANY))
    .queueEvents(ok(events([curbside(), dropOff()])));
  renderApp(harness);
  harness.controller.start();
  await harness.flush();
  await userEvent.click(screen.getByRole('button', { name: 'Koblenz' }));
  await harness.flush();
};

const pipelines = (harness: Harness): number => harness.gateway.countOf('listCollectionEvents');

describe('secondary navigation sits at the top', () => {
  it('puts Back in the heading row, before the city introduction and with none after the grid', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    const back = screen.getByTestId('back-action');
    const heading = screen.getByRole('heading', {
      level: 2,
      name: DE.states.needs_selection.heading,
    });
    const intro = screen.getByTestId('city-intro');
    const grid = screen.getAllByTestId('area-choice')[0]?.closest('ul');

    expect(back).toHaveTextContent(DE.actions.back);
    // In the heading row, on its trailing side — the same pattern the schedule uses.
    expect(heading.parentElement?.contains(back)).toBe(true);
    // Before the introduction, and therefore before the search and the grid.
    expect(back.compareDocumentPosition(intro)).toBe(Node.DOCUMENT_POSITION_FOLLOWING as number);
    expect(grid?.compareDocumentPosition(back)).toBe(Node.DOCUMENT_POSITION_PRECEDING as number);
    // Exactly one Back: the old bottom row is gone.
    expect(screen.getAllByRole('button', { name: DE.actions.back })).toHaveLength(1);
  });

  it('still returns to the previous step, with the controller deciding the focus', async () => {
    const harness = createHarness();

    await reachDistricts(harness);
    await userEvent.click(screen.getByTestId('back-action'));
    await harness.flush();

    const view = harness.view();

    expect(view.kind).toBe('needs_selection');
    expect(view.kind === 'needs_selection' && view.selection.step).toBe('city');
    // No schedule was requested by navigating.
    expect(pipelines(harness)).toBe(0);
  });

  it('puts Change selection beside the schedule heading, not under the event list', async () => {
    const harness = createHarness();

    await reachDistricts(harness);
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByTestId('confirm-selection'));
    await harness.flush();

    const change = screen.getByTestId('change-selection');
    const heading = screen.getByRole('heading', { level: 2, name: DE.states.live.heading });
    const list = screen.getAllByTestId('event-row')[0]?.closest('ul');

    expect(change).toHaveTextContent(DE.actions.changeSelection);
    // In the heading's own row, and before the schedule itself.
    expect(heading.parentElement?.contains(change)).toBe(true);
    expect(change.compareDocumentPosition(list as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING as number,
    );
    expect(screen.getAllByRole('button', { name: DE.actions.changeSelection })).toHaveLength(1);

    await userEvent.click(change);
    await harness.flush();

    expect(harness.view().kind).toBe('needs_selection');
  });

  it('keeps the header location shortcut working beside it', async () => {
    const harness = createHarness();

    await reachDistricts(harness);
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByTestId('confirm-selection'));
    await harness.flush();

    await userEvent.click(screen.getByTestId('header-place'));
    await harness.flush();

    expect(harness.view().kind).toBe('needs_selection');
  });
});

describe('the district confirmation bar', () => {
  it('prompts and stays disabled until a district is drafted', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    const bar = screen.getByTestId('confirm-bar');
    const confirm = screen.getByTestId('confirm-selection');

    expect(within(bar).getByTestId('confirm-summary')).toHaveTextContent(DE.steps.noneSelected);
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveTextContent(DE.actions.confirm);
    // One confirmation control on the page, not two.
    expect(screen.getAllByRole('button', { name: DE.actions.confirm })).toHaveLength(1);
  });

  it('summarizes the draft and confirms it, without the person reaching the end of the grid', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    // A district near the start of the list, chosen with a single click.
    const first = screen.getByRole('button', { name: /Stadtmitte/ });

    await userEvent.click(first);

    // Selecting drafts; it does not navigate and it does not move focus somewhere else.
    expect(document.activeElement).toBe(first);
    expect(pipelines(harness)).toBe(0);
    expect(screen.getByTestId('confirm-summary')).toHaveTextContent(
      `${DE.steps.selected}: Stadtmitte`,
    );

    const confirm = screen.getByTestId('confirm-selection');

    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    await harness.flush();

    expect(harness.view().kind).toBe('live');
    expect(pipelines(harness)).toBe(1);
  });

  it('summarizes a district chosen in the middle of the grid, and survives filtering', async () => {
    const harness = createHarness();

    await reachDistricts(harness);
    await userEvent.click(screen.getByRole('button', { name: 'Lützel' }));

    expect(screen.getByTestId('confirm-summary')).toHaveTextContent(`${DE.steps.selected}: Lützel`);

    // Filtering the grid hides the card but must not quietly unselect it.
    await userEvent.type(screen.getByRole('searchbox'), 'karthause');

    expect(screen.queryByRole('button', { name: 'Lützel' })).not.toBeInTheDocument();
    expect(screen.getByTestId('confirm-summary')).toHaveTextContent(`${DE.steps.selected}: Lützel`);
    expect(screen.getByTestId('confirm-selection')).toBeEnabled();
  });

  it('starts one pipeline whether the bar or the double-click shortcut confirms', async () => {
    const barHarness = createHarness();

    await reachDistricts(barHarness);
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByTestId('confirm-selection'));
    await barHarness.flush();

    expect(pipelines(barHarness)).toBe(1);

    const shortcutHarness = createHarness();

    await reachDistricts(shortcutHarness);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Neuendorf' }));
    await shortcutHarness.flush();

    expect(shortcutHarness.view().kind).toBe('live');
    // A double click is two clicks; only the shortcut confirms, and it confirms once.
    expect(pipelines(shortcutHarness)).toBe(1);
  });

  it('is gone, with its reserved space, once district selection is left', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    expect(document.documentElement.style.getPropertyValue('--ar-action-bar')).not.toBe('');

    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByTestId('confirm-selection'));
    await harness.flush();

    expect(screen.queryByTestId('confirm-bar')).not.toBeInTheDocument();
    // The floating scroll-to-top button reads this; a stale value would leave it hovering.
    expect(document.documentElement.style.getPropertyValue('--ar-action-bar')).toBe('');
  });
});

describe('the header location reads the same in every state', () => {
  const typography = (element: Element): string[] =>
    element.className
      .split(' ')
      .filter((token) => /^(text-(xs|sm|base|lg)|font-|leading-|tracking-)/.test(token))
      .sort();

  it('uses one explicit type contract for the static label and the interactive control', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    const staticLabel = screen.getByTestId('header-place');

    expect(staticLabel.tagName).toBe('SPAN');

    const staticType = typography(staticLabel);
    const staticIcon = staticLabel.querySelector('svg')?.getAttribute('width');

    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByTestId('confirm-selection'));
    await harness.flush();

    const control = screen.getByTestId('header-place');

    expect(control.tagName).toBe('BUTTON');
    // Same size, weight, line height and tracking — stated, not inherited from a button default.
    expect(typography(control)).toEqual(staticType);
    expect(staticType).toContain('text-xs');
    expect(staticType).toContain('font-normal');
    expect(control.querySelector('svg')?.getAttribute('width')).toBe(staticIcon);
    // And it is still the change-selection action it was.
    expect(control).toHaveAccessibleName(`${DE.actions.changeSelection}: Koblenz · Stadtmitte`);
  });
});

describe('the language control', () => {
  it('shows only the language code, and keeps every menu semantic', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    const trigger = screen.getByTestId('language-control');

    expect(trigger.textContent).toBe('de');
    // No chevron and no space reserved for one.
    expect(trigger.querySelector('svg')).toBeNull();
    expect(trigger).toHaveAccessibleName(`${DE.language.label}: ${MESSAGES.de.languageName}`);
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The same 44 px target rule as the appearance button beside it: a 36 px visible box whose overlay
    // is inset 5 px from the padding box, i.e. 4 px beyond the 1 px border (hit-tested in Chrome).
    expect(trigger.className).toContain('h-9');
    expect(trigger.className).toContain('border');
    expect(trigger.className).toContain('after:-inset-[5px]');
    expect(trigger.className).toBe(screen.getByTestId('theme-control').className);

    await userEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const menu = screen.getByRole('menu');

    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(4);

    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Escape}');

    // Focus returns to the trigger, and the menu is gone.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});
