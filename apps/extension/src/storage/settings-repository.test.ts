import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { ServiceAreaCapability } from '@/src/schedule/capability';
import { evidenceFor } from '@/src/test/fixtures';
import { type AppSettings, defaultSettings, SETTINGS_SCHEMA_VERSION } from './settings';
import {
  invalidateSelectionIfMatches,
  persistSelection,
  persistSettings,
  readSettings,
  readSettingsState,
  UnsupportedSettingsVersionError,
  watchSettings,
  writeSettings,
} from './settings-repository';

const STORAGE_KEY = 'settings';

const UNAVAILABLE: ServiceAreaCapability = { availability: 'unavailable' };

const OFFICIAL_AREA_ID = 'koblenz-stadtmitte';

const OFFICIAL_PROVIDER_ID = 'koblenz-servicebetrieb';

const OFFICIAL_SELECTION = {
  providerId: 'koblenz-servicebetrieb',
  serviceAreaId: 'koblenz-stadtmitte',
} as const;

/** A settings value whose selection has already been verified and persisted. */
const UNAVAILABLE_SELECTION = {
  providerId: 'koblenz-servicebetrieb',
  serviceAreaId: 'koblenz-unavailable',
} as const;

const STORED_WITH_SELECTION = {
  ...defaultSettings,
  selection: OFFICIAL_SELECTION,
  visibleWasteTypes: ['paper'],
} satisfies AppSettings;

const setStored = async (value: unknown): Promise<void> => {
  await fakeBrowser.storage.local.set({ [STORAGE_KEY]: value });
};

const getStored = async (): Promise<unknown> =>
  (await fakeBrowser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];

describe('readSettings', () => {
  it('returns defaults with no selection on a fresh install', async () => {
    expect(await readSettings()).toEqual(defaultSettings);
  });

  it('writes nothing on a fresh install, so a failure cannot look like a completed migration', async () => {
    await readSettings();

    expect(await getStored()).toBeUndefined();
  });

  it('migrates a legacy value and persists the new version once', async () => {
    await setStored({
      districtId: 'koblenz-stadtmitte',
      remindersEnabled: false,
      reminderDaysBefore: 2,
      reminderTime: '19:00',
      visibleWasteTypes: ['paper'],
    });

    const settings = await readSettings();

    expect(settings.selection).toEqual(OFFICIAL_SELECTION);
    expect(settings.reminderTime).toBe('19:00');
    expect(await getStored()).toEqual({
      version: SETTINGS_SCHEMA_VERSION,
      selection: OFFICIAL_SELECTION,
      remindersEnabled: false,
      reminderDaysBefore: 2,
      reminderTime: '19:00',
      visibleWasteTypes: ['paper'],
    });
  });

  it('migrates an unverified legacy district to the needs-selection state, keeping the rest', async () => {
    await setStored({
      districtId: 'koblenz-metternich-1',
      remindersEnabled: true,
      reminderDaysBefore: 3,
      reminderTime: '20:00',
      visibleWasteTypes: ['bio', 'residual'],
    });

    const settings = await readSettings();

    expect(settings.selection).toBeNull();
    expect(settings.reminderDaysBefore).toBe(3);
    expect(settings.visibleWasteTypes).toEqual(['bio', 'residual']);
  });

  it('leaves a value written by a newer build untouched on disk', async () => {
    const newer = { version: SETTINGS_SCHEMA_VERSION + 1, selection: null, somethingNewer: true };

    await setStored(newer);

    expect(await readSettings()).toEqual(defaultSettings);
    expect(await getStored()).toEqual(newer);
  });

  it('writes nothing for a malformed stored value', async () => {
    await setStored('nonsense');

    expect(await readSettings()).toEqual(defaultSettings);
    expect(await getStored()).toBe('nonsense');
  });
});

describe('writeSettings', () => {
  /**
   * The point of this test is what happens to a value the type system would already have rejected, so
   * it has to arrive as `unknown` and be re-asserted. That is the documented boundary reason for the
   * assertion below; production code never does this.
   */
  const writeUnvalidated = (value: unknown): Promise<void> => writeSettings(value as AppSettings);

  it('validates before persisting, so a half-chosen selection can never be stored', async () => {
    // A provider with no area is exactly the state the single-value selection exists to prevent.
    await expect(
      writeUnvalidated({ ...defaultSettings, selection: { providerId: 'koblenz-servicebetrieb' } }),
    ).rejects.toThrow();

    expect(await getStored()).toBeUndefined();
  });

  it('rejects an unknown member rather than persisting it', async () => {
    // Persisted schemas are strict: both sides ship in one artifact, so an unexpected member is a defect.
    await expect(writeUnvalidated({ ...defaultSettings, theme: 'dark' })).rejects.toThrow();

    expect(await getStored()).toBeUndefined();
  });

  it('rejects a version this build does not write', async () => {
    await expect(
      writeUnvalidated({ ...defaultSettings, version: SETTINGS_SCHEMA_VERSION + 1 }),
    ).rejects.toThrow();
  });
});

