import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { AreaCatalogueState } from '@/src/hooks/use-catalogue';
import type { ServiceAreaSummary } from '@/src/messaging/contract';
import type { AppSettings } from '@/src/storage/settings';
import { defaultSettings } from '@/src/storage/settings';
import {
  invalidateSelectionIfMatches,
  persistSettings,
  readSettings,
  writeSettings,
} from '@/src/storage/settings-repository';
import {
  CATALOGUE_WITH_DEMO,
  MIXED_AREAS,
  OFFICIAL_AREA_ID,
  OFFICIAL_PROVIDER_ID,
  UNAVAILABLE_AREA,
  evidenceForArea,
  UNAVAILABLE_AREA_ID,
} from '@/src/test/fixtures';
import { SettingsView } from './settings-view';

/**
 * Settings is transactional: nothing reaches storage until Save.
 *
 * These tests assert that against the **real** repository and the in-memory extension storage, not against a
 * spy alone, so "no write happened" means the stored value is genuinely unchanged.
 */

const OTHER_PROVIDER_ID = 'muelheim-betrieb';

const OTHER_AREA_ID = 'muelheim-mitte';

/** A second offered provider, so a provider change has somewhere to go. */
const OTHER_PROVIDER = {
  id: OTHER_PROVIDER_ID,
  name: 'Anderer Servicebetrieb',
  sourceKind: 'official_ics',
} as const;

const OTHER_AREA = {
  id: OTHER_AREA_ID,
  providerId: OTHER_PROVIDER_ID,
  locality: 'Mülheim',
  name: 'Mitte',
  collectionEvents: {
    availability: 'available',
    timeZone: 'Europe/Berlin',
    validity: { from: '2026-01-01', to: '2026-12-31' },
  },
} as const;

const PROVIDERS = [...CATALOGUE_WITH_DEMO, OTHER_PROVIDER];

/** The selection stored when Settings opens, and therefore the premise every draft here is built on. */
const OFFICIAL_SELECTION = {
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: OFFICIAL_AREA_ID,
} as const;

const STORED: AppSettings = {
  ...defaultSettings,
  selection: OFFICIAL_SELECTION,
  visibleWasteTypes: ['paper'],
  reminderTime: '18:00',
};

const storedValue = async (): Promise<unknown> =>
  (await fakeBrowser.storage.local.get('settings')).settings;

/** A successful area answer for one provider, which is the only shape that can produce an area list. */
const loadedFor = (
  providerId: string,
  areas: readonly ServiceAreaSummary[],
): AreaCatalogueState => ({ kind: 'loaded', providerId, areas });

const AREAS_FAILED_FOR = (providerId: string): AreaCatalogueState => ({
  kind: 'failed',
  providerId,
  failure: { kind: 'network', operation: 'listServiceAreas' },
});

interface RenderOptions {
  /** Where the area request has got to when Settings opens. */
  readonly areaState?: AreaCatalogueState;
  readonly onSave?: Parameters<typeof SettingsView>[0]['onSave'];
}

/**
 * Renders against the real repository. `onSave` defaults to the same single operation the popup performs, so
 * a save here really writes and a refusal here really refuses.
 *
 * The area state is a **prop the test controls**, because that is what it is in the product: Settings asks
 * for a provider's areas and the catalogue above answers later, or fails, or refuses. `answerWith` is the
 * test playing that part. Handing the view a pool of areas for several providers at once — what these tests
 * used to do — cannot express a failure, an in-flight request, or an empty answer at all.
 */
const renderView = ({
  areaState = loadedFor(OFFICIAL_PROVIDER_ID, MIXED_AREAS),
  onSave,
}: RenderOptions = {}) => {
  const onCancel = vi.fn();
  const onRequestAreas = vi.fn();
  const onRetryAreas = vi.fn();
  const save =
    onSave ??
    vi.fn(
      async (input: Parameters<NonNullable<RenderOptions['onSave']>>[0]) =>
        (await persistSettings(input)).outcome,
    );

  const element = (state: AreaCatalogueState) => (
    <SettingsView
      providers={PROVIDERS}
      areaState={state}
      initialSettings={STORED}
      onCancel={onCancel}
      onSave={save}
      onRequestAreas={onRequestAreas}
      onRetryAreas={onRetryAreas}
    />
  );

  const view = render(element(areaState));

  return {
    ...view,
    onCancel,
    onRequestAreas,
    onRetryAreas,
    save,
    /**
     * The catalogue answering. Rendered as the same element type in the same position, so the draft the view
     * holds survives — exactly as it does when the real answer arrives mid-edit.
     */
    answerWith: (next: AreaCatalogueState) => view.rerender(element(next)),
    /** A render with nothing new in it, for asserting that no request follows from rendering alone. */
    renderAgain: (state: AreaCatalogueState = areaState) => view.rerender(element(state)),
  };
};

