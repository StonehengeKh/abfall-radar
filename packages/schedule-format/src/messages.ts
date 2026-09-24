import type { RuleVerification, WasteType } from '@abfall-radar/domain';
import { withSentencePeriod } from './format';
import type { Locale } from './locale';

/**
 * The copy every schedule surface shares, in each supported language.
 *
 * Exactly what the shared presentation renders — waste categories, the collection-day status, the
 * countdown, drop-off window wording, source details, and the language and appearance labels — so the
 * web application and the extension say the same thing in the same words, from one copy. Copy that
 * belongs to one application's own flows (its states, steps, actions and failures) stays with it.
 *
 * Typed rather than looked up by free-form key: a waste type without a name is a TypeScript error in
 * four languages at once. Nothing is assembled from fragments, and a count that varies is formatted by
 * `Intl` rather than by joining a number to a noun.
 *
 * What this file deliberately does **not** contain: provider names, service-area names, localities,
 * attribution, source titles, and the source link. Those are authored by the municipal operator and are
 * reproduced exactly as published, in every language.
 */
export interface ScheduleMessages {
  readonly languageName: string;
  readonly language: { readonly label: string };
  readonly appearance: {
    readonly label: string;
    readonly light: string;
    readonly dark: string;
    readonly system: string;
  };
  readonly provenance: {
    readonly heading: string;
    readonly openSource: string;
    readonly retrieved: string;
    readonly fresh: string;
    readonly stale: string;
    readonly shownPeriod: string;
    readonly publishedWasteTypes: string;
    readonly nextCollection: string;
    readonly details: string;
  };
  /**
   * The two bins the operator publishes no calendar for, calculated from its rules.
   *
   * Shared because both applications must say the same thing about them, and because the distinction
   * they carry — calculated from a rule, not retrieved from a calendar — is the one a person has to be
   * able to see wherever the collection appears.
   */
  readonly household: {
    readonly calculated: string;
    readonly calculatedHint: string;
    readonly movedFrom: (date: string) => string;
    /**
     * The **automatic** check of the operator's published documents, by its result, stating when it ran.
     *
     * Result and instant in one sentence because neither means much alone: "checked on Tuesday" does not
     * say what was found, and "unchanged" does not say how long ago. Keyed by the verification state, so
     * a new state cannot be added without deciding what every surface says about it.
     *
     * Shared, and kept strictly apart from `announcementsReviewed` below, because the two are
     * established in completely different ways and can each be true of the other's opposite.
     */
    readonly sourceChecked: Record<RuleVerification, (instant: string) => string>;
    /**
     * The **manual** half: how far a person has read the operator's later announcements.
     *
     * Nothing automatic covers it. The operator publishes per-holiday notices that restate, and could in
     * principle amend, a row of the annual table; they are free prose, and no check here reads them. So
     * the wording names both facts — the date the reading reached, and that later notices are not
     * checked automatically — because the date alone reads like a second automatic check.
     */
    readonly announcementsReviewed: (date: string) => string;
  };
  readonly schedule: {
    readonly today: string;
    /**
     * The status of an all-day collection whose day has arrived.
     *
     * A calendar statement about the day, not a report on a vehicle: the source publishes the date and
     * no time, so nothing here may imply a start, a progress share, or a completion.
     */
    readonly inProgress: string;
  };
  /**
   * The countdown panel.
   *
   * `untilDayStarts` is the honest caption for a date-only collection: the source publishes no pickup
   * time, so what is being counted is the beginning of the collection day, not the collection.
   */
  readonly countdown: {
    readonly heading: string;
    readonly untilStart: string;
    readonly untilDayStarts: string;
    /** Said when the schedule holds nothing further — never a zero, a negative, or an invented date. */
    readonly noFurtherDates: string;
    /** No `days` label: that one agrees with its number, so `dayUnitLabel` produces it from `Intl`. */
    readonly hours: string;
    readonly minutes: string;
  };
  /**
   * The connector words of a spoken drop-off window.
   *
   * Only the words are localized. The numbers, the offsets, and the zone identifier are composed from
   * `Intl` parts in a fixed order, so no locale can reorder a time into a different one.
   */
  readonly window: {
    readonly from: string;
    readonly to: string;
    readonly oClock: string;
    readonly timeZone: string;
  };
  readonly waste: Record<WasteType, string>;
}