describe('persistSelection', () => {
  it('persists a selection for an area whose provider publishes a calendar', async () => {
    const result = await persistSelection({
      selection: OFFICIAL_SELECTION,
      evidence: evidenceFor(OFFICIAL_SELECTION),
    });

    expect(result.outcome).toBe('persisted');
    expect((await readSettings()).selection).toEqual(OFFICIAL_SELECTION);
  });

  it('refuses an area whose provider publishes no calendar, independently of any UI', async () => {
    const result = await persistSelection({
      selection: UNAVAILABLE_SELECTION,
      evidence: evidenceFor(UNAVAILABLE_SELECTION, UNAVAILABLE),
    });

    expect(result.outcome).toBe('rejected_unavailable');
  });

  it('writes nothing when it refuses', async () => {
    await persistSelection({
      selection: UNAVAILABLE_SELECTION,
      evidence: evidenceFor(UNAVAILABLE_SELECTION, UNAVAILABLE),
    });

    expect(await getStored()).toBeUndefined();
    expect((await readSettings()).selection).toBeNull();
  });

  it('does not replace an existing selection when it refuses a new one', async () => {
    await persistSelection({
      selection: OFFICIAL_SELECTION,
      evidence: evidenceFor(OFFICIAL_SELECTION),
    });

    await persistSelection({
      selection: UNAVAILABLE_SELECTION,
      evidence: evidenceFor(UNAVAILABLE_SELECTION, UNAVAILABLE),
    });

    expect((await readSettings()).selection).toEqual(OFFICIAL_SELECTION);
  });

  it('preserves unrelated settings', async () => {
    await writeSettings({ ...defaultSettings, reminderTime: '20:00', reminderDaysBefore: 3 });
    await persistSelection({
      selection: OFFICIAL_SELECTION,
      evidence: evidenceFor(OFFICIAL_SELECTION),
    });

    const settings = await readSettings();

    expect(settings.reminderTime).toBe('20:00');
    expect(settings.reminderDaysBefore).toBe(3);
  });
});

/**
 * Clearing a selection is a compare-and-clear, because the decision is always about a selection observed
 * *earlier*.
 *
 * A capability response is the end of a chain of requests, and a reminder's chain can run for seconds while the
 * popup is open — long enough for someone to pick a different area. An unconditional clear would discard the
 * choice they had just made, on the authority of an answer about somewhere else entirely.
 */
describe('invalidateSelectionIfMatches', () => {
  const OTHER_SELECTION = {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-oberwerth',
  } as const;

  it('returns to the needs-selection state and preserves everything else', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: OFFICIAL_SELECTION,
      reminderTime: '17:00',
      visibleWasteTypes: ['paper'],
    });

    const result = await invalidateSelectionIfMatches(OFFICIAL_SELECTION);

    expect(result.outcome).toBe('invalidated');
    expect(result.settings.selection).toBeNull();
    // Only the selection was withdrawn, so every unrelated preference survives.
    expect(result.settings.reminderTime).toBe('17:00');
    expect(result.settings.visibleWasteTypes).toEqual(['paper']);
    expect((await readSettings()).selection).toBeNull();
  });

  it('preserves reminder and lead-time preferences', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: OFFICIAL_SELECTION,
      remindersEnabled: false,
      reminderDaysBefore: 3,
    });

    const result = await invalidateSelectionIfMatches(OFFICIAL_SELECTION);

    expect(result.settings.remindersEnabled).toBe(false);
    expect(result.settings.reminderDaysBefore).toBe(3);
  });

  it('leaves a different stored selection exactly as it is', async () => {
    await writeSettings({ ...defaultSettings, selection: OTHER_SELECTION });

    const result = await invalidateSelectionIfMatches(OFFICIAL_SELECTION);

    // Somebody chose differently. Their choice stands, and this answer was about somewhere else.
    expect(result.outcome).toBe('superseded');
    expect(result.settings.selection).toEqual(OTHER_SELECTION);
    expect((await readSettings()).selection).toEqual(OTHER_SELECTION);
  });

  it('does not clear a selection chosen while the invalidation was queued behind it', async () => {
    // The race the compare exists for: the write of the new choice is queued first, so the compare-and-clear
    // rereads *after* it lands and finds a selection that is no longer the one it was told about.
    await writeSettings({ ...defaultSettings, selection: OFFICIAL_SELECTION });

    const [, invalidation] = await Promise.all([
      persistSelection({ selection: OTHER_SELECTION, evidence: evidenceFor(OTHER_SELECTION) }),
      invalidateSelectionIfMatches(OFFICIAL_SELECTION),
    ]);

    expect(invalidation.outcome).toBe('superseded');
    expect((await readSettings()).selection).toEqual(OTHER_SELECTION);
  });

  it('reports superseded when there is no selection left at all', async () => {
    await writeSettings({ ...defaultSettings, selection: null });

    const result = await invalidateSelectionIfMatches(OFFICIAL_SELECTION);

    // Nothing of the caller's to clear, which is the same conclusion as somebody else having changed it.
    expect(result.outcome).toBe('superseded');
    expect(result.settings.selection).toBeNull();
  });

  it('rejects when storage refuses the write, leaving the selection in place', async () => {
    await writeSettings({ ...defaultSettings, selection: OFFICIAL_SELECTION });

    const set = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValue(new Error('storage unavailable at /internal/path'));

    await expect(invalidateSelectionIfMatches(OFFICIAL_SELECTION)).rejects.toThrow();

    set.mockRestore();

    // Still stored, so the next attempt has something to clear.
    expect((await readSettings()).selection).toEqual(OFFICIAL_SELECTION);
  });

  it('completes on a later attempt once storage recovers', async () => {
    await writeSettings({ ...defaultSettings, selection: OFFICIAL_SELECTION });

    const set = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValue(new Error('storage unavailable'));

    await expect(invalidateSelectionIfMatches(OFFICIAL_SELECTION)).rejects.toThrow();

    set.mockRestore();

    // A failed mutation must not poison the queue: the retry runs and finishes the job.
    const result = await invalidateSelectionIfMatches(OFFICIAL_SELECTION);

    expect(result.outcome).toBe('invalidated');
    expect((await readSettings()).selection).toBeNull();
  });

  it('keeps serving later mutations after one has failed', async () => {
    await writeSettings({ ...defaultSettings, selection: OFFICIAL_SELECTION });

    const set = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(invalidateSelectionIfMatches(OFFICIAL_SELECTION)).rejects.toThrow();

    set.mockRestore();

    expect(
      (
        await persistSelection({
          selection: OTHER_SELECTION,
          evidence: evidenceFor(OTHER_SELECTION),
        })
      ).outcome,
    ).toBe('persisted');
  });
});

