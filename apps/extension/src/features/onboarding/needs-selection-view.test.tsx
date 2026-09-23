import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AreaCatalogueState,
  CityCatalogueState,
  ProviderCatalogueState,
} from '@/src/hooks/use-catalogue';
import { offerableProviders } from '@/src/hooks/use-catalogue';
import { PresentationProvider } from '@/src/i18n/copy';
import type { CitySummary, ProviderSummary, ServiceAreaSummary } from '@/src/messaging/contract';
import {
  AVAILABLE_AREA,
  CATALOGUE_WITH_DEMO,
  CITY_CATALOGUE,
  DEMO_PROVIDER,
  MIXED_AREAS,
  OFFICIAL_CITY_ID,
  OFFICIAL_PROVIDER,
  OFFICIAL_PROVIDER_ID,
  UNAVAILABLE_AREA,
} from '@/src/test/fixtures';
import { NeedsSelectionView, type NeedsSelectionViewProps } from './needs-selection-view';

/**
 * The unavailable-area rules are verified here, against a fixture of an **offered, non-demo** provider
 * whose list mixes an `available` and an `unavailable` area.
 *
 * The live API currently offers no unavailable area under a non-demo provider, and exposing the demo
 * provider to manufacture one would break the very rule being verified: a demo provider is excluded at the
 * catalogue, so none of its areas is ever listed, reachable, or rendered.
 */

const CITIES: CityCatalogueState = { kind: 'loaded', cities: CITY_CATALOGUE };

const CATALOGUE: ProviderCatalogueState = { kind: 'loaded', providers: CATALOGUE_WITH_DEMO };

const LOADED: AreaCatalogueState = {
  kind: 'loaded',
  providerId: OFFICIAL_PROVIDER_ID,
  areas: MIXED_AREAS,
};

const FAILED: AreaCatalogueState = {
  kind: 'failed',
  providerId: OFFICIAL_PROVIDER_ID,
  failure: { kind: 'network', operation: 'listServiceAreas' },
};

const renderView = (
  overrides: Partial<NeedsSelectionViewProps> & { areaState?: AreaCatalogueState } = {},
) => {
  const handlers = {
    onConfirm: vi.fn(),
    onRequestAreas: vi.fn(),
    onRetryAreas: vi.fn(),
    onRetryCatalogue: vi.fn(),
    onRetryCities: vi.fn(),
  };
  const props = (next: Partial<NeedsSelectionViewProps> = {}): NeedsSelectionViewProps => {
    const { areaState = LOADED, ...rest } = {
      ...overrides,
      ...next,
    } as Partial<NeedsSelectionViewProps> & { areaState?: AreaCatalogueState };

    return {
      cities: CITIES,
      catalogue: CATALOGUE,
      // The surface asks about one operator at a time; a test names that one answer.
      areaStateFor: () => areaState,
      ...handlers,
      ...rest,
    };
  };

  const view = render(<NeedsSelectionView {...props()} />);

  return {
    ...view,
    ...handlers,
    rerenderWith: (next: Partial<NeedsSelectionViewProps> & { areaState?: AreaCatalogueState }) =>
      view.rerender(<NeedsSelectionView {...props(next)} />),
  };
};

const cityField = () => screen.getByRole('combobox', { name: /Stadt/ });

/** The first step on every path: the person chooses their city. Nothing is chosen for them. */
const chooseCity = async (user = userEvent.setup(), cityId = OFFICIAL_CITY_ID) => {
  await user.selectOptions(cityField(), cityId);

  return user;
};

/** A district in the list: one option of the single-choice group. */
const areaButton = (name: RegExp) => screen.getByRole('option', { name });

const retryButton = () => screen.getByRole('button', { name: 'Sammelgebiete erneut laden' });

describe('offerableProviders', () => {
  it('excludes a demo provider from what may be offered', () => {
    // Asserted against a catalogue that really contains one, so this cannot pass by there being none.
    expect(CATALOGUE_WITH_DEMO.some((provider) => provider.sourceKind === 'demo')).toBe(true);
    expect(offerableProviders(CATALOGUE_WITH_DEMO).map((provider) => provider.id)).toEqual([
      OFFICIAL_PROVIDER_ID,
    ]);
  });
});

