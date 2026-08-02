import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { evidenceFor } from '@/src/test/fixtures';
import type { MessagingClient } from '@/src/messaging/client';
import {
  SETTINGS_CHANGED_NOTIFICATION,
  SETTINGS_STORAGE_UNAVAILABLE,
} from '@/src/messaging/contract';
import { type AppSettings, defaultSettings, SETTINGS_SCHEMA_VERSION } from '@/src/storage/settings';
import {
  invalidateSelectionIfMatches,
  persistSelection,
  persistSettings,
  readSettings,
  writeSettings,
} from '@/src/storage/settings-repository';
import { useSettings } from './use-settings';

/**
 * Settings reach the popup through the **worker**, and hydration has to finish.
 *
 * The popup and the Manifest V3 worker are separate module instances, so a mutation queue in a module variable
 * serializes each context against itself and neither against the other. The worker owns the settings item, so
 * every read and write here is a message to it — and this hook's job is to turn those replies into a state a
 * surface can render, including the two that used to leave a spinner running forever: a migration whose write
 * failed, and a stored value that cannot be read at all.
 */

const LEGACY = {
  districtId: 'koblenz-stadtmitte',
  remindersEnabled: false,
  reminderDaysBefore: 2,
  reminderTime: '19:00',
  visibleWasteTypes: ['paper'],
} as const;

const OFFICIAL_SELECTION = {
  providerId: 'koblenz-servicebetrieb',
  serviceAreaId: 'koblenz-stadtmitte',
} as const;

const setStored = async (value: unknown): Promise<void> => {
  await fakeBrowser.storage.local.set({ settings: value });
};

/**
 * A client that answers settings intents the way the worker does: by delegating to the repository.
 *
 * The point of the architecture is that exactly one context owns the queue, so a stub that faked replies would
 * be testing nothing about it. Every API read throws, because this hook must never perform one.
 */
const workerBackedClient = (): MessagingClient => ({
  async listProviders(): Promise<never> {
    throw new Error('useSettings is not expected to read the provider catalogue.');
  },
  async listServiceAreas(): Promise<never> {
    throw new Error('useSettings is not expected to read service areas.');
  },
  async listCollectionEvents(): Promise<never> {
    throw new Error('useSettings is not expected to read collection events.');
  },
  async restoreCachedSchedule(): Promise<never> {
    throw new Error('useSettings is not expected to restore a cached schedule.');
  },
  async invalidateCachedSchedule(): Promise<never> {
    throw new Error('useSettings is not expected to invalidate a cached schedule.');
  },

  async readSettings() {
    try {
      return { ok: true, data: await readSettings() };
    } catch {
      // The settings command's own failure family: kind only, no operation and no status.
      return { ok: false, failure: SETTINGS_STORAGE_UNAVAILABLE };
    }
  },

  async selectServiceArea({ selection, evidence }) {
    try {
      const result = await persistSelection({ selection, evidence });

      return {
        ok: true,
        data:
          result.outcome === 'persisted'
            ? { outcome: 'persisted', settings: result.settings }
            : { outcome: result.outcome, settings: await readSettings() },
      };
    } catch {
      // The settings command's own failure family: kind only, no operation and no status.
      return { ok: false, failure: SETTINGS_STORAGE_UNAVAILABLE };
    }
  },

  async saveSettings(input) {
    try {
      const result = await persistSettings({
        expectedSelection: input.expectedSelection,
        settings: {
          version: SETTINGS_SCHEMA_VERSION,
          selection: input.selection,
          remindersEnabled: input.remindersEnabled,
          reminderDaysBefore: input.reminderDaysBefore,
          reminderTime: input.reminderTime,
          visibleWasteTypes: [...input.visibleWasteTypes],
        },
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      });

      return {
        ok: true,
        data:
          result.outcome === 'persisted'
            ? { outcome: 'persisted', settings: result.settings }
            : { outcome: result.outcome, settings: await readSettings() },
      };
    } catch {
      // The settings command's own failure family: kind only, no operation and no status.
      return { ok: false, failure: SETTINGS_STORAGE_UNAVAILABLE };
    }
  },

  async invalidateSelectionIfMatches(expectedSelection) {
    try {
      const result = await invalidateSelectionIfMatches(expectedSelection);

      return { ok: true, data: { outcome: result.outcome, settings: result.settings } };
    } catch {
      // The settings command's own failure family: kind only, no operation and no status.
      return { ok: false, failure: SETTINGS_STORAGE_UNAVAILABLE };
    }
  },
});

const renderSettings = () => renderHook(() => useSettings({ client: workerBackedClient() }));

