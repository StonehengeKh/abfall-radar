import { describe, expect, it } from 'vitest';
import { defaultSettings, SETTINGS_SCHEMA_VERSION } from './settings';
import { migrateSettings, shouldPersistMigration } from './settings-migration';

const LEGACY_BASE = {
  remindersEnabled: false,
  reminderDaysBefore: 2,
  reminderTime: '19:00',
  visibleWasteTypes: ['paper', 'hazardous'],
} as const;

const legacyWith = (districtId: string) => ({ districtId, ...LEGACY_BASE });

const CURRENT_SETTINGS = {
  version: SETTINGS_SCHEMA_VERSION,
  selection: { providerId: 'koblenz-servicebetrieb', serviceAreaId: 'koblenz-stadtmitte' },
  remindersEnabled: true,
  reminderDaysBefore: 1,
  reminderTime: '18:00',
  visibleWasteTypes: ['paper'],
} as const;

describe('migrateSettings', () => {
  it.each([
    ['an absent value', undefined],
    ['a null value', null],
  ])('falls back to defaults for %s, which is a fresh installation', (_reason, raw) => {
    const migration = migrateSettings(raw);

    expect(migration.outcome).toBe('defaulted');
    expect(migration.settings).toEqual(defaultSettings);
    expect(migration.settings.selection).toBeNull();
  });

  it('migrates the one verified legacy district to the official selection', () => {
    const migration = migrateSettings(legacyWith('koblenz-stadtmitte'));

    expect(migration.outcome).toBe('migrated');
    expect(migration.settings.selection).toEqual({
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-stadtmitte',
    });
  });

  it.each([
    'koblenz-metternich-1',
    'koblenz-karthause-2',
    'koblenz-stadtmitte-2',
    'stadtmitte',
    'unknown-district',
    'KOBLENZ-STADTMITTE',
  ])('migrates the unverified legacy district %s to no selection', (districtId) => {
    // Mapping by name similarity would silently move a person to an area nobody checked, and a wrong
    // collection area produces confidently wrong dates.
    const migration = migrateSettings(legacyWith(districtId));

    expect(migration.outcome).toBe('migrated');
    expect(migration.settings.selection).toBeNull();
  });

  it('invents no provider or service-area identifier', () => {
    const migration = migrateSettings(legacyWith('koblenz-metternich-1'));

    expect(JSON.stringify(migration.settings)).not.toContain('metternich');
    expect(JSON.stringify(migration.settings)).not.toContain('koblenz-servicebetrieb');
  });

  it('preserves the reminder settings and waste types when they are valid', () => {
    const migration = migrateSettings(legacyWith('koblenz-metternich-1'));

    expect(migration.settings.remindersEnabled).toBe(false);
    expect(migration.settings.reminderDaysBefore).toBe(2);
    expect(migration.settings.reminderTime).toBe('19:00');
    expect(migration.settings.visibleWasteTypes).toEqual(['paper', 'hazardous']);
  });

  it('ignores an unrelated stray member rather than discarding a person’s preferences', () => {
    // A migration input is not something this build wrote. Being strict here would mean one leftover
    // member cost the user their reminder settings.
    const migration = migrateSettings({ ...legacyWith('koblenz-stadtmitte'), theme: 'dark' });

    expect(migration.outcome).toBe('migrated');
    expect(migration.settings.reminderTime).toBe('19:00');
    expect(Object.keys(migration.settings)).not.toContain('theme');
  });

  it('recognizes a value that is already current and changes nothing', () => {
    const migration = migrateSettings(CURRENT_SETTINGS);

    expect(migration.outcome).toBe('current');
    expect(migration.settings).toEqual(CURRENT_SETTINGS);
  });

  it('recognizes a current value with no selection', () => {
    const migration = migrateSettings({ ...CURRENT_SETTINGS, selection: null });

    expect(migration.outcome).toBe('current');
    expect(migration.settings.selection).toBeNull();
  });

  it.each([
    ['a string', 'settings'],
    ['a number', 7],
    ['an array', []],
    ['an empty object', {}],
    ['a legacy value with an empty district', { ...LEGACY_BASE, districtId: '' }],
    [
      'a legacy value with an invalid time',
      { ...legacyWith('koblenz-stadtmitte'), reminderTime: '25:00' },
    ],
    [
      'a legacy value with no waste types',
      { ...legacyWith('koblenz-stadtmitte'), visibleWasteTypes: [] },
    ],
    [
      'a legacy value with an unrecognized waste type',
      { ...legacyWith('koblenz-stadtmitte'), visibleWasteTypes: ['plutonium'] },
    ],
    [
      'a current value with a half-chosen selection',
      { ...CURRENT_SETTINGS, selection: { providerId: 'p' } },
    ],
  ])('falls back to defaults for %s', (_reason, raw) => {
    const migration = migrateSettings(raw);

    expect(migration.outcome).toBe('defaulted');
    expect(migration.settings).toEqual(defaultSettings);
  });

  it('leaves a value written by a newer build alone', () => {
    const migration = migrateSettings({
      version: SETTINGS_SCHEMA_VERSION + 1,
      selection: null,
      somethingNewer: true,
    });

    expect(migration.outcome).toBe('unsupported_version');
    expect(migration.settings).toEqual(defaultSettings);
  });

  it('is idempotent: migrating twice yields an identical result', () => {
    const once = migrateSettings(legacyWith('koblenz-stadtmitte'));
    const twice = migrateSettings(once.settings);

    expect(twice.settings).toEqual(once.settings);
    expect(twice.outcome).toBe('current');
  });

  it('is deterministic and does not mutate its input', () => {
    const raw = legacyWith('koblenz-stadtmitte');
    const snapshot = JSON.stringify(raw);

    expect(migrateSettings(raw)).toEqual(migrateSettings(raw));
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it('always stamps the current version on a migrated value', () => {
    expect(migrateSettings(legacyWith('koblenz-stadtmitte')).settings.version).toBe(
      SETTINGS_SCHEMA_VERSION,
    );
  });
});

describe('shouldPersistMigration', () => {
  it('persists only a successful migration', () => {
    expect(shouldPersistMigration(migrateSettings(legacyWith('koblenz-stadtmitte')))).toBe(true);
  });

  it.each([
    ['an already current value', CURRENT_SETTINGS],
    ['a malformed value', 'nonsense'],
    ['an absent value', undefined],
    ['a newer version', { version: SETTINGS_SCHEMA_VERSION + 1 }],
  ])('writes nothing for %s', (_reason, raw) => {
    // A failed read must never be recorded as a completed migration, and a newer build's settings must
    // survive this build reading them.
    expect(shouldPersistMigration(migrateSettings(raw))).toBe(false);
  });
});

/**
 * Only the **absence** of a `version` property identifies the original shape.
 *
 * `LegacyAppSettingsSchema` is not strict — the legacy shape was never closed — so a record carrying a version
 * alongside otherwise valid legacy fields parsed as legacy and was *migrated*: its `districtId` mapped onto a real
 * service area, and a "successful migration" written back over data this build had already failed to understand.
 * The version is what says "something that knew about versions wrote this", and reinterpreting such a record as the
 * pre-version shape is guessing.
 */
describe('a record that declares a version', () => {
  /** Otherwise perfectly valid legacy fields, so only the version marker decides the outcome. */
  const versionedLegacy = (version: unknown): Record<string, unknown> => ({
    version,
    ...legacyWith('koblenz-stadtmitte'),
  });

  it.each([
    ['its own current version, but malformed', 2],
    ['the first version', 1],
    ['zero', 0],
    ['a negative version', -1],
    ['null', null],
    ['a string', '2'],
    ['a boolean', true],
    ['an object', {}],
  ])('is not legacy-migrated when the version is %s', (_reason, version) => {
    const migration = migrateSettings(versionedLegacy(version));

    expect(migration.outcome).toBe('defaulted');
  });

  it('is not legacy-migrated when the version property is present but undefined', () => {
    /**
     * The case an own-property check exists for. `raw.version !== undefined` and a truthiness test both read this
     * as unversioned, and both are wrong: the property was written deliberately by something that knew about
     * versions.
     */
    const raw = { version: undefined, ...legacyWith('koblenz-stadtmitte') };

    expect(Object.hasOwn(raw, 'version')).toBe(true);
    expect(migrateSettings(raw).outcome).toBe('defaulted');
  });

  it.each([
    ['its own current version, but malformed', 2],
    ['the first version', 1],
    ['zero', 0],
    ['null', null],
    ['a string', '2'],
  ])('maps no district when the version is %s', (_reason, version) => {
    // The concrete harm: a verified legacy identifier would otherwise become a real selection, chosen for the
    // person by a guess about a record this build could not read.
    const migration = migrateSettings(versionedLegacy(version));

    expect(migration.settings.selection).toBeNull();
    expect(migration.settings).toEqual(defaultSettings);
  });

  it.each([
    ['its own current version, but malformed', 2],
    ['the first version', 1],
    ['zero', 0],
    ['null', null],
    ['a string', '2'],
  ])('is never written back when the version is %s', (_reason, version) => {
    // Persisting would destroy the evidence: the next read would find a v2 record and never know a migration had
    // been guessed at.
    expect(shouldPersistMigration(migrateSettings(versionedLegacy(version)))).toBe(false);
  });

  it('still reports a newer version as unsupported rather than defaulted', () => {
    // The one versioned outcome that is not merely invalid, and its behaviour is unchanged.
    const migration = migrateSettings({
      ...CURRENT_SETTINGS,
      version: SETTINGS_SCHEMA_VERSION + 1,
    });

    expect(migration.outcome).toBe('unsupported_version');
    expect(shouldPersistMigration(migration)).toBe(false);
  });

  it('still reports a newer version as unsupported even carrying legacy fields', () => {
    const migration = migrateSettings(versionedLegacy(SETTINGS_SCHEMA_VERSION + 1));

    expect(migration.outcome).toBe('unsupported_version');
    expect(migration.settings.selection).toBeNull();
  });

  it('accepts a valid current record unchanged', () => {
    // The counterweight: declaring a version is not itself a problem.
    const migration = migrateSettings(CURRENT_SETTINGS);

    expect(migration.outcome).toBe('current');
    expect(migration.settings).toEqual(CURRENT_SETTINGS);
  });
});

describe('a record that declares no version', () => {
  it('is the only shape that enters the legacy branch, and it migrates', () => {
    const migration = migrateSettings(legacyWith('koblenz-stadtmitte'));

    expect(migration.outcome).toBe('migrated');
    expect(migration.settings.selection).toEqual({
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-stadtmitte',
    });
    expect(shouldPersistMigration(migration)).toBe(true);
  });

  it('migrates an unknown district to no selection at all', () => {
    // Unchanged: only a hand-verified identifier has an official counterpart, and none is invented.
    const migration = migrateSettings(legacyWith('koblenz-unverified'));

    expect(migration.outcome).toBe('migrated');
    expect(migration.settings.selection).toBeNull();
  });

  it('is unaffected by a version reached through the prototype chain', () => {
    /**
     * `hasOwn` rather than `in`. A `version` inherited from a prototype was never written to this record, and
     * treating it as declared would refuse to migrate legitimate legacy data — a real hazard, because a value
     * revived from JSON by something that set a prototype would silently stop migrating.
     */
    const raw = Object.create({ version: 1 }) as Record<string, unknown>;

    Object.assign(raw, legacyWith('koblenz-stadtmitte'));

    expect('version' in raw).toBe(true);
    expect(Object.hasOwn(raw, 'version')).toBe(false);
    expect(migrateSettings(raw).outcome).toBe('migrated');
  });

  it('remains idempotent: migrating the result again changes nothing', () => {
    const once = migrateSettings(legacyWith('koblenz-stadtmitte'));
    const twice = migrateSettings(once.settings);

    expect(twice.outcome).toBe('current');
    expect(twice.settings).toEqual(once.settings);
  });
});
