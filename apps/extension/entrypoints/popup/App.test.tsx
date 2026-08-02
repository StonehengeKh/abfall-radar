import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { showReminder } from '@/src/background/reminder';
import {
  type GatewayRequest,
  GatewayRequestSchema,
  isSettingsRequest,
  SETTINGS_STORAGE_UNAVAILABLE,
  SettingsChangedNotificationSchema,
  SETTINGS_UNSUPPORTED_VERSION,
  type SettingsRequestKind,
} from '@/src/messaging/contract';
import {
  invalidateSelectionIfMatches,
  persistSelection,
  persistSettings,
  readSettings,
  readSettingsState,
  UnsupportedSettingsVersionError,
  writeSettings,
} from '@/src/storage/settings-repository';
import { type AppSettings, defaultSettings, SETTINGS_SCHEMA_VERSION } from '@/src/storage/settings';
import {
  AVAILABLE_AREA,
  evidenceForArea,
  CATALOGUE_WITH_DEMO,
  curbsideEvent,
  MIXED_AREAS,
  OFFICIAL_AREA_ID,
  OFFICIAL_PROVIDER_ID,
  restoredSchedule,
  schedule,
  UNAVAILABLE_AREA,
  UNAVAILABLE_AREA_ID,
} from '@/src/test/fixtures';
import App from './App';

/**
 * The popup as a whole, driven through the real message boundary.
 *
 * Every request is counted by kind, because the defect this exists to prevent is invisible to an
 * outcome-based test: the popup rendered the right schedule while asking for it over and over. `verifyProvider`
 * derived a new verdict object on every render, and the two effects reading it treated each render as the
 * catalogue having spoken again — so a restored cache landing or a schedule arriving re-triggered the whole
 * chain, and each of those updates triggered it once more.
 *
 * `list_service_areas` settles at **two**, and that is by design rather than a leftover: the catalogue hook
 * reads the list the selection surfaces offer, and the schedule hook reads the authoritative capability of the
 * one selected area. Two consumers, one request each. The number is asserted exactly, so a return to
 * once-per-render fails here — and `SETTLED_AREA_REQUESTS` names it so the expectation cannot be mistaken for
 * a duplicate nobody noticed.
 */
const SETTLED_AREA_REQUESTS = 2;

/**
 * `fakeBrowser` implements the real extension APIs rather than mocking them, so a spy installed on one of them
 * survives `fakeBrowser.reset()` and leaks into the next test. Every spy here is therefore removed explicitly —
 * without this, a test that made storage unreadable left it unreadable for everything that followed.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Answers a settings intent the way the worker does: by delegating to the repository.
 *
 * The popup reads and writes settings only through the worker now, so these tests have to stand in for that
 * owner. Delegating to the real repository rather than faking a reply keeps `writeSettings` in a test's arrange
 * step meaningful, and keeps the capability refusals and the compare-and-clear genuinely exercised.
 */
/** The worker's own guarded read for an outcome that wrote nothing, mirrored rather than approximated. */
const settingsAfterRefusal = async (): Promise<AppSettings> => {
  const state = await readSettingsState();

  if (state.status === 'unsupported_version') {
    throw new UnsupportedSettingsVersionError();
  }

  return state.settings;
};

const answerSettings = async (
  request: Extract<GatewayRequest, { kind: SettingsRequestKind }>,
): Promise<unknown> => {
  try {
    switch (request.kind) {
      case 'read_settings': {
        const state = await readSettingsState();

        // Exactly what the worker answers: a newer build's value is reported, never handed back as defaults.
        return state.status === 'unsupported_version'
          ? { ok: false, failure: { kind: 'unsupported_version' } }
          : { ok: true, data: state.settings };
      }
      case 'select_service_area': {
        const result = await persistSelection({
          selection: request.selection,
          evidence: request.evidence,
        });

        return {
          ok: true,
          data:
            result.outcome === 'persisted'
              ? { outcome: 'persisted', settings: result.settings }
              : { outcome: result.outcome, settings: await settingsAfterRefusal() },
        };
      }
      case 'save_settings': {
        const result = await persistSettings({
          expectedSelection: request.expectedSelection,
          settings: {
            version: SETTINGS_SCHEMA_VERSION,
            selection: request.selection,
            remindersEnabled: request.remindersEnabled,
            reminderDaysBefore: request.reminderDaysBefore,
            reminderTime: request.reminderTime,
            visibleWasteTypes: [...request.visibleWasteTypes],
          },
          ...(request.evidence === undefined ? {} : { evidence: request.evidence }),
        });

        return {
          ok: true,
          data:
            result.outcome === 'persisted'
              ? { outcome: 'persisted', settings: result.settings }
              : { outcome: result.outcome, settings: await settingsAfterRefusal() },
        };
      }
      case 'invalidate_selection_if_matches': {
        const result = await invalidateSelectionIfMatches(request.expectedSelection);

        return { ok: true, data: { outcome: result.outcome, settings: result.settings } };
      }
    }
  } catch (error) {
    // Both of the worker's own failures, told apart the same way it tells them apart. A settings command makes
    // no HTTP request, so neither of them may name an operation or a status.
    return {
      ok: false,
      failure:
        error instanceof UnsupportedSettingsVersionError
          ? SETTINGS_UNSUPPORTED_VERSION
          : SETTINGS_STORAGE_UNAVAILABLE,
    };
  }
};

const STORED: AppSettings = {
  ...defaultSettings,
  selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
  visibleWasteTypes: ['paper'],
};

interface WorkerOptions {
  /** `null` means nothing trustworthy is cached, which is not a failure. */
  readonly restored?: ReturnType<typeof restoredSchedule> | null;
}

/**
 * Answers as the background worker does, and records every request kind.
 *
 * `browser.runtime.sendMessage` is what the default messaging client uses, so stubbing it here exercises the
 * popup's real transport rather than a hook parameter no product code passes.
 */
const stubWorker = ({ restored = null }: WorkerOptions = {}) => {
  const kinds: GatewayRequest['kind'][] = [];
  /** The validated requests themselves, for assertions about what a surface actually sent. */
  const requests: GatewayRequest[] = [];

  /**
   * The real dispatcher, captured before the spy replaces it.
   *
   * Messages travel in both directions: the popup sends requests *to* the worker, and the worker announces
   * settings changes *to* the popup. Stubbing `sendMessage` intercepts both, so an announcement has to be handed
   * to the genuine dispatcher or it would never reach the popup's own listener — and a test of that path would
   * silently prove nothing.
   */
  const deliver = fakeBrowser.runtime.sendMessage.bind(fakeBrowser.runtime);

  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
    if (SettingsChangedNotificationSchema.safeParse(message).success) {
      try {
        return await deliver(message);
      } catch {
        // No popup listening, which is the ordinary case and never the sender's problem.
        return undefined;
      }
    }

    // Validated exactly as the worker validates it, so a request the popup malformed is a test failure here
    // rather than something this stub quietly accepts.
    const request = GatewayRequestSchema.parse(message);

    kinds.push(request.kind);
    requests.push(request);

    switch (request.kind) {
      case 'list_providers':
        return { ok: true, data: CATALOGUE_WITH_DEMO };
      case 'list_service_areas':
        return { ok: true, data: MIXED_AREAS };
      case 'list_collection_events':
        return {
          ok: true,
          data: { kind: 'live', schedule: schedule({ events: [curbsideEvent('2026-03-10')] }) },
        };
      case 'restore_cached_schedule':
        return { ok: true, data: restored };
      case 'invalidate_cached_schedule':
        return { ok: true, data: null };
      default:
        // Settings intents are answered by the real repository, exactly as the worker answers them. The popup
        // owns no settings storage of its own, so a stub that faked these would be testing nothing.
        return answerSettings(request);
    }
  });

  const countOf = (kind: GatewayRequest['kind']): number =>
    kinds.filter((entry) => entry === kind).length;

  const sent = <Kind extends GatewayRequest['kind']>(
    kind: Kind,
  ): Extract<GatewayRequest, { kind: Kind }> | undefined =>
    requests.find(
      (request): request is Extract<GatewayRequest, { kind: Kind }> => request.kind === kind,
    );

  return { kinds, countOf, requests, sent };
};