/** A complete current-version value, for the announcement tests to start from. */
const STORED = {
  ...defaultSettings,
  visibleWasteTypes: ['paper'],
} satisfies AppSettings;

describe('useSettings on a fresh install', () => {
  it('reaches the ready state with defaults', async () => {
    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.settings).toEqual(defaultSettings);
    expect(result.current.isHydrated).toBe(true);
  });

  it('starts out preparing rather than claiming either outcome', async () => {
    const { result } = renderSettings();

    // The one state that is neither an answer nor a failure, and the only one the spinner belongs to.
    expect(result.current.status).toBe('preparing');
    expect(result.current.isHydrated).toBe(false);

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
  });
});

describe('useSettings after a transient migration-write failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches the ready state with the migrated settings', async () => {
    await setStored(LEGACY);

    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // The regression: this used to stay `preparing` forever, because the failed write rejected the read.
    expect(result.current.isHydrated).toBe(true);
    expect(result.current.settings.selection).toEqual(OFFICIAL_SELECTION);
    expect(result.current.settings.reminderTime).toBe('19:00');
    expect(result.current.settings.version).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('never reports the failure as unreadable, because the settings were read perfectly well', async () => {
    await setStored(LEGACY);

    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.status).not.toBe('unreadable');
  });
});

describe('useSettings when the stored value cannot be read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches an explicit unreadable state rather than preparing forever', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));

    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('unreadable');
    });

    // Terminal and *named*, so the surface can say what happened instead of waiting on an answer that is
    // never coming.
    expect(result.current.status).not.toBe('preparing');
  });

  it('does not present defaults as a successful read', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));

    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('unreadable');
    });

    // `isHydrated` stays false, so no surface renders the application over settings that were never read.
    expect(result.current.isHydrated).toBe(false);
  });

  it('reveals nothing about the storage error', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(
      new Error('storage unavailable at /internal/path'),
    );

    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('unreadable');
    });

    expect(JSON.stringify(result.current.status)).not.toContain('/internal/path');
  });
});

/**
 * Every write is an **intent** sent to the owner, never a settings snapshot.
 *
 * Sending a snapshot would carry a read alongside the write — a value observed before the request was sent — so
 * a concurrent change would be overwritten by fields the sender never meant to touch.
 */
describe('useSettings writes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('confirms a selection and reports what the owner decided', async () => {
    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const outcome = await result.current.saveSelection({
      selection: OFFICIAL_SELECTION,
      evidence: evidenceFor(OFFICIAL_SELECTION),
    });

    expect(outcome.outcome).toBe('persisted');
    expect((await readSettings()).selection).toEqual(OFFICIAL_SELECTION);

    await waitFor(() => {
      expect(result.current.settings.selection).toEqual(OFFICIAL_SELECTION);
    });
  });

  it('refuses an area publishing no calendar, decided by the owner rather than the caller', async () => {
    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const outcome = await result.current.saveSelection({
      selection: { providerId: 'koblenz-servicebetrieb', serviceAreaId: 'koblenz-oberwerth' },
      evidence: evidenceFor(
        { providerId: 'koblenz-servicebetrieb', serviceAreaId: 'koblenz-oberwerth' },
        { availability: 'unavailable' },
      ),
    });

    expect(outcome.outcome).toBe('rejected_unavailable');
    expect((await readSettings()).selection).toBeNull();
  });

  it('saves preferences without carrying a version a caller could assert', async () => {
    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const draft: AppSettings = {
      ...defaultSettings,
      remindersEnabled: false,
      reminderTime: '20:00',
      visibleWasteTypes: ['paper'],
    };

    expect(
      (await result.current.saveSettings({ settings: draft, expectedSelection: null })).outcome,
    ).toBe('persisted');

    const stored = await readSettings();

    expect(stored.reminderTime).toBe('20:00');
    expect(stored.remindersEnabled).toBe(false);
    // The version is the owner's to state, and it is the current one whatever the caller sent.
    expect(stored.version).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('clears a selection that is still the one it saw', async () => {
    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await result.current.saveSelection({
      selection: OFFICIAL_SELECTION,
      evidence: evidenceFor(OFFICIAL_SELECTION),
    });

    const outcome = await result.current.clearSelectionIfUnchanged(OFFICIAL_SELECTION);

    expect(outcome.outcome).toBe('invalidated');
    expect((await readSettings()).selection).toBeNull();
  });

  it('leaves a newer selection alone and reports it as superseded', async () => {
    const other = {
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-oberwerth',
    } as const;
    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await result.current.saveSelection({ selection: other, evidence: evidenceFor(other) });

    const outcome = await result.current.clearSelectionIfUnchanged(OFFICIAL_SELECTION);

    expect(outcome.outcome).toBe('superseded');
    // The newer choice stands, and the hook reports it rather than the value it was asked to clear.
    expect(outcome.settings.selection).toEqual(other);
    expect((await readSettings()).selection).toEqual(other);
  });

  it('raises a safe failure when the write cannot be delivered', async () => {
    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(
      new Error('storage unavailable at /internal/path'),
    );

    // Raised rather than returned, so each surface's existing recoverable error state catches it — and nothing
    // about the storage error travels with it.
    await expect(
      result.current.saveSelection({
        selection: OFFICIAL_SELECTION,
        evidence: evidenceFor(OFFICIAL_SELECTION),
      }),
    ).rejects.toThrow(/could not be completed/);
  });
});

