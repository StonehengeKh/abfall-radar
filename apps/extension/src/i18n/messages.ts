import {
  type Locale,
  SCHEDULE_MESSAGES,
  type ScheduleMessages,
} from '@abfall-radar/schedule-format';
import type { CachedReason } from '@/src/schedule/view-state';

/**
 * Every string the popup owns, in each supported language.
 *
 * The copy it shares with the website — waste names, the collection-day status, the countdown, drop-off
 * window wording, source details, and the language and appearance labels — is in
 * `@abfall-radar/schedule-format` and composed in below, so the two applications say those things in the
 * same words from one copy. What is here belongs to the popup's own flows: its onboarding, its cached and
 * offline states, its withdrawal of an area a source no longer serves, and its settings.
 *
 * Typed rather than looked up by key, so a state without copy is a TypeScript error in four languages at
 * once. A sentence that varies is written out per language, and a value placed into one is formatted
 * before it gets here, so no language has to assemble grammar from fragments.
 *
 * Deliberately absent: provider names, district names, localities, attribution and the source link. Those
 * are the operator's own words and are reproduced exactly as published, in every language.
 */

type ProblemCode =
  | 'PROVIDER_NOT_FOUND'
  | 'SERVICE_AREA_NOT_FOUND'
  | 'COLLECTION_EVENTS_NOT_AVAILABLE'
  | 'UPSTREAM_SOURCE_UNAVAILABLE'
  | 'UPSTREAM_SOURCE_INVALID';

export interface PopupMessages {
  readonly preparing: string;
  readonly header: {
    readonly openSettings: string;
    readonly back: string;
  };
  readonly unsupportedVersion: { readonly heading: string; readonly body: string };
  readonly unreadable: { readonly heading: string; readonly body: string };
  readonly withdrawal: {
    readonly heading: string;
    readonly body: string;
    readonly stalledAtCache: string;
    readonly stalledAtClear: string;
    readonly retry: string;
    readonly reset: string;
    readonly clearing: string;
  };
  readonly onboarding: {
    readonly heading: string;
    readonly intro: string;
    readonly city: string;
    readonly citiesLoading: string;
    readonly citiesFailed: string;
    readonly retryCities: string;
    readonly noCities: string;
    readonly choose: string;
    readonly provider: string;
    readonly providersLoading: string;
    readonly providersFailed: string;
    readonly retryProviders: string;
    readonly noProviders: string;
    readonly district: string;
    /** The sticky action area: what is chosen, so the choice is readable where it is acted on. */
    readonly selected: string;
    readonly noneSelected: string;
    readonly confirm: string;
    readonly confirming: string;
  };
  readonly districts: {
    readonly loading: string;
    readonly loadFailed: string;
    readonly retry: string;
    readonly empty: string;
    readonly providerUnavailable: string;
    /** Shown on a district the operator publishes no calendar for, and as its accessible description. */
    readonly unavailable: string;
    readonly unavailableHint: string;
  };
  readonly selectionErrors: {
    readonly rejectedUnavailable: string;
    readonly rejectedUnknownCapability: string;
    readonly storage: string;
  };
  readonly dashboard: {
    readonly heading: string;
    readonly loadingTitle: string;
    readonly loadingBody: string;
    readonly rangeNotCoveredTitle: string;
    readonly rangeNotCoveredBody: string;
    readonly errorTitle: string;
    readonly supportReference: string;
    readonly retry: string;
    readonly emptyTitle: string;
    readonly emptyBody: (from: string, to: string) => string;
    readonly listHeading: string;
  };
  readonly announcements: {
    readonly needsSelection: string;
    readonly loading: string;
    readonly liveFresh: string;
    readonly liveStale: string;
    readonly cached: Record<CachedReason, string>;
    readonly rangeNotCovered: string;
    readonly error: string;
  };
  readonly status: {
    readonly cachedReason: Record<CachedReason, string>;
    readonly storedAt: (instant: string) => string;
    readonly coverageBoth: (from: string, to: string) => string;
    readonly coverageHead: (from: string) => string;
    readonly coverageTail: (to: string) => string;
    readonly undeclared: (types: string) => string;
  };
  readonly failures: {
    readonly network: string;
    readonly timeout: string;
    readonly cancelled: string;
    readonly invalid_response: string;
    readonly unsupported_message: string;
    readonly problems: Record<ProblemCode, string>;
    readonly generic: string;
  };
  readonly settings: {
    readonly heading: string;
    readonly save: string;
    readonly saving: string;
    readonly reminders: string;
    readonly remindersDescription: string;
    readonly remindersToggle: string;
    readonly reminderTime: string;
    readonly wasteTypes: string;
    readonly conflict: string;
    readonly saveFailed: string;
  };
}

