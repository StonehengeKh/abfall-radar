import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppShell } from '@/src/app/app';
import { ThemeProvider } from '@/src/app/theme';
import { LocaleProvider } from '@/src/i18n/context';
import { MESSAGES } from '@/src/i18n/messages';
import {
  area,
  areas,
  cities,
  CITY_ID,
  curbside,
  events,
  KOBLENZ_CITY,
  OFFICIAL_PROVIDER,
  providers,
  SECOND_PROVIDER,
  TWO_PROVIDER_CITY,
} from '@/src/test/fixtures';
import { createHarness, fail, type Harness, ok } from '@/src/test/harness';

/**
 * Selection recovery as a person meets it: the choices on screen, the Back that leads out, and where
 * keyboard focus actually is. Controller tests assert the state; these assert the rendered result and
 * `document.activeElement`, because a focus request for a heading that is not mounted helps nobody.
 */

const DE = MESSAGES.de;

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

const buttonsIn = (testId: string): string[] =>
  screen.queryAllByTestId(testId).map((button) => button.textContent?.trim() ?? '');

describe('R6 — Back from the provider step', () => {
  const twoProviders = (harness: Harness): void => {
    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      .queueProviders(ok(providers(OFFICIAL_PROVIDER, SECOND_PROVIDER)));
  };

  it('offers Back beside the provider choices and returns focus to the chosen city', async () => {
    const harness = createHarness();

    twoProviders(harness);
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: 'Koblenz' }));
    await harness.flush();

    expect(buttonsIn('provider-choice')).toEqual([OFFICIAL_PROVIDER.name, SECOND_PROVIDER.name]);

    await userEvent.click(screen.getByTestId('back-action'));
    await harness.flush();

    // Back on the city step, with the city list mounted and focus on the city that led here.
    expect(buttonsIn('city-choice')).toEqual(['Koblenz']);
    expect(document.activeElement).toBe(screen.getByTestId('city-choice'));
    expect(document.activeElement?.getAttribute('data-city-id')).toBe(CITY_ID);
  });

  it('offers Back while the providers are still loading, and cancels that read', async () => {
    const harness = createHarness();

    twoProviders(harness);
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    harness.gateway.defer('listProviders');
    await userEvent.click(screen.getByRole('button', { name: 'Koblenz' }));
    await harness.flush();

    expect(screen.getByText(DE.steps.providerLoading)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('back-action'));
    await harness.flush();

    const signals = harness.gateway.signalsOf('listProviders');

    expect(signals.at(-1)?.aborted).toBe(true);
    expect(buttonsIn('city-choice')).toEqual(['Koblenz']);
    expect(document.activeElement?.getAttribute('data-city-id')).toBe(CITY_ID);

    // The cancelled read settling later changes nothing.
    harness.gateway.release();
    await harness.flush();

    expect(buttonsIn('city-choice')).toEqual(['Koblenz']);
    expect(screen.queryAllByTestId('provider-choice')).toHaveLength(0);
  });

  it('offers Back on the provider step’s empty and failed presentations', async () => {
    const empty = createHarness();

    empty.gateway.queueCities(ok(cities(KOBLENZ_CITY))).queueProviders(ok(providers()));
    renderApp(empty);
    empty.controller.start();
    await empty.flush();
    await userEvent.click(screen.getByRole('button', { name: 'Koblenz' }));
    await empty.flush();

    expect(empty.view().kind).toBe('no_official_providers');

    await userEvent.click(screen.getByRole('button', { name: DE.actions.back }));
    await empty.flush();

    expect(buttonsIn('city-choice')).toEqual(['Koblenz']);
    expect(document.activeElement?.getAttribute('data-city-id')).toBe(CITY_ID);
  });

  it('offers Back after a failed provider read, but not after a failed city read', async () => {
    const harness = createHarness();

    harness.gateway
      .queueCities(ok(cities(KOBLENZ_CITY)))
      .queueProviders(fail({ kind: 'network', operation: 'listProviders' }));
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: 'Koblenz' }));
    await harness.flush();

    expect(harness.view().kind).toBe('error');

    await userEvent.click(screen.getByRole('button', { name: DE.actions.back }));
    await harness.flush();

    expect(buttonsIn('city-choice')).toEqual(['Koblenz']);

    const cityFailure = createHarness();

    cityFailure.gateway.queueCities(fail({ kind: 'network', operation: 'listCities' }));
    renderApp(cityFailure);
    cityFailure.controller.start();
    await cityFailure.flush();

    // Two shells are mounted now; the second is the one that failed its city read.
    const shells = screen.getAllByRole('main');
    const last = shells.at(-1) as HTMLElement;

    expect(within(last).getByRole('button', { name: DE.actions.retry })).toBeInTheDocument();
    expect(within(last).queryByRole('button', { name: DE.actions.back })).toBeNull();
  });

  it('offers Back on the provider step shown after a stale-provider recovery', async () => {
    const harness = createHarness();

    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      .queueProviders(ok(providers(OFFICIAL_PROVIDER, SECOND_PROVIDER)))
      .queueAreas(
        fail({
          kind: 'problem',
          operation: 'listServiceAreas',
          status: 404,
          code: 'PROVIDER_NOT_FOUND',
          requestId: 'req-stale',
        }),
      );
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: 'Koblenz' }));
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: OFFICIAL_PROVIDER.name }));
    await harness.flush();
    await harness.flush();

    // The visible notice (the live region repeats the same words for assistive technology).
    expect(
      within(screen.getByRole('main')).getByText(DE.notices.provider_invalidated),
    ).toBeVisible();
    expect(buttonsIn('provider-choice')).toEqual([OFFICIAL_PROVIDER.name, SECOND_PROVIDER.name]);
    expect(screen.getByTestId('back-action')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('back-action'));
    await harness.flush();

    expect(buttonsIn('city-choice')).toEqual(['Koblenz']);
  });
});