const providerSelect = () => screen.getByRole('combobox', { name: /Entsorgungsbetrieb/ });

const areaButton = (name: RegExp) => screen.getByRole('button', { name });

const saveButton = () => screen.getByRole('button', { name: 'Einstellungen speichern' });

describe('the draft is not persisted until Save', () => {
  it('writes nothing when an area is chosen', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);
    renderView();

    await user.click(areaButton(/Stadtmitte/));

    expect(await storedValue()).toEqual(STORED);
  });

  it('writes nothing when the waste types change', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);
    renderView();

    await user.click(screen.getByRole('button', { name: 'Biotonne' }));

    expect(await storedValue()).toEqual(STORED);
  });

  it('writes nothing when the reminder settings change', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);
    renderView();

    await user.click(screen.getByRole('checkbox', { name: 'Erinnerungen aktivieren' }));

    expect(await storedValue()).toEqual(STORED);
  });

  it('writes nothing when the reminder time changes', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);
    renderView();

    await user.selectOptions(screen.getByRole('combobox', { name: /Uhrzeit/ }), '20:00');

    expect(await storedValue()).toEqual(STORED);
  });

  it('writes nothing when the provider changes', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);
    renderView();

    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);

    // The drafted area is cleared, but the persisted selection is untouched.
    expect(await storedValue()).toEqual(STORED);
    expect((await readSettings()).selection).toEqual(STORED.selection);
  });
});

describe('Back discards the whole draft', () => {
  it('keeps the previously stored area after choosing a different one', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);

    const { onCancel, save, answerWith } = renderView();

    // A -> choose B -> Back.
    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);
    // The catalogue answers for the newly drafted provider, as it does in the product.
    answerWith(loadedFor(OTHER_PROVIDER_ID, [OTHER_AREA]));
    await user.click(areaButton(/Mitte/));
    await user.click(screen.getByRole('button', { name: 'Zurück' }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    // Storage still holds area A, exactly as it was.
    expect(await storedValue()).toEqual(STORED);
    expect((await readSettings()).selection).toEqual({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
    });
  });

  it('keeps every other stored setting after editing them', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);

    const { onCancel } = renderView();

    await user.click(screen.getByRole('button', { name: 'Biotonne' }));
    await user.selectOptions(screen.getByRole('combobox', { name: /Uhrzeit/ }), '20:00');
    await user.click(screen.getByRole('button', { name: 'Zurück' }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(await storedValue()).toEqual(STORED);
  });
});

describe('Save persists the whole value in one operation', () => {
  it('persists a new provider and area together with the other draft settings', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);

    const { save, answerWith } = renderView();

    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);
    answerWith(loadedFor(OTHER_PROVIDER_ID, [OTHER_AREA]));
    await user.click(areaButton(/Mitte/));
    await user.click(screen.getByRole('button', { name: 'Biotonne' }));
    await user.click(saveButton());

    // Exactly one repository operation, carrying the complete value.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      settings: {
        ...STORED,
        selection: { providerId: OTHER_PROVIDER_ID, serviceAreaId: OTHER_AREA_ID },
        visibleWasteTypes: ['paper', 'bio'],
      },
      // The evidence names the area it was read for, so a save can never be made on another area's calendar.
      evidence: evidenceForArea(OTHER_AREA),
      expectedSelection: OFFICIAL_SELECTION,
    });

    expect(await readSettings()).toEqual({
      ...STORED,
      selection: { providerId: OTHER_PROVIDER_ID, serviceAreaId: OTHER_AREA_ID },
      visibleWasteTypes: ['paper', 'bio'],
    });
  });

  it('persists once, so storage is never left half-changed', async () => {
    const user = userEvent.setup();
    const writes: unknown[] = [];

    await writeSettings(STORED);
    fakeBrowser.storage.local.onChanged.addListener((changes) => {
      if (changes.settings !== undefined) {
        writes.push(changes.settings.newValue);
      }
    });

    const { answerWith } = renderView();

    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);
    answerWith(loadedFor(OTHER_PROVIDER_ID, [OTHER_AREA]));
    await user.click(areaButton(/Mitte/));
    await user.click(saveButton());

    // One storage change, not a selection write followed by a settings write.
    expect(writes).toHaveLength(1);
  });
});