const de: PopupMessages = {
  preparing: 'AbfallRadar wird vorbereitet…',
  header: { openSettings: 'Einstellungen öffnen', back: 'Zurück' },
  unsupportedVersion: {
    heading: 'Neuere Einstellungen gefunden',
    body: 'Die gespeicherten Einstellungen wurden von einer neueren Version von AbfallRadar erstellt. Sie bleiben unverändert erhalten. Bitte aktualisiere die Erweiterung oder lade sie neu, um sie wieder zu verwenden.',
  },
  unreadable: {
    heading: 'Einstellungen nicht lesbar',
    body: 'Die gespeicherten Einstellungen konnten nicht gelesen werden. Bitte öffne AbfallRadar erneut.',
  },
  withdrawal: {
    heading: 'Sammelgebiet nicht mehr verfügbar',
    body: 'Für dieses Sammelgebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender mehr.',
    stalledAtCache:
      'Das Verwerfen des gespeicherten Kalenders konnte nicht bestätigt werden, deshalb bleibt die Auswahl vorläufig erhalten.',
    stalledAtClear:
      'Der gespeicherte Kalender wurde verworfen, die Auswahl konnte aber nicht zurückgesetzt werden.',
    retry: 'Erneut versuchen',
    reset: 'Auswahl zurücksetzen',
    clearing: 'Das gespeicherte Sammelgebiet wird zurückgesetzt…',
  },
  onboarding: {
    heading: 'Sammelgebiet wählen',
    intro:
      'Wähle deine Stadt und dein Sammelgebiet. Erst danach werden offizielle Termine geladen.',
    city: 'Stadt',
    citiesLoading: 'Städte werden geladen…',
    citiesFailed: 'Die Liste der Städte konnte nicht geladen werden.',
    retryCities: 'Städte erneut laden',
    noCities: 'Derzeit ist keine Stadt mit offiziellen Terminen verfügbar.',
    choose: 'Bitte wählen',
    provider: 'Entsorgungsbetrieb',
    providersLoading: 'Entsorgungsbetriebe werden geladen…',
    providersFailed: 'Die Liste der Entsorgungsbetriebe konnte nicht geladen werden.',
    retryProviders: 'Entsorgungsbetriebe erneut laden',
    noProviders: 'Für diese Stadt ist derzeit kein offizieller Entsorgungsbetrieb verfügbar.',
    district: 'Sammelgebiet',
    selected: 'Ausgewählt',
    noneSelected: 'Noch kein Gebiet ausgewählt',
    confirm: 'Auswahl bestätigen',
    confirming: 'Auswahl wird gespeichert…',
  },
  districts: {
    loading: 'Sammelgebiete werden geladen…',
    loadFailed: 'Die Sammelgebiete konnten nicht geladen werden.',
    retry: 'Sammelgebiete erneut laden',
    empty: 'Für diesen Entsorgungsbetrieb sind derzeit keine Sammelgebiete abrufbar.',
    providerUnavailable:
      'Dieser Entsorgungsbetrieb steht derzeit nicht zur Verfügung. Bitte wähle einen anderen.',
    unavailable: 'Kein offizieller Kalender veröffentlicht',
    unavailableHint:
      'Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.',
  },
  selectionErrors: {
    rejectedUnavailable:
      'Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.',
    rejectedUnknownCapability:
      'Das Gebiet konnte nicht geprüft werden. Bitte erneut versuchen, sobald die Verbindung steht.',
    storage: 'Die Auswahl konnte nicht gespeichert werden. Bitte erneut versuchen.',
  },
  dashboard: {
    heading: 'Alles im Blick',
    loadingTitle: 'Termine werden geladen',
    loadingBody: 'Die offiziellen Termine werden abgerufen.',
    rangeNotCoveredTitle: 'Kein Kalender für diesen Zeitraum',
    rangeNotCoveredBody:
      'Die offizielle Quelle veröffentlicht für den aktuellen Zeitraum keine Termine. Sobald der Betrieb den nächsten Zeitraum veröffentlicht, erscheinen die Termine hier.',
    errorTitle: 'Termine nicht verfügbar',
    supportReference: 'Referenz für den Support:',
    retry: 'Erneut versuchen',
    emptyTitle: 'Keine Abholung in diesem Zeitraum',
    emptyBody: (from, to) => `Die Quelle enthält für ${from} bis ${to} keine passende Abholung.`,
    listHeading: 'Danach',
  },
  announcements: {
    needsSelection: 'Es ist noch kein Sammelgebiet gewählt.',
    loading: 'Termine werden geladen.',
    liveFresh: 'Aktuelle offizielle Termine geladen.',
    liveStale: 'Offizielle Termine geladen. Die Quelle konnte zuletzt nicht aktualisiert werden.',
    cached: {
      refreshing: 'Gespeicherte Termine werden angezeigt. Aktualisierung läuft.',
      offline: 'Die API ist nicht erreichbar. Gespeicherte Termine werden angezeigt.',
      refresh_failed:
        'Die Aktualisierung ist fehlgeschlagen. Gespeicherte Termine werden angezeigt.',
      retained_newer:
        'Die Aktualisierung hat einen älteren Abruf der Quelle geliefert. Der neuere gespeicherte Stand wird weiterhin angezeigt.',
    },
    rangeNotCovered: 'Für diesen Zeitraum veröffentlicht die Quelle keinen Kalender.',
    error: 'Die Termine konnten nicht geladen werden.',
  },
  status: {
    cachedReason: {
      refreshing: 'Gespeicherte Termine, während die aktuellen Termine geladen werden.',
      offline: 'Gespeicherte Termine, weil die API nicht erreichbar ist.',
      refresh_failed: 'Gespeicherte Termine, weil die Aktualisierung fehlgeschlagen ist.',
      retained_newer:
        'Gespeicherte Termine, weil die Aktualisierung einen älteren Abruf der Quelle geliefert hat. Der neuere gespeicherte Stand wurde beibehalten.',
    },
    storedAt: (instant) => `Gespeichert am ${instant}.`,
    coverageBoth: (from, to) =>
      `Die gespeicherten Termine liegen nur vom ${from} bis zum ${to} vor. Für die Zeit davor und danach liegen offline keine Daten vor.`,
    coverageHead: (from) =>
      `Die gespeicherten Termine liegen erst ab dem ${from} vor. Für die Zeit davor liegen offline keine Daten vor.`,
    coverageTail: (to) =>
      `Die gespeicherten Termine reichen nur bis zum ${to}. Für die Zeit danach liegen offline keine Daten vor.`,
    undeclared: (types) => `Diese Quelle veröffentlicht keine Termine für ${types}.`,
  },
  failures: {
    network: 'Die AbfallRadar-API ist nicht erreichbar. Prüfe deine Verbindung.',
    timeout: 'Die Anfrage an die AbfallRadar-API hat zu lange gedauert.',
    cancelled: 'Die Anfrage wurde abgebrochen.',
    invalid_response: 'Die Antwort der AbfallRadar-API war unlesbar.',
    unsupported_message: 'Die Erweiterung konnte die Termine nicht abrufen.',
    problems: {
      PROVIDER_NOT_FOUND:
        'Dieser Entsorgungsbetrieb ist nicht mehr verfügbar. Bitte wähle ihn neu.',
      SERVICE_AREA_NOT_FOUND: 'Dieses Sammelgebiet ist nicht mehr verfügbar. Bitte wähle es neu.',
      COLLECTION_EVENTS_NOT_AVAILABLE:
        'Für dieses Sammelgebiet veröffentlicht der Betrieb keinen offiziellen Kalender.',
      UPSTREAM_SOURCE_UNAVAILABLE: 'Die offizielle Quelle ist derzeit nicht erreichbar.',
      UPSTREAM_SOURCE_INVALID: 'Die offizielle Quelle konnte nicht ausgewertet werden.',
    },
    generic: 'Die Termine konnten nicht geladen werden.',
  },
  settings: {
    heading: 'Einstellungen',
    save: 'Einstellungen speichern',
    saving: 'Wird gespeichert…',
    reminders: 'Erinnerungen',
    remindersDescription: 'Am Vorabend erinnern',
    remindersToggle: 'Erinnerungen aktivieren',
    reminderTime: 'Uhrzeit',
    wasteTypes: 'Abfallarten',
    conflict:
      'Das gespeicherte Sammelgebiet hat sich zwischenzeitlich geändert. Die Einstellungen wurden nicht gespeichert. Bitte schließe die Einstellungen und prüfe die Auswahl erneut.',
    saveFailed: 'Die Einstellungen konnten nicht gespeichert werden. Bitte erneut versuchen.',
  },
};