/**
 * Staying in step with a worker that can change the settings on its own.
 *
 * An alarm discovering a withdrawn area compare-and-clears the selection with no popup involved, and an open popup
 * went on presenting the dashboard for an area nothing could serve until someone closed and reopened it. The worker
 * announces the change; the popup re-reads through the ordinary boundary. It gains no storage access from this.
 */
describe('reacting to a worker settings announcement', () => {
  /**
   * Sends the notification and reports whether anything received it.
   *
   * `sendMessage` rejects when no listener exists, which is the ordinary case — most of the time no popup is open.
   * That rejection is exactly what the worker's emitter has to swallow, and here it is the observable that tells a
   * subscribed popup from an unsubscribed one.
   */
  const announce = async (message: unknown = SETTINGS_CHANGED_NOTIFICATION): Promise<boolean> => {
    let delivered = true;

    await act(async () => {
      try {
        await fakeBrowser.runtime.sendMessage(message);
      } catch {
        delivered = false;
      }
    });

    return delivered;
  };

  it('re-reads and reflects a selection the worker cleared', async () => {
    await writeSettings({ ...STORED, selection: OFFICIAL_SELECTION });

    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.settings.selection).toEqual(OFFICIAL_SELECTION);
    });

    /**
     * The worker's own mutation, exactly as an alarm performs it — and nothing here announces anything. The
     * mutation announces for itself, which is the whole point: no caller has to remember to.
     */
    await act(async () => {
      await invalidateSelectionIfMatches(OFFICIAL_SELECTION);
    });

    await waitFor(() => {
      expect(result.current.settings.selection).toBeNull();
    });
  });

  it('ignores a message that is not the notification', async () => {
    /**
     * A pushed message is the least trustworthy input the popup receives — it is not a reply to anything it asked
     * for — so anything that is not exactly the notification is ignored rather than acted on.
     */
    await writeSettings({ ...STORED, selection: OFFICIAL_SELECTION });

    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // Changed through the raw primitive, which announces nothing — so only a message can make the hook notice.
    await writeSettings({ ...STORED, selection: null });

    for (const malformed of [
      { kind: 'settings_changed', extra: true },
      { kind: 'settings-changed' },
      { kind: 'read_settings' },
      'settings_changed',
      null,
      42,
    ]) {
      await announce(malformed);
    }

    // Still the stale value, because none of those was a reason to re-read.
    expect(result.current.settings.selection).toEqual(OFFICIAL_SELECTION);

    // And the real one still works, so the guard is not refusing everything.
    await announce();

    await waitFor(() => {
      expect(result.current.settings.selection).toBeNull();
    });
  });

  it('stops listening once unmounted', async () => {
    /**
     * Asserted by behaviour rather than by inspecting the listener registry: what matters is that an announcement
     * after unmount performs no work and sets no state, not which internal list the callback is on.
     */
    await writeSettings({ ...STORED, selection: OFFICIAL_SELECTION });

    const worker = workerBackedClient();
    let reads = 0;
    const client: MessagingClient = {
      ...worker,
      async readSettings() {
        reads += 1;

        return worker.readSettings();
      },
    };

    const { result, unmount } = renderHook(() => useSettings({ client }));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // Still subscribed: an announcement is delivered and acted on.
    expect(await announce()).toBe(true);
    await waitFor(() => {
      expect(reads).toBe(2);
    });

    unmount();

    // Nothing is listening any more, and no further read happens.
    expect(await announce()).toBe(false);
    await act(async () => {});

    expect(reads).toBe(2);
  });

  it('does not make a worker mutation fail when no popup is listening', async () => {
    /**
     * The common case: the worker changes the settings from an alarm with no popup open at all. The write has
     * already happened and is correct, so a notification nobody received must not turn it into a failure — and
     * must not surface as an unhandled rejection either.
     */
    await writeSettings({ ...STORED, selection: OFFICIAL_SELECTION });

    // Nothing mounted, so nothing is subscribed.
    expect(await announce()).toBe(false);

    const unhandled = vi.fn();

    process.on('unhandledRejection', unhandled);

    const result = await invalidateSelectionIfMatches(OFFICIAL_SELECTION);

    // Several turns, so a swallowed rejection would have had time to surface.
    await act(async () => {});
    await act(async () => {});

    process.off('unhandledRejection', unhandled);

    expect(result.outcome).toBe('invalidated');
    expect((await readSettings()).selection).toBeNull();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('keeps a popup-originated save correct despite the announcement it causes', async () => {
    // The popup's own write already applied the result it was given; the announcement that follows triggers a
    // re-read of the same value. It must converge, not oscillate or double-write.
    const { result } = renderSettings();

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await act(async () => {
      await result.current.saveSelection({
        selection: OFFICIAL_SELECTION,
        evidence: evidenceFor(OFFICIAL_SELECTION),
      });
    });

    await announce();

    await waitFor(() => {
      expect(result.current.settings.selection).toEqual(OFFICIAL_SELECTION);
    });

    expect((await readSettings()).selection).toEqual(OFFICIAL_SELECTION);
  });
});

