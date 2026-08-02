import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AreaCatalogueState } from '@/src/hooks/use-catalogue';
import { offerableProviders } from '@/src/hooks/use-catalogue';
import {
  AVAILABLE_AREA,
  CATALOGUE_WITH_DEMO,
  MIXED_AREAS,
  OFFICIAL_PROVIDER_ID,
  UNAVAILABLE_AREA,
} from '@/src/test/fixtures';
import { NeedsSelectionView } from './needs-selection-view';

/**
 * The unavailable-area rules are verified here, against a fixture of an **offered, non-demo** provider
 * whose list mixes an `available` and an `unavailable` area.
 *
 * The live API currently offers no unavailable area under a non-demo provider, and exposing the demo
 * provider to manufacture one would break the very rule being verified: a demo provider is excluded at the
 * catalogue, so none of its areas is ever listed, reachable, or rendered.
 */

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

const renderView = (overrides: Partial<Parameters<typeof NeedsSelectionView>[0]> = {}) => {
  const onConfirm = vi.fn();
  const onRequestAreas = vi.fn();
  const onRetryAreas = vi.fn();
  const onRetryCatalogue = vi.fn();

  const view = render(
    <NeedsSelectionView
      providers={CATALOGUE_WITH_DEMO}
      areaState={LOADED}
      isCatalogueLoading={false}
      onConfirm={onConfirm}
      onRetryCatalogue={onRetryCatalogue}
      onRequestAreas={onRequestAreas}
      onRetryAreas={onRetryAreas}
      {...overrides}
    />,
  );

  return { ...view, onConfirm, onRequestAreas, onRetryAreas, onRetryCatalogue };
};

const areaButton = (name: RegExp) => screen.getByRole('button', { name });

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