describe('watchSettings', () => {
  it('reports migrated settings rather than the raw stored value', async () => {
    const seen: (string | null)[] = [];
    const unwatch = watchSettings((settings) => {
      seen.push(settings.selection === null ? null : settings.selection.serviceAreaId);
    });

    await setStored({
      districtId: 'koblenz-stadtmitte',
      remindersEnabled: true,
      reminderDaysBefore: 1,
      reminderTime: '18:00',
      visibleWasteTypes: ['paper'],
    });

    unwatch();

    expect(seen).toEqual(['koblenz-stadtmitte']);
  });
});

describe('the settings storage item', () => {
  const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  const REPOSITORY_FILE = 'src/storage/settings-repository.ts';

  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        return [];
      }

      const path = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return sourceFiles(path);
      }

      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it('is read and written by the repository alone', () => {
    // A second raw reader is exactly how a half-migrated value reaches a product surface, so the rule is
    // asserted against the source rather than trusted.
    const offenders = sourceFiles(EXTENSION_ROOT)
      .filter((file) => readFileSync(file, 'utf8').includes("'local:settings'"))
      .map((file) => relative(EXTENSION_ROOT, file))
      .filter((file) => file !== REPOSITORY_FILE && !file.endsWith('.test.ts'));

    expect(offenders).toEqual([]);
  });

  it('finds the repository itself, so the check above is really scanning files', () => {
    const declaring = sourceFiles(EXTENSION_ROOT)
      .filter((file) => readFileSync(file, 'utf8').includes("'local:settings'"))
      .map((file) => relative(EXTENSION_ROOT, file));

    expect(declaring).toContain(REPOSITORY_FILE);
  });
});

describe('editing preferences while the API is unreachable', () => {
  const CAPABILITY_FREE = {
    settings: STORED_WITH_SELECTION,
    expectedSelection: OFFICIAL_SELECTION,
  } as const;

  it('persists preference edits when the selection is unchanged and no capability is available', async () => {
    // The regression: requiring a capability unconditionally made the reminder time and waste types hostage to
    // the network, even though neither has anything to do with the selection.
    await writeSettings(STORED_WITH_SELECTION);

    const result = await persistSettings({
      expectedSelection: (await readSettings()).selection,
      settings: { ...STORED_WITH_SELECTION, reminderTime: '20:00', visibleWasteTypes: ['bio'] },
    });

    expect(result.outcome).toBe('persisted');

    const stored = await readSettings();

    expect(stored.reminderTime).toBe('20:00');
    expect(stored.visibleWasteTypes).toEqual(['bio']);
    // The already-verified selection is carried across untouched.
    expect(stored.selection).toEqual(STORED_WITH_SELECTION.selection);
  });

  it('persists an unchanged selection with no capability at all', async () => {
    await writeSettings(STORED_WITH_SELECTION);

    expect((await persistSettings(CAPABILITY_FREE)).outcome).toBe('persisted');
  });

  it('rejects a changed area with no capability', async () => {
    await writeSettings(STORED_WITH_SELECTION);

    const result = await persistSettings({
      expectedSelection: (await readSettings()).selection,
      settings: {
        ...STORED_WITH_SELECTION,
        selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: 'a-different-area' },
      },
    });

    expect(result.outcome).toBe('rejected_unknown_capability');
    expect(await readSettings()).toEqual(STORED_WITH_SELECTION);
  });

  it('rejects a changed provider with no capability', async () => {
    await writeSettings(STORED_WITH_SELECTION);

    const result = await persistSettings({
      expectedSelection: (await readSettings()).selection,
      settings: {
        ...STORED_WITH_SELECTION,
        selection: { providerId: 'another-betrieb', serviceAreaId: OFFICIAL_AREA_ID },
      },
    });

    expect(result.outcome).toBe('rejected_unknown_capability');
    expect(await readSettings()).toEqual(STORED_WITH_SELECTION);
  });

  it('rejects a first selection with no capability', async () => {
    await writeSettings({ ...STORED_WITH_SELECTION, selection: null });

    const result = await persistSettings({
      settings: STORED_WITH_SELECTION,
      expectedSelection: (await readSettings()).selection,
    });

    expect(result.outcome).toBe('rejected_unknown_capability');
    expect((await readSettings()).selection).toBeNull();
  });

  it('rejects an unavailable capability even when the selection is unchanged', async () => {
    await writeSettings(STORED_WITH_SELECTION);

    const result = await persistSettings({
      expectedSelection: (await readSettings()).selection,
      settings: { ...STORED_WITH_SELECTION, reminderTime: '20:00' },
      evidence: evidenceFor(OFFICIAL_SELECTION, UNAVAILABLE),
    });

    expect(result.outcome).toBe('rejected_unavailable');
    expect(await readSettings()).toEqual(STORED_WITH_SELECTION);
  });

  it('persists no selection at all with no capability', async () => {
    await writeSettings(STORED_WITH_SELECTION);

    const result = await persistSettings({
      expectedSelection: (await readSettings()).selection,
      settings: { ...STORED_WITH_SELECTION, selection: null },
    });

    expect(result.outcome).toBe('persisted');
    expect((await readSettings()).selection).toBeNull();
  });

  it('writes once, so an offline preference edit is still atomic', async () => {
    await writeSettings(STORED_WITH_SELECTION);

    const writes: unknown[] = [];

    fakeBrowser.storage.local.onChanged.addListener((changes) => {
      if (changes.settings !== undefined) {
        writes.push(changes.settings.newValue);
      }
    });

    await persistSettings({
      settings: { ...STORED_WITH_SELECTION, reminderTime: '17:00' },
      expectedSelection: OFFICIAL_SELECTION,
    });

    expect(writes).toHaveLength(1);
  });
});