/**
 * Two reads can be in flight at once, and they can answer in either order.
 *
 * The initial hydration and a notification-triggered read are independent requests. Without newest-read-wins the
 * slow one overwrites the fast one, so a popup told the selection had been cleared shows the selection again a
 * moment later — the exact stale state the announcement existed to remove.
 */
describe('two settings reads racing', () => {
  it('lets the newer read win when the initial one resolves last', async () => {
    await writeSettings({ ...STORED, selection: OFFICIAL_SELECTION });

    const worker = workerBackedClient();
    let held: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      held = resolve;
    });
    let reads = 0;

    const client: MessagingClient = {
      ...worker,
      async readSettings() {
        reads += 1;

        /**
         * The answer is captured **now** and delivered later, which is what a slow round trip actually is: the
         * worker replied with the value as it stood, and the reply arrives late. Reading storage after the delay
         * instead would return whatever is current by then — so the reply would never be stale and there would be
         * nothing for newest-read-wins to discard.
         */
        const answer = await worker.readSettings();

        if (reads === 1) {
          await first;
        }

        return answer;
      },
    };

    const { result } = renderHook(() => useSettings({ client }));

    await waitFor(() => {
      expect(reads).toBe(1);
    });

    // The worker clears the selection and announces it while the first read is still outstanding.
    await invalidateSelectionIfMatches(OFFICIAL_SELECTION);
    await act(async () => {
      await fakeBrowser.runtime.sendMessage(SETTINGS_CHANGED_NOTIFICATION);
    });

    await waitFor(() => {
      expect(result.current.settings.selection).toBeNull();
    });

    // Now the initial read finally answers — with the value from before the clear.
    await act(async () => {
      held?.();
      await first;
    });

    // It is discarded, because a newer read has already answered.
    expect(result.current.settings.selection).toBeNull();
  });

  it('does not lose a mutation that lands during initial hydration', async () => {
    /**
     * The listener is installed before the first read is issued, so an announcement arriving in that window still
     * triggers a re-read. Registering after would simply drop it, leaving the popup holding a value it had already
     * been told was stale.
     */
    await writeSettings({ ...STORED, selection: OFFICIAL_SELECTION });

    const worker = workerBackedClient();
    let held: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      held = resolve;
    });
    let reads = 0;

    const client: MessagingClient = {
      ...worker,
      async readSettings() {
        reads += 1;

        // Captured before the delay, so the first reply carries the pre-clear value.
        const answer = await worker.readSettings();

        if (reads === 1) {
          await first;
        }

        return answer;
      },
    };

    const { result } = renderHook(() => useSettings({ client }));

    await waitFor(() => {
      expect(reads).toBe(1);
    });

    // Announced while hydration is still in flight — before the hook has ever had a value.
    await invalidateSelectionIfMatches(OFFICIAL_SELECTION);
    await act(async () => {
      await fakeBrowser.runtime.sendMessage(SETTINGS_CHANGED_NOTIFICATION);
    });
    await act(async () => {
      held?.();
      await first;
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // The announcement was not lost: a second read happened and its answer is what is held.
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(result.current.settings.selection).toBeNull();
  });
});
