import { type CollectionEvent, wasteLabels } from '@abfall-radar/domain';
import { tryToDomainCollectionEvents } from '@/src/adapters/collection-event';
import type { Gateway } from '@/src/background/gateway';
import type { CollectionEventPayload, ScheduleProvenance } from '@/src/messaging/contract';
import { isAvailable, type SourceWindow, toSourceCalendar } from '@/src/schedule/capability';
import { formatCollectionWindow } from '@/src/schedule/collection-window';
import {
  addCalendarDays,
  deriveLocalDate,
  deriveTargetRange,
  isWithinRange,
} from '@/src/schedule/schedule-range';
import { byDisplayOrder } from '@/src/schedule/view-state';
import { recordReminderShown, toReminderKey, wasReminderShown } from '@/src/storage/reminder-state';
import type { AppSettings, ServiceAreaSelection } from '@/src/storage/settings';
import { invalidateSelectionIfMatches, readSettingsState } from '@/src/storage/settings-repository';

/**
 * The collection reminder.
 *
 * Keeps its alarm name, its schedule, and its behavior. Only its data source changed: it reads settings
 * through the repository and the schedule through the worker gateway, and it never reads a provider
 * directly.
 *
 * A notification is unprompted and tells someone to act, so the rules here are stricter than for the
 * popup:
 *
 * - with no selection, nothing is shown, because there is nothing trustworthy to remind anyone about;
 * - only events **inside the safe display range** are considered, and the absence of an event outside it is
 *   never read as nothing being scheduled;
 * - a reminder derived from demo data would be the most damaging possible form of presenting sample data
 *   as official, which is why the extension no longer reads a demo provider at all.
 *
 * It does **not** depend on the popup having been opened. The cache is a fast path, not a prerequisite: when
 * nothing cached covers the day being reminded about — nothing stored, expired, evicted as inconsistent, or
 * simply served for an earlier window — this fetches a schedule itself through the same gateway the popup
 * uses. Every request, every validation, every cache write and every failure translation happens in that
 * gateway; the only thing added here is the order to ask in, and the rule that a provider is confirmed before
 * anything provider-specific is requested.
 */

export const REMINDER_ALARM = 'abfall-radar-reminder';

export const getNextReminderTimestamp = (time: string, referenceDate = new Date()): number => {
  const [hour = 18, minute = 0] = time.split(':').map(Number);
  const nextReminder = new Date(referenceDate);

  nextReminder.setHours(hour, minute, 0, 0);

  if (nextReminder.getTime() <= referenceDate.getTime()) {
    nextReminder.setDate(nextReminder.getDate() + 1);
  }

  return nextReminder.getTime();
};

export interface ReminderDependencies {
  readonly gateway: Gateway;
  readonly now?: () => Date;
}

/**
 * Brings the reminder alarm into line with the settings. The **one** place its lifecycle is decided.
 *
 * Every path that can change whether a reminder is possible ends here: installation and startup, settings
 * hydration and migration, every successful settings mutation (through the repository watcher), authoritative
 * invalidation of the selection, and the alarm callback itself once it has fired. Deciding it in one function is
 * what makes "there is an alarm exactly when a reminder could be produced" true rather than a property each call
 * site has to remember.
 *
 * It **clears first, unconditionally**, and only then decides whether to create. That is what keeps it idempotent:
 * calling it twice cannot leave two alarms, and every ineligible case ends with no alarm rather than with whatever
 * was scheduled before.
 *
 * Two things make a reminder impossible, and both now clear the alarm:
 *
 * - reminders switched off, which is the person's own instruction;
 * - **no selection**, which was the gap. An alarm was created from `remindersEnabled` alone, so a fresh install, an
 *   unknown legacy district migrated to no selection, and an area withdrawn by an authoritative response all left
 *   a recurring alarm firing against nothing. Each firing woke the service worker, read the settings, found no
 *   selection and returned — work with no possible outcome, repeating for as long as the extension was installed.
 */
export const scheduleNextReminder = async (settings?: AppSettings): Promise<void> => {
  if (settings === undefined) {
    const state = await readSettingsState();

    if (state.status === 'unsupported_version') {
      /**
       * No alarm is scheduled from defaults a newer build did not choose. The existing alarm is cleared first, so
       * a reminder scheduled by the newer build does not keep firing against settings this build cannot read.
       */
      await browser.alarms.clear(REMINDER_ALARM);

      return;
    }

    return scheduleNextReminder(state.settings);
  }

  const currentSettings = settings;

  await browser.alarms.clear(REMINDER_ALARM);

  if (!currentSettings.remindersEnabled) {
    return;
  }

  if (currentSettings.selection === null) {
    // Nothing to remind about, so nothing to wake up for. `showReminder` already refuses to notify without a
    // selection; this is what stops the alarm existing in the first place.
    return;
  }

  await browser.alarms.create(REMINDER_ALARM, {
    when: getNextReminderTimestamp(currentSettings.reminderTime),
  });
};

