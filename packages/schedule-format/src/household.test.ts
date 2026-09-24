import type { HouseholdBinSetup, HouseholdCollectionRules } from '@abfall-radar/domain';
import { describe, expect, it } from 'vitest';
import {
  coverageEndsAfter,
  type HouseholdCollection,
  householdCollectionsIn,
  isoWeekOf,
  toCollectionEvent,
  wasteTypeForDate,
} from './household';

/**
 * The calculation, against rules stated here rather than the real transcription.
 *
 * The transcription is Koblenz's and belongs to the provider package; what is tested here is the
 * arithmetic every municipality's rules would go through. The fixture carries the same *shapes* the
 * real table has — a whole week moved later, a whole week moved earlier across a month boundary, and a
 * two-day cascade — because those are what the rules can do, not because they are Koblenz's.
 */

const RULES: HouseholdCollectionRules = {
  providerId: 'koblenz-servicebetrieb',
  cityId: 'koblenz',
  coverage: { from: '2026-01-01', to: '2026-12-26' },
  parity: { even: 'bio', odd: 'residual' },
  replacements: [
    // A cascade: the Thursday route moves to Friday, the Friday route to Saturday.
    { nominalDate: '2026-05-14', actualDate: '2026-05-15', reason: 'Christi Himmelfahrt' },
    { nominalDate: '2026-05-15', actualDate: '2026-05-16', reason: 'Christi Himmelfahrt' },
    // A Vorverlegung that crosses both a week and a month boundary.
    { nominalDate: '2026-03-30', actualDate: '2026-03-28', reason: 'Karfreitag' },
    { nominalDate: '2026-03-31', actualDate: '2026-03-30', reason: 'Karfreitag' },
  ],
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
  announcementsReviewedThrough: '2026-09-23',
  checks: { table: 'verified', parityRule: 'verified', tableLink: 'verified' },
  verification: 'verified',
};

/** The confirmed household: Koblenz, Neuendorf, collected on Mondays. */
const MONDAY_HOUSEHOLD: HouseholdBinSetup = {
  providerId: 'koblenz-servicebetrieb',
  serviceAreaId: 'koblenz-neuendorf',
  weekday: 1,
};

const datesAndTypes = (from: string, to: string, setup = MONDAY_HOUSEHOLD) =>
  householdCollectionsIn(RULES, setup, { from, to }).collections.map(
    (collection) => `${collection.date} ${collection.type}`,
  );

describe('ISO weeks', () => {
  it.each([
    ['2026-09-21', 39, 1],
    ['2026-09-28', 40, 1],
    ['2026-01-01', 1, 4],
    // The ISO year is not the calendar year at the turn: 2026-12-28 opens week 53 of 2026, and
    // 2027-01-01 is still inside it.
    ['2026-12-28', 53, 1],
    ['2027-01-01', 53, 5],
  ])('reads %s as week %i, weekday %i', (date, week, weekday) => {
    expect(isoWeekOf(date)).toMatchObject({ week, weekday });
  });

  it('refuses a date that does not exist rather than rolling it into the next month', () => {
    expect(isoWeekOf('2026-02-30')).toBeNull();
    expect(isoWeekOf('not-a-date')).toBeNull();
  });

  it('assigns the bin from the week’s parity', () => {
    // Week 39 is odd, week 40 even.
    expect(wasteTypeForDate(RULES, '2026-09-21')).toBe('residual');
    expect(wasteTypeForDate(RULES, '2026-09-28')).toBe('bio');
  });
});

/**
 * The four dates the household confirmed against their own bins.
 *
 * These are the ground truth this whole feature is checked against: if the parity rule or the weekday
 * were applied the wrong way round, every one of them would be the other bin.
 */
describe('the confirmed household', () => {
  it('produces the four confirmed collections', () => {
    expect(datesAndTypes('2026-09-21', '2026-10-12')).toEqual([
      '2026-09-21 residual',
      '2026-09-28 bio',
      '2026-10-05 residual',
      '2026-10-12 bio',
    ]);
  });

  it('alternates from one week to the next, never twice in a week', () => {
    const collections = householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, {
      from: '2026-09-01',
      to: '2026-10-31',
    }).collections;

    // Mondays from 2026-09-07 (week 37, odd) through 2026-10-26 (week 44, even).
    expect(collections.map((collection) => `${collection.date} ${collection.type}`)).toEqual([
      '2026-09-07 residual',
      '2026-09-14 bio',
      '2026-09-21 residual',
      '2026-09-28 bio',
      '2026-10-05 residual',
      '2026-10-12 bio',
      '2026-10-19 residual',
      '2026-10-26 bio',
    ]);
  });

  it('gives a Thursday household its own weekday', () => {
    const thursday = { ...MONDAY_HOUSEHOLD, weekday: 4 as const };

    expect(datesAndTypes('2026-09-21', '2026-10-01', thursday)).toEqual([
      '2026-09-24 residual',
      '2026-10-01 bio',
    ]);
  });
});