/**
 * A migration that cannot be persisted must still produce usable settings.
 *
 * The migration is pure and happens in memory, so the value is already valid and complete before anything is
 * written. Treating the write as part of the read meant a transient `storage.set` failure rejected the whole
 * read — and the popup, whose hydration waits on it, stayed on its preparation screen indefinitely with no
 * error and no way forward.
 *
 * What must not happen instead is the migration being recorded as done: the legacy value has to survive so the
 * next read migrates again and retries the write. Otherwise a storage hiccup loses a person's settings
 * permanently.
 */
describe('a legacy migration whose write fails', () => {
  const LEGACY = {
    districtId: 'koblenz-stadtmitte',
    remindersEnabled: false,
    reminderDaysBefore: 2,
    reminderTime: '19:00',
    visibleWasteTypes: ['paper'],
  } as const;

  /** Fails every `storage.local.set` until the returned release is called. */
  const withFailingWrites = () => {
    const spy = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValue(new Error('storage is temporarily unavailable at /internal/path'));

    return {
      writeAttempts: () => spy.mock.calls.length,
      allowWrites: () => {
        spy.mockRestore();
      },
    };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the migrated settings rather than rejecting', async () => {
    await setStored(LEGACY);

    const failing = withFailingWrites();
    const settings = await readSettings();

    // Valid, complete, and carried across — the whole point of migrating in memory first.
    expect(settings.selection).toEqual(OFFICIAL_SELECTION);
    expect(settings.reminderTime).toBe('19:00');
    expect(settings.reminderDaysBefore).toBe(2);
    expect(settings.version).toBe(SETTINGS_SCHEMA_VERSION);
    expect(failing.writeAttempts()).toBeGreaterThan(0);

    failing.allowWrites();
  });

  it('leaves the legacy raw value exactly as it was', async () => {
    await setStored(LEGACY);

    const failing = withFailingWrites();

    await readSettings();

    // Not half-written, not replaced, not deleted. The legacy settings are still the only copy on disk.
    expect(await getStored()).toEqual(LEGACY);

    failing.allowWrites();
  });

  it('never records the migration as complete while the v2 value is not on disk', async () => {
    await setStored(LEGACY);

    const failing = withFailingWrites();

    await readSettings();

    const stored = await getStored();

    expect(stored).not.toHaveProperty('version');
    expect(stored).toHaveProperty('districtId');

    failing.allowWrites();
  });

  it('retries the persistence on the next read', async () => {
    await setStored(LEGACY);

    const failing = withFailingWrites();

    await readSettings();

    const afterFirst = failing.writeAttempts();

    await readSettings();

    // The legacy value is still there, so the next read migrates again and attempts the write again.
    expect(failing.writeAttempts()).toBeGreaterThan(afterFirst);

    failing.allowWrites();
  });

  it('persists the migrated v2 value once a later write succeeds', async () => {
    await setStored(LEGACY);

    const failing = withFailingWrites();

    await readSettings();
    failing.allowWrites();

    const settings = await readSettings();

    expect(settings.selection).toEqual(OFFICIAL_SELECTION);
    expect(await getStored()).toEqual({
      version: SETTINGS_SCHEMA_VERSION,
      selection: OFFICIAL_SELECTION,
      remindersEnabled: false,
      reminderDaysBefore: 2,
      reminderTime: '19:00',
      visibleWasteTypes: ['paper'],
    });
  });

  it('reveals nothing about the storage error it swallowed', async () => {
    await setStored(LEGACY);

    const failing = withFailingWrites();
    const settings = await readSettings();

    // The rejection message named an internal path. Nothing of it may travel with the settings.
    expect(JSON.stringify(settings)).not.toContain('/internal/path');

    failing.allowWrites();
  });
});

/**
 * A raw read that fails is a different thing from a migration that could not be written.
 *
 * It must **not** degrade to defaults: defaults would present a fresh installation to someone whose settings
 * exist and are merely unreadable at this moment, so the area they chose would look like a choice they never
 * made. It propagates, and the surfaces above turn it into an explicit state.
 */
describe('an unreadable raw settings value', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is reported rather than hidden behind defaults', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));

    await expect(readSettings()).rejects.toThrow();
  });

  it('does not write anything in place of the value it could not read', async () => {
    const set = vi.spyOn(fakeBrowser.storage.local, 'set');

    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));

    await expect(readSettings()).rejects.toThrow();

    expect(set).not.toHaveBeenCalled();
  });
});