describe('the popup with a stored selection', () => {
  it('asks each question once per consumer and shows the schedule', async () => {
    await writeSettings(STORED);

    const { countOf } = stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Koblenz · Stadtmitte')).toBeInTheDocument();
    });

    // Settled: no further request may follow from the renders those answers caused.
    await waitFor(() => {
      expect(screen.getByText(/Aktuell abgerufen am/)).toBeInTheDocument();
    });

    expect(countOf('list_providers')).toBe(1);
    expect(countOf('list_service_areas')).toBe(SETTLED_AREA_REQUESTS);
    expect(countOf('list_collection_events')).toBe(1);
    expect(countOf('restore_cached_schedule')).toBe(1);
  });

  it('asks nothing more once the live schedule has arrived', async () => {
    await writeSettings(STORED);

    const { countOf, kinds } = stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Aktuell abgerufen am/)).toBeInTheDocument();
    });

    const settled = [...kinds];

    // Several turns after the answer, so a re-triggered effect would have had every chance to run.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(kinds).toEqual(settled);
    expect(countOf('list_service_areas')).toBe(SETTLED_AREA_REQUESTS);
    expect(countOf('list_collection_events')).toBe(1);
  });

  it('asks nothing more when a restored cache arrives before the live answer', async () => {
    // The restored cache is a *second* state update on the same attempt, and it used to look like news about
    // the provider — which reset the phase to pending and asked for everything again.
    await writeSettings(STORED);

    const { countOf } = stubWorker({
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Aktuell abgerufen am/)).toBeInTheDocument();
    });

    expect(countOf('restore_cached_schedule')).toBe(1);
    expect(countOf('list_service_areas')).toBe(SETTLED_AREA_REQUESTS);
    expect(countOf('list_collection_events')).toBe(1);
  });

  it('never asks for the areas of a provider before the catalogue confirms it', async () => {
    await writeSettings(STORED);

    const { kinds } = stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(kinds).toContain('list_service_areas');
    });

    // A stored identifier is not evidence: the catalogue answers first, always.
    expect(kinds.indexOf('list_providers')).toBeLessThan(kinds.indexOf('list_service_areas'));
  });
});

describe('the popup with no stored selection', () => {
  it('asks for the catalogue only, and for no provider-specific data', async () => {
    const { countOf } = stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sammelgebiet wählen' })).toBeInTheDocument();
    });

    expect(countOf('list_providers')).toBe(1);
    // Nothing is preselected, fetched, or reminded about on a person's behalf.
    expect(countOf('list_service_areas')).toBe(0);
    expect(countOf('list_collection_events')).toBe(0);
    expect(countOf('restore_cached_schedule')).toBe(0);
  });

  it('requests the areas of a chosen provider exactly once', async () => {
    const { countOf } = stubWorker();

    render(<App />);

    const select = await screen.findByRole('combobox', { name: /Entsorgungsbetrieb/ });

    // `selectOptions` dispatches the same change the product handles.
    await userEvent.setup().selectOptions(select, OFFICIAL_PROVIDER_ID);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Stadtmitte/ })).toBeInTheDocument();
    });

    expect(countOf('list_service_areas')).toBe(1);
    expect(screen.getByRole('button', { name: /Stadtmitte/ })).toBeEnabled();
    // The area belongs to the provider that was chosen, so nothing was carried across providers.
    expect(AVAILABLE_AREA.providerId).toBe(OFFICIAL_PROVIDER_ID);
  });
});

/**
 * The popup must never sit on its preparation screen indefinitely.
 *
 * That screen is shown while the settings read is in flight, so any read that never answers is a spinner with
 * no error, no explanation, and nothing to act on. Two paths did exactly that: a migration whose write failed,
 * and a stored value that could not be read at all.
 */
describe('the popup while settings are being prepared', () => {
  const LEGACY = {
    districtId: 'koblenz-stadtmitte',
    remindersEnabled: false,
    reminderDaysBefore: 2,
    reminderTime: '19:00',
    visibleWasteTypes: ['paper'],
  } as const;

  const PREPARING = 'AbfallRadar wird vorbereitet…';

  it('completes hydration and shows the schedule when the migration write fails', async () => {
    await fakeBrowser.storage.local.set({ settings: LEGACY });
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));
    stubWorker();

    render(<App />);

    // The migrated selection is honoured for this session even though it could not be written back.
    await waitFor(() => {
      expect(screen.getByText('Koblenz · Stadtmitte')).toBeInTheDocument();
    });

    expect(screen.queryByText(PREPARING)).not.toBeInTheDocument();
  });

  it('shows an explicit error when the stored settings cannot be read', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));
    stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Einstellungen nicht lesbar')).toBeInTheDocument();
    });

    // Not the preparation screen, and not the ordinary application over settings nobody read.
    expect(screen.queryByText(PREPARING)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/konnten nicht gelesen werden/);
  });

  it('does not offer onboarding over settings it never read', async () => {
    // Defaults carry `selection: null`, so rendering the application here would ask a person to choose an area
    // they may already have chosen — and then overwrite it.
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));
    stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Einstellungen nicht lesbar')).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: 'Sammelgebiet wählen' })).not.toBeInTheDocument();
  });
});

/**
 * Confirming a selection replaces the whole surface, so focus has to go somewhere deliberate.
 *
 * The button that was just pressed is removed from the document, and focus falls back to `<body>`. For a
 * keyboard or screen-reader user that is a dead end: the next Tab restarts from the top of the document, and
 * nothing announces that the screen changed at all. Moving focus to the new main region is what makes the
 * transition perceivable and continues the keyboard journey where it left off.
 *
 * Driven with the keyboard rather than a click, because that is the interaction the defect is about.
 */