describe('the city step', () => {
  it('asks for the city first and chooses none on the person’s behalf', () => {
    const { onRequestAreas } = renderView({ areaState: { kind: 'idle' } });

    expect(cityField()).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Koblenz' })).toBeInTheDocument();
    // With no city there is no operator and no district, so nothing is asked about either.
    expect(onRequestAreas).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: /Stadtmitte/ })).not.toBeInTheDocument();
  });

  it('says the cities are loading while the list is in flight', () => {
    renderView({ cities: { kind: 'loading' } });

    expect(screen.getByText('Städte werden geladen…')).toBeInTheDocument();
  });

  it('reports a failed city list and reads it again, once per press', async () => {
    const user = userEvent.setup();
    const { onRetryCities, onRequestAreas } = renderView({
      cities: { kind: 'failed', failure: { kind: 'network', operation: 'listCities' } },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Die Liste der Städte konnte nicht geladen werden.',
    );

    await user.click(screen.getByRole('button', { name: 'Städte erneut laden' }));
    await user.click(screen.getByRole('button', { name: 'Städte erneut laden' }));

    expect(onRetryCities).toHaveBeenCalledTimes(2);
    expect(onRequestAreas).not.toHaveBeenCalled();
  });

  it('states that no city is available rather than showing an empty field', () => {
    renderView({ cities: { kind: 'loaded', cities: [] } });

    expect(screen.getByText(/keine Stadt mit offiziellen Terminen/)).toBeInTheDocument();
  });
});

describe('the operator step', () => {
  it('takes the only official operator without asking, and names it', async () => {
    const { onRequestAreas } = renderView({ areaState: { kind: 'idle' } });

    await chooseCity();

    // One answer is not a question, so there is no operator field — but whose calendar it is stays visible.
    expect(screen.queryByRole('combobox', { name: /Entsorgungsbetrieb/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('single-provider')).toHaveTextContent('Kommunaler Servicebetrieb');
    expect(onRequestAreas).toHaveBeenCalledWith(OFFICIAL_PROVIDER_ID);
    expect(onRequestAreas).toHaveBeenCalledTimes(1);
  });

  it('never offers the demo provider, even when a city lists it', async () => {
    const cities: CitySummary[] = [
      { id: OFFICIAL_CITY_ID, name: 'Koblenz', providers: [DEMO_PROVIDER, OFFICIAL_PROVIDER] },
    ];

    renderView({ cities: { kind: 'loaded', cities }, areaState: { kind: 'idle' } });
    await chooseCity();

    expect(screen.queryByRole('option', { name: 'Demo provider' })).not.toBeInTheDocument();
    expect(screen.getByTestId('single-provider')).toHaveTextContent('Kommunaler Servicebetrieb');
  });

  it('asks which operator when a city has more than one', async () => {
    const second: ProviderSummary = {
      id: 'second-operator',
      name: 'Zweiter Betrieb',
      sourceKind: 'official_ics',
    };
    const cities: CitySummary[] = [
      { id: OFFICIAL_CITY_ID, name: 'Koblenz', providers: [OFFICIAL_PROVIDER, second] },
    ];
    const { onRequestAreas } = renderView({
      cities: { kind: 'loaded', cities },
      catalogue: { kind: 'loaded', providers: [...CATALOGUE_WITH_DEMO, second] },
      areaState: { kind: 'idle' },
    });
    const user = await chooseCity();

    // Nothing is requested until the person has answered the question.
    expect(onRequestAreas).not.toHaveBeenCalled();

    await user.selectOptions(
      screen.getByRole('combobox', { name: /Entsorgungsbetrieb/ }),
      'second-operator',
    );

    expect(onRequestAreas).toHaveBeenCalledWith('second-operator');
  });

  it('states that a city has no official operator', async () => {
    renderView({ catalogue: { kind: 'loaded', providers: [DEMO_PROVIDER] } });
    await chooseCity();

    expect(screen.getByText(/kein offizieller Entsorgungsbetrieb verfügbar/)).toBeInTheDocument();
  });

  it('reports a failed provider catalogue and reads it again, once per press', async () => {
    const { onRetryCatalogue, onRetryAreas } = renderView({
      catalogue: { kind: 'failed', failure: { kind: 'network', operation: 'listProviders' } },
      areaState: { kind: 'idle' },
    });
    const user = await chooseCity();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Die Liste der Entsorgungsbetriebe konnte nicht geladen werden.',
    );

    await user.click(screen.getByRole('button', { name: 'Entsorgungsbetriebe erneut laden' }));

    expect(onRetryCatalogue).toHaveBeenCalledTimes(1);
    // The failed resource is the catalogue, so nothing downstream is asked for.
    expect(onRetryAreas).not.toHaveBeenCalled();
  });

  it('recovers once the catalogue retry succeeds', async () => {
    const { rerenderWith } = renderView({
      catalogue: { kind: 'failed', failure: { kind: 'network', operation: 'listProviders' } },
    });

    await chooseCity();
    rerenderWith({ catalogue: CATALOGUE });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(areaButton(/Stadtmitte/)).toBeInTheDocument();
  });
});

/**
 * Every area-request state says which one it is.
 *
 * An empty panel is the failure mode being ruled out here: it reads as a request that is still running, so a
 * person waits for something that already finished, failed, or was refused.
 */
describe('the district-request state', () => {
  it('says the districts are loading while the request is in flight, and announces it', async () => {
    renderView({ areaState: { kind: 'loading', providerId: OFFICIAL_PROVIDER_ID } });
    await chooseCity();

    // One node, inside the live region: seen once and heard once.
    expect(screen.getByRole('status')).toHaveTextContent('Sammelgebiete werden geladen…');
  });

  it('states plainly that a provider publishes no districts rather than showing nothing', async () => {
    renderView({ areaState: { kind: 'loaded', providerId: OFFICIAL_PROVIDER_ID, areas: [] } });
    await chooseCity();

    expect(screen.getByRole('status')).toHaveTextContent(/keine Sammelgebiete abrufbar/);
  });

  it('shows only the chosen city’s districts, by the city identifier rather than a name', async () => {
    const elsewhere: ServiceAreaSummary = {
      ...AVAILABLE_AREA,
      id: 'elsewhere-mitte',
      cityId: 'elsewhere',
      // The same locality text, so only the identifier can tell the two apart.
      name: 'Mitte',
    };

    renderView({
      areaState: {
        kind: 'loaded',
        providerId: OFFICIAL_PROVIDER_ID,
        areas: [...MIXED_AREAS, elsewhere],
      },
    });
    await chooseCity();

    expect(areaButton(/Stadtmitte/)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Mitte$/ })).not.toBeInTheDocument();
  });

  it('says there is nothing to choose when none of the operator’s districts is in this city', async () => {
    renderView({
      areaState: {
        kind: 'loaded',
        providerId: OFFICIAL_PROVIDER_ID,
        areas: [{ ...AVAILABLE_AREA, cityId: 'elsewhere' }],
      },
    });
    await chooseCity();

    expect(screen.getByRole('status')).toHaveTextContent(/keine Sammelgebiete abrufbar/);
  });

  it('says a provider is unavailable when the catalogue refused to request it', async () => {
    renderView({ areaState: { kind: 'not_offered', providerId: OFFICIAL_PROVIDER_ID } });
    await chooseCity();

    expect(screen.getByRole('status')).toHaveTextContent(/steht derzeit nicht zur Verfügung/);
  });
});