const de: ScheduleMessages = {
  languageName: 'Deutsch',
  language: { label: 'Sprache' },
  appearance: { label: 'Darstellung', light: 'Hell', dark: 'Dunkel', system: 'System' },
  provenance: {
    heading: 'Quelle',
    openSource: 'Quelle öffnen',
    retrieved: 'Abgerufen',
    fresh: 'Aktuell',
    stale: 'Quelle meldet veraltete Daten',
    shownPeriod: 'Angezeigter Zeitraum',
    publishedWasteTypes: 'Veröffentlichte Abfallarten',
    nextCollection: 'Nächste Abfuhr',
    details: 'Quelle und Details',
  },
  household: {
    calculated: 'Berechnet',
    calculatedHint:
      'Aus den Regeln des Betriebs und deinem bestätigten Abfuhrtag berechnet, nicht aus dem digitalen Kalender.',
    movedFrom: (date) => `Verlegt vom ${date}`,
    sourceChecked: {
      verified: (instant) =>
        `Automatische Quellprüfung am ${instant}: die veröffentlichten Unterlagen sind unverändert.`,
      unverified: (instant) =>
        `Automatische Quellprüfung am ${instant}: die veröffentlichten Unterlagen konnten nicht geprüft werden.`,
      changed: (instant) =>
        `Automatische Quellprüfung am ${instant}: die veröffentlichten Unterlagen haben sich geändert.`,
    },
    announcementsReviewed: (date) =>
      `Mitteilungen des Betriebs von Hand gelesen bis ${withSentencePeriod(date)} Spätere Mitteilungen werden nicht automatisch geprüft.`,
  },
  schedule: {
    today: 'Heute',
    inProgress: 'Abholung läuft',
  },
  countdown: {
    heading: 'Countdown',
    untilStart: 'bis zur Abholung',
    untilDayStarts: 'bis der Abfuhrtag beginnt',
    noFurtherDates: 'Keine weiteren Abfuhrtermine veröffentlicht',
    hours: 'Std.',
    minutes: 'Min.',
  },
  window: { from: 'Von', to: 'bis', oClock: 'Uhr', timeZone: 'Zeitzone' },
  waste: {
    residual: 'Restabfall',
    bio: 'Biotonne',
    paper: 'Altpapier',
    yellow_bag: 'Gelber Sack',
    green_waste: 'Grünschnitt',
    christmas_tree: 'Weihnachtsbaum',
    hazardous: 'Schadstoffe',
    small_electronics: 'Elektrokleinteile',
  },
};

const en: ScheduleMessages = {
  languageName: 'English',
  language: { label: 'Language' },
  appearance: { label: 'Appearance', light: 'Light', dark: 'Dark', system: 'System' },
  provenance: {
    heading: 'Source',
    openSource: 'Open source page',
    retrieved: 'Retrieved',
    fresh: 'Current',
    stale: 'Source reports stale data',
    shownPeriod: 'Period shown',
    publishedWasteTypes: 'Published waste types',
    nextCollection: 'Next collection',
    details: 'Source and details',
  },
  household: {
    calculated: 'Calculated',
    calculatedHint:
      'Calculated from the operator’s rules and your confirmed collection weekday, not from the digital calendar.',
    movedFrom: (date) => `Moved from ${date}`,
    sourceChecked: {
      verified: (instant) =>
        `Automatic source check on ${instant}: the published documents are unchanged.`,
      unverified: (instant) =>
        `Automatic source check on ${instant}: the published documents could not be checked.`,
      changed: (instant) =>
        `Automatic source check on ${instant}: the published documents have changed.`,
    },
    announcementsReviewed: (date) =>
      `Operator announcements read by hand through ${withSentencePeriod(date)} Later notices are not checked automatically.`,
  },
  schedule: {
    today: 'Today',
    inProgress: 'In progress',
  },
  countdown: {
    heading: 'Countdown',
    untilStart: 'until the collection',
    untilDayStarts: 'until the collection day starts',
    noFurtherDates: 'No further collection dates published',
    hours: 'hrs',
    minutes: 'min',
  },
  window: { from: 'From', to: 'to', oClock: '', timeZone: 'Time zone' },
  waste: {
    residual: 'Residual waste',
    bio: 'Organic waste',
    paper: 'Paper',
    yellow_bag: 'Yellow bag',
    green_waste: 'Garden waste',
    christmas_tree: 'Christmas tree',
    hazardous: 'Hazardous waste',
    small_electronics: 'Small electronics',
  },
};