describe('focus after confirming a selection', () => {
  /** Tabs to the confirm button and activates it with Enter, as a keyboard user would. */
  const confirmWithKeyboard = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    const confirm = screen.getByRole('button', { name: 'Auswahl bestätigen' });

    // Focused by tabbing, so the starting point is a real keyboard position rather than a synthetic one.
    for (let step = 0; step < 12 && document.activeElement !== confirm; step += 1) {
      await user.tab();
    }

    expect(confirm).toHaveFocus();

    await user.keyboard('{Enter}');
  };

  /** Chooses the available area on the onboarding surface, leaving the confirm button enabled. */
  const chooseArea = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    const select = await screen.findByRole('combobox', { name: /Entsorgungsbetrieb/ });

    await user.selectOptions(select, OFFICIAL_PROVIDER_ID);
    await user.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
  };

  it('moves focus to the dashboard main region', async () => {
    const user = userEvent.setup();

    stubWorker();
    render(<App />);

    await chooseArea(user);
    await confirmWithKeyboard(user);

    // The confirmation really was persisted and the dashboard really did replace the onboarding surface.
    await waitFor(() => {
      expect(screen.getByText('Koblenz · Stadtmitte')).toBeInTheDocument();
    });

    const main = screen.getByRole('main');

    await waitFor(() => {
      expect(main).toHaveFocus();
    });

    expect(document.activeElement).toBe(main);
  });

  it('unmounts the confirmation button and leaves focus nowhere near the document body', async () => {
    const user = userEvent.setup();

    stubWorker();
    render(<App />);

    await chooseArea(user);
    await confirmWithKeyboard(user);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Auswahl bestätigen' })).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
    });

    expect(document.activeElement).not.toBe(document.documentElement);
    expect(document.activeElement).not.toBeNull();
  });

  it('keeps the main region out of the tab order, so it is not a stop on every pass', async () => {
    const user = userEvent.setup();

    stubWorker();
    render(<App />);

    await chooseArea(user);
    await confirmWithKeyboard(user);

    await waitFor(() => {
      expect(screen.getByRole('main')).toHaveFocus();
    });

    // Programmatically focusable, never tabbable.
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
  });

  it('does not take focus again when the schedule updates afterwards', async () => {
    const user = userEvent.setup();

    stubWorker();
    render(<App />);

    await chooseArea(user);
    await confirmWithKeyboard(user);

    await waitFor(() => {
      expect(screen.getByRole('main')).toHaveFocus();
    });

    // The person moves on to a control of their own choosing.
    const settingsButton = screen.getByRole('button', { name: 'Einstellungen öffnen' });

    settingsButton.focus();
    expect(settingsButton).toHaveFocus();

    // Schedule and cache updates keep arriving and rerendering the dashboard.
    await waitFor(() => {
      expect(screen.getByText(/Aktuell abgerufen am/)).toBeInTheDocument();
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    // Focus is still where the person put it. A handoff that survived its own render would have stolen it.
    expect(settingsButton).toHaveFocus();
  });

  it('leaves focus in onboarding when the confirmation is refused', async () => {
    const user = userEvent.setup();

    stubWorker();

    // The repository refuses an area whose capability publishes no calendar, so the surface stays put.
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const request = GatewayRequestSchema.parse(message);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      if (request.kind === 'list_providers') {
        return { ok: true, data: CATALOGUE_WITH_DEMO };
      }

      if (request.kind === 'list_service_areas') {
        return { ok: true, data: [UNAVAILABLE_AREA] };
      }

      return { ok: true, data: null };
    });

    render(<App />);

    const select = await screen.findByRole('combobox', { name: /Entsorgungsbetrieb/ });

    await user.selectOptions(select, OFFICIAL_PROVIDER_ID);

    // The unavailable area cannot be chosen at all, so confirmation stays unreachable and focus never leaves.
    const unavailable = await screen.findByRole('button', { name: /Oberwerth/ });

    expect(unavailable).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Auswahl bestätigen' })).toBeDisabled();
    // Still the onboarding surface. Both surfaces render a `main`, so the heading is what tells them apart.
    expect(screen.queryByRole('heading', { name: 'Alles im Blick' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sammelgebiet wählen' })).toBeInTheDocument();
  });

  it('keeps focus on the confirmation button when persistence fails', async () => {
    const user = userEvent.setup();

    stubWorker();
    render(<App />);

    await chooseArea(user);

    // Storage refuses the write, so nothing is persisted and the surface must not change.
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    await confirmWithKeyboard(user);

    const confirm = await screen.findByRole('button', { name: 'Auswahl bestätigen' });

    // Still on onboarding, still on the button that was pressed, with the failure explained beside it.
    expect(confirm).toBeInTheDocument();
    expect(confirm).toHaveFocus();
    expect(screen.queryByRole('heading', { name: 'Alles im Blick' })).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/konnte nicht gespeichert werden/);
  });
});

/**
 * The retry control has to retry the read that actually failed.
 *
 * The dashboard shows one retry for every error it can render, but "the schedule failed" is three different
 * situations underneath. Wiring all of them to the schedule's own refresh meant that when `listProviders` had
 * failed, pressing retry re-ran the schedule against the same unchanged failed verification, landed on the same
 * failure, and never asked the catalogue anything — a control that looked like it worked and changed nothing.
 */
describe('retrying after a failed read', () => {
  const retryButton = () => screen.getByRole('button', { name: 'Erneut versuchen' });

  /**
   * Answers each endpoint from a queue, so the first attempt can fail and the next succeed.
   *
   * Counts by kind, because "it recovered" is compatible with a retry that asked the wrong endpoint and got
   * lucky, and with one that asked nothing at all.
   */
  const stubFailingWorker = ({ providersFail = 0, areasFail = 0 } = {}) => {
    const kinds: GatewayRequest['kind'][] = [];
    let providersFailures = providersFail;
    let areasFailures = areasFail;

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const request = GatewayRequestSchema.parse(message);

      kinds.push(request.kind);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      const unreachable = {
        ok: false,
        failure: { kind: 'network', operation: 'listProviders' },
      };

      switch (request.kind) {
        case 'list_providers':
          if (providersFailures > 0) {
            providersFailures -= 1;

            return unreachable;
          }

          return { ok: true, data: CATALOGUE_WITH_DEMO };
        case 'list_service_areas':
          if (areasFailures > 0) {
            areasFailures -= 1;

            return unreachable;
          }

          return { ok: true, data: MIXED_AREAS };
        case 'list_collection_events':
          return {
            ok: true,
            data: { kind: 'live', schedule: schedule({ events: [curbsideEvent('2026-03-10')] }) },
          };
        default:
          return { ok: true, data: null };
      }
    });

    return {
      kinds,
      countOf: (kind: GatewayRequest['kind']) => kinds.filter((entry) => entry === kind).length,
    };
  };

  it('reads the catalogue again when the catalogue is what failed', async () => {
    await writeSettings(STORED);

    const { countOf } = stubFailingWorker({ providersFail: 1 });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Termine nicht verfügbar')).toBeInTheDocument();
    });

    expect(countOf('list_providers')).toBe(1);

    await userEvent.setup().click(retryButton());

    // The catalogue read is what happens — not a schedule refresh against the same failed verification.
    await waitFor(() => {
      expect(countOf('list_providers')).toBe(2);
    });
  });

  it('recovers the schedule after the catalogue retry succeeds', async () => {
    await writeSettings(STORED);

    stubFailingWorker({ providersFail: 1 });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Termine nicht verfügbar')).toBeInTheDocument();
    });

    await userEvent.setup().click(retryButton());

    // The gate opens, so the areas and the events follow and the schedule finally renders.
    await waitFor(() => {
      expect(screen.getByText('Koblenz · Stadtmitte')).toBeInTheDocument();
    });
  });

  it('asks for exactly one more catalogue read per press', async () => {
    await writeSettings(STORED);

    const { countOf } = stubFailingWorker({ providersFail: 5 });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Termine nicht verfügbar')).toBeInTheDocument();
    });

    const user = userEvent.setup();

    await user.click(retryButton());
    await waitFor(() => {
      expect(countOf('list_providers')).toBe(2);
    });

    // Still failing, and still retryable.
    await user.click(retryButton());
    await waitFor(() => {
      expect(countOf('list_providers')).toBe(3);
    });
  });

  it('reads that provider’s areas again when the areas are what failed', async () => {
    await writeSettings(STORED);

    const { countOf } = stubFailingWorker({ areasFail: 2 });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Termine nicht verfügbar')).toBeInTheDocument();
    });

    const beforeCatalogue = countOf('list_providers');
    const beforeAreas = countOf('list_service_areas');

    await userEvent.setup().click(retryButton());

    await waitFor(() => {
      expect(screen.getByText('Koblenz · Stadtmitte')).toBeInTheDocument();
    });

    // The catalogue was read successfully already, so it is not read again.
    expect(countOf('list_providers')).toBe(beforeCatalogue);
    // Both readers of the service areas retried: the catalogue hook's list and the schedule's capability read.
    expect(countOf('list_service_areas')).toBe(beforeAreas + SETTLED_AREA_REQUESTS);
  });

  it('does not read the catalogue again when only the events request failed', async () => {
    await writeSettings(STORED);

    const kinds: GatewayRequest['kind'][] = [];
    let eventsFailures = 1;

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const request = GatewayRequestSchema.parse(message);

      kinds.push(request.kind);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      if (request.kind === 'list_providers') {
        return { ok: true, data: CATALOGUE_WITH_DEMO };
      }

      if (request.kind === 'list_service_areas') {
        return { ok: true, data: MIXED_AREAS };
      }

      if (request.kind === 'list_collection_events') {
        if (eventsFailures > 0) {
          eventsFailures -= 1;

          return { ok: false, failure: { kind: 'network', operation: 'listCollectionEvents' } };
        }

        return {
          ok: true,
          data: { kind: 'live', schedule: schedule({ events: [curbsideEvent('2026-03-10')] }) },
        };
      }

      return { ok: true, data: null };
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Termine nicht verfügbar')).toBeInTheDocument();
    });

    const countOf = (kind: GatewayRequest['kind']) =>
      kinds.filter((entry) => entry === kind).length;
    const beforeCatalogue = countOf('list_providers');

    await userEvent.setup().click(retryButton());

    await waitFor(() => {
      expect(screen.getByText('Koblenz · Stadtmitte')).toBeInTheDocument();
    });

    // Nothing upstream was broken, so the schedule's own refresh is the right retry and the catalogue is left
    // alone.
    expect(countOf('list_providers')).toBe(beforeCatalogue);
    expect(countOf('list_collection_events')).toBe(2);
  });
});

