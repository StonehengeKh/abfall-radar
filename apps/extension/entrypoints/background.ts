import { createApiClient } from '@abfall-radar/api-client';
import { createGateway } from '@/src/background/gateway';
import { REMINDER_ALARM, scheduleNextReminder, showReminder } from '@/src/background/reminder';
import { API_ORIGIN } from '@/src/config/api';
import { watchSettings } from '@/src/storage/settings-repository';

/**
 * The background service worker: the only place in the extension that constructs an HTTP request.
 *
 * Manifest V3 has one place where a network boundary belongs. The worker owns lifecycle, storage, and
 * alarms; a popup is a short-lived window that can be closed mid-request, so a request in flight when it
 * closes would have nowhere to deliver a validated response and the cache would never be written by
 * exactly the requests most likely to matter.
 */
export default defineBackground(() => {
  const gateway = createGateway({
    client: createApiClient({ baseUrl: API_ORIGIN }),
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // `sendResponse` plus `return true` is the selected compatibility baseline for the Chrome versions this
    // project supports, not a claim about what Chrome will support later: a promise-returning listener is a
    // viable alternative the moment that baseline makes it uniformly available.
    //
    // The handler never rejects, so `sendResponse` is always called exactly once. A dropped reply would
    // leave the popup waiting on something that never arrives.
    void gateway.handle(message).then(sendResponse);

    return true;
  });

  browser.runtime.onInstalled.addListener(() => {
    void scheduleNextReminder();
  });

  browser.runtime.onStartup.addListener(() => {
    void scheduleNextReminder();
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== REMINDER_ALARM) {
      return;
    }

    void showReminder({ gateway }).finally(() => scheduleNextReminder());
  });

  // Migrated settings only: the raw stored object is never read here, because a second raw reader is how a
  // half-migrated value reaches a product surface.
  watchSettings((settings) => {
    void scheduleNextReminder(settings);
  });
});
