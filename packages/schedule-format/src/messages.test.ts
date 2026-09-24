import { describe, expect, it } from 'vitest';
import { formatCalendarDate, withSentencePeriod } from './format';
import { SCHEDULE_MESSAGES } from './messages';

/**
 * The shared copy as a reader actually sees it, punctuation included.
 *
 * Asserted as **complete sentences** rather than by searching for key phrases. A phrase check passes
 * happily on `до 23 вер. 2026 р.. Пізніші` — the defect this file exists for — because every phrase it
 * looks for is present. Only the whole string shows the doubled stop.
 *
 * The dates are built with the same formatter the applications use, so this tests the templates rather
 * than a hard-coded ICU spelling.
 */

const DATE = '2026-09-23';

describe('the manual announcement-review disclosure', () => {
  it('ends the Ukrainian sentence with one full stop, not the year abbreviation’s plus another', () => {
    expect(
      SCHEDULE_MESSAGES.uk.household.announcementsReviewed(formatCalendarDate('uk', DATE)),
    ).toBe(
      'Повідомлення оператора прочитано вручну до 23 вер. 2026 р. Пізніші повідомлення автоматично не перевіряються.',
    );
  });

  it('ends the Russian sentence with one full stop', () => {
    expect(
      SCHEDULE_MESSAGES.ru.household.announcementsReviewed(formatCalendarDate('ru', DATE)),
    ).toBe(
      'Сообщения оператора прочитаны вручную до 23 сент. 2026 г. Более поздние сообщения автоматически не проверяются.',
    );
  });

  it('still punctuates German, whose date ends in a digit', () => {
    expect(
      SCHEDULE_MESSAGES.de.household.announcementsReviewed(formatCalendarDate('de', DATE)),
    ).toBe(
      'Mitteilungen des Betriebs von Hand gelesen bis 23.09.2026. Spätere Mitteilungen werden nicht automatisch geprüft.',
    );
  });

  it('still punctuates English', () => {
    expect(
      SCHEDULE_MESSAGES.en.household.announcementsReviewed(formatCalendarDate('en', DATE)),
    ).toBe(
      'Operator announcements read by hand through Sep 23, 2026. Later notices are not checked automatically.',
    );
  });

  it('never leaves a doubled stop in any locale', () => {
    for (const [locale, messages] of Object.entries(SCHEDULE_MESSAGES)) {
      const sentence = messages.household.announcementsReviewed(
        formatCalendarDate(locale as keyof typeof SCHEDULE_MESSAGES, DATE),
      );

      expect(sentence, locale).not.toContain('..');
    }
  });
});

describe('withSentencePeriod', () => {
  it('adds the stop a date ending in a digit needs', () => {
    expect(withSentencePeriod('23.09.2026')).toBe('23.09.2026.');
    expect(withSentencePeriod('Sep 23, 2026')).toBe('Sep 23, 2026.');
  });

  it('leaves a date that already ends a sentence alone', () => {
    expect(withSentencePeriod('23 вер. 2026 р.')).toBe('23 вер. 2026 р.');
    expect(withSentencePeriod('23 сент. 2026 г.')).toBe('23 сент. 2026 г.');
  });

  it('does not touch the formatter, so a date mid-sentence keeps its own spelling', () => {
    // The guard is applied where a sentence ends; `formatCalendarDate` is unchanged.
    expect(formatCalendarDate('uk', DATE)).toBe('23 вер. 2026 р.');
    expect(formatCalendarDate('de', DATE)).toBe('23.09.2026');
  });
});
