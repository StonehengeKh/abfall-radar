import { SCHEDULE_MESSAGES, type ScheduleMessages } from '@abfall-radar/schedule-format';
import type { Locale } from '@/src/i18n/locale';
import type { AppViewKind } from '@/src/schedule/view-state';

/**
 * Every string the web application owns, in each supported locale. The copy it shares with the
 * extension — waste names, the countdown, window wording, source details — is in
 * `@abfall-radar/schedule-format` and composed in below.
 *
 * Typed rather than looked up by free-form key: `Messages` is exhaustive over the view-state union, the
 * renderable failure kinds, and the waste vocabulary, so adding a state or a waste type without copy is
 * a TypeScript error in four locales at once rather than a missing string at runtime.
 *
 * Nothing here is assembled from fragments. A sentence that varies is written out per locale, and a
 * count that varies is formatted by `Intl` rather than by concatenating a number to a noun — Ukrainian
 * and Russian have three plural forms, which no amount of string joining gets right.
 *
 * What this file deliberately does **not** contain: provider names, service-area names, localities,
 * attribution, source titles, and the source link. Those are authored by the municipal operator and are
 * reproduced exactly as published, in every locale.
 */

export interface StateMessages {
  readonly heading: string;
  readonly body: string;
  /** What the polite live region announces when the state becomes current. */
  readonly announcement: string;
}

export interface WebMessages {
  readonly states: Record<AppViewKind, StateMessages>;
  readonly failures: Record<
    'network' | 'timeout' | 'invalid_response' | 'problem' | 'source_date_unavailable',
    string
  >;
  readonly problemCodes: Record<
    | 'SCHEDULE_RANGE_NOT_COVERED'
    | 'PROVIDER_NOT_FOUND'
    | 'SERVICE_AREA_NOT_FOUND'
    | 'COLLECTION_EVENTS_NOT_AVAILABLE'
    | 'UPSTREAM_SOURCE_UNAVAILABLE'
    | 'UPSTREAM_SOURCE_INVALID',
    string
  >;
  readonly notices: Record<'provider_invalidated' | 'area_unavailable', string>;
  readonly steps: {
    readonly city: string;
    readonly cityLoading: string;
    readonly provider: string;
    readonly providerLoading: string;
    readonly area: (providerName: string) => string;
    readonly areaLoading: string;
    readonly areaUnavailable: string;
    readonly retained: string;
    /** The instruction above the district grid, beside the city's own name. */
    readonly selectDistrict: string;
    /** The confirmation bar's summary: a label for the draft, and what it says before one exists. */
    readonly selected: string;
    readonly noneSelected: string;
  };
  readonly actions: Record<'back' | 'changeSelection' | 'retry' | 'confirm', string>;
  readonly diagnostics: {
    readonly identifier: string;
    readonly recoveryIdentifier: string;
    readonly rangeIdentifier: string;
    readonly lastRecoveryFailed: string;
  };
  /**
   * The page footer.
   *
   * `description` takes the city the view is about, when it knows one, so the line stays true for
   * whatever city a provider adds later instead of naming one in the message itself.
   */
  readonly footer: {
    readonly description: (city: string | null) => string;
    readonly backToTop: string;
  } /** The district search, which shows a query and a count. */;
  readonly schedule: {
    readonly searchDistricts: string;
    readonly districtCount: (shown: number, total: number) => string;
    readonly noMatches: string;
  };
}

/**
 * Everything the web application renders: the shared schedule copy and the web's own, as one value.
 *
 * `schedule` is the one section both sides write to — the shared collection-day words and the web's
 * district search — so it is merged rather than replaced, which keeps every existing lookup such as
 * `messages.schedule.inProgress` exactly as it was.
 */
export type Messages = Omit<ScheduleMessages, 'schedule'> &
  Omit<WebMessages, 'schedule'> & {
    readonly schedule: ScheduleMessages['schedule'] & WebMessages['schedule'];
  };