describe('R1 — the rendered result of an authoritative invalidation', () => {
  it('shows the remaining provider as a real choice, with focus on its mounted heading', async () => {
    const harness = createHarness();

    harness.gateway
      .queueCities(ok(cities(TWO_PROVIDER_CITY)))
      .queueProviders(
        ok(providers(OFFICIAL_PROVIDER, SECOND_PROVIDER)),
        ok(providers(SECOND_PROVIDER)),
      )
      .queueAreas(ok(areas(area())))
      .queueEvents(ok(events([curbside()])));
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: 'Koblenz' }));
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: OFFICIAL_PROVIDER.name }));
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByTestId('confirm-selection'));
    await harness.flush();

    expect(buttonsIn('provider-choice')).toEqual([SECOND_PROVIDER.name]);
    expect(screen.queryByText(DE.steps.cityLoading)).toBeNull();
    expect(document.activeElement?.id).toBe('provider-heading');
    expect(harness.gateway.pendingCount).toBe(0);
  });

  it('shows the remaining districts, with focus on the mounted district heading', async () => {
    const harness = createHarness();

    harness.gateway
      .queueProviders(ok(providers(OFFICIAL_PROVIDER)))
      .queueAreas(
        ok(areas(area())),
        ok(areas(area({ id: 'koblenz-neuendorf', name: 'Neuendorf' }))),
      )
      .queueEvents(ok(events([curbside()])));
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: 'Koblenz' }));
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByTestId('confirm-selection'));
    await harness.flush();

    expect(buttonsIn('area-choice')).toEqual(['Neuendorf']);
    expect(document.activeElement?.id).toBe('area-heading');
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
  });
});