/**
 * Discarding a withdrawn selection is a write, and a write can fail.
 *
 * It used to be fire-and-forget: the schedule stopped being presented the moment the capability response said
 * the area was withdrawn, and the clear was started without being awaited. A rejected storage write then
 * vanished as an unhandled rejection while the popup sat on a loading state with nothing coming — the schedule
 * gone, onboarding never reached, and no way forward.
 */
describe('discarding a withdrawn selection', () => {
  const WITHDRAWN = 'Sammelgebiet nicht mehr verfügbar';

  /**
   * A worker whose capability response reports the selected area unavailable.
   *
   * That is the authoritative signal: a successful response saying this provider publishes no calendar here.
   */
  const stubWithdrawnArea = () => {
    const kinds: GatewayRequest['kind'][] = [];

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const request = GatewayRequestSchema.parse(message);

      kinds.push(request.kind);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      switch (request.kind) {
        case 'list_providers':
          return { ok: true, data: CATALOGUE_WITH_DEMO };
        case 'list_service_areas':
          return {
            ok: true,
            data: [{ ...AVAILABLE_AREA, collectionEvents: { availability: 'unavailable' } }],
          };
        default:
          return { ok: true, data: null };
      }
    });

    return {
      kinds,
      countOf: (kind: GatewayRequest['kind']) => kinds.filter((entry) => entry === kind).length,
    };
  };

  it('reaches onboarding once the selection is cleared', async () => {
    await writeSettings(STORED);
    stubWithdrawnArea();

    render(<App />);

    // Both steps succeeded: the entry was discarded, then the selection was compare-and-cleared.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sammelgebiet wählen' })).toBeInTheDocument();
    });

    expect((await readSettings()).selection).toBeNull();
  });

  it('never presents the withdrawn schedule', async () => {
    await writeSettings(STORED);

    const { countOf } = stubWithdrawnArea();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sammelgebiet wählen' })).toBeInTheDocument();
    });

    // The dashboard was never rendered — its heading is what tells it apart from onboarding, which lists an
    // area row carrying the same locality and name.
    expect(screen.queryByRole('heading', { name: 'Alles im Blick' })).not.toBeInTheDocument();
    // And no schedule was ever fetched for the withdrawn area, so there was nothing that could have been shown.
    expect(countOf('list_collection_events')).toBe(0);
  });

  it('keeps the selection and exposes a retry when the cache invalidation is refused', async () => {
    /**
     * The ordering's failure rule. The entry is still on disk, so clearing the selection now would leave a stored
     * schedule for an area with no selection left to re-validate it against and nothing to rediscover the problem.
     * The selection is kept, the schedule stays hidden, and the retry starts again from the invalidation.
     */
    await writeSettings(STORED);

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const request = GatewayRequestSchema.parse(message);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      switch (request.kind) {
        case 'list_providers':
          return { ok: true, data: CATALOGUE_WITH_DEMO };
        case 'list_service_areas':
          return {
            ok: true,
            data: [{ ...AVAILABLE_AREA, collectionEvents: { availability: 'unavailable' } }],
          };
        case 'invalidate_cached_schedule':
          // The barrier refuses. The area still publishes nothing, so the withdrawal must continue.
          return { ok: false, failure: { kind: 'network', operation: 'listCollectionEvents' } };
        default:
          return { ok: true, data: null };
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN)).toBeInTheDocument();
    });

    // Not the loading state, not the schedule, and not onboarding.
    expect(screen.queryByText('Termine werden geladen')).not.toBeInTheDocument();
    expect(screen.queryByText('Koblenz · Stadtmitte')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sammelgebiet wählen' })).not.toBeInTheDocument();
    // The copy says the discard could not be *confirmed*, which is what is actually known, and why the choice
    // is still there.
    expect(screen.getByRole('alert')).toHaveTextContent(/konnte nicht bestätigt werden/);
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeEnabled();
    expect((await readSettings()).selection).toEqual(STORED.selection);
  });

  it('keeps the selection when the cache invalidation message rejects outright', async () => {
    // The same, for a barrier whose message never gets an answer at all rather than an answering failure.
    await writeSettings(STORED);

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const request = GatewayRequestSchema.parse(message);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      switch (request.kind) {
        case 'list_providers':
          return { ok: true, data: CATALOGUE_WITH_DEMO };
        case 'list_service_areas':
          return {
            ok: true,
            data: [{ ...AVAILABLE_AREA, collectionEvents: { availability: 'unavailable' } }],
          };
        case 'invalidate_cached_schedule':
          throw new Error('no receiving end');
        default:
          return { ok: true, data: null };
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeEnabled();
    expect((await readSettings()).selection).toEqual(STORED.selection);
  });

  it('never restores a cache entry once the selection has been cleared', async () => {
    /**
     * What makes best-effort eviction safe on this surface. If storage refused the removal the entry is still on
     * disk, but the selection was cleared — and the popup restores a cache only for a selection it holds, so
     * nothing asks for that area again.
     */
    await writeSettings(STORED);

    const restoredFor: string[] = [];

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const request = GatewayRequestSchema.parse(message);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      switch (request.kind) {
        case 'list_providers':
          return { ok: true, data: CATALOGUE_WITH_DEMO };
        case 'list_service_areas':
          return {
            ok: true,
            data: [{ ...AVAILABLE_AREA, collectionEvents: { availability: 'unavailable' } }],
          };
        case 'restore_cached_schedule':
          restoredFor.push(request.serviceAreaId);

          // Answers as though the refused eviction left the entry in place.
          return { ok: true, data: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }) };
        default:
          return { ok: true, data: null };
      }
    });

    render(<App />);

    // The withdrawal completed: the selection is gone and onboarding replaced the schedule.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sammelgebiet wählen' })).toBeInTheDocument();
    });

    expect((await readSettings()).selection).toBeNull();

    const beforeSettling = restoredFor.length;

    await act(async () => {});
    await act(async () => {});

    // No further restore was asked for, and the dashboard — the only surface that renders a schedule — is absent.
    // Its heading is what tells it apart from onboarding, which lists an area row carrying the same locality.
    expect(restoredFor.length).toBe(beforeSettling);
    expect(screen.queryByRole('heading', { name: 'Alles im Blick' })).not.toBeInTheDocument();
    expect(screen.queryByText('Altpapier')).not.toBeInTheDocument();
  });

  it('shows a recoverable error when the storage write is refused', async () => {
    await writeSettings(STORED);
    stubWithdrawnArea();
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN)).toBeInTheDocument();
    });

    // Not the loading state, not the schedule, and not onboarding — the stored choice is still on disk.
    expect(screen.queryByText('Termine werden geladen')).not.toBeInTheDocument();
    expect(screen.queryByText('Koblenz · Stadtmitte')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auswahl zurücksetzen' })).toBeEnabled();
    // The cache really was discarded; only the selection survived, and the copy says which step failed.
    expect(screen.getByRole('alert')).toHaveTextContent(/Kalender wurde verworfen/);
    expect(screen.getByRole('alert')).toHaveTextContent(/nicht zurückgesetzt werden/);
  });

  it('reveals nothing about the storage error', async () => {
    await writeSettings(STORED);
    stubWithdrawnArea();
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(
      new Error('storage unavailable at /internal/path'),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN)).toBeInTheDocument();
    });

    expect(document.body.textContent).not.toContain('/internal/path');
  });

  it('completes the reset when the retry succeeds', async () => {
    await writeSettings(STORED);
    stubWithdrawnArea();

    const failing = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValue(new Error('storage unavailable'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN)).toBeInTheDocument();
    });

    failing.mockRestore();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Auswahl zurücksetzen' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sammelgebiet wählen' })).toBeInTheDocument();
    });

    expect((await readSettings()).selection).toBeNull();
  });

  it('issues no further request for the rejected selection while the error is shown', async () => {
    await writeSettings(STORED);

    const { countOf } = stubWithdrawnArea();

    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN)).toBeInTheDocument();
    });

    const settled = countOf('list_service_areas');

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    // The selection is already known to be unusable, so nothing keeps asking about it.
    expect(countOf('list_service_areas')).toBe(settled);
    expect(countOf('list_collection_events')).toBe(0);
  });

  it('does not produce an unhandled rejection when the write is refused', async () => {
    await writeSettings(STORED);
    stubWithdrawnArea();
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    const unhandled: unknown[] = [];
    const record = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
    };

    window.addEventListener('unhandledrejection', record);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN)).toBeInTheDocument();
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    window.removeEventListener('unhandledrejection', record);

    expect(unhandled).toEqual([]);
  });

  it('keeps a selection chosen while the clear was running', async () => {
    // The compare-and-clear finds a selection that is no longer the one it was told about, so the newer choice
    // stands and is re-evaluated on its own merits rather than being erased.
    const other = { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: 'koblenz-oberwerth' } as const;

    await writeSettings(STORED);
    stubWithdrawnArea();

    render(<App />);

    // The new choice lands before the clear runs, which is the race the comparison exists for.
    await writeSettings({ ...defaultSettings, selection: other, visibleWasteTypes: ['paper'] });

    await waitFor(() => {
      expect(screen.queryByText('Termine werden geladen')).not.toBeInTheDocument();
    });

    expect((await readSettings()).selection).toEqual(other);
  });
});