const de: WebMessages = {
  states: {
    configuration_error: {
      heading: 'AbfallRadar kann den Dienst von dieser Seite aus nicht sicher erreichen',
      body: 'Diese Seite läuft in einem Kontext ohne vertrauenswürdigen Ursprung. Öffnen Sie AbfallRadar direkt über eine normale http- oder https-Adresse, um die Abfuhrtermine zu laden.',
      announcement: 'AbfallRadar kann den Dienst von dieser Seite aus nicht sicher erreichen.',
    },
    needs_selection: {
      heading: 'Abfuhrtermine finden',
      body: 'Wählen Sie Ihre Stadt und Ihr Gebiet. Erst nach Ihrer Bestätigung werden Termine geladen.',
      announcement: 'Bitte wählen Sie Stadt und Gebiet.',
    },
    no_official_providers: {
      heading: 'Zurzeit kein offizieller Entsorger verfügbar',
      body: 'Es ist derzeit kein offizieller Entsorger hinterlegt. Bitte versuchen Sie es später erneut.',
      announcement: 'Zurzeit ist kein offizieller Entsorger verfügbar.',
    },
    no_service_areas: {
      heading: 'Keine Gebiete hinterlegt',
      body: 'Für diesen Entsorger sind zurzeit keine Gebiete hinterlegt.',
      announcement: 'Für diesen Entsorger sind keine Gebiete hinterlegt.',
    },
    loading: {
      heading: 'Abfuhrtermine werden geladen',
      body: 'Die Termine für Ihre Auswahl werden geladen.',
      announcement: 'Abfuhrtermine werden geladen.',
    },
    live: {
      heading: 'Ihre Abfuhrtermine',
      body: 'Alle Termine, die Ihr Entsorger für den abgedeckten Zeitraum veröffentlicht.',
      announcement: 'Abfuhrtermine geladen.',
    },
    empty: {
      heading: 'Keine Termine im abgedeckten Zeitraum',
      body: 'Ihr Entsorger veröffentlicht für den abgedeckten Zeitraum keine Termine. Das ist keine Störung.',
      announcement: 'Keine Termine im abgedeckten Zeitraum.',
    },
    range_not_covered: {
      heading: 'Für den aktuellen Zeitraum liegt kein Kalender vor',
      body: 'Ihr Entsorger veröffentlicht für den aktuellen Zeitraum keinen Kalender. AbfallRadar prüft regelmäßig, ob ein neuer Zeitraum vorliegt.',
      announcement: 'Für den aktuellen Zeitraum liegt kein Kalender vor.',
    },
    error: {
      heading: 'Die Abfuhrtermine konnten nicht geladen werden',
      body: 'Bitte versuchen Sie es erneut.',
      announcement: 'Die Abfuhrtermine konnten nicht geladen werden.',
    },
  },
  failures: {
    network: 'Der Dienst ist nicht erreichbar. Bitte prüfen Sie Ihre Verbindung.',
    timeout: 'Die Anfrage hat zu lange gedauert.',
    invalid_response: 'Der Dienst hat unbrauchbare Daten zurückgegeben.',
    problem: 'Der Dienst konnte die Anfrage nicht beantworten.',
    source_date_unavailable:
      'Das heutige Datum in der Zeitzone Ihres Entsorgers konnte nicht bestimmt werden. Deshalb werden keine Termine angezeigt.',
  },
  problemCodes: {
    SCHEDULE_RANGE_NOT_COVERED:
      'Der angefragte Zeitraum wird vom Kalender Ihres Entsorgers nicht abgedeckt.',
    PROVIDER_NOT_FOUND: 'Dieser Entsorger ist nicht mehr verfügbar.',
    SERVICE_AREA_NOT_FOUND: 'Dieses Gebiet ist nicht mehr verfügbar.',
    COLLECTION_EVENTS_NOT_AVAILABLE: 'Für dieses Gebiet sind zurzeit keine Termine abrufbar.',
    UPSTREAM_SOURCE_UNAVAILABLE: 'Die Quelle Ihres Entsorgers ist zurzeit nicht erreichbar.',
    UPSTREAM_SOURCE_INVALID: 'Die Quelle Ihres Entsorgers hat unbrauchbare Daten geliefert.',
  },
  notices: {
    provider_invalidated:
      'Dieser Anbieter ist nicht mehr verfügbar. Die Anbieterliste wird aktualisiert.',
    area_unavailable: 'Für Ihr bisheriges Gebiet veröffentlicht die Quelle keinen Kalender mehr.',
  },
  steps: {
    city: 'Stadt',
    cityLoading: 'Städte werden geladen.',
    provider: 'Entsorger',
    providerLoading: 'Entsorger werden geladen.',
    area: (providerName) => `Gebiet bei ${providerName}`,
    areaLoading: 'Gebiete werden geladen.',
    areaUnavailable: 'Für dieses Gebiet veröffentlicht die Quelle keinen Kalender.',
    retained: 'Ihre bisherige Auswahl bleibt gespeichert, bis Sie erneut bestätigen.',
    selectDistrict: 'Wählen Sie Ihr Gebiet.',
    selected: 'Ausgewählt',
    noneSelected: 'Noch kein Gebiet ausgewählt',
  },
  actions: {
    back: 'Zurück',
    changeSelection: 'Auswahl ändern',
    retry: 'Erneut versuchen',
    confirm: 'Auswahl bestätigen',
  },
  diagnostics: {
    identifier: 'Kennung',
    recoveryIdentifier: 'Kennung der Aktualisierung',
    rangeIdentifier: 'Kennung der ersten Zeitraum-Antwort',
    lastRecoveryFailed: 'Letzte Aktualisierung fehlgeschlagen',
  },
  footer: {
    description: (city) =>
      city === null ? 'Offizielle Abfuhrtermine' : `Abfuhrtermine für ${city}`,
    backToTop: 'Nach oben',
  },
  schedule: {
    searchDistricts: 'Gebiet suchen',
    districtCount: (shown, total) => `Gebiete: ${shown} von ${total}`,
    noMatches: 'Kein Gebiet gefunden.',
  },
};