const uk: ScheduleMessages = {
  languageName: 'Українська',
  language: { label: 'Мова' },
  appearance: { label: 'Оформлення', light: 'Світле', dark: 'Темне', system: 'Системне' },
  provenance: {
    heading: 'Джерело',
    openSource: 'Відкрити джерело',
    retrieved: 'Отримано',
    fresh: 'Актуально',
    stale: 'Джерело повідомляє про застарілі дані',
    shownPeriod: 'Показаний період',
    publishedWasteTypes: 'Опубліковані типи відходів',
    nextCollection: 'Найближче вивезення',
    details: 'Джерело та деталі',
  },
  household: {
    calculated: 'Обчислено',
    calculatedHint:
      'Обчислено за правилами оператора та підтвердженим днем вивезення, а не з цифрового календаря.',
    movedFrom: (date) => `Перенесено з ${date}`,
    sourceChecked: {
      verified: (instant) =>
        `Автоматична перевірка джерел ${instant}: опубліковані документи без змін.`,
      unverified: (instant) =>
        `Автоматична перевірка джерел ${instant}: опубліковані документи перевірити не вдалося.`,
      changed: (instant) =>
        `Автоматична перевірка джерел ${instant}: опубліковані документи змінено.`,
    },
    announcementsReviewed: (date) =>
      `Повідомлення оператора прочитано вручну до ${withSentencePeriod(date)} Пізніші повідомлення автоматично не перевіряються.`,
  },
  schedule: {
    today: 'Сьогодні',
    inProgress: 'Вивезення триває',
  },
  countdown: {
    heading: 'Зворотний відлік',
    untilStart: 'до вивезення',
    untilDayStarts: 'до початку дня вивезення',
    noFurtherDates: 'Подальші дати вивезення не опубліковані',
    hours: 'год',
    minutes: 'хв',
  },
  window: { from: 'Від', to: 'до', oClock: '', timeZone: 'Часовий пояс' },
  waste: {
    residual: 'Змішані відходи',
    bio: 'Органічні відходи',
    paper: 'Папір',
    yellow_bag: 'Жовтий мішок',
    green_waste: 'Садові відходи',
    christmas_tree: 'Ялинка',
    hazardous: 'Небезпечні відходи',
    small_electronics: 'Дрібна електроніка',
  },
};

const ru: ScheduleMessages = {
  languageName: 'Русский',
  language: { label: 'Язык' },
  appearance: { label: 'Оформление', light: 'Светлое', dark: 'Тёмное', system: 'Системное' },
  provenance: {
    heading: 'Источник',
    openSource: 'Открыть источник',
    retrieved: 'Получено',
    fresh: 'Актуально',
    stale: 'Источник сообщает об устаревших данных',
    shownPeriod: 'Показанный период',
    publishedWasteTypes: 'Опубликованные типы отходов',
    nextCollection: 'Ближайший вывоз',
    details: 'Источник и подробности',
  },
  household: {
    calculated: 'Рассчитано',
    calculatedHint:
      'Рассчитано по правилам оператора и подтверждённому дню вывоза, а не из цифрового календаря.',
    movedFrom: (date) => `Перенесено с ${date}`,
    sourceChecked: {
      verified: (instant) =>
        `Автоматическая проверка источников ${instant}: опубликованные документы без изменений.`,
      unverified: (instant) =>
        `Автоматическая проверка источников ${instant}: опубликованные документы проверить не удалось.`,
      changed: (instant) =>
        `Автоматическая проверка источников ${instant}: опубликованные документы изменились.`,
    },
    announcementsReviewed: (date) =>
      `Сообщения оператора прочитаны вручную до ${withSentencePeriod(date)} Более поздние сообщения автоматически не проверяются.`,
  },
  schedule: {
    today: 'Сегодня',
    inProgress: 'В процессе',
  },
  countdown: {
    heading: 'Обратный отсчёт',
    untilStart: 'до вывоза',
    untilDayStarts: 'до начала дня вывоза',
    noFurtherDates: 'Дальнейшие даты вывоза не опубликованы',
    hours: 'ч',
    minutes: 'мин',
  },
  window: { from: 'С', to: 'до', oClock: '', timeZone: 'Часовой пояс' },
  waste: {
    residual: 'Смешанные отходы',
    bio: 'Органические отходы',
    paper: 'Бумага',
    yellow_bag: 'Жёлтый мешок',
    green_waste: 'Садовые отходы',
    christmas_tree: 'Ёлка',
    hazardous: 'Опасные отходы',
    small_electronics: 'Мелкая электроника',
  },
};

export const SCHEDULE_MESSAGES: Record<Locale, ScheduleMessages> = { de, en, uk, ru };