describe('NeedsSelectionView provider selection', () => {
  it('does not offer the demo provider', () => {
    renderView();

    expect(screen.queryByRole('option', { name: 'Demo provider' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Kommunaler Servicebetrieb' })).toBeInTheDocument();
  });

  it('requests the areas of the provider that was chosen', async () => {
    const user = userEvent.setup();
    const { onRequestAreas } = renderView({ areaState: { kind: 'idle' } });

    await user.selectOptions(
      screen.getByRole('combobox', { name: /Entsorgungsbetrieb/ }),
      OFFICIAL_PROVIDER_ID,
    );

    expect(onRequestAreas).toHaveBeenCalledWith(OFFICIAL_PROVIDER_ID);
    expect(onRequestAreas).toHaveBeenCalledTimes(1);
  });

  it('shows a loading state while the catalogue is being read', () => {
    renderView({ isCatalogueLoading: true });

    expect(screen.getByText('Daten werden geladen…')).toBeInTheDocument();
  });

  it('shows an error state when the catalogue could not be read', () => {
    renderView({ errorMessage: 'Die Liste konnte nicht geladen werden.' });

    expect(screen.getByRole('alert')).toHaveTextContent('Die Liste konnte nicht geladen werden.');
  });
});

/**
 * A failed catalogue read has to be recoverable on the surface that reports it.
 *
 * The catalogue is read once on mount, so a message alone left a person with nothing to do but close and
 * reopen the popup. And the retry has to ask the **catalogue** — retrying anything downstream is impossible
 * here, because no provider has been confirmed yet.
 */
describe('a failed provider catalogue', () => {
  const catalogueRetry = () =>
    screen.getByRole('button', { name: 'Entsorgungsbetriebe erneut laden' });

  it('offers a retry control beside the error', () => {
    renderView({ errorMessage: 'Die Liste konnte nicht geladen werden.' });

    expect(catalogueRetry()).toBeEnabled();
  });

  it('offers no catalogue retry when nothing failed', () => {
    renderView();

    expect(
      screen.queryByRole('button', { name: 'Entsorgungsbetriebe erneut laden' }),
    ).not.toBeInTheDocument();
  });

  it('asks for exactly one more catalogue read per press', async () => {
    const user = userEvent.setup();
    const { onRetryCatalogue, onRequestAreas, onRetryAreas } = renderView({
      errorMessage: 'Die Liste konnte nicht geladen werden.',
      areaState: { kind: 'idle' },
    });

    await user.click(catalogueRetry());

    expect(onRetryCatalogue).toHaveBeenCalledTimes(1);
    // The failed resource is the catalogue, so nothing downstream is asked for.
    expect(onRequestAreas).not.toHaveBeenCalled();
    expect(onRetryAreas).not.toHaveBeenCalled();
  });

  it('retries nothing merely because the component rendered again', () => {
    const { onRetryCatalogue, rerender } = renderView({
      errorMessage: 'Die Liste konnte nicht geladen werden.',
      areaState: { kind: 'idle' },
    });

    for (let render = 0; render < 3; render += 1) {
      rerender(
        <NeedsSelectionView
          providers={CATALOGUE_WITH_DEMO}
          areaState={{ kind: 'idle' }}
          isCatalogueLoading={false}
          errorMessage="Die Liste konnte nicht geladen werden."
          onConfirm={vi.fn()}
          onRetryCatalogue={onRetryCatalogue}
          onRequestAreas={vi.fn()}
          onRetryAreas={vi.fn()}
        />,
      );
    }

    expect(onRetryCatalogue).not.toHaveBeenCalled();
  });

  it('stays retryable after a repeated failure', async () => {
    const user = userEvent.setup();
    const { onRetryCatalogue } = renderView({
      errorMessage: 'Die Liste konnte nicht geladen werden.',
      areaState: { kind: 'idle' },
    });

    await user.click(catalogueRetry());
    await user.click(catalogueRetry());

    expect(onRetryCatalogue).toHaveBeenCalledTimes(2);
  });

  it('recovers the surface once the retry succeeds', () => {
    const { rerender, onRetryCatalogue } = renderView({
      errorMessage: 'Die Liste konnte nicht geladen werden.',
      areaState: { kind: 'idle' },
    });

    rerender(
      <NeedsSelectionView
        providers={CATALOGUE_WITH_DEMO}
        areaState={LOADED}
        isCatalogueLoading={false}
        onConfirm={vi.fn()}
        onRetryCatalogue={onRetryCatalogue}
        onRequestAreas={vi.fn()}
        onRetryAreas={vi.fn()}
      />,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Entsorgungsbetriebe erneut laden' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Kommunaler Servicebetrieb' })).toBeInTheDocument();
    expect(areaButton(/Stadtmitte/)).toBeInTheDocument();
  });
});

/**
 * Every area-request state says which one it is.
 *
 * An empty panel is the failure mode being ruled out here: it reads as a request that is still running, so a
 * person waits for something that already finished, failed, or was refused.
 */
describe('the area-request state', () => {
  it('says the areas are loading while the request is in flight, and announces it', () => {
    renderView({ areaState: { kind: 'loading', providerId: OFFICIAL_PROVIDER_ID } });

    // One node, inside the live region: seen once and heard once.
    expect(screen.getByRole('status')).toHaveTextContent('Sammelgebiete werden geladen…');
    expect(screen.getByText('Sammelgebiete werden geladen…')).toBeInTheDocument();
  });

  it('states plainly that a provider publishes no areas rather than showing nothing', () => {
    renderView({
      areaState: { kind: 'loaded', providerId: OFFICIAL_PROVIDER_ID, areas: [] },
    });

    expect(screen.getByRole('status')).toHaveTextContent(/keine Sammelgebiete abrufbar/);
  });

  it('says a provider is unavailable when the catalogue refused to request it', () => {
    renderView({ areaState: { kind: 'not_offered', providerId: OFFICIAL_PROVIDER_ID } });

    expect(screen.getByRole('status')).toHaveTextContent(/steht derzeit nicht zur Verfügung/);
  });

  it('shows no area state at all before a provider is chosen', () => {
    renderView({ areaState: { kind: 'idle' } });

    expect(screen.queryByText('Sammelgebiete werden geladen…')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Sammelgebiete erneut laden' }),
    ).not.toBeInTheDocument();
  });
});

describe('a failed area request', () => {
  it('says it failed and announces it', () => {
    renderView({ areaState: FAILED });

    // Announced as well as shown: a failure that only appeared visually would be silent for a screen-reader
    // user who had just chosen a provider.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Die Sammelgebiete konnten nicht geladen werden.',
    );
    expect(screen.getByText('Die Sammelgebiete konnten nicht geladen werden.')).toBeInTheDocument();
  });

  it('offers a retry control with its own accessible name', () => {
    renderView({ areaState: FAILED });

    expect(retryButton()).toBeEnabled();
  });

  it('retries nothing merely because the component rendered again', () => {
    const { onRequestAreas, onRetryAreas, rerender } = renderView({ areaState: FAILED });

    // The failed state persists across renders, so a surface that retried on render would hammer an API
    // that is down for as long as the popup stayed open.
    for (let render = 0; render < 3; render += 1) {
      rerender(
        <NeedsSelectionView
          providers={CATALOGUE_WITH_DEMO}
          areaState={FAILED}
          isCatalogueLoading={false}
          onConfirm={vi.fn()}
          onRetryCatalogue={vi.fn()}
          onRequestAreas={onRequestAreas}
          onRetryAreas={onRetryAreas}
        />,
      );
    }

    expect(onRetryAreas).not.toHaveBeenCalled();
    expect(onRequestAreas).not.toHaveBeenCalled();
  });

  it('asks for exactly one more attempt per press', async () => {
    const user = userEvent.setup();
    const { onRetryAreas } = renderView({ areaState: FAILED });

    await user.click(retryButton());

    expect(onRetryAreas).toHaveBeenCalledTimes(1);
    expect(onRetryAreas).toHaveBeenCalledWith(OFFICIAL_PROVIDER_ID);
  });

  it('renders the areas once a retry succeeds', () => {
    const { rerender, onRequestAreas, onRetryAreas } = renderView({ areaState: FAILED });

    rerender(
      <NeedsSelectionView
        providers={CATALOGUE_WITH_DEMO}
        areaState={LOADED}
        isCatalogueLoading={false}
        onConfirm={vi.fn()}
        onRetryCatalogue={vi.fn()}
        onRequestAreas={onRequestAreas}
        onRetryAreas={onRetryAreas}
      />,
    );

    expect(areaButton(/Stadtmitte/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Sammelgebiete erneut laden' }),
    ).not.toBeInTheDocument();
  });

  it('stays retryable after a repeated failure', async () => {
    const user = userEvent.setup();
    const { onRetryAreas } = renderView({ areaState: FAILED });

    await user.click(retryButton());
    // The attempt failed again, which is the same state — and it must still offer a way forward.
    await user.click(retryButton());

    expect(onRetryAreas).toHaveBeenCalledTimes(2);
  });
});

describe('an unavailable area of an offered provider', () => {
  it('is listed with explanatory copy rather than omitted', () => {
    renderView();

    expect(areaButton(/Oberwerth/)).toBeInTheDocument();
    expect(screen.getByText('Kein offizieller Kalender veröffentlicht')).toBeInTheDocument();
  });

  it('leaves a sibling available area selectable, so the test cannot pass by disabling everything', () => {
    renderView();

    expect(areaButton(/Stadtmitte/)).toBeEnabled();
    expect(areaButton(/Oberwerth/)).toBeDisabled();
  });

  it('exposes its disabled state through the accessibility tree', () => {
    renderView();

    // Asserted through the accessibility tree rather than a class name: appearance is never the mechanism.
    expect(areaButton(/Oberwerth/)).toBeDisabled();
    expect(areaButton(/Oberwerth/)).toHaveAccessibleDescription(
      'Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.',
    );
  });

  it('cannot be selected by pointer', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderView();

    await user.click(areaButton(/Oberwerth/));

    expect(screen.getByRole('button', { name: 'Auswahl bestätigen' })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cannot be reached or confirmed by keyboard', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderView();

    // Tab through every reachable control: a disabled button is out of the tab order, so focus never lands
    // on it and Enter or Space cannot activate it.
    for (let step = 0; step < 6; step += 1) {
      await user.tab();
      expect(areaButton(/Oberwerth/)).not.toHaveFocus();
    }

    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('is never handed to the confirm callback', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderView();

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
    const user = userEvent.setup();
    const { onConfirm } = renderView();

    // Choosing an area is not the same as confirming it: nothing is persisted on the user's behalf.
    await user.click(areaButton(/Stadtmitte/));
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Auswahl bestätigen' }));
    expect(onConfirm).toHaveBeenCalledWith(AVAILABLE_AREA);
  });

  it('cannot be confirmed before an area is chosen', () => {
    renderView();

    expect(screen.getByRole('button', { name: 'Auswahl bestätigen' })).toBeDisabled();
  });

  it('clears the chosen area when the provider changes', async () => {
    const user = userEvent.setup();

    renderView();

    await user.click(areaButton(/Stadtmitte/));
    expect(screen.getByRole('button', { name: 'Auswahl bestätigen' })).toBeEnabled();

    await user.selectOptions(
      screen.getByRole('combobox', { name: /Entsorgungsbetrieb/ }),
      OFFICIAL_PROVIDER_ID,
    );

    // An identifier is never carried across providers.
    expect(screen.getByRole('button', { name: 'Auswahl bestätigen' })).toBeDisabled();
  });
});