/**
 * Every screen change replaces the whole surface, so focus has to be placed deliberately each time.
 *
 * Opening Settings removes the dashboard, and leaving it removes Settings — either way the element a person was
 * focused on is gone and focus falls back to `<body>`. For a keyboard or screen-reader user that means the next
 * Tab restarts from the top of the document and nothing announces that the screen changed.
 *
 * Driven with the keyboard throughout, because that is the interaction this is about.
 */
describe('focus across the Settings transition', () => {
  const settingsTrigger = () => screen.getByRole('button', { name: 'Einstellungen öffnen' });

  const settingsHeading = () => screen.getByRole('heading', { name: 'Einstellungen' });

  /** Reaches the dashboard with a stored selection and a rendered schedule. */
  const openDashboard = async () => {
    await writeSettings(STORED);

    const worker = stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Aktuell abgerufen am/)).toBeInTheDocument();
    });

    return worker;
  };

  /** Tabs to the Settings trigger and activates it, as a keyboard user would. */
  const openSettingsWithKeyboard = async (
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> => {
    const trigger = settingsTrigger();

    for (let step = 0; step < 12 && document.activeElement !== trigger; step += 1) {
      await user.tab();
    }

    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
  };

  it('moves focus into Settings when it opens', async () => {
    const user = userEvent.setup();

    await openDashboard();
    await openSettingsWithKeyboard(user);

    await waitFor(() => {
      expect(settingsHeading()).toHaveFocus();
    });

    // Programmatically focusable, never a stop in the tab order.
    expect(settingsHeading()).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).not.toBe(document.body);
  });

  it('restores focus to the Settings trigger on Back', async () => {
    const user = userEvent.setup();

    await openDashboard();
    await openSettingsWithKeyboard(user);

    await waitFor(() => {
      expect(settingsHeading()).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: 'Zurück' }));

    await waitFor(() => {
      expect(settingsTrigger()).toHaveFocus();
    });
  });

  it('restores focus to the Settings trigger when Back is pressed by keyboard', async () => {
    const user = userEvent.setup();

    await openDashboard();
    await openSettingsWithKeyboard(user);

    await waitFor(() => {
      expect(settingsHeading()).toHaveFocus();
    });

    // Back sits before the heading in the header, so it is reached by tabbing backwards from it.
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Zurück' })).toHaveFocus();

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(settingsTrigger()).toHaveFocus();
    });
  });

  it('restores focus to the Settings trigger after a successful save', async () => {
    const user = userEvent.setup();

    await openDashboard();
    await openSettingsWithKeyboard(user);

    await waitFor(() => {
      expect(settingsHeading()).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: 'Einstellungen speichern' }));

    await waitFor(() => {
      expect(settingsTrigger()).toHaveFocus();
    });
  });

  it('stays in Settings with meaningful focus when the save fails', async () => {
    const user = userEvent.setup();

    await openDashboard();
    await openSettingsWithKeyboard(user);

    await waitFor(() => {
      expect(settingsHeading()).toHaveFocus();
    });

    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    const save = screen.getByRole('button', { name: 'Einstellungen speichern' });

    await user.click(save);

    // Still on Settings, with the error beside the control that was pressed — and focus still on it.
    expect(await screen.findByRole('alert')).toHaveTextContent(/konnten nicht gespeichert werden/);
    expect(settingsHeading()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Einstellungen speichern' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Einstellungen öffnen' })).not.toBeInTheDocument();
  });

  it('does not steal focus while Settings rerenders', async () => {
    const user = userEvent.setup();

    await openDashboard();
    await openSettingsWithKeyboard(user);

    await waitFor(() => {
      expect(settingsHeading()).toHaveFocus();
    });

    // The person moves to a control of their own choosing, then edits — which rerenders Settings repeatedly.
    const reminderToggle = screen.getByRole('checkbox', { name: 'Erinnerungen aktivieren' });

    reminderToggle.focus();
    await user.click(screen.getByRole('button', { name: 'Biotonne' }));
    await user.click(screen.getByRole('button', { name: 'Altpapier' }));

    // Focus follows the pointer for the buttons that were clicked, never snapping back to the heading.
    expect(settingsHeading()).not.toHaveFocus();
  });

  it('does not steal focus when the schedule updates on the dashboard', async () => {
    await openDashboard();

    const trigger = settingsTrigger();

    trigger.focus();
    expect(trigger).toHaveFocus();

    // Several turns of schedule and cache activity later, focus is still where the person left it.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(trigger).toHaveFocus();
  });

  it('does not move focus on the initial dashboard render', async () => {
    // No transition happened, so nothing is focused on this person's behalf.
    await openDashboard();

    expect(document.activeElement).toBe(document.body);
  });
});