/**
 * A stored value written by a **newer** build is not editable defaults.
 *
 * The migration answers such a value with defaults so the stored object is left alone — correct for preservation,
 * and completely wrong to treat as a person's settings. Every mutation is refused, and the refusal is checked
 * inside the serialized queue rather than only at hydration: another window running the newer build can write
 * between this one opening and its first save, and the queue is the only place where "what is stored" and "what is
 * about to be written" are the same moment.
 */
describe('stored settings from a newer schema version', () => {
  /** A newer value carrying members this build has no name for. */
  const NEWER = {
    version: SETTINGS_SCHEMA_VERSION + 1,
    selection: { providerId: 'koblenz-servicebetrieb', serviceAreaId: 'koblenz-oberwerth' },
    remindersEnabled: false,
    reminderDaysBefore: 4,
    reminderTime: '21:00',
    visibleWasteTypes: ['bio'],
    somethingThisBuildCannotName: { nested: ['values', 1, true] },
  } as const;

  /** Counts every write attempt, so "nothing was written" is proved rather than inferred from the value. */
  const watchWrites = () => vi.spyOn(fakeBrowser.storage.local, 'set');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the unsupported state rather than answering with defaults', async () => {
    await setStored(NEWER);

    expect(await readSettingsState()).toEqual({ status: 'unsupported_version' });
  });

  it('reports a current value as ready', async () => {
    await writeSettings(STORED_WITH_SELECTION);

    expect(await readSettingsState()).toEqual({
      status: 'ready',
      settings: STORED_WITH_SELECTION,
    });
  });

  it('migrates a legacy value normally', async () => {
    await setStored({
      districtId: 'koblenz-stadtmitte',
      remindersEnabled: false,
      reminderDaysBefore: 2,
      reminderTime: '19:00',
      visibleWasteTypes: ['paper'],
    });

    const state = await readSettingsState();

    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.settings.selection).toEqual(OFFICIAL_SELECTION);
  });

  it('returns fresh defaults when nothing is stored at all', async () => {
    expect(await readSettingsState()).toEqual({ status: 'ready', settings: defaultSettings });
  });

  it('blocks confirming a selection', async () => {
    await setStored(NEWER);

    const writes = watchWrites();

    await expect(
      persistSelection({
        selection: OFFICIAL_SELECTION,
        evidence: evidenceFor(OFFICIAL_SELECTION),
      }),
    ).rejects.toThrow(UnsupportedSettingsVersionError);

    expect(writes).not.toHaveBeenCalled();
  });

  it('blocks saving a draft', async () => {
    await setStored(NEWER);

    const writes = watchWrites();

    await expect(
      persistSettings({
        settings: STORED_WITH_SELECTION,
        expectedSelection: OFFICIAL_SELECTION,
        evidence: evidenceFor(OFFICIAL_SELECTION),
      }),
    ).rejects.toThrow(UnsupportedSettingsVersionError);

    expect(writes).not.toHaveBeenCalled();
  });

  it('blocks a preference-only update', async () => {
    await setStored(NEWER);

    const writes = watchWrites();

    await expect(
      persistSettings({
        settings: { ...defaultSettings, reminderTime: '17:00' },
        expectedSelection: null,
      }),
    ).rejects.toThrow(UnsupportedSettingsVersionError);

    expect(writes).not.toHaveBeenCalled();
  });

  it('blocks the compare-and-clear invalidation', async () => {
    await setStored(NEWER);

    const writes = watchWrites();

    await expect(invalidateSelectionIfMatches(OFFICIAL_SELECTION)).rejects.toThrow(
      UnsupportedSettingsVersionError,
    );

    expect(writes).not.toHaveBeenCalled();
  });

  it('leaves the raw object deeply unchanged, including members it cannot name', async () => {
    await setStored(NEWER);

    // Every mutation, one after another.
    await persistSelection({
      selection: OFFICIAL_SELECTION,
      evidence: evidenceFor(OFFICIAL_SELECTION),
    }).catch(() => undefined);
    await persistSettings({
      settings: STORED_WITH_SELECTION,
      expectedSelection: OFFICIAL_SELECTION,
      evidence: evidenceFor(OFFICIAL_SELECTION),
    }).catch(() => undefined);
    await invalidateSelectionIfMatches(OFFICIAL_SELECTION).catch(() => undefined);
    await readSettingsState();

    // Not a byte of it moved, and the unknown member survived intact.
    expect(await getStored()).toEqual(NEWER);
  });

  it('performs no storage write at all across a read and every mutation', async () => {
    await setStored(NEWER);

    const writes = watchWrites();

    await readSettingsState();
    await persistSelection({
      selection: OFFICIAL_SELECTION,
      evidence: evidenceFor(OFFICIAL_SELECTION),
    }).catch(() => undefined);
    await invalidateSelectionIfMatches(OFFICIAL_SELECTION).catch(() => undefined);

    // Not even a migration write: a newer value is preserved by doing nothing whatsoever.
    expect(writes).not.toHaveBeenCalled();
  });

  it('stays blocked for every later operation, not only the first', async () => {
    await setStored(NEWER);

    await expect(invalidateSelectionIfMatches(OFFICIAL_SELECTION)).rejects.toThrow();
    await expect(invalidateSelectionIfMatches(OFFICIAL_SELECTION)).rejects.toThrow();

    // A refused mutation must not poison the queue either.
    await expect(
      persistSelection({
        selection: OFFICIAL_SELECTION,
        evidence: evidenceFor(OFFICIAL_SELECTION),
      }),
    ).rejects.toThrow(UnsupportedSettingsVersionError);
  });

  it('blocks a mutation whose newer value appeared after this session started', async () => {
    // The reason the check is inside the queue: at hydration the value was this build's, and it changed since.
    await writeSettings(STORED_WITH_SELECTION);

    expect((await readSettingsState()).status).toBe('ready');

    await setStored(NEWER);

    await expect(invalidateSelectionIfMatches(OFFICIAL_SELECTION)).rejects.toThrow(
      UnsupportedSettingsVersionError,
    );
    expect(await getStored()).toEqual(NEWER);
  });

  it('carries no operation and no request identifier on the error it raises', async () => {
    await setStored(NEWER);

    const error = await invalidateSelectionIfMatches(OFFICIAL_SELECTION).catch(
      (raised: unknown) => raised,
    );

    expect(error).toBeInstanceOf(UnsupportedSettingsVersionError);
    // Nothing about an HTTP request, and nothing about the newer build's contents.
    expect(
      JSON.stringify({ name: (error as Error).name, message: (error as Error).message }),
    ).not.toMatch(/operation|requestId|somethingThisBuildCannotName/);
  });
});