describe('published replacements', () => {
  it('moves a collection earlier and keeps the nominal week’s bin', () => {
    const [moved] = householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, {
      from: '2026-03-23',
      to: '2026-04-05',
    }).collections.filter((collection) => collection.movedFrom !== null);

    /*
     * The operator's own example: Monday 2026-03-30 is in week 14, which is even, so it is Bioabfall.
     * It is collected on Saturday 2026-03-28 — in week 13, which is odd — and it is still Bioabfall.
     * Deriving the bin from the date it lands on would call this Restabfall.
     */
    expect(moved).toMatchObject({
      date: '2026-03-28',
      nominalDate: '2026-03-30',
      type: 'bio',
      movedFrom: '2026-03-30',
      reason: 'Karfreitag',
    });
  });

  it('moves a collection later', () => {
    const thursday = { ...MONDAY_HOUSEHOLD, weekday: 4 as const };

    expect(datesAndTypes('2026-05-11', '2026-05-17', thursday)).toEqual(['2026-05-15 bio']);
  });

  it('applies a cascade to each nominal date, never chaining one into the next', () => {
    // The Thursday route lands on Friday and the Friday route on Saturday. If the replacement were
    // applied to its own result, the Thursday collection would walk on to Saturday too.
    const thursday = householdCollectionsIn(
      RULES,
      { ...MONDAY_HOUSEHOLD, weekday: 4 },
      { from: '2026-05-11', to: '2026-05-17' },
    ).collections;
    const friday = householdCollectionsIn(
      RULES,
      { ...MONDAY_HOUSEHOLD, weekday: 5 },
      { from: '2026-05-11', to: '2026-05-17' },
    ).collections;

    expect(thursday[0]?.date).toBe('2026-05-15');
    expect(friday[0]?.date).toBe('2026-05-16');
  });

  it('leaves an unmoved collection with no reason to explain', () => {
    const [ordinary] = householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, {
      from: '2026-09-21',
      to: '2026-09-21',
    }).collections;

    expect(ordinary).toMatchObject({ movedFrom: null, reason: null });
  });

  it('orders by the date the collection actually happens', () => {
    // The Vorverlegung puts a nominally later collection before a nominally earlier one.
    const dates = householdCollectionsIn(
      RULES,
      { ...MONDAY_HOUSEHOLD, weekday: 2 },
      { from: '2026-03-23', to: '2026-04-05' },
    ).collections.map((collection) => collection.date);

    expect(dates).toEqual([...dates].sort());
  });

  it('leaves out a collection the operator moved before the requested range', () => {
    const dates = householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, {
      from: '2026-03-30',
      to: '2026-04-05',
    }).collections.map((collection) => collection.date);

    // The Monday nominally in range is collected on the 28th, which is before it starts — so a surface
    // asking about this window is not told about a collection that already happened.
    expect(dates).toEqual([]);
  });

  /**
   * The mirror image, and the one the operator publishes a notice about: a collection moved *into* the
   * range from a nominal date outside it.
   */
  it('includes a collection the operator moved into the requested range', () => {
    const [moved] = householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, {
      from: '2026-03-28',
      to: '2026-03-28',
    }).collections;

    // Asking about that Saturday alone finds the Monday collection the operator brought forward onto it.
    expect(moved).toMatchObject({
      date: '2026-03-28',
      nominalDate: '2026-03-30',
      type: 'bio',
      reason: 'Karfreitag',
    });
  });
});

describe('coverage', () => {
  it('generates nothing past the published table and says so', () => {
    const result = householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, {
      from: '2026-12-14',
      to: '2027-01-31',
    });

    // The last Monday inside the coverage window is 2026-12-21; 2026-12-28 is past it. These fixture
    // rules carry no Christmas row, so neither date is moved — the coverage boundary alone decides.
    expect(result.collections.map((collection) => collection.date)).toEqual([
      '2026-12-14',
      '2026-12-21',
    ]);
    expect(result.limitedCoverage).toBe(true);
    expect(result.coveredRange).toEqual({ from: '2026-12-14', to: '2026-12-26' });
  });

  it('never extrapolates the parity rule into the next year', () => {
    const result = householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, {
      from: '2027-01-01',
      to: '2027-03-31',
    });

    expect(result.collections).toEqual([]);
    expect(result.coveredRange).toBeNull();
    expect(result.limitedCoverage).toBe(true);
  });

  it('reports full coverage for a range inside the published table', () => {
    expect(
      householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, { from: '2026-09-01', to: '2026-09-30' }),
    ).toMatchObject({ limitedCoverage: false });
  });

  it('names the day the published knowledge stops', () => {
    expect(coverageEndsAfter(RULES)).toBe('2026-12-27');
  });
});

describe('the setup a calculation may be made for', () => {
  it('refuses rules belonging to another operator', () => {
    const elsewhere = { ...MONDAY_HOUSEHOLD, providerId: 'somewhere-else' };

    expect(
      householdCollectionsIn(RULES, elsewhere, { from: '2026-09-01', to: '2026-09-30' }),
    ).toMatchObject({ collections: [], coveredRange: null, limitedCoverage: true });
  });

  it('keeps an identity that survives a collection being moved', () => {
    const [moved] = householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, {
      // The date it is actually collected on, which is where a surface would find it.
      from: '2026-03-28',
      to: '2026-03-28',
    }).collections;

    // Keyed by the nominal date, so the same collection keeps one identity on both sides of a shift.
    expect(moved?.id).toBe('calculated:koblenz-servicebetrieb:koblenz-neuendorf:2026-03-30:bio');
  });

  it('marks the domain event as calculated rather than published', () => {
    const [collection] = householdCollectionsIn(RULES, MONDAY_HOUSEHOLD, {
      from: '2026-09-21',
      to: '2026-09-21',
    }).collections;

    expect(toCollectionEvent(collection as HouseholdCollection, 'koblenz-neuendorf')).toMatchObject(
      {
        source: 'user_rule',
        date: '2026-09-21',
        type: 'residual',
        collectionMode: 'curbside',
        timing: { kind: 'all_day' },
      },
    );
  });
});