describe('a failed district request', () => {
  it('says it failed, announces it, and offers a retry', async () => {
    renderView({ areaState: FAILED });
    await chooseCity();

    expect(screen.getByRole('status')).toHaveTextContent(
      'Die Sammelgebiete konnten nicht geladen werden.',
    );
    expect(retryButton()).toBeEnabled();
  });

  it('retries nothing merely because the component rendered again', async () => {
    const { onRequestAreas, onRetryAreas, rerenderWith } = renderView({ areaState: FAILED });

    await chooseCity();

    // The failed state persists across renders, so a surface that retried on render would hammer an API
    // that is down for as long as the popup stayed open.
    for (let render = 0; render < 3; render += 1) {
      rerenderWith({ areaState: FAILED });
    }

    expect(onRetryAreas).not.toHaveBeenCalled();
    expect(onRequestAreas).not.toHaveBeenCalled();
  });

  it('asks for exactly one more attempt per press, and stays retryable', async () => {
    const { onRetryAreas } = renderView({ areaState: FAILED });
    const user = await chooseCity();

    await user.click(retryButton());
    await user.click(retryButton());

    expect(onRetryAreas).toHaveBeenCalledTimes(2);
    expect(onRetryAreas).toHaveBeenCalledWith(OFFICIAL_PROVIDER_ID);
  });

  it('renders the districts once a retry succeeds', async () => {
    const { rerenderWith } = renderView({ areaState: FAILED });

    await chooseCity();
    rerenderWith({ areaState: LOADED });

    expect(areaButton(/Stadtmitte/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Sammelgebiete erneut laden' }),
    ).not.toBeInTheDocument();
  });
});

describe('an unavailable district of an offered provider', () => {
  it('is listed with explanatory copy rather than omitted', async () => {
    renderView();
    await chooseCity();

    expect(areaButton(/Oberwerth/)).toBeInTheDocument();
    expect(screen.getByText('Kein offizieller Kalender veröffentlicht')).toBeInTheDocument();
  });

  it('is disabled through the accessibility tree, beside a selectable sibling', async () => {
    renderView();
    await chooseCity();

    // Asserted through the accessibility tree rather than a class name: appearance is never the mechanism.
    expect(areaButton(/Stadtmitte/)).toBeEnabled();
    expect(areaButton(/Oberwerth/)).toBeDisabled();
    expect(areaButton(/Oberwerth/)).toHaveAccessibleDescription(
      'Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.',
    );
  });

  it('cannot be reached or confirmed by keyboard', async () => {
    const { onConfirm } = renderView();
    const user = await chooseCity();

    // A disabled button is out of the tab order, so focus never lands on it and Enter or Space cannot
    // activate it.
    for (let step = 0; step < 8; step += 1) {
      await user.tab();
      expect(areaButton(/Oberwerth/)).not.toHaveFocus();
    }

    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('is never handed to the confirm callback', async () => {
    const { onConfirm } = renderView();
    const user = await chooseCity();

    await user.click(areaButton(/Oberwerth/));
    await user.click(areaButton(/Stadtmitte/));
    await user.click(screen.getByRole('button', { name: 'Auswahl bestätigen' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(AVAILABLE_AREA);
    expect(onConfirm).not.toHaveBeenCalledWith(UNAVAILABLE_AREA);
  });
});

describe('confirming a selection', () => {
  it('requires an explicit confirmation', async () => {
    const { onConfirm } = renderView();
    const user = await chooseCity();

    // Choosing a district is not the same as confirming it: nothing is persisted on the user's behalf.
    await user.click(areaButton(/Stadtmitte/));
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Auswahl bestätigen' }));
    expect(onConfirm).toHaveBeenCalledWith(AVAILABLE_AREA);
  });

  it('cannot be confirmed before a district is chosen', () => {
    renderView();

    expect(screen.getByRole('button', { name: 'Auswahl bestätigen' })).toBeDisabled();
  });

  it('clears the chosen district when the city changes', async () => {
    renderView();
    const user = await chooseCity();

    await user.click(areaButton(/Stadtmitte/));
    expect(screen.getByRole('button', { name: 'Auswahl bestätigen' })).toBeEnabled();

    // Choosing the placeholder is not possible, so the city is changed through the same field and back.
    await user.selectOptions(cityField(), OFFICIAL_CITY_ID);

    // An identifier is never carried across a changed city.
    expect(screen.getByRole('button', { name: 'Auswahl bestätigen' })).toBeDisabled();
  });

  it('explains a refusal in the language on screen', async () => {
    const onConfirm = vi.fn().mockResolvedValue('rejected_unavailable');

    render(
      <PresentationProvider locale="en" appearance="system">
        <NeedsSelectionView
          cities={CITIES}
          catalogue={CATALOGUE}
          areaStateFor={() => LOADED}
          onConfirm={onConfirm}
          onRetryCities={vi.fn()}
          onRetryCatalogue={vi.fn()}
          onRequestAreas={vi.fn()}
          onRetryAreas={vi.fn()}
        />
      </PresentationProvider>,
    );

    const user = userEvent.setup();

    await user.selectOptions(screen.getByRole('combobox', { name: /City/ }), OFFICIAL_CITY_ID);
    await user.click(areaButton(/Stadtmitte/));
    await user.click(screen.getByRole('button', { name: 'Confirm selection' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The operator publishes no official calendar for this district.',
    );
  });
});

/**
 * Choosing a district must not cost thirty-three keystrokes.
 *
 * The operator publishes thirty-four districts. As a list of ordinary buttons every one was a tab stop, so
 * selecting the first district and then reaching the confirmation meant tabbing past all the others — the
 * measured burden that this group's semantics remove. The list is one choice: one tab stop, arrows inside it,
 * and the next `Tab` lands on the action that acts on the choice.
 */
describe('moving through the districts by keyboard', () => {
  /** A list the size of the shipped one, with the unavailable district among the rest. */
  const MANY: ServiceAreaSummary[] = [
    ...Array.from({ length: 33 }, (_, index) => ({
      ...AVAILABLE_AREA,
      id: `district-${index}`,
      name: `Bezirk ${index}`,
    })),
    UNAVAILABLE_AREA,
  ];
  const LONG_LIST: AreaCatalogueState = {
    kind: 'loaded',
    providerId: OFFICIAL_PROVIDER_ID,
    areas: MANY,
  };

  const confirm = () => screen.getByRole('button', { name: 'Auswahl bestätigen' });

  it('reaches confirmation in one Tab after choosing the first district', async () => {
    renderView({ areaState: LONG_LIST });
    const user = await chooseCity();

    await user.click(areaButton(/^Bezirk 0$/));
    // The chosen district holds the group's single tab stop, so focus is already inside the group.
    expect(areaButton(/^Bezirk 0$/)).toHaveFocus();

    await user.tab();

    // One press, not thirty-three.
    expect(confirm()).toHaveFocus();
    expect(confirm()).toBeEnabled();
  });

  it('gives the whole list one tab stop, wherever the choice sits', async () => {
    renderView({ areaState: LONG_LIST });
    const user = await chooseCity();

    await user.click(areaButton(/^Bezirk 20$/));
    await user.tab();
    expect(confirm()).toHaveFocus();

    // And backwards: from the action to the choice it acts on, never through the rest of the list.
    await user.tab({ shift: true });
    expect(areaButton(/^Bezirk 20$/)).toHaveFocus();
  });

  it('enters the list at the first district while nothing is chosen', async () => {
    renderView({ areaState: LONG_LIST });
    const user = await chooseCity();

    // From the city field: the operator line is text, so the list is the next stop.
    cityField().focus();
    await user.tab();

    expect(areaButton(/^Bezirk 0$/)).toHaveFocus();
  });

  it('moves focus with the arrow keys without choosing anything', async () => {
    const { onConfirm } = renderView({ areaState: LONG_LIST });
    const user = await chooseCity();

    cityField().focus();
    await user.tab();
    await user.keyboard('{ArrowDown}{ArrowDown}');

    expect(areaButton(/^Bezirk 2$/)).toHaveFocus();
    // Focus is looking, not picking: nothing is selected until the person says so.
    expect(areaButton(/^Bezirk 2$/)).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('confirm-summary')).toHaveTextContent('Noch kein Gebiet ausgewählt');
    expect(confirm()).toBeDisabled();

    await user.keyboard('{ArrowUp}');
    expect(areaButton(/^Bezirk 1$/)).toHaveFocus();

    // Space chooses the district focus is on, and the summary says which.
    await user.keyboard(' ');
    expect(areaButton(/^Bezirk 1$/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('confirm-summary')).toHaveTextContent('Bezirk 1');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('jumps to the ends with Home and End, and stops there', async () => {
    renderView({ areaState: LONG_LIST });
    const user = await chooseCity();

    cityField().focus();
    await user.tab();
    await user.keyboard('{End}');

    // The last **selectable** district: the unavailable one is not a stop.
    expect(areaButton(/^Bezirk 32$/)).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(areaButton(/^Bezirk 32$/)).toHaveFocus();

    await user.keyboard('{Home}');
    expect(areaButton(/^Bezirk 0$/)).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(areaButton(/^Bezirk 0$/)).toHaveFocus();
  });

  it('steps over an unavailable district', async () => {
    renderView({ areaState: LOADED });
    const user = await chooseCity();

    cityField().focus();
    await user.tab();
    expect(areaButton(/Stadtmitte/)).toHaveFocus();

    // Oberwerth publishes no calendar, so the arrows pass it by and it is never focused.
    await user.keyboard('{ArrowDown}');
    expect(areaButton(/Stadtmitte/)).toHaveFocus();
    expect(areaButton(/Oberwerth/)).not.toHaveFocus();
  });

  it('uses no positive tabindex', async () => {
    renderView({ areaState: LONG_LIST });
    await chooseCity();

    const positive = [...document.querySelectorAll('[tabindex]')].filter(
      (element) => Number(element.getAttribute('tabindex')) > 0,
    );

    expect(positive).toEqual([]);
  });
});