/**
 * A schedule reduced to the three things deciding a reminder: whose zone it is in, what period it can speak
 * for, and what it holds.
 *
 * One shape for both sources, so the selection rules below are written once. The cache and a live response
 * disagree only about *which* field states the safe period — a restored entry carries an intersection, a live
 * response was served for exactly the range requested — and mapping that here is the whole difference.
 */
interface ReminderSchedule {
  readonly provenance: ScheduleProvenance;
  /** The period this schedule may be read as complete. Nothing outside it means anything. */
  readonly displayRange: SourceWindow;
  readonly events: readonly CollectionEventPayload[];
}

/**
 * Whether a schedule can answer for the day being reminded about, and which collection is due.
 *
 * `null` covers three different situations that must all be silent: the day lies outside what this schedule
 * covers, no collection falls on it, or the one that does is a waste type the person asked not to see. Only
 * the first is a reason to look further — and the caller distinguishes them by asking again with a refreshed
 * schedule rather than by being told which it was.
 */
const dueCollection = (
  schedule: ReminderSchedule,
  settings: AppSettings,
  now: Date,
): CollectionEvent | null => {
  /**
   * Today, and therefore the day being reminded about, in the zone the **source** publishes in.
   *
   * The zone comes from the response's own validated provenance, so nothing is guessed. Using the device zone,
   * the service-worker process zone, or UTC instead would pick a different official calendar date for anyone
   * whose device is set elsewhere, and a reminder is unprompted and tells someone to act: naming the wrong day
   * is worse than saying nothing. This is the same rule the requested range already follows.
   */
  const today = deriveLocalDate(schedule.provenance.timeZone, now);
  const reminderDate = addCalendarDays(today, settings.reminderDaysBefore);

  // The day itself has to be inside what this schedule covers. Outside it there is no data, so an absence of
  // events there says nothing at all and must never be read as nothing being scheduled.
  if (!isWithinRange(reminderDate, schedule.displayRange)) {
    return null;
  }

  const mapped = tryToDomainCollectionEvents([...schedule.events]);

  if (mapped === null) {
    /**
     * The schedule could not be mapped onto the domain, so nothing is announced.
     *
     * Reported rather than thrown: this runs inside an alarm handler, where a rejection is invisible and would
     * silently end the run. Saying nothing is the correct outcome for a schedule this build cannot interpret —
     * a notification is unprompted and tells someone to act.
     */
    return null;
  }

  const events = mapped.filter((event) =>
    // Only what this schedule actually covers.
    isWithinRange(event.date, schedule.displayRange),
  );

  /**
   * Calendar-date arithmetic throughout: both sides are `YYYY-MM-DD`, so no instant and no ambient zone is
   * involved in deciding which collection is due.
   *
   * Ordered before choosing, because more than one visible collection can fall on the same day. Taking the
   * first match meant the notification named whichever waste type the response happened to list first, so two
   * runs over the same data could announce different things. The order is shared with the dashboard, so the
   * collection the notification names is the one the popup calls next.
   */
  const due = events
    .filter(
      (candidate) =>
        candidate.date === reminderDate && settings.visibleWasteTypes.includes(candidate.type),
    )
    .sort(byDisplayOrder);

  return due[0] ?? null;
};

/** A restored cache entry, read as a reminder schedule. Its safe period is the intersection it recorded. */
const fromRestored = (restored: {
  readonly schedule: {
    readonly provenance: ScheduleProvenance;
    readonly events: readonly CollectionEventPayload[];
  };
  readonly displayRange: SourceWindow;
}): ReminderSchedule => ({
  provenance: restored.schedule.provenance,
  displayRange: restored.displayRange,
  events: restored.schedule.events,
});

/**
 * Withdraws everything the extension holds for a selection a **successful** response says it cannot serve.
 *
 * One helper for all three authoritative absences, because they are the same conclusion reached at three points
 * in the same chain and they were not being treated alike: an area reported `unavailable` invalidated both the
 * cache and the selection, while a provider missing from a successful catalogue and an area missing from a
 * successful area list simply returned — leaving a stored selection nothing can serve and a cache that kept
 * answering the next alarm from it, indefinitely, for anyone who never opens the popup.
 *
 * What makes all three authoritative is the same thing: the response was fetched, validated, and *complete*. A
 * provider or an area absent from a complete list is absent, not unknown.
 *
 * The order matters. The cache is evicted **first**, so if only one of the two writes can land it is the one
 * that stops a later alarm reading the withdrawn schedule — the selection surviving only costs a repeated
 * discovery, whereas the cache surviving a cleared selection would be data with nothing left to check it
 * against. Both are attempted independently and both swallow their storage failure: neither may take down an
 * alarm handler, and the authoritative fact holds regardless of whether storage cooperated. A failure simply
 * leaves the next run to reach the same conclusion, which is why nothing here is retried in place.
 *
 * The selection is cleared by **compare-and-clear**, never unconditionally: this decision is always about a
 * selection observed earlier in a chain that can run for seconds, and somebody may have chosen a different area
 * in the meantime. Their choice is newer and stands on its own merits.
 */
