import { WasteTypeSchema } from '@abfall-radar/domain';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@abfall-radar/schedule-format';
import { z } from 'zod';

/**
 * Persisted settings: schemas and defaults only.
 *
 * This module deliberately imports no storage API. `./settings-repository` is the only reader and writer
 * of the raw storage item, because a second raw reader is exactly how a half-migrated value reaches a
 * product surface.
 */

/**
 * The version this build writes. The original shape was unversioned, which is why an absent `version`
 * identifies it rather than a `1`.
 *
 * - **2** — the selection as one `{ providerId, serviceAreaId }` value, with reminders and waste types.
 * - **3** — adds the interface language and the appearance. Everything version 2 stored is carried across
 *   unchanged, including the selection's shape; see `./settings-migration`.
 */
export const SETTINGS_SCHEMA_VERSION = 3;

/** The version before this one, still read so an existing installation migrates rather than resets. */
export const PREVIOUS_SETTINGS_SCHEMA_VERSION = 2;

/** The interface languages, from the same list the website offers. */
export const LocaleSchema = z.enum(SUPPORTED_LOCALES);

/**
 * Light, dark, or whatever the system says. The same three choices the website offers; the extension keeps
 * its own value, because the two applications have separate storage and nothing synchronizes them.
 */
export const AppearanceSchema = z.enum(['light', 'dark', 'system']);

export type Appearance = z.infer<typeof AppearanceSchema>;

export const ReminderTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/**
 * The chosen area, as **one value**. A provider without an area, or an area without a provider, is a
 * half-chosen selection that no surface could act on, so the shape makes it unrepresentable.
 */
export const ServiceAreaSelectionSchema = z.strictObject({
  providerId: z.string().min(1),
  serviceAreaId: z.string().min(1),
});

export type ServiceAreaSelection = z.infer<typeof ServiceAreaSelectionSchema>;

/** Persisted schemas are strict: an unexpected member is a defect, not a newer contract. */
export const AppSettingsSchema = z.strictObject({
  version: z.literal(SETTINGS_SCHEMA_VERSION),
  /** `null` is the explicit needs-selection state. Nothing is preselected on the user's behalf. */
  selection: ServiceAreaSelectionSchema.nullable(),
  remindersEnabled: z.boolean(),
  reminderDaysBefore: z.number().int().min(0).max(7),
  reminderTime: ReminderTimeSchema,
  visibleWasteTypes: z.array(WasteTypeSchema).min(1),
  locale: LocaleSchema,
  appearance: AppearanceSchema,
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

/**
 * The two presentation preferences.
 *
 * Written only by their own narrow operation, one field at a time, inside the worker's serialized queue — never
 * as part of a Settings draft. A draft is built from what was stored when a view opened, so carrying these in it
 * would let a stale draft put back an appearance another window had changed in the meantime.
 */
export type PresentationPreferences = Pick<AppSettings, 'locale' | 'appearance'>;

/** Everything a Settings draft may set: every stored value except the presentation preferences. */
export type SettingsDraft = Omit<AppSettings, keyof PresentationPreferences>;

/**
 * The version-2 shape exactly as that build wrote it, read for migration only.
 *
 * Strict, like the persisted schema it was: a version-2 record is something a build of this extension wrote,
 * so it is either exactly this shape or it is not a version-2 record — and then it is not migrated.
 */
export const SettingsV2Schema = z.strictObject({
  version: z.literal(PREVIOUS_SETTINGS_SCHEMA_VERSION),
  selection: ServiceAreaSelectionSchema.nullable(),
  remindersEnabled: z.boolean(),
  reminderDaysBefore: z.number().int().min(0).max(7),
  reminderTime: ReminderTimeSchema,
  visibleWasteTypes: z.array(WasteTypeSchema).min(1),
});

export type SettingsV2 = z.infer<typeof SettingsV2Schema>;

/** What a migration adds for the preferences an earlier version had no field for. */
export const DEFAULT_PRESENTATION: PresentationPreferences = {
  locale: DEFAULT_LOCALE,
  appearance: 'system',
};

/**
 * A fresh installation starts with no selection, which is what removes the last hard-coded municipality
 * from the extension's default state.
 */
export const defaultSettings: AppSettings = {
  version: SETTINGS_SCHEMA_VERSION,
  selection: null,
  remindersEnabled: true,
  reminderDaysBefore: 1,
  reminderTime: '18:00',
  visibleWasteTypes: ['residual', 'bio', 'paper', 'yellow_bag', 'green_waste', 'small_electronics'],
  ...DEFAULT_PRESENTATION,
};

/**
 * The original unversioned shape, read for migration only.
 *
 * Not strict, and that is a deliberate difference from the persisted schema above: this is a *migration
 * input* rather than something this build wrote. Every known member is still fully validated, and the
 * result is re-validated against the strict current schema before it is persisted. Being strict here
 * would mean one stray member from an older build discarded a person's reminder settings and waste-type
 * choices, which is a worse outcome than ignoring it.
 */
export const LegacyAppSettingsSchema = z.object({
  districtId: z.string().min(1),
  remindersEnabled: z.boolean(),
  reminderDaysBefore: z.number().int().min(0).max(7),
  reminderTime: ReminderTimeSchema,
  visibleWasteTypes: z.array(WasteTypeSchema).min(1),
});

export type LegacyAppSettings = z.infer<typeof LegacyAppSettingsSchema>;