/**
 * Evidence is only evidence about the area it names.
 *
 * A bare availability flag travelling beside a selection *looked* like evidence for that selection and asserted
 * nothing of the kind. A surface that found the capability by area id in whichever list it happened to be showing
 * could hand over an `available` flag belonging to another area — or another provider entirely — and the write
 * went through on the strength of it. That defeats the one guarantee the check exists to give: an area is
 * persisted only when *its own* calendar was confirmed.
 *
 * These cover both entry points, because a rule enforced by only one of them is a rule the other surface skips.
 */
describe('capability evidence bound to the candidate identity', () => {
  const CANDIDATE = {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-stadtmitte',
  } as const;

  const OTHER_AREA = {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-oberwerth',
  } as const;

  const OTHER_PROVIDER = {
    providerId: 'muelheim-betrieb',
    serviceAreaId: 'koblenz-stadtmitte',
  } as const;

  describe('persistSelection', () => {
    it('rejects evidence describing a different area of the same provider', async () => {
      const result = await persistSelection({
        selection: CANDIDATE,
        evidence: evidenceFor(OTHER_AREA),
      });

      expect(result.outcome).toBe('rejected_unknown_capability');
      expect((await readSettings()).selection).toBeNull();
    });

    it('rejects evidence describing the same area under a different provider', async () => {
      // An area id is unique only within its provider, so the provider half of the identity is load-bearing.
      const result = await persistSelection({
        selection: CANDIDATE,
        evidence: evidenceFor(OTHER_PROVIDER),
      });

      expect(result.outcome).toBe('rejected_unknown_capability');
      expect((await readSettings()).selection).toBeNull();
    });

    it('reports mismatched evidence as unverified rather than as unavailable', async () => {
      /**
       * The ordering that matters. Evidence about somewhere else says nothing about this candidate — not that it
       * is available and not that it is unavailable — so reading its availability at all would attribute a
       * statement about another area to the one being chosen.
       */
      const result = await persistSelection({
        selection: CANDIDATE,
        evidence: evidenceFor(OTHER_AREA, UNAVAILABLE),
      });

      expect(result.outcome).toBe('rejected_unknown_capability');
      expect(result.outcome).not.toBe('rejected_unavailable');
    });

    it('accepts evidence that names the candidate and says it is available', async () => {
      const result = await persistSelection({
        selection: CANDIDATE,
        evidence: evidenceFor(CANDIDATE),
      });

      expect(result.outcome).toBe('persisted');
      expect((await readSettings()).selection).toEqual(CANDIDATE);
    });

    it('leaves an existing selection untouched when it refuses mismatched evidence', async () => {
      await persistSelection({ selection: CANDIDATE, evidence: evidenceFor(CANDIDATE) });

      await persistSelection({ selection: OTHER_AREA, evidence: evidenceFor(CANDIDATE) });

      expect((await readSettings()).selection).toEqual(CANDIDATE);
    });
  });

  describe('persistSettings', () => {
    const draftFor = (selection: {
      readonly providerId: string;
      readonly serviceAreaId: string;
    }) => ({
      ...STORED_WITH_SELECTION,
      selection,
      reminderTime: '20:00',
      visibleWasteTypes: ['bio'] as AppSettings['visibleWasteTypes'],
    });

    it('rejects a draft whose evidence describes a different area', async () => {
      await writeSettings(STORED_WITH_SELECTION);

      const result = await persistSettings({
        expectedSelection: OFFICIAL_SELECTION,
        settings: draftFor(OTHER_AREA),
        evidence: evidenceFor(CANDIDATE),
      });

      expect(result.outcome).toBe('rejected_unknown_capability');
    });

    it('rejects a draft whose evidence describes a different provider', async () => {
      await writeSettings(STORED_WITH_SELECTION);

      const result = await persistSettings({
        expectedSelection: OFFICIAL_SELECTION,
        settings: draftFor(OTHER_AREA),
        evidence: evidenceFor({ ...OTHER_AREA, providerId: 'muelheim-betrieb' }),
      });

      expect(result.outcome).toBe('rejected_unknown_capability');
    });

    it('writes nothing on a mismatch, including the preferences travelling with it', async () => {
      /**
       * A draft is one transactional value. Applying the reminder time and the waste types while refusing the
       * area would store a combination the person never saw — and would make the refusal invisible, because the
       * save appeared to work.
       */
      await writeSettings(STORED_WITH_SELECTION);

      await persistSettings({
        expectedSelection: OFFICIAL_SELECTION,
        settings: draftFor(OTHER_AREA),
        evidence: evidenceFor(CANDIDATE),
      });

      expect(await readSettings()).toEqual(STORED_WITH_SELECTION);
    });

    it('accepts a changed area whose own evidence says it is available', async () => {
      await writeSettings(STORED_WITH_SELECTION);

      const result = await persistSettings({
        expectedSelection: OFFICIAL_SELECTION,
        settings: draftFor(OTHER_AREA),
        evidence: evidenceFor(OTHER_AREA),
      });

      expect(result.outcome).toBe('persisted');
      expect((await readSettings()).selection).toEqual(OTHER_AREA);
    });

    it('still edits preferences on an unchanged selection with no evidence at all', async () => {
      // The approved offline case, unaffected: keeping an already-verified area asserts nothing new about it.
      await writeSettings(STORED_WITH_SELECTION);

      const result = await persistSettings({
        expectedSelection: OFFICIAL_SELECTION,
        settings: { ...STORED_WITH_SELECTION, reminderTime: '20:00' },
      });

      expect(result.outcome).toBe('persisted');
      expect((await readSettings()).reminderTime).toBe('20:00');
    });

    it('refuses a stale draft before it ever looks at the evidence', async () => {
      /**
       * The order the two checks run in. The draft's premise is checked first, so a stale draft is reported as
       * the conflict it is rather than as unverified evidence — which would send the surface looking for a
       * capability problem that does not exist.
       */
      await writeSettings({ ...STORED_WITH_SELECTION, selection: OTHER_AREA });

      const result = await persistSettings({
        expectedSelection: OFFICIAL_SELECTION,
        settings: draftFor(CANDIDATE),
        // Mismatched as well, so the reported outcome says which check ran first.
        evidence: evidenceFor(OTHER_PROVIDER),
      });

      expect(result.outcome).toBe('conflict');
      expect((await readSettings()).selection).toEqual(OTHER_AREA);
    });
  });
});

