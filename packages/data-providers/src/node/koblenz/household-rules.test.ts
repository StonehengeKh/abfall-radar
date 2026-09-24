import { HouseholdCollectionRulesSchema } from '@abfall-radar/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  KOBLENZ_ANNOUNCEMENTS_REVIEWED_THROUGH,
  KOBLENZ_HOUSEHOLD_RULES,
  KOBLENZ_HOUSEHOLD_RULES_REVISION,
  KOBLENZ_HOUSEHOLD_TABLE_URL,
} from './household-rules';
import {
  getKoblenzHouseholdRules,
  overallVerification,
  verifyHouseholdRuleSource,
} from './household-verification';

/**
 * The transcription itself, asserted row by row.
 *
 * This is the one place in the repository where dates were copied from a document by a person, so it is
 * the one place where a test can only check that the copy is *self-consistent and complete* — it cannot
 * re-read the image. Every row below was also read a second time from page 23 of the operator's 2026
 * brochure, and six of the nine holidays are additionally restated by dated press notices; AR-007 records
 * which. What these assertions protect is the transcription against later edits.
 */

const complete = {
  ...KOBLENZ_HOUSEHOLD_RULES,
  checkedAt: '2026-09-23T08:00:00.000Z',
  checks: { table: 'verified', parityRule: 'verified', tableLink: 'verified' } as const,
  verification: 'verified' as const,
};

const mapping = (nominalDate: string): string | undefined =>
  KOBLENZ_HOUSEHOLD_RULES.replacements.find(
    (replacement) => replacement.nominalDate === nominalDate,
  )?.actualDate;

describe('the published rules', () => {
  it('is a valid rule set', () => {
    expect(HouseholdCollectionRulesSchema.safeParse(complete).success).toBe(true);
  });

  it('states the parity the operator publishes: brown in even weeks, grey in odd', () => {
    expect(KOBLENZ_HOUSEHOLD_RULES.parity).toEqual({ even: 'bio', odd: 'residual' });
  });

  it('stops at the last day the published rows describe', () => {
    /*
     * A conservative implementation cutoff, not a municipal statement. Both 2026 tables end with a
     * "Weihnachten I" row describing the week to Saturday 26.12.2026, and nothing published for 2026
     * describes the week beginning 28.12.2026 — which is ISO week 53 **of 2026**, not a new ISO year.
     * Whether that week is moved for Neujahr 2027 is unverified, so no date is generated in it.
     */
    expect(KOBLENZ_HOUSEHOLD_RULES.coverage).toEqual({ from: '2026-01-01', to: '2026-12-26' });
  });

  it('records the transcription’s own corroboration and review dates', () => {
    // How far a person has read the operator's announcements: the part nothing automatic covers.
    expect(KOBLENZ_HOUSEHOLD_RULES.announcementsReviewedThrough).toBe('2026-09-23');
  });

  it('attributes both published sources it was transcribed from', () => {
    expect(KOBLENZ_HOUSEHOLD_RULES.source).toMatchObject({
      landingPageUrl: 'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine/',
      replacementsSourceUrl: KOBLENZ_HOUSEHOLD_TABLE_URL,
      timeZone: 'Europe/Berlin',
    });
    expect(KOBLENZ_HOUSEHOLD_RULES.revision).toBe(KOBLENZ_HOUSEHOLD_RULES_REVISION);
  });
});

/**
 * Every row of the published table.
 *
 * Written out as the operator's own table reads, holiday by holiday, so a reviewer can hold the image
 * beside this list. A missing row is a silently wrong date on somebody's screen.
 */