/**
 * A temporary surface must not unmount the focused element and leave focus nowhere.
 *
 * Discarding a withdrawn selection replaces the dashboard with onboarding, and the recoverable error screen
 * replaces both — so whatever a person was focused on, including the retry control they just pressed, is removed
 * from the document. Without a target, focus falls back to `<body>` and the next Tab restarts from the top.
 */
describe('focus after a withdrawn selection is discarded', () => {
  const stubWithdrawn = () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const request = GatewayRequestSchema.parse(message);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      if (request.kind === 'list_providers') {
        return { ok: true, data: CATALOGUE_WITH_DEMO };
      }

      if (request.kind === 'list_service_areas') {
        return {
          ok: true,
          data: [{ ...AVAILABLE_AREA, collectionEvents: { availability: 'unavailable' } }],
        };
      }

      return { ok: true, data: null };
    });
  };

  it('moves focus to the onboarding heading', async () => {
    await writeSettings(STORED);
    stubWithdrawn();

    render(<App />);

    const heading = await screen.findByRole('heading', { name: 'Sammelgebiet wählen' });

    await waitFor(() => {
      expect(heading).toHaveFocus();
    });

    expect(document.activeElement).not.toBe(document.body);
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus to onboarding after the retry succeeds, not to the button it unmounted', async () => {
    await writeSettings(STORED);
    stubWithdrawn();

    const failing = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValue(new Error('storage unavailable'));

    render(<App />);

    const retry = await screen.findByRole('button', { name: 'Auswahl zurücksetzen' });

    failing.mockRestore();
    retry.focus();

    await userEvent.setup().click(retry);

    const heading = await screen.findByRole('heading', { name: 'Sammelgebiet wählen' });

    await waitFor(() => {
      expect(heading).toHaveFocus();
    });

    // The control that was focused is gone, and focus did not fall through to the document.
    expect(screen.queryByRole('button', { name: 'Auswahl zurücksetzen' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('does not move focus when a newer selection supersedes the invalidation', async () => {
    // No transition of this person's happened: their newer choice stands and is re-evaluated on its own merits.
    const other = { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: 'koblenz-oberwerth' } as const;

    await writeSettings(STORED);
    stubWithdrawn();

    render(<App />);

    await writeSettings({ ...defaultSettings, selection: other, visibleWasteTypes: ['paper'] });

    await waitFor(() => {
      expect(
        screen.queryByText('Das gespeicherte Sammelgebiet wird zurückgesetzt…'),
      ).not.toBeInTheDocument();
    });

    expect((await readSettings()).selection).toEqual(other);
  });
});

/**
 * Settings written by a newer build are intact and unreadable, which is neither an error nor a fresh install.
 *
 * Presenting defaults would show a fresh installation to someone whose real settings are right there on disk, and
 * every edit offered would be refused. The surface says so instead, and offers no button that could destroy data
 * this build cannot even read.
 */
describe('the popup with stored settings from a newer version', () => {
  const NEWER = {
    version: 99,
    selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
    remindersEnabled: true,
    reminderDaysBefore: 1,
    reminderTime: '18:00',
    visibleWasteTypes: ['paper'],
    somethingNewer: { nested: true },
  } as const;

  const seedNewer = async (): Promise<void> => {
    await fakeBrowser.storage.local.set({ settings: NEWER });
  };

  it('explains that the settings came from a newer version', async () => {
    await seedNewer();
    stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Neuere Einstellungen gefunden')).toBeInTheDocument();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/von einer neueren Version/);
    // The reassurance that matters: nothing of theirs was thrown away.
    expect(screen.getByRole('alert')).toHaveTextContent(/bleiben unverändert erhalten/);
  });

  it('offers a non-destructive recovery path and no reset', async () => {
    await seedNewer();
    stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Neuere Einstellungen gefunden')).toBeInTheDocument();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/aktualisiere die Erweiterung oder lade/);
    // No control that could downgrade or discard settings this build cannot read.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows neither the application nor onboarding over settings it cannot read', async () => {
    await seedNewer();
    stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Neuere Einstellungen gefunden')).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: 'Alles im Blick' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sammelgebiet wählen' })).not.toBeInTheDocument();
    expect(screen.queryByText('AbfallRadar wird vorbereitet…')).not.toBeInTheDocument();
  });

  it('issues no schedule request from invented defaults', async () => {
    await seedNewer();

    const { kinds } = stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Neuere Einstellungen gefunden')).toBeInTheDocument();
    });

    // The catalogue read is the popup's own, unconditional. Nothing provider-specific follows from defaults.
    expect(kinds).not.toContain('list_service_areas');
    expect(kinds).not.toContain('list_collection_events');
    expect(kinds).not.toContain('restore_cached_schedule');
  });

  it('leaves the stored value exactly as the newer build left it', async () => {
    await seedNewer();
    stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Neuere Einstellungen gefunden')).toBeInTheDocument();
    });

    expect((await fakeBrowser.storage.local.get('settings')).settings).toEqual(NEWER);
  });
});

/**
 * A confirmation is made on the chosen area's **own** calendar.
 *
 * The worker compares the evidence identity against the candidate and writes nothing on a mismatch, so a surface
 * that sent a bare availability flag — or one lifted from a different area — would be refused. This asserts the
 * surface sends the right thing rather than relying on the refusal.
 *
 * The stub validates every message with the worker's own schema, so evidence missing its identity fails here too.
 */