describe('R1 — the city’s only official provider disappears', () => {
  /**
   * The reviewer's exact sequence: Koblenz is served by one provider, and it is gone by the time the
   * confirmation pipeline reads the providers again. There is no provider left to choose, so the
   * terminal state is the existing "no official provider" surface — not a district choice with nothing
   * in it, and never the permanent city spinner the review found.
   */
  const reachVanishedProvider = async (): Promise<Harness> => {
    const harness = createHarness();

    harness.gateway
      .queueProviders(ok(providers(OFFICIAL_PROVIDER)))
      .queueAreas(ok(areas(area())))
      .queueEvents(ok(events([curbside()])));
    renderApp(harness);
    harness.controller.start();
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: 'Koblenz' }));
    await harness.flush();
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    harness.gateway.replaceProviders(ok(providers(SECOND_PROVIDER)));
    await userEvent.click(screen.getByTestId('confirm-selection'));
    await harness.flush();

    return harness;
  };

  it('ends at the no-official-provider state, with focus on its mounted heading and no spinner', async () => {
    const harness = await reachVanishedProvider();
    const main = screen.getByRole('main');

    // No city spinner, and nothing left loading.
    expect(within(main).queryByText(DE.steps.cityLoading)).toBeNull();
    expect(within(main).queryByText(DE.steps.providerLoading)).toBeNull();
    expect(harness.gateway.pendingCount).toBe(0);
    expect(harness.gateway.calls).toEqual([
      'listCities',
      'listProviders',
      'listServiceAreas',
      'listProviders',
    ]);

    // The terminal state, as rendered.
    expect(harness.view()).toEqual({ kind: 'no_official_providers', draftCityId: CITY_ID });
    const heading = within(main).getByRole('heading', {
      level: 2,
      name: DE.states.no_official_providers.heading,
    });

    // Focus is on an element that exists: the state's own heading.
    expect(document.activeElement).toBe(heading);
    expect(heading.id).toBe('main-heading');

    // No district or provider choice is offered, empty or otherwise.
    expect(screen.queryAllByTestId('area-choice')).toHaveLength(0);
    expect(screen.queryAllByTestId('provider-choice')).toHaveLength(0);
    expect(screen.queryByTestId('confirm-bar')).toBeNull();

    // Both recovery actions are present.
    expect(within(main).getByRole('button', { name: DE.actions.retry })).toBeEnabled();
    expect(within(main).getByRole('button', { name: DE.actions.back })).toBeEnabled();
  });

  it('Retry is usable: once the provider is back, it leads to the district choice', async () => {
    const harness = await reachVanishedProvider();

    harness.gateway.replaceProviders(ok(providers(OFFICIAL_PROVIDER)));
    await userEvent.click(screen.getByRole('button', { name: DE.actions.retry }));
    await harness.flush();
    await harness.flush();

    expect(buttonsIn('area-choice')).toEqual(['Stadtmitte']);
    expect(document.activeElement?.id).toBe('area-heading');
    expect(harness.gateway.pendingCount).toBe(0);
  });

  it('Retry is usable while the provider is still missing: the same state, focus kept on its heading', async () => {
    const harness = await reachVanishedProvider();

    await userEvent.click(screen.getByRole('button', { name: DE.actions.retry }));
    await harness.flush();

    expect(harness.view()).toEqual({ kind: 'no_official_providers', draftCityId: CITY_ID });
    expect(document.activeElement?.id).toBe('main-heading');
    expect(harness.gateway.pendingCount).toBe(0);
  });

  it('Back is usable: it returns to the city choice with focus on the city', async () => {
    const harness = await reachVanishedProvider();

    await userEvent.click(screen.getByRole('button', { name: DE.actions.back }));
    await harness.flush();

    expect(buttonsIn('city-choice')).toEqual(['Koblenz']);
    expect(document.activeElement?.getAttribute('data-city-id')).toBe(CITY_ID);
    expect(harness.gateway.pendingCount).toBe(0);
  });
});

describe('R9 — focus after a city Retry', () => {
  const CITIES_DOWN = { kind: 'network', operation: 'listCities' } as const;

  it('leaves focus alone on bootstrap, then moves it to the city heading after a successful Retry', async () => {
    const harness = createHarness();

    harness.gateway.queueCities(fail(CITIES_DOWN), ok(cities(KOBLENZ_CITY)));
    renderApp(harness);
    harness.controller.start();
    await harness.flush();

    // The first load failed, but it was not the user's action: focus is where the browser left it.
    expect(document.activeElement).toBe(document.body);

    await userEvent.click(screen.getByRole('button', { name: DE.actions.retry }));
    await harness.flush();

    expect(buttonsIn('city-choice')).toEqual(['Koblenz']);
    expect(document.activeElement?.id).toBe('city-heading');
  });

  it('moves focus to the failure heading when the Retry fails again, never to the body', async () => {
    const harness = createHarness();

    harness.gateway.queueCities(fail(CITIES_DOWN));
    renderApp(harness);
    harness.controller.start();
    await harness.flush();

    await userEvent.click(screen.getByRole('button', { name: DE.actions.retry }));
    await harness.flush();

    expect(harness.view().kind).toBe('error');
    expect(document.activeElement?.id).toBe('main-heading');
  });
});