describe('the nine transcribed holidays', () => {
  it.each([
    ['Neujahr', '2026-01-01', '2026-01-02'],
    ['Neujahr', '2026-01-02', '2026-01-03'],
    ['Rosenmontag', '2026-02-16', '2026-02-17'],
    ['Rosenmontag', '2026-02-17', '2026-02-18'],
    ['Rosenmontag', '2026-02-18', '2026-02-19'],
    ['Rosenmontag', '2026-02-19', '2026-02-20'],
    ['Rosenmontag', '2026-02-20', '2026-02-21'],
    // Vorverlegung: the whole week is collected one day earlier, the Monday route on the Saturday.
    ['Karfreitag', '2026-03-30', '2026-03-28'],
    ['Karfreitag', '2026-03-31', '2026-03-30'],
    ['Karfreitag', '2026-04-01', '2026-03-31'],
    ['Karfreitag', '2026-04-02', '2026-04-01'],
    ['Karfreitag', '2026-04-03', '2026-04-02'],
    ['Ostermontag', '2026-04-06', '2026-04-07'],
    ['Ostermontag', '2026-04-07', '2026-04-08'],
    ['Ostermontag', '2026-04-08', '2026-04-09'],
    ['Ostermontag', '2026-04-09', '2026-04-10'],
    ['Ostermontag', '2026-04-10', '2026-04-11'],
    // Only the Friday route moves, which the notice of 2026-04-27 states.
    ['Maifeiertag', '2026-05-01', '2026-05-02'],
    ['Christi Himmelfahrt', '2026-05-14', '2026-05-15'],
    ['Christi Himmelfahrt', '2026-05-15', '2026-05-16'],
    ['Pfingstmontag', '2026-05-25', '2026-05-26'],
    ['Pfingstmontag', '2026-05-26', '2026-05-27'],
    ['Pfingstmontag', '2026-05-27', '2026-05-28'],
    ['Pfingstmontag', '2026-05-28', '2026-05-29'],
    ['Pfingstmontag', '2026-05-29', '2026-05-30'],
    ['Fronleichnam', '2026-06-04', '2026-06-05'],
    ['Fronleichnam', '2026-06-05', '2026-06-06'],
    ['Weihnachten I', '2026-12-21', '2026-12-19'],
    ['Weihnachten I', '2026-12-22', '2026-12-21'],
    ['Weihnachten I', '2026-12-23', '2026-12-22'],
    ['Weihnachten I', '2026-12-24', '2026-12-23'],
    ['Weihnachten I', '2026-12-25', '2026-12-24'],
  ])('%s moves %s to %s', (reason, nominalDate, actualDate) => {
    expect(
      KOBLENZ_HOUSEHOLD_RULES.replacements.find(
        (replacement) => replacement.nominalDate === nominalDate,
      ),
    ).toEqual({ nominalDate, actualDate, reason });
  });

  it('carries exactly the rows the table publishes and no more', () => {
    expect(KOBLENZ_HOUSEHOLD_RULES.replacements).toHaveLength(32);
    expect(new Set(KOBLENZ_HOUSEHOLD_RULES.replacements.map((row) => row.reason)).size).toBe(9);
  });

  it('never maps one nominal date twice', () => {
    // The lookup is by nominal date, so a duplicate would silently make one of the two unreachable.
    const nominalDates = KOBLENZ_HOUSEHOLD_RULES.replacements.map((row) => row.nominalDate);

    expect(new Set(nominalDates).size).toBe(nominalDates.length);
  });

  it('keeps every replacement inside the covered period', () => {
    for (const { nominalDate, actualDate } of KOBLENZ_HOUSEHOLD_RULES.replacements) {
      expect(nominalDate >= KOBLENZ_HOUSEHOLD_RULES.coverage.from).toBe(true);
      expect(actualDate <= KOBLENZ_HOUSEHOLD_RULES.coverage.to).toBe(true);
    }
  });

  it('moves the Easter week earlier and the Whitsun week later', () => {
    // The two directions, stated as an assertion rather than left to the reader of the table.
    expect(mapping('2026-03-30')).toBe('2026-03-28');
    expect(mapping('2026-05-25')).toBe('2026-05-26');
  });
});

/**
 * What the automatic checks establish, and what they deliberately do not.
 *
 * Three documents' worth of claim, checked separately because they fail separately: the table's bytes,
 * the page's parity sentence, and the page's link to that table. The operator's announcements are not
 * checked at all — that is human work, and the transcription says how far it has been done.
 */