describe('a failed Save', () => {
  it('leaves storage unchanged and keeps the surface open with an error', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);

    const failing = vi.fn().mockRejectedValue(new Error('Storage unavailable'));

    renderView({ onSave: failing });

    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Die Einstellungen konnten nicht gespeichert werden.',
    );
    // Still on Settings, and the stored value is untouched.
    expect(screen.getByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    expect(await storedValue()).toEqual(STORED);
  });

  it('reports a repository refusal without navigating away', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);

    const refusing = vi.fn().mockResolvedValue('rejected_unavailable' as const);

    renderView({ onSave: refusing });

    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.',
    );
    expect(screen.getByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument();
    expect(await storedValue()).toEqual(STORED);
  });
});

describe('the provider draft', () => {
  it('keeps the chosen provider selected while its areas are still loading', async () => {
    const user = userEvent.setup();

    // The areas list has not caught up yet, which is exactly the pending state.
    renderView();

    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);

    expect(providerSelect()).toHaveValue(OTHER_PROVIDER_ID);
    // No area of the new provider is offered yet, and none is drafted.
    expect(screen.queryByRole('button', { name: /Mitte/ })).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('starts from the persisted provider', () => {
    renderView();

    expect(providerSelect()).toHaveValue(OFFICIAL_PROVIDER_ID);
    expect(areaButton(/Stadtmitte/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears the drafted area when the provider changes', async () => {
    const user = userEvent.setup();

    const { answerWith } = renderView();

    expect(areaButton(/Stadtmitte/)).toHaveAttribute('aria-pressed', 'true');

    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);
    answerWith(loadedFor(OTHER_PROVIDER_ID, [OTHER_AREA]));

    // An identifier is never carried across providers, and the new provider's area is not preselected.
    expect(areaButton(/Mitte/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers only the areas of the provider being edited', async () => {
    const user = userEvent.setup();

    const { answerWith } = renderView();

    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);

    // Not selectable the moment the provider changes, before any answer arrives: the state on hand is about
    // the previous provider, and a list is only ever offered for the provider it belongs to.
    expect(screen.queryByRole('button', { name: /Stadtmitte/ })).not.toBeInTheDocument();

    answerWith(loadedFor(OTHER_PROVIDER_ID, [OTHER_AREA]));

    expect(screen.queryByRole('button', { name: /Stadtmitte/ })).not.toBeInTheDocument();
    expect(areaButton(/Mitte/)).toBeInTheDocument();
  });

  it('cannot save a half-selection made of a new provider and an old area', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);

    const { save } = renderView();

    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);
    await user.click(saveButton());

    // The drafted selection is null, so the saved value carries no selection rather than a mismatched pair.
    expect(save).toHaveBeenCalledWith({
      settings: { ...STORED, selection: null },
      evidence: undefined,
      // The premise the draft was built on: the selection stored when Settings opened.
      expectedSelection: OFFICIAL_SELECTION,
    });
    expect((await readSettings()).selection).toBeNull();
  });

  it('renders and saves only the newest provider after rapid changes', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);

    const { save, onRequestAreas, answerWith } = renderView();

    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);
    await user.selectOptions(providerSelect(), OFFICIAL_PROVIDER_ID);
    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);

    expect(providerSelect()).toHaveValue(OTHER_PROVIDER_ID);
    expect(onRequestAreas).toHaveBeenLastCalledWith(OTHER_PROVIDER_ID);

    // The catalogue answers for the newest provider only. An answer for the one in the middle would be
    // recognized as being about somebody else and never offered.
    answerWith(loadedFor(OTHER_PROVIDER_ID, [OTHER_AREA]));

    // Only the newest provider's areas are offered.
    expect(screen.queryByRole('button', { name: /Stadtmitte/ })).not.toBeInTheDocument();

    await user.click(areaButton(/Mitte/));
    await user.click(saveButton());

    expect(save).toHaveBeenCalledWith({
      settings: {
        ...STORED,
        selection: { providerId: OTHER_PROVIDER_ID, serviceAreaId: OTHER_AREA_ID },
      },
      // The evidence names the area it was read for, so a save can never be made on another area's calendar.
      evidence: evidenceForArea(OTHER_AREA),
      expectedSelection: OFFICIAL_SELECTION,
    });
  });
});