const invalidateAuthoritativelyUnsupportedSelection = async (
  gateway: Gateway,
  target: ServiceAreaSelection,
): Promise<void> => {
  try {
    // Cache first, and awaited: advancing the generation is what makes a response already in flight unusable, and
    // awaiting it is what makes that a barrier rather than a hope. The eviction itself is best-effort inside the
    // worker, so this resolves whether or not storage cooperated.
    await gateway.invalidateCachedSchedule(target);
  } catch {
    // Nothing about the rejection is surfaced or retried, and it does not stop the clear below: the area
    // publishing nothing is true whether or not the entry could be removed, and a selection left pointing at it
    // would keep every later alarm rediscovering the same conclusion.
  }

  try {
    await invalidateSelectionIfMatches(target);
  } catch {
    // Storage refused the write. The selection stays, no notification is produced, and the next alarm — or the
    // popup — reaches the same conclusion and tries again.
  }
};

/**
 * Fetches a schedule for the selected area, in the same order and under the same rules as the popup.
 *
 * Nothing provider-specific is requested until a **successful** catalogue has confirmed the provider exists
 * and is not demo data: a stored selection is schema-valid but its provider is only an identifier, and a
 * reminder built from demo data would be the most damaging possible form of presenting sample data as
 * official. Every step returns `null` on failure, so a network problem, a timeout, an unreadable response, or
 * a withdrawn calendar all end the same way — no notification, and no rejection escaping into the alarm
 * handler.
 */
const refreshSchedule = async (
  gateway: Gateway,
  selection: ServiceAreaSelection,
  now: Date,
): Promise<ReminderSchedule | null> => {
  const providers = await gateway.listProviders();

  if (!providers.ok) {
    return null;
  }

  const provider = providers.data.find((candidate) => candidate.id === selection.providerId);

  if (provider === undefined || provider.sourceKind === 'demo') {
    /**
     * A successful catalogue that does not offer this provider, or offers it only as demo data, is a conclusion
     * and not a gap: this build will never serve either one. No area request and no events request follows, and
     * what is held for it is withdrawn rather than left to be rediscovered every alarm.
     */
    await invalidateAuthoritativelyUnsupportedSelection(gateway, selection);

    return null;
  }

  const areas = await gateway.listServiceAreas(selection.providerId);

  if (!areas.ok) {
    return null;
  }

  const area = areas.data.find((candidate) => candidate.id === selection.serviceAreaId);

  if (area === undefined) {
    // A complete area list that does not contain this area is the same conclusion as one that reports it
    // unavailable, so it is withdrawn the same way rather than returning quietly.
    await invalidateAuthoritativelyUnsupportedSelection(gateway, selection);

    return null;
  }

  if (!isAvailable(area.collectionEvents)) {
    // Authoritative: this area publishes no calendar any more. The alarm may well be the first thing to learn
    // it, so it withdraws through the same helper the two absences above use.
    await invalidateAuthoritativelyUnsupportedSelection(gateway, selection);

    return null;
  }

  const calendar = toSourceCalendar(area.collectionEvents);

  if (calendar === undefined) {
    return null;
  }

  const target = deriveTargetRange(calendar, now);

  if (target.kind !== 'covered') {
    // Outside the declared window, or a zone that cannot decide a date. Neither is a range to request.
    return null;
  }

  const events = await gateway.listCollectionEvents({
    providerId: selection.providerId,
    serviceAreaId: selection.serviceAreaId,
    from: target.range.from,
    to: target.range.to,
  });

  if (!events.ok) {
    return null;
  }

  // The gateway says which of the two this is. A response older than the stored entry comes back as that
  // entry, already restored against the range that was requested, so its own intersection is the safe period.
  return events.data.kind === 'live'
    ? {
        provenance: events.data.schedule.provenance,
        // A live response was served for exactly the range asked for, which is what it may speak for.
        displayRange: events.data.schedule.servedRange,
        events: events.data.schedule.events,
      }
    : fromRestored(events.data.restored);
};

