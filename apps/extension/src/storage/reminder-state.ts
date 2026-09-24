import { storage } from 'wxt/utils/storage';

/**
 * The last reminder the extension showed, so one morning is never announced twice.
 *
 * Owned by the reminder path rather than by the settings module, which keeps `./settings` free of any
 * storage API and makes the "one repository owns the settings item" rule testable.
 */

const LAST_REMINDER_KEY = 'local:last-reminder' as const;

const lastReminderItem = storage.defineItem<string | null>(LAST_REMINDER_KEY, { fallback: null });

/**
 * Identifies one reminder: the district and the day it is about.
 *
 * Keyed on the **day** rather than on a collection, because one notification now names everything due
 * that morning. Keying it on a collection meant that when the set changed between runs — an official
 * schedule that answered the first time and not the second, say — the leading collection changed, its
 * key had never been recorded, and the same morning was announced a second time.
 *
 * A collection that the operator *moves* still re-notifies: it then falls on a different day, which is a
 * different key.
 */
export const toReminderKey = (serviceAreaId: string, date: string): string =>
  `${serviceAreaId}:${date}`;

export const wasReminderShown = async (reminderKey: string): Promise<boolean> =>
  (await lastReminderItem.getValue()) === reminderKey;

export const recordReminderShown = async (reminderKey: string): Promise<void> => {
  await lastReminderItem.setValue(reminderKey);
};