describe('an unavailable area in Settings', () => {
  it('is listed with explanatory copy while a sibling stays selectable', () => {
    renderView();

    expect(areaButton(/Oberwerth/)).toBeDisabled();
    expect(areaButton(/Stadtmitte/)).toBeEnabled();
    expect(screen.getByText('Kein offizieller Kalender veröffentlicht')).toBeInTheDocument();
  });

  it('cannot enter the draft by pointer', async () => {
    const user = userEvent.setup();

    renderView();

    await user.click(areaButton(/Oberwerth/));

    expect(areaButton(/Oberwerth/)).toHaveAttribute('aria-pressed', 'false');
    // The previously drafted area is untouched.
    expect(areaButton(/Stadtmitte/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('cannot be reached or activated by keyboard', async () => {
    const user = userEvent.setup();

    renderView();

    for (let step = 0; step < 8; step += 1) {
      await user.tab();
      expect(areaButton(/Oberwerth/)).not.toHaveFocus();
    }

    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(areaButton(/Oberwerth/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('exposes its disabled state through the accessibility tree', () => {
    renderView();

    expect(areaButton(/Oberwerth/)).toHaveAccessibleDescription(
      'Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.',
    );
  });

  it('is rejected by the repository independently of the UI', async () => {
    // The guarantee must not rest on a disabled control.
    await writeSettings(STORED);

    const result = await persistSettings({
      expectedSelection: OFFICIAL_SELECTION,
      settings: {
        ...STORED,
        selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: UNAVAILABLE_AREA_ID },
      },
      evidence: evidenceForArea(UNAVAILABLE_AREA),
    });

    expect(result.outcome).toBe('rejected_unavailable');
    expect(await storedValue()).toEqual(STORED);
  });

  it('is rejected by the repository when no capability was checked at all', async () => {
    await writeSettings(STORED);

    const result = await persistSettings({
      expectedSelection: OFFICIAL_SELECTION,
      settings: {
        ...STORED,
        selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: 'never-verified' },
      },
    });

    expect(result.outcome).toBe('rejected_unknown_capability');
    expect(await storedValue()).toEqual(STORED);
  });
});

describe('reminder and waste-type editing', () => {
  it('keeps at least one waste type selected', async () => {
    const user = userEvent.setup();

    const { save } = renderView();

    await user.click(screen.getByRole('button', { name: 'Altpapier' }));
    await user.click(saveButton());

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ visibleWasteTypes: ['paper'] }),
      }),
    );
  });

  it('disables the reminder time while reminders are off', async () => {
    const user = userEvent.setup();

    renderView();

    await user.click(screen.getByRole('checkbox', { name: 'Erinnerungen aktivieren' }));

    expect(screen.getByRole('combobox', { name: /Uhrzeit/ })).toBeDisabled();
  });

  it('does not offer the demo provider', () => {
    renderView();

    expect(screen.queryByRole('option', { name: 'Demo provider' })).not.toBeInTheDocument();
  });
});

describe('reopening Settings after a cancelled provider change', () => {
  it('requests the persisted provider’s areas when the list belongs to another provider', async () => {
    // Reproduces the adjacent defect the audit surfaced: cancelling a provider change leaves the catalogue
    // holding the *other* provider's areas, so reopening Settings would show an empty area list forever —
    // the popup only refetches while no provider has been selected yet.
    const { onRequestAreas } = renderView({
      areaState: loadedFor(OTHER_PROVIDER_ID, [OTHER_AREA]),
    });

    await vi.waitFor(() => {
      expect(onRequestAreas).toHaveBeenCalledWith(OFFICIAL_PROVIDER_ID);
    });
  });

  it('asks exactly once, however many times it renders', async () => {
    // The other half of that defect. Asking on every render loops against the catalogue for as long as
    // Settings stays open, which is what the state — rather than a bare list — exists to prevent.
    const { onRequestAreas, renderAgain } = renderView({
      areaState: loadedFor(OTHER_PROVIDER_ID, [OTHER_AREA]),
    });

    await vi.waitFor(() => {
      expect(onRequestAreas).toHaveBeenCalledTimes(1);
    });

    renderAgain();
    renderAgain();

    expect(onRequestAreas).toHaveBeenCalledTimes(1);
  });
});

/**
 * Settings answers for every area-request state, not only the successful one.
 *
 * The area list renders a successful non-empty answer. Everything else — in flight, failed, refused, empty —
 * would otherwise be a blank space under the provider field that reads as a request still running.
 */
describe('the area-request state in Settings', () => {
  it('says the areas are loading while the request is in flight', () => {
    renderView({ areaState: { kind: 'loading', providerId: OFFICIAL_PROVIDER_ID } });

    expect(screen.getByRole('status')).toHaveTextContent('Sammelgebiete werden geladen…');
    expect(screen.queryByRole('button', { name: /Stadtmitte/ })).not.toBeInTheDocument();
  });

  it('states plainly that a provider publishes no areas', () => {
    renderView({ areaState: loadedFor(OFFICIAL_PROVIDER_ID, []) });

    expect(screen.getByRole('status')).toHaveTextContent(/keine Sammelgebiete abrufbar/);
  });

  it('says a provider is unavailable when the catalogue refused to request it', () => {
    renderView({ areaState: { kind: 'not_offered', providerId: OFFICIAL_PROVIDER_ID } });

    expect(screen.getByRole('status')).toHaveTextContent(/steht derzeit nicht zur Verfügung/);
  });

  it('reports nothing about a state that belongs to another provider', () => {
    // A state always names its provider, so one provider's failure can never appear under another's name.
    renderView({ areaState: AREAS_FAILED_FOR(OTHER_PROVIDER_ID) });

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(
      screen.queryByRole('button', { name: 'Sammelgebiete erneut laden' }),
    ).not.toBeInTheDocument();
  });
});

describe('a failed area request in Settings', () => {
  const retryButton = () => screen.getByRole('button', { name: 'Sammelgebiete erneut laden' });

  it('says it failed, announces it, and offers a retry', () => {
    renderView({ areaState: AREAS_FAILED_FOR(OFFICIAL_PROVIDER_ID) });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Die Sammelgebiete konnten nicht geladen werden.',
    );
    expect(retryButton()).toBeEnabled();
  });

  it('retries nothing merely because the component rendered again', () => {
    const { onRequestAreas, onRetryAreas, renderAgain } = renderView({
      areaState: AREAS_FAILED_FOR(OFFICIAL_PROVIDER_ID),
    });

    renderAgain();
    renderAgain();
    renderAgain();

    // The auto-request effect must recognize the failed state as *this* provider's answer, or it would ask
    // again on every render and hammer an API that is down.
    expect(onRequestAreas).not.toHaveBeenCalled();
    expect(onRetryAreas).not.toHaveBeenCalled();
  });

  it('asks for exactly one more attempt per press', async () => {
    const user = userEvent.setup();
    const { onRetryAreas } = renderView({ areaState: AREAS_FAILED_FOR(OFFICIAL_PROVIDER_ID) });

    await user.click(retryButton());

    expect(onRetryAreas).toHaveBeenCalledTimes(1);
    expect(onRetryAreas).toHaveBeenCalledWith(OFFICIAL_PROVIDER_ID);
  });

  it('renders the areas once a retry succeeds', async () => {
    const user = userEvent.setup();
    const { answerWith, onRetryAreas } = renderView({
      areaState: AREAS_FAILED_FOR(OFFICIAL_PROVIDER_ID),
    });

    await user.click(retryButton());
    answerWith({ kind: 'loading', providerId: OFFICIAL_PROVIDER_ID });

    // Failed -> loading, so the error is not still being asserted while the new attempt runs.
    expect(screen.getByRole('status')).toHaveTextContent('Sammelgebiete werden geladen…');

    answerWith(loadedFor(OFFICIAL_PROVIDER_ID, MIXED_AREAS));

    expect(areaButton(/Stadtmitte/)).toBeInTheDocument();
    expect(onRetryAreas).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Sammelgebiete erneut laden' }),
    ).not.toBeInTheDocument();
  });

  it('stays retryable after a repeated failure', async () => {
    const user = userEvent.setup();
    const { answerWith, onRetryAreas } = renderView({
      areaState: AREAS_FAILED_FOR(OFFICIAL_PROVIDER_ID),
    });

    await user.click(retryButton());
    answerWith({ kind: 'loading', providerId: OFFICIAL_PROVIDER_ID });
    answerWith(AREAS_FAILED_FOR(OFFICIAL_PROVIDER_ID));

    await user.click(retryButton());

    expect(onRetryAreas).toHaveBeenCalledTimes(2);
  });
});