/**
 * Migration persistence is a read-modify-write, so it belongs on the same queue as every other one.
 *
 * A legacy value is migrated in memory and the result is *written*, and that write is built from a snapshot taken
 * when the read began. Outside the queue the sequence was: read the legacy value → a mutation reads, computes and
 * writes its own value → write the migrated snapshot, which discards the mutation. A withdrawn area could reappear
 * that way, and a save could vanish.
 *
 * Every case here holds the migration's own read open with a deferred promise, so the interleaving is decided by
 * the test rather than by whichever microtask happened to run first.
 */
describe('a migration racing a mutation', () => {
  const OTHER_SELECTION = {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-oberwerth',
  } as const;

  const LEGACY = {
    districtId: 'koblenz-stadtmitte',
    remindersEnabled: false,
    reminderDaysBefore: 2,
    reminderTime: '19:00',
    visibleWasteTypes: ['paper'],
  } as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** One turn of the microtask queue, so anything able to proceed has proceeded. */
  const act = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * Holds the **first** raw read open until released, and lets every later one through.
   *
   * The first read is the migration's, so this is what puts a mutation into the window the migration used to leave
   * open between reading a legacy value and writing the migrated one.
   */
  const holdFirstRead = () => {
    const store = fakeBrowser.storage.local;
    const read = store.get.bind(store);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;

    vi.spyOn(store, 'get').mockImplementation(async (keys: unknown) => {
      reads += 1;

      if (reads === 1) {
        await held;
      }

      return read(keys as string);
    });

    return {
      reads: () => reads,
      release: () => release?.(),
    };
  };

  it('snapshots the legacy settings when it begins', async () => {
    // The premise: what the migration is about to write is decided from what it read, before anything else ran.
    await setStored(LEGACY);

    const state = await readSettingsState();

    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.settings.selection).toEqual(OFFICIAL_SELECTION);
    expect(state.status === 'ready' && state.settings.reminderTime).toBe('19:00');
  });

  it('cannot overwrite a mutation that was queued behind it', async () => {
    await setStored(LEGACY);

    const gate = holdFirstRead();

    // The migration starts and blocks on its read.
    const migrating = readSettingsState();

    await vi.waitFor(() => {
      expect(gate.reads()).toBe(1);
    });

    // A mutation arrives while the migration is mid-flight.
    const mutating = persistSettings({
      expectedSelection: OFFICIAL_SELECTION,
      settings: { ...STORED_WITH_SELECTION, reminderTime: '06:30' },
    });

    /**
     * The assertion that proves the serialization, made while the migration is still held.
     *
     * A mutation's first act is a raw read of its own, so if it were able to run it would already have made one.
     * Off the queue it read, computed and wrote here — and the migration's snapshot, taken before this mutation
     * existed, then landed on top and discarded it.
     */
    await act();
    await act();
    await act();

    expect(gate.reads()).toBe(1);

    gate.release();

    const [state, result] = await Promise.all([migrating, mutating]);

    expect(state.status).toBe('ready');
    expect(result.outcome).toBe('persisted');

    // The newer value is what survived.
    expect((await readSettings()).reminderTime).toBe('06:30');
  });

  it('leaves the newer mutation in storage, not the migrated snapshot', async () => {
    await setStored(LEGACY);

    const gate = holdFirstRead();
    const migrating = readSettingsState();

    await vi.waitFor(() => {
      expect(gate.reads()).toBe(1);
    });

    const mutating = persistSelection({
      selection: OTHER_SELECTION,
      evidence: evidenceFor(OTHER_SELECTION),
    });

    // Still nothing read by the mutation, so the migration's write cannot be built after it.
    await act();
    await act();
    await act();

    expect(gate.reads()).toBe(1);

    gate.release();
    await Promise.all([migrating, mutating]);

    // Read from disk rather than from either return value: the snapshot's `19:00` and the legacy selection are
    // what a discarded mutation would have left behind.
    const stored = await getStored();

    expect(stored).toMatchObject({
      version: SETTINGS_SCHEMA_VERSION,
      selection: OTHER_SELECTION,
    });
  });

  it('keeps a failed migration persistence retryable', async () => {
    /**
     * The write is best-effort, and it must stay retryable: recording the migration as done while the v2 value is
     * not on disk would lose the legacy settings permanently. Being on the queue changes nothing about that.
     */
    await setStored(LEGACY);

    const failing = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValue(new Error('storage is temporarily unavailable'));

    const first = await readSettingsState();

    expect(first.status).toBe('ready');
    // Untouched, so the next read migrates again.
    expect(await getStored()).toEqual(LEGACY);

    failing.mockRestore();

    const second = await readSettingsState();

    expect(second.status).toBe('ready');
    expect(await getStored()).toMatchObject({ version: SETTINGS_SCHEMA_VERSION });
  });

  it('deadlocks nothing when a mutation and both reads are interleaved', async () => {
    /**
     * The hazard the split exists for. A queued mutation reads through the **unqueued** primitive; had it called a
     * queued read it would await a tail that cannot advance until the mutation it is inside has finished, and every
     * later operation would hang behind it.
     *
     * Asserted with a timeout, because a deadlock does not fail — it simply never answers.
     */
    await setStored(LEGACY);

    const everything = Promise.all([
      readSettingsState(),
      persistSettings({
        expectedSelection: OFFICIAL_SELECTION,
        settings: { ...STORED_WITH_SELECTION, reminderTime: '06:30' },
      }),
      readSettings(),
      invalidateSelectionIfMatches(OFFICIAL_SELECTION),
      readSettingsState(),
    ]);

    const outcome = await Promise.race([
      everything.then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => {
        setTimeout(() => {
          resolve('hung');
        }, 2000);
      }),
    ]);

    expect(outcome).toBe('settled');
  });

  it('serializes them in the order they were requested', async () => {
    // The clear runs after the save, so the selection it compares against is the one the save left.
    await setStored(LEGACY);

    const results = await Promise.all([
      readSettingsState(),
      persistSelection({ selection: OTHER_SELECTION, evidence: evidenceFor(OTHER_SELECTION) }),
      invalidateSelectionIfMatches(OTHER_SELECTION),
    ]);

    expect(results[1].outcome).toBe('persisted');
    expect(results[2].outcome).toBe('invalidated');
    expect((await readSettings()).selection).toBeNull();
  });
});

