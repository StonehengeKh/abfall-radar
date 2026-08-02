import { WasteTypeSchema } from '@abfall-radar/domain';
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
 */
export const SETTINGS_SCHEMA_VERSION = 2;

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
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

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