/** The curbside instruction, named so the mobile-drop-off tests can assert its exact absence. */
export const CURBSIDE_REMINDER_MESSAGE =
  'Heute Abend bereitstellen, damit morgen nichts vergessen wird.';

/**
 * What a notification tells someone to **do**, decided by the collection mode.
 *
 * The two modes are opposite instructions, and using one for the other is worse than saying nothing. A curbside
 * collection is taken from the kerb, so the act is putting the waste out the evening before and leaving it. A
 * mobile drop-off is a vehicle or a stand that is somewhere for a bounded window, so the act is carrying the waste
 * there and being there in time — nothing is collected from anyone's kerb, and no amount of putting a box outside
 * achieves it. Every drop-off reminder used to carry the curbside sentence, which told people to do the one thing
 * that guarantees the waste is not collected.
 *
 * A drop-off message therefore states the window and the place, because those are what make it actionable and
 * neither is inferable. The window is formatted by the same shared function the dashboard uses, in the source's
 * own zone.
 *
 * Exhaustive over the union: a new collection mode cannot be added without deciding what it tells someone to do.
 *
 * Exported for its own tests. The `null` branch is otherwise unreachable from outside: every boundary an event can
 * arrive through validates both instants and the zone, so a schedule that reaches here formats — and a value that
 * did not would be refused by the domain adapter one layer above, for a different reason and with a different
 * outcome. Testing the branch through `showReminder` therefore proves the adapter's guard rather than this one.
 */
export const notificationMessageFor = (due: CollectionEvent): string | null => {
  switch (due.collectionMode) {
    case 'curbside':
      return CURBSIDE_REMINDER_MESSAGE;
    case 'mobile_drop_off': {
      const window = formatCollectionWindow(due.timing);

      if (window === null) {
        /**
         * The window could not be formatted, so **no** notification is produced for this event.
         *
         * Deliberately not a fallback to the curbside sentence, and not a drop-off message with the window left
         * out. Both would be worse than silence: the first tells someone to put waste outside for a collection
         * that will never come to them, and the second tells them to go somewhere without saying when — an
         * instruction that cannot be followed, delivered unprompted. Saying nothing leaves the popup, which shows
         * the same event with the same data, as the place this is discovered.
         */
        return null;
      }

      return `Mobile Annahmestelle: ${due.location.name}. Geöffnet ${window}. Bitte selbst dorthin bringen.`;
    }
  }
};

export const showReminder = async ({
  gateway,
  now = () => new Date(),
}: ReminderDependencies): Promise<void> => {
  const state = await readSettingsState();

  if (state.status === 'unsupported_version') {
    /**
     * The stored settings were written by a newer build, so this build does not know what they say.
     *
     * The migration answers such a value with *defaults*, and a reminder built from those would be a notification
     * assembled from settings nobody chose — the invented-default case this whole guard exists for. Nothing is
     * requested and nothing is shown.
     */
    return;
  }

  const settings = state.settings;

  if (settings.selection === null) {
    // No selection blocks a notification as firmly as it blocks a schedule request. Nothing is requested.
    return;
  }

  const selection = settings.selection;
  /**
   * One reading of the clock for the whole run, captured before anything is derived from it.
   *
   * A run performs several requests and can take seconds, so calling the clock again for each step could decide
   * the cached fast path in one source-local day and the refreshed schedule in the next — naming a day that was
   * the day being reminded about at neither instant. Every derivation below reads this one value.
   */
  const at = now();
  const restored = await gateway.restoreCachedSchedule(selection);

  /**
   * The cache first, and it is a fast path rather than a prerequisite.
   *
   * It answers without touching the network, so when it does cover the day being reminded about nothing is
   * fetched at all. When it does not — nothing stored, expired, evicted as inconsistent, or served for an
   * earlier window — the reminder refreshes instead of giving up, which is what makes it independent of anyone
   * having opened the popup.
   */
  const cached = restored === null ? null : dueCollection(fromRestored(restored), settings, at);

  let due = cached;

  if (due === null) {
    const refreshed = await refreshSchedule(gateway, selection, at);

    due = refreshed === null ? null : dueCollection(refreshed, settings, at);
  }

  if (due === null) {
    return;
  }

  const message = notificationMessageFor(due);

  if (message === null) {
    // Nothing this build can say correctly about this event, so nothing is said — and nothing is recorded as
    // shown either, so a later run with formattable data still reminds about it.
    return;
  }

  const reminderKey = toReminderKey(due.id, due.date);

  if (await wasReminderShown(reminderKey)) {
    return;
  }

  await browser.notifications.create(reminderKey, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icons/128.png'),
    title: `Morgen: ${wasteLabels[due.type]}`,
    message,
  });

  await recordReminderShown(reminderKey);
};
