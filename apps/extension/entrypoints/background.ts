import { demoScheduleProvider } from '@abfall-radar/data-providers';
import { findReminderEvent, wasteLabels } from '@abfall-radar/domain';
import {
  type AppSettings,
  appSettingsItem,
  getSettings,
  lastReminderItem,
  resolveSettings,
} from '@/src/storage/settings';

const REMINDER_ALARM = 'abfall-radar-reminder';

const getNextReminderTimestamp = (time: string, referenceDate = new Date()): number => {
  const [hour = 18, minute = 0] = time.split(':').map(Number);
  const nextReminder = new Date(referenceDate);
  nextReminder.setHours(hour, minute, 0, 0);

  if (nextReminder.getTime() <= referenceDate.getTime()) {
    nextReminder.setDate(nextReminder.getDate() + 1);
  }

  return nextReminder.getTime();
};

const scheduleNextReminder = async (settings?: AppSettings): Promise<void> => {
  const currentSettings = settings ? resolveSettings(settings) : await getSettings();
  await browser.alarms.clear(REMINDER_ALARM);

  if (!currentSettings.remindersEnabled) {
    return;
  }

  await browser.alarms.create(REMINDER_ALARM, {
    when: getNextReminderTimestamp(currentSettings.reminderTime),
  });
};

const showReminder = async (): Promise<void> => {
  const settings = await getSettings();
  const schedule = await demoScheduleProvider.getSchedule(settings.districtId);
  const event = findReminderEvent(schedule, settings.reminderDaysBefore);

  if (!event || !settings.visibleWasteTypes.includes(event.type)) {
    return;
  }

  const reminderKey = `${event.id}:${event.date}`;
  if ((await lastReminderItem.getValue()) === reminderKey) {
    return;
  }

  await browser.notifications.create(reminderKey, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icons/128.png'),
    title: `Morgen: ${wasteLabels[event.type]}`,
    message: 'Heute Abend bereitstellen, damit morgen nichts vergessen wird.',
  });

  await lastReminderItem.setValue(reminderKey);
};

export default defineBackground(() => {
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

    void showReminder().finally(() => scheduleNextReminder());
  });

  appSettingsItem.watch((settings) => {
    void scheduleNextReminder(settings);
  });
});
