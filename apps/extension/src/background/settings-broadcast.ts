import { SETTINGS_CHANGED_NOTIFICATION } from '@/src/messaging/contract';

/**
 * Tells whatever popup is open that the stored settings have changed.
 *
 * The worker owns the settings outright and can change them with nobody watching: an alarm that discovers an area
 * has been withdrawn compare-and-clears the selection, and an open popup went on presenting the dashboard for an
 * area nothing could serve — until the person happened to close and reopen it. The notification is what closes
 * that gap without giving the popup its own access to storage.
 *
 * **Fire-and-forget, and that is a decision rather than laziness.** No popup being open is the ordinary case, and
 * `runtime.sendMessage` rejects when nothing is listening. A mutation that failed because nobody was watching would
 * be absurd: the write has already happened and is correct. So every rejection is swallowed here, and callers do
 * not await this — the notification is an optimization for a surface that may not exist, never part of the write.
 *
 * It carries nothing but its kind. A pushed message cannot have been validated by its recipient the way a reply to
 * its own request can, so the popup is told only that what it holds is stale and re-reads through the ordinary
 * boundary, where the value is validated as it always is.
 */
export const notifySettingsChanged = (): void => {
  try {
    const delivery = browser.runtime.sendMessage(SETTINGS_CHANGED_NOTIFICATION);

    // `sendMessage` rejects when no receiver exists, which is the common case and not a problem. Attached rather
    // than awaited, so a mutation never waits on a popup and an absent one never becomes an unhandled rejection.
    void Promise.resolve(delivery).catch(() => undefined);
  } catch {
    // A synchronous throw from the messaging API itself. Equally not the mutation's problem.
  }
};
