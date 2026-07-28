import { storage } from 'wxt/utils/storage';
import { z } from 'zod';
import { WasteTypeSchema } from '@abfall-radar/domain';

export const ReminderTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const AppSettingsSchema = z.object({
  districtId: z.string().min(1),
  remindersEnabled: z.boolean(),
  reminderDaysBefore: z.number().int().min(0).max(7),
  reminderTime: ReminderTimeSchema,
  visibleWasteTypes: z.array(WasteTypeSchema).min(1),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const defaultSettings: AppSettings = {
  districtId: 'koblenz-stadtmitte',
  remindersEnabled: true,
  reminderDaysBefore: 1,
  reminderTime: '18:00',
  visibleWasteTypes: ['residual', 'bio', 'paper', 'yellow_bag', 'green_waste', 'small_electronics'],
};

export const appSettingsItem = storage.defineItem<AppSettings>('local:settings', {
  fallback: defaultSettings,
});

export const lastReminderItem = storage.defineItem<string | null>('local:last-reminder', {
  fallback: null,
});

export const resolveSettings = (value: unknown): AppSettings => {
  const parsed = AppSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultSettings;
};

export const getSettings = async (): Promise<AppSettings> =>
  resolveSettings(await appSettingsItem.getValue());

export const updateSettings = async (settings: AppSettings): Promise<void> => {
  await appSettingsItem.setValue(AppSettingsSchema.parse(settings));
};
