import { householdCollectionsIn } from '@abfall-radar/schedule-format';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HouseholdPanel } from '@/src/features/household/household-panel';
import type { HouseholdRules } from '@/src/adapters/schedule-gateway';
import type { HouseholdState } from '@/src/hooks/use-household-schedule';
import { LocaleProvider } from '@/src/i18n/context';
import type { Locale } from '@/src/i18n/locale';

/**
 * What the panel says the calculated dates are standing on.
 *
 * Two facts, established two different ways and therefore stated separately: an **automatic** check of
 * the operator's published documents, and the date a **person** last read its announcements. Both are
 * shown in every state where the rules were read at all — including the one where everything succeeded,
 * which is the reading somebody is most likely to act on.
 *
 * The wording is the shared copy in `@abfall-radar/schedule-format`, so this surface and the extension's
 * popup say the same thing in the same words. The assertions below are deliberately about the *meaning*
 * — an automatic check, a hand reading, and the limit of that reading — rather than about whole
 * sentences, which would make this a spelling test.
 */

const RULES: HouseholdRules = {
  providerId: 'koblenz-servicebetrieb',
  cityId: 'koblenz',
  coverage: { from: '2026-01-01', to: '2026-12-26' },
  parity: { even: 'bio', odd: 'residual' },
  replacements: [],
  source: {
    name: 'Kommunaler Servicebetrieb',
    attribution: 'Kommunaler Servicebetrieb, Koblenz',
    landingPageUrl: 'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine/',
    replacementsSourceUrl: 'https://servicebetrieb.koblenz.de/downloads/x.jpg',
    parityRuleSourceUrl: 'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine/',
    timeZone: 'Europe/Berlin',
  },
  revision: '2026.1',
  checkedAt: '2026-09-23T08:00:00.000Z',
  // Deliberately a different date from `checkedAt`: it is a different kind of statement.
  announcementsReviewedThrough: '2026-09-20',
  checks: { table: 'verified', parityRule: 'verified', tableLink: 'verified' },
  verification: 'verified',
};

const ready = (overrides: Partial<HouseholdRules> = {}): HouseholdState => {
  const rules = { ...RULES, ...overrides };

  return {
    status: 'ready',
    weekday: 1,
    rules,
    schedule: householdCollectionsIn(
      rules,
      { providerId: rules.providerId, serviceAreaId: 'koblenz-neuendorf', weekday: 1 },
      { from: '2026-09-21', to: '2026-10-19' },
    ),
  };
};

const show = (state: HouseholdState, locale: Locale = 'de') =>
  render(
    <LocaleProvider initial={locale}>
      <HouseholdPanel
        state={state}
        onDisable={() => undefined}
        onEnable={() => undefined}
        onRetry={() => undefined}
      />
    </LocaleProvider>,
  );

describe('the provenance of calculated household collections', () => {
  it('states the automatic check and when it ran, with everything verified', () => {
    show(ready());

    const checked = screen.getByTestId('household-checked');

    expect(checked).toHaveTextContent('Automatische Quellprüfung');
    expect(checked).toHaveTextContent('23.09.2026');
    expect(checked).toHaveTextContent('unverändert');
  });

  it('states the separate hand reading of the announcements, and its limit', () => {
    show(ready());

    const announcements = screen.getByTestId('household-announcements');

    expect(announcements).toHaveTextContent('20.09.2026');
    expect(announcements).toHaveTextContent('von Hand gelesen');
    expect(announcements).toHaveTextContent('nicht automatisch geprüft');
  });

  it('keeps the two facts apart, so neither can be read as the other', () => {
    show(ready());

    // The automatic line must not claim the announcements, and the manual line must not claim the check.
    expect(screen.getByTestId('household-checked')).not.toHaveTextContent('Mitteilungen');
    expect(screen.getByTestId('household-announcements')).not.toHaveTextContent('Quellprüfung');
  });

  it('keeps saying both while the automatic check could not run', () => {
    show(
      ready({
        checks: { table: 'unverified', parityRule: 'unverified', tableLink: 'unverified' },
        verification: 'unverified',
      }),
    );

    expect(screen.getByTestId('household-checked')).toHaveTextContent(
      'konnten nicht geprüft werden',
    );
    expect(screen.getByTestId('household-announcements')).toHaveTextContent('von Hand gelesen');
  });

  it('keeps saying both once the operator has moved on from the transcription', () => {
    show(
      ready({
        checks: { table: 'changed', parityRule: 'verified', tableLink: 'verified' },
        verification: 'changed',
      }),
    );

    // The dates are withheld in this state; what they rested on is still stated in full.
    expect(screen.getByTestId('household-checked')).toHaveTextContent('haben sich geändert');
    expect(screen.getByTestId('household-announcements')).toHaveTextContent('von Hand gelesen');
  });

  it.each([
    ['en' as const, 'Automatic source check', 'read by hand', 'not checked automatically'],
    ['uk' as const, 'Автоматична перевірка джерел', 'вручну', 'автоматично не перевіряються'],
    [
      'ru' as const,
      'Автоматическая проверка источников',
      'вручную',
      'автоматически не проверяются',
    ],
  ])('says both in %s', (locale, check, byHand, limit) => {
    show(ready(), locale);

    expect(screen.getByTestId('household-checked')).toHaveTextContent(check);
    expect(screen.getByTestId('household-announcements')).toHaveTextContent(byHand);
    expect(screen.getByTestId('household-announcements')).toHaveTextContent(limit);
  });

  it('says neither while the bins are off', () => {
    show({ status: 'off' });

    expect(screen.queryByTestId('household-checked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('household-announcements')).not.toBeInTheDocument();
  });
});