const en: PopupMessages = {
  preparing: 'Getting AbfallRadar ready…',
  header: { openSettings: 'Open settings', back: 'Back' },
  unsupportedVersion: {
    heading: 'Newer settings found',
    body: 'The stored settings were created by a newer version of AbfallRadar. They are kept exactly as they are. Please update or reload the extension to use them again.',
  },
  unreadable: {
    heading: 'Settings unreadable',
    body: 'The stored settings could not be read. Please open AbfallRadar again.',
  },
  withdrawal: {
    heading: 'District no longer available',
    body: 'The operator no longer publishes an official calendar for this district.',
    stalledAtCache:
      'Discarding the stored calendar could not be confirmed, so the selection is kept for now.',
    stalledAtClear: 'The stored calendar was discarded, but the selection could not be reset.',
    retry: 'Try again',
    reset: 'Reset selection',
    clearing: 'Resetting the stored district…',
  },
  onboarding: {
    heading: 'Choose your district',
    intro: 'Choose your city and your district. Official dates are loaded only after that.',
    city: 'City',
    citiesLoading: 'Loading cities…',
    citiesFailed: 'The list of cities could not be loaded.',
    retryCities: 'Load cities again',
    noCities: 'No city with official dates is available at the moment.',
    choose: 'Please choose',
    provider: 'Waste operator',
    providersLoading: 'Loading waste operators…',
    providersFailed: 'The list of waste operators could not be loaded.',
    retryProviders: 'Load waste operators again',
    noProviders: 'No official waste operator is available for this city at the moment.',
    district: 'District',
    selected: 'Selected',
    noneSelected: 'No district selected yet',
    confirm: 'Confirm selection',
    confirming: 'Saving selection…',
  },
  districts: {
    loading: 'Loading districts…',
    loadFailed: 'The districts could not be loaded.',
    retry: 'Load districts again',
    empty: 'No districts are currently available from this waste operator.',
    providerUnavailable:
      'This waste operator is not available at the moment. Please choose another.',
    unavailable: 'No official calendar published',
    unavailableHint: 'The operator publishes no official calendar for this district.',
  },
  selectionErrors: {
    rejectedUnavailable: 'The operator publishes no official calendar for this district.',
    rejectedUnknownCapability:
      'The district could not be checked. Please try again once you are connected.',
    storage: 'The selection could not be saved. Please try again.',
  },
  dashboard: {
    heading: 'Everything at a glance',
    loadingTitle: 'Loading dates',
    loadingBody: 'The official dates are being retrieved.',
    rangeNotCoveredTitle: 'No calendar for this period',
    rangeNotCoveredBody:
      'The official source publishes no dates for the current period. Once the operator publishes the next period, the dates will appear here.',
    errorTitle: 'Dates not available',
    supportReference: 'Support reference:',
    retry: 'Try again',
    emptyTitle: 'No collection in this period',
    emptyBody: (from, to) => `The source lists no matching collection from ${from} to ${to}.`,
    listHeading: 'After that',
  },
  announcements: {
    needsSelection: 'No district has been chosen yet.',
    loading: 'Loading dates.',
    liveFresh: 'Current official dates loaded.',
    liveStale: 'Official dates loaded. The source could not be refreshed recently.',
    cached: {
      refreshing: 'Showing stored dates. Refreshing.',
      offline: 'The API is unreachable. Showing stored dates.',
      refresh_failed: 'The refresh failed. Showing stored dates.',
      retained_newer:
        'The refresh returned an older retrieval of the source. The newer stored version is still shown.',
    },
    rangeNotCovered: 'The source publishes no calendar for this period.',
    error: 'The dates could not be loaded.',
  },
  status: {
    cachedReason: {
      refreshing: 'Stored dates, while the current dates are loading.',
      offline: 'Stored dates, because the API is unreachable.',
      refresh_failed: 'Stored dates, because the refresh failed.',
      retained_newer:
        'Stored dates, because the refresh returned an older retrieval of the source. The newer stored version was kept.',
    },
    storedAt: (instant) => `Stored on ${instant}.`,
    coverageBoth: (from, to) =>
      `The stored dates cover only ${from} to ${to}. There is no offline data before or after that.`,
    coverageHead: (from) =>
      `The stored dates start only on ${from}. There is no offline data before that.`,
    coverageTail: (to) => `The stored dates reach only ${to}. There is no offline data after that.`,
    undeclared: (types) => `This source publishes no dates for ${types}.`,
  },
  failures: {
    network: 'The AbfallRadar API is unreachable. Please check your connection.',
    timeout: 'The request to the AbfallRadar API took too long.',
    cancelled: 'The request was cancelled.',
    invalid_response: 'The response from the AbfallRadar API could not be read.',
    unsupported_message: 'The extension could not retrieve the dates.',
    problems: {
      PROVIDER_NOT_FOUND: 'This waste operator is no longer available. Please choose it again.',
      SERVICE_AREA_NOT_FOUND: 'This district is no longer available. Please choose it again.',
      COLLECTION_EVENTS_NOT_AVAILABLE:
        'The operator publishes no official calendar for this district.',
      UPSTREAM_SOURCE_UNAVAILABLE: 'The official source is unreachable at the moment.',
      UPSTREAM_SOURCE_INVALID: 'The official source could not be read.',
    },
    generic: 'The dates could not be loaded.',
  },
  settings: {
    heading: 'Settings',
    save: 'Save settings',
    saving: 'Saving…',
    reminders: 'Reminders',
    remindersDescription: 'Remind me the evening before',
    remindersToggle: 'Turn on reminders',
    reminderTime: 'Time',
    wasteTypes: 'Waste types',
    conflict:
      'The stored district changed in the meantime. The settings were not saved. Please close the settings and check the selection again.',
    saveFailed: 'The settings could not be saved. Please try again.',
  },
};

