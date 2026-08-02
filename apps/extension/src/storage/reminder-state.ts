import { storage } from 'wxt/utils/storage';

/**
 * The last reminder the extension showed, so one collection is never announced twice.
 *
 * Owned by the reminder path rather than by the settings module, which keeps `./settings` free of any
 * storage API and makes the "one repository owns the settings item" rule testable.
 */

const LAST_REMINDER_KEY = 'local:last-reminder' as const;

const lastReminderItem = storage.defineItem<string | null>(LAST_REMINDER_KEY, { fallback: null });

/** Identifies one collection occurrence. An event that moves gets a new identifier, so it re-notifies. */
export const toReminderKey = (eventId: string, date: string): string => `${eventId}:${date}`;

export const wasReminderShown = async (reminderKey: string): Promise<boolean> =>
  (await lastReminderItem.getValue()) === reminderKey;

export const recordReminderShown = async (reminderKey: string): Promise<void> => {
  await lastReminderItem.setValue(reminderKey);
};