describe('verifying the published sources', () => {
  const PAGE = `
    <p>Grundsätzlich gilt für 2026:</p>
    <ul><li>in geraden Kalenderwochen: Abfuhr Braune Tonne</li>
    <li>in ungeraden Kalenderwochen: Abfuhr der Grauen Tonne</li></ul>
    <a href="${KOBLENZ_HOUSEHOLD_TABLE_URL}">Feiertagsverlegungen 2026</a>`;
  const TABLE_BODY = 'the published table';

  const digestOf = async (value: string) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

  /**
   * Answers each URL with its own body and its own media type, as the real host does.
   *
   * The types are part of the fixture rather than an afterthought: what a response *claims to be* is
   * checked before its bytes are, so a test that omitted them would exercise a different path from
   * production.
   */
  const host = ({
    page = PAGE,
    table = TABLE_BODY,
    pageType = 'text/html; charset=UTF-8',
    tableType = 'image/jpeg',
  }: {
    page?: string | null;
    table?: string | null;
    pageType?: string | null;
    tableType?: string | null;
  } = {}) =>
    vi.fn(async (input: string | URL | Request) => {
      const isTable = String(input).includes('feiertagsverlegungen');
      const body = isTable ? table : page;
      const type = isTable ? tableType : pageType;

      return body === null
        ? new Response('missing', { status: 404 })
        : new Response(body, {
            status: 200,
            ...(type === null ? {} : { headers: { 'content-type': type } }),
          });
    });

  const verify = async (options: Parameters<typeof verifyHouseholdRuleSource>[0] = {}) =>
    verifyHouseholdRuleSource({
      expectedTableDigest: await digestOf(TABLE_BODY),
      ...options,
    });

  it('reports all three checks verified when nothing has moved', async () => {
    const checks = await verify({ fetch: host() });

    expect(checks).toEqual({ table: 'verified', parityRule: 'verified', tableLink: 'verified' });
    expect(overallVerification(checks)).toBe('verified');
  });

  it('reports the table changed when the operator republishes it', async () => {
    const checks = await verify({ fetch: host({ table: 'a new table' }) });

    expect(checks.table).toBe('changed');
    expect(overallVerification(checks)).toBe('changed');
  });

  /**
   * The gap a digest check alone leaves: the rule can change while the image does not.
   */
  it('reports the parity rule changed when the page swaps the bins over', async () => {
    const swapped = PAGE.replace('Abfuhr Braune Tonne', 'Abfuhr der Grauen Tonne').replace(
      'in ungeraden Kalenderwochen: Abfuhr der Grauen Tonne',
      'in ungeraden Kalenderwochen: Abfuhr Braune Tonne',
    );
    const checks = await verify({ fetch: host({ page: swapped }) });

    expect(checks.table).toBe('verified');
    expect(checks.parityRule).toBe('changed');
    expect(overallVerification(checks)).toBe('changed');
  });

  it('reports the parity rule changed when it is stated for another year', async () => {
    const checks = await verify({
      fetch: host({ page: PAGE.replace('für 2026', 'für 2027') }),
    });

    expect(checks.parityRule).toBe('changed');
  });

  it('reports the parity rule changed when the page no longer states it at all', async () => {
    const checks = await verify({ fetch: host({ page: '<p>Rufen Sie uns an.</p>' }) });

    // Read, and what was transcribed from it is gone: that is a change, not an inability to check.
    expect(checks.parityRule).toBe('changed');
  });

  /**
   * The second gap: a new year's table published at a new URL, with the old file left exactly where it
   * is. Checking only the old URL's digest would answer "verified" about a document nobody is shown.
   */
  it('reports the link changed when the page points at a new year’s table', async () => {
    const nextYear = PAGE.replace(
      KOBLENZ_HOUSEHOLD_TABLE_URL,
      'https://servicebetrieb.koblenz.de/downloads/abfallratgeber-zusatzinformationen/feiertagsverlegungen-2027.jpg',
    );
    const checks = await verify({ fetch: host({ page: nextYear }) });

    expect(checks.table).toBe('verified');
    expect(checks.tableLink).toBe('changed');
    expect(overallVerification(checks)).toBe('changed');
  });

  it('reports unverified, not verified, when a source cannot be reached', async () => {
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    const checks = await verify({ fetch: offline });

    expect(checks).toEqual({
      table: 'unverified',
      parityRule: 'unverified',
      tableLink: 'unverified',
    });
    // Not evidence about the rules either way, so the rules stand and say they could not be checked.
    expect(overallVerification(checks)).toBe('unverified');
  });

  it('never calls a partly checked schedule verified', async () => {
    // The table answered; the page did not. Two of three checks could not run.
    const checks = await verify({ fetch: host({ page: null }) });

    expect(checks.table).toBe('verified');
    expect(overallVerification(checks)).toBe('unverified');
  });

  it('refuses an origin nobody approved, before any request', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'));
    const checks = await verifyHouseholdRuleSource({
      fetch: fetchImpl,
      tableUrl: 'https://example.com/table.jpg',
      pageUrl: 'http://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine/',
    });

    expect(checks).toEqual({
      table: 'unverified',
      parityRule: 'unverified',
      tableLink: 'unverified',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves the transcription with the checks and the moment they ran', async () => {
    const rules = await getKoblenzHouseholdRules({
      fetch: host({ table: 'a new table' }),
      clock: { now: () => new Date('2026-09-23T08:00:00.000Z') },
    });

    // The rows are served either way; what changes is what the client is told about them.
    expect(rules.replacements).toEqual(KOBLENZ_HOUSEHOLD_RULES.replacements);
    expect(rules).toMatchObject({
      verification: 'changed',
      checkedAt: '2026-09-23T08:00:00.000Z',
      announcementsReviewedThrough: KOBLENZ_ANNOUNCEMENTS_REVIEWED_THROUGH,
      revision: KOBLENZ_HOUSEHOLD_RULES_REVISION,
    });
    expect(rules.checks.table).toBe('changed');
  });

  /**
   * What a response *claims to be*, checked before what it contains.
   *
   * A digest establishes that bytes match, and nothing else. A proxy, an error endpoint or a changed
   * origin can serve a representation that happens to carry the pinned bytes or the expected phrases, and
   * reporting that as a freshly verified schedule would put calculated dates under a trust the check
   * never earned.
   */
  it('refuses a table that arrives as something other than an image', async () => {
    const checks = await verify({ fetch: host({ tableType: 'application/json' }) });

    // Not evidence of a change — evidence of not having seen the document at all.
    expect(checks.table).toBe('unverified');
    expect(overallVerification(checks)).toBe('unverified');
  });

  it('refuses a schedule page that arrives as something other than HTML', async () => {
    const checks = await verify({ fetch: host({ pageType: 'application/json' }) });

    expect(checks.parityRule).toBe('unverified');
    expect(checks.tableLink).toBe('unverified');
    // The table still answered correctly, so the run is partial rather than wholly unverified.
    expect(checks.table).toBe('verified');
    expect(overallVerification(checks)).toBe('unverified');
  });

  it('refuses a response that does not say what it is', async () => {
    const checks = await verify({ fetch: host({ pageType: null, tableType: null }) });

    expect(checks).toEqual({
      table: 'unverified',
      parityRule: 'unverified',
      tableLink: 'unverified',
    });
  });

  it('never reports verified for matching bytes delivered under the wrong type', async () => {
    // The exact case the review reproduced: real content, wrong representation.
    const checks = await verify({
      fetch: host({ pageType: 'application/json', tableType: 'application/json' }),
    });

    expect(overallVerification(checks)).not.toBe('verified');
  });

  it('accepts the ordinary casing and parameters a server sends', async () => {
    // `TEXT/HTML; charset=UTF-8` and `text/html` are the same representation; refusing one would report
    // a source change on an entirely ordinary server.
    const checks = await verify({
      fetch: host({ pageType: 'TEXT/HTML; charset=utf-8', tableType: 'Image/JPEG' }),
    });

    expect(checks).toEqual({ table: 'verified', parityRule: 'verified', tableLink: 'verified' });
  });

  it('accepts the unregistered image/jpg spelling', async () => {
    const checks = await verify({ fetch: host({ tableType: 'image/jpg' }) });

    expect(checks.table).toBe('verified');
  });

  it('still reports a changed table when the type is right and the bytes are not', async () => {
    // The media-type check guards the others; it must not mask an actual change.
    const checks = await verify({ fetch: host({ table: 'a new table' }) });

    expect(checks.table).toBe('changed');
    expect(overallVerification(checks)).toBe('changed');
  });

  it('records how far the operator’s announcements have been read by a person', async () => {
    // Nothing automatic covers them, so the date is data rather than an implied guarantee.
    expect(KOBLENZ_ANNOUNCEMENTS_REVIEWED_THROUGH).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