const uk: PopupMessages = {
  preparing: 'AbfallRadar готується…',
  header: { openSettings: 'Відкрити налаштування', back: 'Назад' },
  unsupportedVersion: {
    heading: 'Знайдено новіші налаштування',
    body: 'Збережені налаштування створено новішою версією AbfallRadar. Вони залишаються без змін. Оновіть або перезавантажте розширення, щоб знову ними користуватися.',
  },
  unreadable: {
    heading: 'Налаштування не вдалося прочитати',
    body: 'Збережені налаштування не вдалося прочитати. Відкрийте AbfallRadar ще раз.',
  },
  withdrawal: {
    heading: 'Район більше недоступний',
    body: 'Оператор більше не публікує офіційний календар для цього району.',
    stalledAtCache:
      'Не вдалося підтвердити видалення збереженого календаря, тому вибір поки що збережено.',
    stalledAtClear: 'Збережений календар видалено, але вибір скинути не вдалося.',
    retry: 'Спробувати ще раз',
    reset: 'Скинути вибір',
    clearing: 'Збережений район скидається…',
  },
  onboarding: {
    heading: 'Оберіть район',
    intro: 'Оберіть своє місто та район. Лише після цього завантажуються офіційні дати.',
    city: 'Місто',
    citiesLoading: 'Завантаження міст…',
    citiesFailed: 'Не вдалося завантажити список міст.',
    retryCities: 'Завантажити міста ще раз',
    noCities: 'Зараз немає міста з офіційними датами.',
    choose: 'Оберіть',
    provider: 'Оператор вивезення',
    providersLoading: 'Завантаження операторів вивезення…',
    providersFailed: 'Не вдалося завантажити список операторів вивезення.',
    retryProviders: 'Завантажити операторів ще раз',
    noProviders: 'Для цього міста зараз немає офіційного оператора вивезення.',
    district: 'Район',
    selected: 'Обрано',
    noneSelected: 'Район ще не обрано',
    confirm: 'Підтвердити вибір',
    confirming: 'Вибір зберігається…',
  },
  districts: {
    loading: 'Завантаження районів…',
    loadFailed: 'Не вдалося завантажити райони.',
    retry: 'Завантажити райони ще раз',
    empty: 'У цього оператора зараз немає доступних районів.',
    providerUnavailable: 'Цей оператор зараз недоступний. Оберіть іншого.',
    unavailable: 'Офіційний календар не опубліковано',
    unavailableHint: 'Оператор не публікує офіційний календар для цього району.',
  },
  selectionErrors: {
    rejectedUnavailable: 'Оператор не публікує офіційний календар для цього району.',
    rejectedUnknownCapability:
      'Не вдалося перевірити район. Спробуйте ще раз, коли з’явиться з’єднання.',
    storage: 'Не вдалося зберегти вибір. Спробуйте ще раз.',
  },
  dashboard: {
    heading: 'Усе в полі зору',
    loadingTitle: 'Завантаження дат',
    loadingBody: 'Офіційні дати завантажуються.',
    rangeNotCoveredTitle: 'Немає календаря на цей період',
    rangeNotCoveredBody:
      'Офіційне джерело не публікує дат на поточний період. Щойно оператор опублікує наступний період, дати з’являться тут.',
    errorTitle: 'Дати недоступні',
    supportReference: 'Ідентифікатор для підтримки:',
    retry: 'Спробувати ще раз',
    emptyTitle: 'У цьому періоді вивезення немає',
    emptyBody: (from, to) => `Джерело не містить відповідного вивезення з ${from} по ${to}.`,
    listHeading: 'Далі',
  },
  announcements: {
    needsSelection: 'Район ще не обрано.',
    loading: 'Завантаження дат.',
    liveFresh: 'Завантажено актуальні офіційні дати.',
    liveStale: 'Офіційні дати завантажено. Останнім часом джерело не вдалося оновити.',
    cached: {
      refreshing: 'Показано збережені дати. Триває оновлення.',
      offline: 'API недоступний. Показано збережені дати.',
      refresh_failed: 'Оновлення не вдалося. Показано збережені дати.',
      retained_newer:
        'Оновлення повернуло старіше отримання з джерела. Новішу збережену версію показано й надалі.',
    },
    rangeNotCovered: 'Джерело не публікує календар на цей період.',
    error: 'Не вдалося завантажити дати.',
  },
  status: {
    cachedReason: {
      refreshing: 'Збережені дати, поки завантажуються актуальні.',
      offline: 'Збережені дати, бо API недоступний.',
      refresh_failed: 'Збережені дати, бо оновлення не вдалося.',
      retained_newer:
        'Збережені дати, бо оновлення повернуло старіше отримання з джерела. Новішу збережену версію залишено.',
    },
    storedAt: (instant) => `Збережено ${instant}.`,
    coverageBoth: (from, to) =>
      `Збережені дати охоплюють лише період з ${from} по ${to}. Даних офлайн до і після цього немає.`,
    coverageHead: (from) =>
      `Збережені дати починаються лише з ${from}. Даних офлайн до цього немає.`,
    coverageTail: (to) => `Збережені дати сягають лише ${to}. Даних офлайн після цього немає.`,
    undeclared: (types) => `Це джерело не публікує дат для: ${types}.`,
  },
  failures: {
    network: 'API AbfallRadar недоступний. Перевірте з’єднання.',
    timeout: 'Запит до API AbfallRadar тривав надто довго.',
    cancelled: 'Запит скасовано.',
    invalid_response: 'Відповідь API AbfallRadar не вдалося прочитати.',
    unsupported_message: 'Розширенню не вдалося отримати дати.',
    problems: {
      PROVIDER_NOT_FOUND: 'Цей оператор більше недоступний. Оберіть його ще раз.',
      SERVICE_AREA_NOT_FOUND: 'Цей район більше недоступний. Оберіть його ще раз.',
      COLLECTION_EVENTS_NOT_AVAILABLE: 'Оператор не публікує офіційний календар для цього району.',
      UPSTREAM_SOURCE_UNAVAILABLE: 'Офіційне джерело зараз недоступне.',
      UPSTREAM_SOURCE_INVALID: 'Офіційне джерело не вдалося обробити.',
    },
    generic: 'Не вдалося завантажити дати.',
  },
  settings: {
    heading: 'Налаштування',
    save: 'Зберегти налаштування',
    saving: 'Зберігається…',
    reminders: 'Нагадування',
    remindersDescription: 'Нагадувати напередодні ввечері',
    remindersToggle: 'Увімкнути нагадування',
    reminderTime: 'Час',
    wasteTypes: 'Види відходів',
    conflict:
      'Збережений район тим часом змінився. Налаштування не збережено. Закрийте налаштування та перевірте вибір ще раз.',
    saveFailed: 'Не вдалося зберегти налаштування. Спробуйте ще раз.',
  },
};