/**
 * A versioned record this build cannot read is never rewritten during a read.
 *
 * Asserted through the repository rather than the pure migration, because the harm is a *write*: a record carrying
 * `version: 1` alongside otherwise valid legacy fields used to be classified as legacy, migrated, and persisted —
 * replacing the only copy of data this build had already failed to understand, and mapping a district onto a real
 * service area on the strength of a guess.
 */
describe('reading a versioned record this build cannot read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Records every raw write, so "nothing was persisted" is an observation rather than an inference. */
  const watchWrites = () => vi.spyOn(fakeBrowser.storage.local, 'set');

  const versionedLegacy = (version: unknown): Record<string, unknown> => ({
    version,
    districtId: 'koblenz-stadtmitte',
    remindersEnabled: false,
    reminderDaysBefore: 2,
    reminderTime: '19:00',
    visibleWasteTypes: ['paper'],
  });

  it.each([
    ['its own current version, but malformed', 2],
    ['the first version', 1],
    ['zero', 0],
    ['null', null],
    ['a string', '2'],
  ])('leaves the raw record exactly as it was, for %s', async (_reason, version) => {
    const raw = versionedLegacy(version);

    await setStored(raw);
    await readSettingsState();

    // Not a byte moved. The next read sees the same evidence.
    expect(await getStored()).toEqual(raw);
  });

  it('performs no storage write at all', async () => {
    await setStored(versionedLegacy(1));

    const writes = watchWrites();

    await readSettingsState();

    expect(writes).not.toHaveBeenCalled();
  });

  it('answers with defaults rather than a guessed selection', async () => {
    await setStored(versionedLegacy(1));

    const state = await readSettingsState();

    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.settings.selection).toBeNull();
  });

  it('still migrates a record that declares no version', async () => {
    // The counterweight, through the same path: a genuinely unversioned record is migrated and persisted.
    const { version: _version, ...unversioned } = versionedLegacy(1);

    await setStored(unversioned);

    const state = await readSettingsState();

    expect(state.status === 'ready' && state.settings.selection).toEqual(OFFICIAL_SELECTION);
    expect(await getStored()).toMatchObject({ version: SETTINGS_SCHEMA_VERSION });
  });
});