describe('the evidence the onboarding surface sends', () => {
  it('names the area that was confirmed, with that area’s own capability', async () => {
    const user = userEvent.setup();
    const worker = stubWorker();

    render(<App />);

    const select = await screen.findByRole('combobox', { name: /Entsorgungsbetrieb/ });

    await user.selectOptions(select, OFFICIAL_PROVIDER_ID);
    await user.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await user.click(screen.getByRole('button', { name: 'Auswahl bestätigen' }));

    await waitFor(() => {
      expect(worker.sent('select_service_area')).toBeDefined();
    });

    expect(worker.sent('select_service_area')).toEqual({
      kind: 'select_service_area',
      selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      evidence: evidenceForArea(AVAILABLE_AREA),
    });
  });

  it('persists the confirmation, so the identity it sent was accepted', async () => {
    const user = userEvent.setup();

    stubWorker();
    render(<App />);

    const select = await screen.findByRole('combobox', { name: /Entsorgungsbetrieb/ });

    await user.selectOptions(select, OFFICIAL_PROVIDER_ID);
    await user.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await user.click(screen.getByRole('button', { name: 'Auswahl bestätigen' }));

    await waitFor(async () => {
      expect((await readSettings()).selection).toEqual({
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
      });
    });
  });
});

/**
 * A background alarm can withdraw the selected area while the popup is open.
 *
 * Nothing in the popup caused it and nothing in the popup was watching for it, so the dashboard went on presenting
 * a calendar the operator no longer publishes — as current official data — until the person happened to close and
 * reopen the window. The worker announces the change and the popup re-reads through the ordinary boundary.
 */
describe('an alarm clearing the selection while the popup is open', () => {
  /** The area the fixture stores, named so the compare-and-clear can be given exactly it. */
  const SELECTED = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  it('replaces the withdrawn dashboard with onboarding', async () => {
    await writeSettings(STORED);
    stubWorker();

    render(<App />);

    // The dashboard is up, for the area that is about to be withdrawn.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Alles im Blick' })).toBeInTheDocument();
    });

    /**
     * The worker's own compare-and-clear, exactly as the reminder performs it when a successful catalogue says the
     * area is gone. It announces for itself — nothing here sends a message.
     */
    await act(async () => {
      await invalidateSelectionIfMatches(SELECTED);
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sammelgebiet wählen' })).toBeInTheDocument();
    });

    // The withdrawn surface is gone, not merely covered.
    expect(screen.queryByRole('heading', { name: 'Alles im Blick' })).not.toBeInTheDocument();
    expect(await readSettings()).toMatchObject({ selection: null });
  });

  it('leaves no schedule a reminder could still use', async () => {
    // The other half of the same conclusion: the popup's view and the stored selection agree that there is
    // nothing selected, so neither surface has anything to present or to notify from.
    await writeSettings(STORED);

    const worker = stubWorker();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Alles im Blick' })).toBeInTheDocument();
    });

    const before = worker.countOf('list_collection_events');

    await act(async () => {
      await invalidateSelectionIfMatches(SELECTED);
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sammelgebiet wählen' })).toBeInTheDocument();
    });

    // No new schedule was requested for the withdrawn area, and none is rendered.
    expect(worker.countOf('list_collection_events')).toBe(before);
    expect(screen.queryByText('Altpapier')).not.toBeInTheDocument();
  });
});

/**
 * Settings must not survive the selection being cleared underneath it.
 *
 * The worker owns the selection and can clear it with nobody watching — a reminder discovering the area was
 * withdrawn, an unavailable capability, a provider or an area gone from a successful catalogue. Settings used to
 * win that race and stay open, editing an area that no longer existed with a provider list it could not resolve,
 * until the person pressed Back.
 */
describe('the selection being cleared while Settings is open', () => {
  const SELECTED = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  const settingsHeading = () => screen.queryByRole('heading', { name: 'Einstellungen' });

  const onboardingHeading = () => screen.queryByRole('heading', { name: 'Sammelgebiet wählen' });

  /** Reaches Settings from a stored selection, by pressing the trigger as a person would. */
  const openSettings = async (worker: ReturnType<typeof stubWorker>) => {
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Einstellungen öffnen' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Einstellungen öffnen' }));

    await waitFor(() => {
      expect(settingsHeading()).toBeInTheDocument();
    });

    return worker;
  };

  it('replaces Settings with onboarding when the worker clears the selection', async () => {
    await writeSettings(STORED);

    const worker = stubWorker();

    render(<App />);
    await openSettings(worker);

    // The worker's own compare-and-clear, which announces for itself.
    await act(async () => {
      await invalidateSelectionIfMatches(SELECTED);
    });

    await waitFor(() => {
      expect(onboardingHeading()).toBeInTheDocument();
    });

    // Gone in the same resulting state, not merely covered by it.
    expect(settingsHeading()).not.toBeInTheDocument();
  });

  it('moves focus to the onboarding heading', async () => {
    // The surface the person was interacting with has been replaced by something they did not ask for, so focus
    // has to be placed rather than left on `<body>` with nothing saying why.
    await writeSettings(STORED);

    const worker = stubWorker();

    render(<App />);
    await openSettings(worker);

    await act(async () => {
      await invalidateSelectionIfMatches(SELECTED);
    });

    await waitFor(() => {
      expect(onboardingHeading()).toHaveFocus();
    });
  });

  it('does not leave the popup logically stuck on Settings', async () => {
    /**
     * The local screen value has to be normalized, not just out-voted by the branch order. Left on `settings`,
     * confirming an area on onboarding would land straight back in Settings — because the popup still believed
     * that was where it was.
     */
    await writeSettings(STORED);

    const worker = stubWorker();

    render(<App />);
    await openSettings(worker);

    await act(async () => {
      await invalidateSelectionIfMatches(SELECTED);
    });

    await waitFor(() => {
      expect(onboardingHeading()).toBeInTheDocument();
    });

    const user = userEvent.setup();

    await user.selectOptions(
      await screen.findByRole('combobox', { name: /Entsorgungsbetrieb/ }),
      OFFICIAL_PROVIDER_ID,
    );
    await user.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await user.click(screen.getByRole('button', { name: 'Auswahl bestätigen' }));

    // The dashboard, not Settings.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Alles im Blick' })).toBeInTheDocument();
    });

    expect(settingsHeading()).not.toBeInTheDocument();
  });

  it('behaves the same when a successful capability response says the area is unavailable', async () => {
    /**
     * The authoritative-withdrawal route rather than the announcement route: the popup's own schedule attempt
     * discovers the area publishes nothing. Same conclusion, and it has to reach the same result.
     *
     * Settings cannot be opened first here — the withdrawal lands during hydration — so this asserts the end
     * state the withdrawal produces.
     */
    await writeSettings(STORED);

    const requestKinds: GatewayRequest['kind'][] = [];
    const deliver = fakeBrowser.runtime.sendMessage.bind(fakeBrowser.runtime);

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      if (SettingsChangedNotificationSchema.safeParse(message).success) {
        try {
          return await deliver(message);
        } catch {
          return undefined;
        }
      }

      const request = GatewayRequestSchema.parse(message);

      requestKinds.push(request.kind);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      switch (request.kind) {
        case 'list_providers':
          return { ok: true, data: CATALOGUE_WITH_DEMO };
        case 'list_service_areas':
          return {
            ok: true,
            data: [{ ...AVAILABLE_AREA, collectionEvents: { availability: 'unavailable' } }],
          };
        default:
          return { ok: true, data: null };
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(onboardingHeading()).toBeInTheDocument();
    });

    expect(settingsHeading()).not.toBeInTheDocument();
    expect((await readSettings()).selection).toBeNull();
    expect(requestKinds).not.toContain('list_collection_events');
  });

  it('behaves the same when a background reminder clears the selection', async () => {
    /**
     * Driven through `showReminder` rather than by calling the mutation directly, so this covers the path an alarm
     * actually takes: a successful catalogue that no longer offers the provider is authoritative, the reminder
     * withdraws the selection, and the announcement reaches the open popup.
     */
    await writeSettings(STORED);

    const worker = stubWorker();

    render(<App />);
    await openSettings(worker);

    // A catalogue that does not offer the stored provider. Everything else is unreachable on this path.
    const gateway = {
      handle: vi.fn(),
      listProviders: async () => ({ ok: true, data: [] }),
      listServiceAreas: vi.fn(),
      listCollectionEvents: vi.fn(),
      restoreCachedSchedule: async () => null,
      invalidateCachedSchedule: async () => undefined,
    } as unknown as Parameters<typeof showReminder>[0]['gateway'];

    await act(async () => {
      await showReminder({ gateway, now: () => new Date('2026-03-09T18:00:00.000Z') });
    });

    await waitFor(() => {
      expect(onboardingHeading()).toBeInTheDocument();
    });

    expect(settingsHeading()).not.toBeInTheDocument();
    expect((await readSettings()).selection).toBeNull();
  });

  it('cannot have the cleared selection restored by a late save', async () => {
    /**
     * The Settings view is gone, but a save it issued can still be in flight. The expected-selection guard is what
     * refuses it: the draft was built on a selection that is no longer stored, so the worker reports a conflict and
     * writes nothing.
     */
    await writeSettings(STORED);

    const worker = stubWorker();

    render(<App />);
    await openSettings(worker);

    // Cleared while Settings is open.
    await act(async () => {
      await invalidateSelectionIfMatches(SELECTED);
    });

    await waitFor(() => {
      expect(onboardingHeading()).toBeInTheDocument();
    });

    // A save carrying the stale premise, exactly as the unmounted view would have sent it.
    const outcome = await persistSettings({
      expectedSelection: SELECTED,
      settings: { ...STORED, reminderTime: '20:00' },
      evidence: evidenceForArea(AVAILABLE_AREA),
    });

    expect(outcome.outcome).toBe('conflict');
    // Neither the selection nor the preference was written.
    expect(await readSettings()).toMatchObject({
      selection: null,
      reminderTime: STORED.reminderTime,
    });
    expect(onboardingHeading()).toBeInTheDocument();
  });
});