const en: WebMessages = {
  states: {
    configuration_error: {
      heading: 'AbfallRadar cannot reach the service securely from this page',
      body: 'This page is running in a context without a trusted origin. Open AbfallRadar directly over an ordinary http or https address to load the collection dates.',
      announcement: 'AbfallRadar cannot reach the service securely from this page.',
    },
    needs_selection: {
      heading: 'Find collection dates',
      body: 'Choose your city and your district. Dates are loaded only after you confirm.',
      announcement: 'Please choose a city and a district.',
    },
    no_official_providers: {
      heading: 'No official waste service available right now',
      body: 'No official waste service is registered at the moment. Please try again later.',
      announcement: 'No official waste service is available right now.',
    },
    no_service_areas: {
      heading: 'No districts registered',
      body: 'This waste service has no districts registered at the moment.',
      announcement: 'This waste service has no districts registered.',
    },
    loading: {
      heading: 'Loading collection dates',
      body: 'The dates for your selection are being loaded.',
      announcement: 'Loading collection dates.',
    },
    live: {
      heading: 'Your collection dates',
      body: 'Every date your waste service publishes for the covered period.',
      announcement: 'Collection dates loaded.',
    },
    empty: {
      heading: 'No collections in the covered period',
      body: 'Your waste service publishes no collections for the covered period. This is not a fault.',
      announcement: 'No collections in the covered period.',
    },
    range_not_covered: {
      heading: 'No calendar published for the current period',
      body: 'Your waste service publishes no calendar for the current period. AbfallRadar checks regularly whether a new period is available.',
      announcement: 'No calendar is published for the current period.',
    },
    error: {
      heading: 'The collection dates could not be loaded',
      body: 'Please try again.',
      announcement: 'The collection dates could not be loaded.',
    },
  },
  failures: {
    network: 'The service cannot be reached. Please check your connection.',
    timeout: 'The request took too long.',
    invalid_response: 'The service returned unusable data.',
    problem: 'The service could not answer the request.',
    source_date_unavailable:
      'Today’s date in your waste service’s time zone could not be determined, so no collection dates are shown.',
  },
  problemCodes: {
    SCHEDULE_RANGE_NOT_COVERED:
      'The requested period is not covered by your waste service’s calendar.',
    PROVIDER_NOT_FOUND: 'This waste service is no longer available.',
    SERVICE_AREA_NOT_FOUND: 'This district is no longer available.',
    COLLECTION_EVENTS_NOT_AVAILABLE: 'No collection dates can be retrieved for this district.',
    UPSTREAM_SOURCE_UNAVAILABLE: 'Your waste service’s source cannot be reached right now.',
    UPSTREAM_SOURCE_INVALID: 'Your waste service’s source returned unusable data.',
  },
  notices: {
    provider_invalidated:
      'This provider is no longer available. The provider list is being refreshed.',
    area_unavailable: 'Your previous district no longer has a calendar published by the source.',
  },
  steps: {
    city: 'City',
    cityLoading: 'Loading cities.',
    provider: 'Waste service',
    providerLoading: 'Loading waste services.',
    area: (providerName) => `District at ${providerName}`,
    areaLoading: 'Loading districts.',
    areaUnavailable: 'The source publishes no calendar for this district.',
    retained: 'Your previous selection is kept until you confirm again.',
    selectDistrict: 'Choose your district.',
    selected: 'Selected',
    noneSelected: 'No district selected yet',
  },
  actions: {
    back: 'Back',
    changeSelection: 'Change selection',
    retry: 'Try again',
    confirm: 'Confirm selection',
  },
  diagnostics: {
    identifier: 'Reference',
    recoveryIdentifier: 'Refresh reference',
    rangeIdentifier: 'Reference of the first period response',
    lastRecoveryFailed: 'Last refresh failed',
  },
  footer: {
    description: (city) =>
      city === null ? 'Official collection dates' : `Collection dates for ${city}`,
    backToTop: 'Back to top',
  },
  schedule: {
    searchDistricts: 'Search districts',
    districtCount: (shown, total) => `Districts: ${shown} of ${total}`,
    noMatches: 'No district found.',
  },
};

