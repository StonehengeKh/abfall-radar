import type { CollectionEvent } from '@abfall-radar/domain';
import { CalculatedBadge, EventRow } from '@abfall-radar/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '@/src/i18n/messages';
import type { Locale } from '@/src/i18n/locale';

/**
 * A calculated row at the narrowest size the product supports.
 *
 * The reviewer reproduced horizontal scrolling at 320 px with the root font at 32 px in Russian: the
 * waste icon takes 80 px, the title column is about 100 px, and both the badge (`Рассчитано`, 173 px)
 * and the title (`Смешанные отходы`, 136 px) are single words with no break opportunity inside them. A
 * flex item's minimum size is its longest unbreakable run, so both refused to shrink and the card pushed
 * the whole page sideways in **both** applications.
 *
 * jsdom computes no layout, so the widths themselves are measured in a real browser and recorded in the
 * fix report. What is asserted here is the rule that produces them — `overflow-wrap: anywhere`, which is
 * the only one of the wrapping utilities that lowers an element's min-content contribution — together
 * with the things that must survive it: the complete label, the waste title, and the icon.
 */

/** One calculated collection: the Russian labels are the longest the product has to place. */
const CALCULATED: CollectionEvent = {
  id: 'residual-2026-10-05',
  districtId: 'koblenz-neuendorf',
  type: 'residual',
  date: '2026-10-05',
  title: 'Restabfall',
  source: 'user_rule',
  collectionMode: 'curbside',
  timing: { kind: 'all_day' },
};

const row = (locale: Locale) =>
  render(
    <ul>
      <EventRow
        event={CALCULATED}
        locale={locale}
        messages={MESSAGES[locale]}
        sourceToday="2026-10-01"
      />
    </ul>,
  );

describe('a calculated row in a narrow column', () => {
  it('lets the Russian badge wrap inside the word rather than widen the card', () => {
    row('ru');

    const badge = screen.getByTestId('calculated-badge');

    // `break-words` would not have been enough: it never lowers the min-content width.
    expect(badge.className).toContain('wrap-anywhere');
    expect(badge.className).toContain('min-w-0');
    // The label stays whole, and stays at its own size — wrapped, never clipped or shortened.
    expect(badge).toHaveTextContent('Рассчитано');
    expect(badge.className).not.toContain('truncate');
    expect(badge.className).not.toContain('overflow-hidden');
  });

  it('lets the Russian waste title wrap the same way, and keeps it complete', () => {
    row('ru');

    const title = screen.getByTestId('event-row-title');

    expect(title.className).toContain('wrap-anywhere');
    expect(title.className).toContain('min-w-0');
    expect(title).toHaveTextContent('Смешанные отходы');
  });

  it('keeps the icon beside the title, which the wrapping must not cost', () => {
    const { container } = row('ru');

    // The overflow is never solved by dropping the icon or hiding part of the row.
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('[data-testid=event-row]')?.className).not.toContain(
      'overflow-hidden',
    );
  });

  it.each(['de', 'en', 'uk', 'ru'] as const)(
    'keeps the badge readable and whole in %s',
    (locale) => {
      row(locale);

      const badge = screen.getByTestId('calculated-badge');

      // The shared label, unabbreviated, at the badge's own text size in every language.
      expect(badge).toHaveTextContent(MESSAGES[locale].household.calculated);
      expect(badge.className).toContain('text-[0.65rem]');
    },
  );

  it('is the one shared badge, so the featured card cannot drift from the rows', () => {
    render(<CalculatedBadge messages={MESSAGES.ru} />);

    /*
     * The featured card and the list rows render this same component. They used to carry two copies of
     * the markup, which is how the card kept an overflowing badge while the row was being fixed.
     */
    const badge = screen.getByTestId('calculated-badge');

    expect(badge.className).toContain('wrap-anywhere');
    expect(badge).toHaveTextContent('Рассчитано');
    expect(badge).toHaveAttribute('title', MESSAGES.ru.household.calculatedHint);
  });
});