/**
 * A stalled withdrawal must not outlive the selection it was about.
 *
 * Its screen takes precedence over every selection-based one, so a failed withdrawal of the stored area held the
 * popup on an error about that area after another window selected a different one — indefinitely, and the only way
 * out was retrying an operation for an area nobody was looking at any more.
 */
describe('a stalled withdrawal after the selection moves on', () => {
  const WITHDRAWN_COPY = 'Sammelgebiet nicht mehr verfügbar';

  /** The area the fixture stores, and the different one another popup chooses. */
  const SELECTED_AREA = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  const OTHER_SELECTION = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: UNAVAILABLE_AREA_ID,
  } as const;

  /** A worker whose area list withdraws the stored area and whose cache invalidation is refused. */
  const stubStalledWithdrawal = () => {
    const deliver = fakeBrowser.runtime.sendMessage.bind(fakeBrowser.runtime);

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      if (SettingsChangedNotificationSchema.safeParse(message).success) {
        try {
          return await deliver(message);
        } catch {
          return undefined;
        }
      }

      const request = GatewayRequestSchema.parse(message);

      if (isSettingsRequest(request)) {
        return answerSettings(request);
      }

      switch (request.kind) {
        case 'list_providers':
          return { ok: true, data: CATALOGUE_WITH_DEMO };
        case 'list_service_areas':
          /**
           * The stored area is withdrawn; the other one is genuinely available.
           *
           * Both matter. Withdrawing every area would start a *new* withdrawal the moment a different one was
           * selected, and the error screen would reappear legitimately — so the test would prove nothing about the
           * stale one having been superseded.
           */
          return {
            ok: true,
            data: [
              { ...AVAILABLE_AREA, collectionEvents: { availability: 'unavailable' } },
              { ...AVAILABLE_AREA, id: UNAVAILABLE_AREA_ID },
            ],
          };
        case 'invalidate_cached_schedule':
          // Never acknowledged, so the withdrawal stalls before the selection is cleared.
          return { ok: false, failure: { kind: 'cache_storage' } };
        default:
          return { ok: true, data: null };
      }
    });
  };

  it('stops showing the error once another area becomes the selection', async () => {
    await writeSettings(STORED);
    stubStalledWithdrawal();

    render(<App />);

    // Stalled: the selection is untouched and the error offers a retry.
    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN_COPY)).toBeInTheDocument();
    });

    expect((await readSettings()).selection).toEqual(STORED.selection);

    // Another popup chooses a different area. The worker announces it, and this popup re-reads.
    await act(async () => {
      await persistSelection({
        selection: OTHER_SELECTION,
        evidence: evidenceForArea({ ...AVAILABLE_AREA, id: UNAVAILABLE_AREA_ID }),
      });
    });

    // The error is about an area nobody is looking at any more, so it is gone.
    await waitFor(() => {
      expect(screen.queryByText(WITHDRAWN_COPY)).not.toBeInTheDocument();
    });

    expect((await readSettings()).selection).toEqual(OTHER_SELECTION);
  });

  it('renders the newly selected area rather than staying on the error', async () => {
    // Not merely "the error is gone": ordinary selection-based rendering has to resume.
    await writeSettings(STORED);
    stubStalledWithdrawal();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN_COPY)).toBeInTheDocument();
    });

    await act(async () => {
      await persistSelection({
        selection: OTHER_SELECTION,
        evidence: evidenceForArea({ ...AVAILABLE_AREA, id: UNAVAILABLE_AREA_ID }),
      });
    });

    await waitFor(() => {
      expect(screen.queryByText(WITHDRAWN_COPY)).not.toBeInTheDocument();
    });

    // A real surface, not a blank screen: the dashboard for the area that is now selected.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Alles im Blick' })).toBeInTheDocument();
    });
  });

  it('stops showing the error once the selection is cleared by something else', async () => {
    await writeSettings(STORED);
    stubStalledWithdrawal();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN_COPY)).toBeInTheDocument();
    });

    // Another popup or an alarm got there first.
    await act(async () => {
      await invalidateSelectionIfMatches(SELECTED_AREA);
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sammelgebiet wählen' })).toBeInTheDocument();
    });

    expect(screen.queryByText(WITHDRAWN_COPY)).not.toBeInTheDocument();
  });

  it('keeps showing the error while its own area is still the selection', async () => {
    // The counterweight: the error disappears because the target moved, not because time passed.
    await writeSettings(STORED);
    stubStalledWithdrawal();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(WITHDRAWN_COPY)).toBeInTheDocument();
    });

    await act(async () => {});
    await act(async () => {});

    expect(screen.getByText(WITHDRAWN_COPY)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeEnabled();
  });
});