const ru: PopupMessages = {
  preparing: 'AbfallRadar готовится…',
  header: { openSettings: 'Открыть настройки', back: 'Назад' },
  unsupportedVersion: {
    heading: 'Найдены более новые настройки',
    body: 'Сохранённые настройки созданы более новой версией AbfallRadar. Они остаются без изменений. Обновите или перезагрузите расширение, чтобы снова ими пользоваться.',
  },
  unreadable: {
    heading: 'Настройки не удалось прочитать',
    body: 'Сохранённые настройки не удалось прочитать. Откройте AbfallRadar ещё раз.',
  },
  withdrawal: {
    heading: 'Район больше недоступен',
    body: 'Оператор больше не публикует официальный календарь для этого района.',
    stalledAtCache:
      'Не удалось подтвердить удаление сохранённого календаря, поэтому выбор пока сохранён.',
    stalledAtClear: 'Сохранённый календарь удалён, но выбор сбросить не удалось.',
    retry: 'Повторить',
    reset: 'Сбросить выбор',
    clearing: 'Сохранённый район сбрасывается…',
  },
  onboarding: {
    heading: 'Выберите район',
    intro: 'Выберите свой город и район. Только после этого загружаются официальные даты.',
    city: 'Город',
    citiesLoading: 'Загрузка городов…',
    citiesFailed: 'Не удалось загрузить список городов.',
    retryCities: 'Загрузить города ещё раз',
    noCities: 'Сейчас нет города с официальными датами.',
    choose: 'Выберите',
    provider: 'Оператор вывоза',
    providersLoading: 'Загрузка операторов вывоза…',
    providersFailed: 'Не удалось загрузить список операторов вывоза.',
    retryProviders: 'Загрузить операторов ещё раз',
    noProviders: 'Для этого города сейчас нет официального оператора вывоза.',
    district: 'Район',
    selected: 'Выбрано',
    noneSelected: 'Район ещё не выбран',
    confirm: 'Подтвердить выбор',
    confirming: 'Выбор сохраняется…',
  },
  districts: {
    loading: 'Загрузка районов…',
    loadFailed: 'Не удалось загрузить районы.',
    retry: 'Загрузить районы ещё раз',
    empty: 'У этого оператора сейчас нет доступных районов.',
    providerUnavailable: 'Этот оператор сейчас недоступен. Выберите другого.',
    unavailable: 'Официальный календарь не опубликован',
    unavailableHint: 'Оператор не публикует официальный календарь для этого района.',
  },
  selectionErrors: {
    rejectedUnavailable: 'Оператор не публикует официальный календарь для этого района.',
    rejectedUnknownCapability:
      'Не удалось проверить район. Повторите попытку, когда появится соединение.',
    storage: 'Не удалось сохранить выбор. Повторите попытку.',
  },
  dashboard: {
    heading: 'Всё под контролем',
    loadingTitle: 'Загрузка дат',
    loadingBody: 'Официальные даты загружаются.',
    rangeNotCoveredTitle: 'Нет календаря на этот период',
    rangeNotCoveredBody:
      'Официальный источник не публикует дат на текущий период. Как только оператор опубликует следующий период, даты появятся здесь.',
    errorTitle: 'Даты недоступны',
    supportReference: 'Идентификатор для поддержки:',
    retry: 'Повторить',
    emptyTitle: 'В этом периоде вывоза нет',
    emptyBody: (from, to) => `Источник не содержит подходящего вывоза с ${from} по ${to}.`,
    listHeading: 'Далее',
  },
  announcements: {
    needsSelection: 'Район ещё не выбран.',
    loading: 'Загрузка дат.',
    liveFresh: 'Загружены актуальные официальные даты.',
    liveStale: 'Официальные даты загружены. В последнее время источник не удалось обновить.',
    cached: {
      refreshing: 'Показаны сохранённые даты. Идёт обновление.',
      offline: 'API недоступен. Показаны сохранённые даты.',
      refresh_failed: 'Обновление не удалось. Показаны сохранённые даты.',
      retained_newer:
        'Обновление вернуло более старое получение из источника. Более новая сохранённая версия по-прежнему показана.',
    },
    rangeNotCovered: 'Источник не публикует календарь на этот период.',
    error: 'Не удалось загрузить даты.',
  },
  status: {
    cachedReason: {
      refreshing: 'Сохранённые даты, пока загружаются актуальные.',
      offline: 'Сохранённые даты, потому что API недоступен.',
      refresh_failed: 'Сохранённые даты, потому что обновление не удалось.',
      retained_newer:
        'Сохранённые даты, потому что обновление вернуло более старое получение из источника. Более новая сохранённая версия оставлена.',
    },
    storedAt: (instant) => `Сохранено ${instant}.`,
    coverageBoth: (from, to) =>
      `Сохранённые даты охватывают только период с ${from} по ${to}. Данных офлайн до и после этого нет.`,
    coverageHead: (from) =>
      `Сохранённые даты начинаются только с ${from}. Данных офлайн до этого нет.`,
    coverageTail: (to) =>
      `Сохранённые даты доходят только до ${to}. Данных офлайн после этого нет.`,
    undeclared: (types) => `Этот источник не публикует дат для: ${types}.`,
  },
  failures: {
    network: 'API AbfallRadar недоступен. Проверьте соединение.',
    timeout: 'Запрос к API AbfallRadar длился слишком долго.',
    cancelled: 'Запрос отменён.',
    invalid_response: 'Ответ API AbfallRadar не удалось прочитать.',
    unsupported_message: 'Расширению не удалось получить даты.',
    problems: {
      PROVIDER_NOT_FOUND: 'Этот оператор больше недоступен. Выберите его заново.',
      SERVICE_AREA_NOT_FOUND: 'Этот район больше недоступен. Выберите его заново.',
      COLLECTION_EVENTS_NOT_AVAILABLE:
        'Оператор не публикует официальный календарь для этого района.',
      UPSTREAM_SOURCE_UNAVAILABLE: 'Официальный источник сейчас недоступен.',
      UPSTREAM_SOURCE_INVALID: 'Официальный источник не удалось обработать.',
    },
    generic: 'Не удалось загрузить даты.',
  },
  settings: {
    heading: 'Настройки',
    save: 'Сохранить настройки',
    saving: 'Сохраняется…',
    reminders: 'Напоминания',
    remindersDescription: 'Напоминать накануне вечером',
    remindersToggle: 'Включить напоминания',
    reminderTime: 'Время',
    wasteTypes: 'Виды отходов',
    conflict:
      'Сохранённый район за это время изменился. Настройки не сохранены. Закройте настройки и проверьте выбор ещё раз.',
    saveFailed: 'Не удалось сохранить настройки. Повторите попытку.',
  },
};

/** Everything the popup renders: the shared schedule copy and its own, as one value. */
export type Messages = ScheduleMessages & PopupMessages;

const compose = (locale: Locale, own: PopupMessages): Messages => ({
  ...SCHEDULE_MESSAGES[locale],
  ...own,
});

export const MESSAGES: Record<Locale, Messages> = {
  de: compose('de', de),
  en: compose('en', en),
  uk: compose('uk', uk),
  ru: compose('ru', ru),
};
