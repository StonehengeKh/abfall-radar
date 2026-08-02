import { z } from 'zod';
import {
  type AppSettings,
  AppSettingsSchema,
  defaultSettings,
  LegacyAppSettingsSchema,
  SETTINGS_SCHEMA_VERSION,
  type ServiceAreaSelection,
} from './settings';

/**
 * Migrates whatever is on disk onto the current settings shape.
 *
 * Pure, deterministic, and idempotent: it takes the raw stored value and returns settings plus what the
 * caller should do about them. No storage access, no clock, no randomness.
 */

/**
 * The **only** automatic mapping, written as a literal table.
 *
 * It is a hand-recorded fact from AR-003's source verification record — the official Stadtmitte area is
 * the same real place as the demo Stadtmitte district — and **not** a rule derived from the two
 * identifiers happening to match. No other legacy identifier has a verified official counterpart, so
 * none is invented: mapping by name similarity would silently move a person to an area nobody checked,
 * and a wrong collection area produces confidently wrong dates.
 */
const VERIFIED_LEGACY_SELECTIONS: Readonly<Record<string, ServiceAreaSelection>> = {
  'koblenz-stadtmitte': {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-stadtmitte',
  },
};

export type SettingsMigrationOutcome =
  /** Already current. Nothing to write. */
  | 'current'
  /** Migrated from the legacy shape. The new version is persisted only for this outcome. */
  | 'migrated'
  /** Absent or unreadable. Defaults are used in memory and nothing is written. */
  | 'defaulted'
  /** Written by a newer build. Defaults are used in memory and **nothing is written**. */
  | 'unsupported_version';

export interface SettingsMigration {
  readonly outcome: SettingsMigrationOutcome;
  readonly settings: AppSettings;
}

/**
 * Reads only the version marker, so a value written by a future build can be recognized before this
 * build's schema rejects it.
 */
const VersionMarkerSchema = z.object({ version: z.number() });

const migrateLegacySelection = (districtId: string): ServiceAreaSelection | null =>
  VERIFIED_LEGACY_SELECTIONS[districtId] ?? null;

/**
 * Whether the stored object **declares a version at all**.
 *
 * This is what separates the original unversioned shape from every later one, and it is the whole
 * classification. `LegacyAppSettingsSchema` is not strict — it cannot be, because the legacy shape was never
 * closed — so a record carrying `version: 1`, `version: null`, or a malformed `version: 2` alongside otherwise
 * valid legacy fields parsed as legacy and was **migrated**: its `districtId` mapped, and a "successful
 * migration" written back over data this build had already failed to understand.
 *
 * An own-property check rather than `raw.version !== undefined` or a truthiness test, because those three
 * disagree on exactly the values that matter. `{ version: undefined }` was explicitly written by *something*
 * that knew about versions, and `version: 0` is falsy while being a perfectly deliberate marker. Only the
 * absence of the property means "written before versions existed".
 *
 * Inherited properties do not count either: a `version` reached through the prototype chain was never written
 * to this record, and `hasOwn` is what keeps a polluted prototype from reclassifying legitimate legacy data.
 */
const declaresVersion = (raw: unknown): boolean =>
  typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'version');

export const migrateSettings = (raw: unknown): SettingsMigration => {
  // 1. Nothing stored. A fresh installation, which is not a failure and writes nothing.
  if (raw === null || raw === undefined) {
    return { outcome: 'defaulted', settings: defaultSettings };
  }

  // 2. Already exactly what this build stores.
  const current = AppSettingsSchema.safeParse(raw);

  if (current.success) {
    return { outcome: 'current', settings: current.data };
  }

  // 3. Versioned, and not this version. Never legacy, whatever else it happens to contain.
  if (declaresVersion(raw)) {
    const marker = VersionMarkerSchema.safeParse(raw);

    if (marker.success && marker.data.version > SETTINGS_SCHEMA_VERSION) {
      // A newer build wrote this. Defaults are used for this session, and the stored value is left exactly
      // as it is: overwriting it would destroy settings this build cannot represent but a newer one can.
      return { outcome: 'unsupported_version', settings: defaultSettings };
    }

    /**
     * Versioned data this build cannot read: a malformed record of its own version, a version it has already
     * migrated past, or a marker that is not a number at all.
     *
     * Defaults in memory and **nothing written**, which is the same treatment any unreadable value gets. No
     * `districtId` is mapped and no migration is recorded: the record says it was written by something that
     * knew about versions, so reinterpreting its fields as the pre-version shape would be guessing — and the
     * guess would be persisted as a completed migration, destroying the evidence.
     */
    return { outcome: 'defaulted', settings: defaultSettings };
  }

  // 4. No version declared, so this is the only shape it can be.
  const legacy = LegacyAppSettingsSchema.safeParse(raw);

  if (!legacy.success) {
    // Unversioned and not the legacy shape either. Defaults in memory, nothing written, so a failure cannot
    // be mistaken for a completed migration on the next read.
    return { outcome: 'defaulted', settings: defaultSettings };
  }

  // Everything unrelated to the selection is carried across untouched.
  return {
    outcome: 'migrated',
    settings: {
      version: SETTINGS_SCHEMA_VERSION,
      selection: migrateLegacySelection(legacy.data.districtId),
      remindersEnabled: legacy.data.remindersEnabled,
      reminderDaysBefore: legacy.data.reminderDaysBefore,
      reminderTime: legacy.data.reminderTime,
      visibleWasteTypes: [...legacy.data.visibleWasteTypes],
    },
  };
};

/**
 * Whether the migrated value should be written back.
 *
 * Only a successful migration persists the new version. A defaulted read writes nothing, so a failure is
 * never recorded as a completed migration, and an unsupported version writes nothing so a newer build's
 * settings survive.
 */
export const shouldPersistMigration = (migration: SettingsMigration): boolean =>
  migration.outcome === 'migrated';