/**
 * A Settings session builds its draft from what was stored when it opened, so the draft can go stale.
 *
 * The surface has to say so in its own words: pressing Save again would be refused for the same reason, so the
 * generic retry message would be actively misleading. The person is told the selection changed and asked to look
 * again.
 */
describe('a stale draft refused by the owner', () => {
  const CONFLICT_COPY = /Das gespeicherte Sammelgebiet hat sich zwischenzeitlich geändert/;

  it('sends the selection that was stored when the draft was created', async () => {
    const user = userEvent.setup();
    const { save } = renderView();

    await user.click(screen.getByRole('button', { name: 'Biotonne' }));
    await user.click(saveButton());

    // The premise, captured at mount and unchanged by anything edited since.
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSelection: OFFICIAL_SELECTION }),
    );
  });

  it('keeps the same premise even after the drafted selection changes', async () => {
    const user = userEvent.setup();
    const { save, answerWith } = renderView();

    await user.selectOptions(providerSelect(), OTHER_PROVIDER_ID);
    answerWith(loadedFor(OTHER_PROVIDER_ID, [OTHER_AREA]));
    await user.click(areaButton(/Mitte/));
    await user.click(saveButton());

    // Editing the draft cannot move its premise: that is what makes the check detect a *stored* change.
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSelection: OFFICIAL_SELECTION }),
    );
  });

  it('explains a conflict in its own words rather than offering a pointless retry', async () => {
    const user = userEvent.setup();

    renderView({ onSave: vi.fn().mockResolvedValue('conflict') });

    await user.click(saveButton());

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(CONFLICT_COPY);
    expect(alert).toHaveTextContent(/wurden nicht gespeichert/);
    // Not the generic message, which would invite a press that is refused for the same reason.
    expect(alert).not.toHaveTextContent('Bitte erneut versuchen.');
  });

  it('asks the person to review the selection again', async () => {
    const user = userEvent.setup();

    renderView({ onSave: vi.fn().mockResolvedValue('conflict') });

    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/prüfe die Auswahl erneut/);
  });

  it('stays open with its controls usable, so the edit is not lost', async () => {
    const user = userEvent.setup();

    renderView({ onSave: vi.fn().mockResolvedValue('conflict') });

    await user.click(saveButton());
    await screen.findByRole('alert');

    // Still on Settings, and the person can leave deliberately through Back.
    expect(screen.getByRole('heading', { name: 'Einstellungen' })).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Zurück' })).toBeEnabled();
  });

  it('keeps focus on the control that was pressed', async () => {
    const user = userEvent.setup();

    renderView({ onSave: vi.fn().mockResolvedValue('conflict') });

    await user.click(saveButton());
    await screen.findByRole('alert');

    expect(saveButton()).toHaveFocus();
  });

  it('writes nothing through the real repository when the draft is stale', async () => {
    const user = userEvent.setup();

    await writeSettings(STORED);
    renderView();

    // The stored selection moves on while this draft is open.
    await invalidateSelectionIfMatches(OFFICIAL_SELECTION);

    await user.click(screen.getByRole('button', { name: 'Biotonne' }));
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(CONFLICT_COPY);

    const stored = await readSettings();

    // Neither the selection it would have restored nor the preference it edited.
    expect(stored.selection).toBeNull();
    expect(stored.visibleWasteTypes).toEqual(['paper']);
  });
});