const uk: WebMessages = {
  states: {
    configuration_error: {
      heading: 'AbfallRadar не може безпечно звернутися до служби з цієї сторінки',
      body: 'Ця сторінка працює в середовищі без довіреного джерела. Відкрийте AbfallRadar безпосередньо за звичайною адресою http або https, щоб завантажити дати вивезення.',
      announcement: 'AbfallRadar не може безпечно звернутися до служби з цієї сторінки.',
    },
    needs_selection: {
      heading: 'Знайти дати вивезення',
      body: 'Оберіть своє місто та свій район. Дати завантажуються лише після підтвердження.',
      announcement: 'Будь ласка, оберіть місто та район.',
    },
    no_official_providers: {
      heading: 'Наразі немає доступної офіційної служби',
      body: 'Наразі не зареєстровано жодної офіційної служби вивезення. Спробуйте пізніше.',
      announcement: 'Наразі немає доступної офіційної служби.',
    },
    no_service_areas: {
      heading: 'Райони не зареєстровані',
      body: 'Для цієї служби наразі не зареєстровано жодного району.',
      announcement: 'Для цієї служби не зареєстровано жодного району.',
    },
    loading: {
      heading: 'Завантаження дат вивезення',
      body: 'Дати для вашого вибору завантажуються.',
      announcement: 'Завантаження дат вивезення.',
    },
    live: {
      heading: 'Ваші дати вивезення',
      body: 'Усі дати, які ваша служба публікує на охоплений період.',
      announcement: 'Дати вивезення завантажено.',
    },
    empty: {
      heading: 'На охоплений період вивезень немає',
      body: 'Ваша служба не публікує вивезень на охоплений період. Це не збій.',
      announcement: 'На охоплений період вивезень немає.',
    },
    range_not_covered: {
      heading: 'На поточний період календар не опубліковано',
      body: 'Ваша служба не публікує календар на поточний період. AbfallRadar регулярно перевіряє, чи з’явився новий період.',
      announcement: 'На поточний період календар не опубліковано.',
    },
    error: {
      heading: 'Не вдалося завантажити дати вивезення',
      body: 'Спробуйте ще раз.',
      announcement: 'Не вдалося завантажити дати вивезення.',
    },
  },
  failures: {
    network: 'Служба недоступна. Перевірте з’єднання.',
    timeout: 'Запит тривав занадто довго.',
    invalid_response: 'Служба повернула непридатні дані.',
    problem: 'Служба не змогла відповісти на запит.',
    source_date_unavailable:
      'Не вдалося визначити сьогоднішню дату в часовому поясі вашої служби, тому дати вивезення не показано.',
  },
  problemCodes: {
    SCHEDULE_RANGE_NOT_COVERED: 'Запитаний період не охоплено календарем вашої служби.',
    PROVIDER_NOT_FOUND: 'Ця служба більше недоступна.',
    SERVICE_AREA_NOT_FOUND: 'Цей район більше недоступний.',
    COLLECTION_EVENTS_NOT_AVAILABLE: 'Для цього району дати вивезення наразі недоступні.',
    UPSTREAM_SOURCE_UNAVAILABLE: 'Джерело вашої служби наразі недоступне.',
    UPSTREAM_SOURCE_INVALID: 'Джерело вашої служби повернуло непридатні дані.',
  },
  notices: {
    provider_invalidated: 'Ця служба більше недоступна. Список служб оновлюється.',
    area_unavailable: 'Для вашого попереднього району джерело більше не публікує календар.',
  },
  steps: {
    city: 'Місто',
    cityLoading: 'Завантаження міст.',
    provider: 'Служба вивезення',
    providerLoading: 'Завантаження служб вивезення.',
    area: (providerName) => `Район у службі ${providerName}`,
    areaLoading: 'Завантаження районів.',
    areaUnavailable: 'Для цього району джерело не публікує календар.',
    retained: 'Ваш попередній вибір збережено, доки ви не підтвердите знову.',
    selectDistrict: 'Оберіть свій район.',
    selected: 'Обрано',
    noneSelected: 'Район ще не обрано',
  },
  actions: {
    back: 'Назад',
    changeSelection: 'Змінити вибір',
    retry: 'Спробувати ще раз',
    confirm: 'Підтвердити вибір',
  },
  diagnostics: {
    identifier: 'Ідентифікатор',
    recoveryIdentifier: 'Ідентифікатор оновлення',
    rangeIdentifier: 'Ідентифікатор першої відповіді про період',
    lastRecoveryFailed: 'Останнє оновлення не вдалося',
  },
  footer: {
    description: (city) =>
      city === null ? 'Офіційні дати вивезення' : `Дати вивезення для міста ${city}`,
    backToTop: 'Догори',
  },
  schedule: {
    searchDistricts: 'Пошук району',
    districtCount: (shown, total) => `Районів: ${shown} з ${total}`,
    noMatches: 'Район не знайдено.',
  },
};

const ru: WebMessages = {
  states: {
    configuration_error: {
      heading: 'AbfallRadar не может безопасно обратиться к службе с этой страницы',
      body: 'Эта страница работает в контексте без доверенного источника. Откройте AbfallRadar напрямую по обычному адресу http или https, чтобы загрузить даты вывоза.',
      announcement: 'AbfallRadar не может безопасно обратиться к службе с этой страницы.',
    },
    needs_selection: {
      heading: 'Найти даты вывоза',
      body: 'Выберите город и район. Даты загружаются только после подтверждения.',
      announcement: 'Пожалуйста, выберите город и район.',
    },
    no_official_providers: {
      heading: 'Сейчас нет доступной официальной службы',
      body: 'Сейчас не зарегистрировано ни одной официальной службы вывоза. Попробуйте позже.',
      announcement: 'Сейчас нет доступной официальной службы.',
    },
    no_service_areas: {
      heading: 'Районы не зарегистрированы',
      body: 'Для этой службы сейчас не зарегистрировано ни одного района.',
      announcement: 'Для этой службы не зарегистрировано ни одного района.',
    },
    loading: {
      heading: 'Загрузка дат вывоза',
      body: 'Даты для вашего выбора загружаются.',
      announcement: 'Загрузка дат вывоза.',
    },
    live: {
      heading: 'Ваши даты вывоза',
      body: 'Все даты, которые ваша служба публикует на охваченный период.',
      announcement: 'Даты вывоза загружены.',
    },
    empty: {
      heading: 'На охваченный период вывозов нет',
      body: 'Ваша служба не публикует вывозов на охваченный период. Это не сбой.',
      announcement: 'На охваченный период вывозов нет.',
    },
    range_not_covered: {
      heading: 'На текущий период календарь не опубликован',
      body: 'Ваша служба не публикует календарь на текущий период. AbfallRadar регулярно проверяет, появился ли новый период.',
      announcement: 'На текущий период календарь не опубликован.',
    },
    error: {
      heading: 'Не удалось загрузить даты вывоза',
      body: 'Пожалуйста, попробуйте ещё раз.',
      announcement: 'Не удалось загрузить даты вывоза.',
    },
  },
  failures: {
    network: 'Служба недоступна. Проверьте соединение.',
    timeout: 'Запрос занял слишком много времени.',
    invalid_response: 'Служба вернула непригодные данные.',
    problem: 'Служба не смогла ответить на запрос.',
    source_date_unavailable:
      'Не удалось определить сегодняшнюю дату в часовом поясе вашей службы, поэтому даты вывоза не показаны.',
  },
  problemCodes: {
    SCHEDULE_RANGE_NOT_COVERED: 'Запрошенный период не охвачен календарём вашей службы.',
    PROVIDER_NOT_FOUND: 'Эта служба больше недоступна.',
    SERVICE_AREA_NOT_FOUND: 'Этот район больше недоступен.',
    COLLECTION_EVENTS_NOT_AVAILABLE: 'Для этого района даты вывоза сейчас недоступны.',
    UPSTREAM_SOURCE_UNAVAILABLE: 'Источник вашей службы сейчас недоступен.',
    UPSTREAM_SOURCE_INVALID: 'Источник вашей службы вернул непригодные данные.',
  },
  notices: {
    provider_invalidated: 'Эта служба больше недоступна. Список служб обновляется.',
    area_unavailable: 'Для вашего прежнего района источник больше не публикует календарь.',
  },
  steps: {
    city: 'Город',
    cityLoading: 'Загрузка городов.',
    provider: 'Служба вывоза',
    providerLoading: 'Загрузка служб вывоза.',
    area: (providerName) => `Район в службе ${providerName}`,
    areaLoading: 'Загрузка районов.',
    areaUnavailable: 'Для этого района источник не публикует календарь.',
    retained: 'Ваш прежний выбор сохраняется, пока вы не подтвердите снова.',
    selectDistrict: 'Выберите свой район.',
    selected: 'Выбрано',
    noneSelected: 'Район ещё не выбран',
  },
  actions: {
    back: 'Назад',
    changeSelection: 'Изменить выбор',
    retry: 'Попробовать ещё раз',
    confirm: 'Подтвердить выбор',
  },
  diagnostics: {
    identifier: 'Идентификатор',
    recoveryIdentifier: 'Идентификатор обновления',
    rangeIdentifier: 'Идентификатор первого ответа о периоде',
    lastRecoveryFailed: 'Последнее обновление не удалось',
  },
  footer: {
    description: (city) =>
      city === null ? 'Официальные даты вывоза' : `Даты вывоза для города ${city}`,
    backToTop: 'Наверх',
  },
  schedule: {
    searchDistricts: 'Поиск района',
    districtCount: (shown, total) => `Районов: ${shown} из ${total}`,
    noMatches: 'Район не найден.',
  },
};

const compose = (locale: Locale, own: WebMessages): Messages => {
  const shared = SCHEDULE_MESSAGES[locale];

  return { ...shared, ...own, schedule: { ...shared.schedule, ...own.schedule } };
};

export const MESSAGES: Record<Locale, Messages> = {
  de: compose('de', de),
  en: compose('en', en),
  uk: compose('uk', uk),
  ru: compose('ru', ru),
};
