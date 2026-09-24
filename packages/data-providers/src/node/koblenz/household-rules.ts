import type { CollectionDateReplacement, HouseholdCollectionRules } from '@abfall-radar/domain';
import { KOBLENZ_CITY_ID, KOBLENZ_PROVIDER_ID } from './manifest';

/**
 * The Koblenz rules for the Braune Tonne and the Graue Tonne, transcribed from the operator's own
 * publications.
 *
 * **This is a maintained transcription, not an extraction.** The operator publishes the week-parity rule
 * as a sentence on the schedule page and the year's holiday replacements as a **JPEG image**. Neither is
 * machine-readable, and the digital calendars exclude both bins outright. Nothing in this repository
 * parses that image: a person read it, wrote the rows below, and checked every one against the operator's
 * own press notices. What *is* automatic is the check that the published image still matches what was
 * read — `verifyHouseholdRuleSource` fetches it and compares digests, so a changed source stops these
 * rules being served as verified rather than quietly producing plausible dates from last year's table.
 *
 * Two official publications carry the same table, and both were read: the linked image, and page 23 of
 * the operator's own `Abfallratgeber 2026` brochure, whose text version states every row identically.
 * **Seven** of the nine rows are additionally restated by a dated press notice; Neujahr and
 * Weihnachten I are not, one because its notice predates the site's 2026 listing and the other because
 * it has not been published yet. Which row has which corroboration is tabulated in
 * [AR-007](../../../../../docs/tasks/AR-007-household-bin-schedules.md) rather than implied here — no
 * claim is made that every row was checked against a notice, because two could not be.
 *
 * Refreshing this for a new year is deliberate work, and the steps are exactly these:
 *
 * 1. open the schedule page, confirm the parity sentence and the year it names, and record the claim's
 *    digest in `KOBLENZ_PARITY_CLAIM_DIGEST`;
 * 2. take the URL the page now links and put it in `KOBLENZ_HOUSEHOLD_TABLE_URL`;
 * 3. read every row of that table and write the replacements here;
 * 4. record the document's SHA-256 in `KOBLENZ_HOUSEHOLD_TABLE_DIGEST` and bump `KOBLENZ_HOUSEHOLD_RULES_REVISION`;
 * 5. set `coverage` to the period the rows actually describe, and no further;
 * 6. read the operator's announcements published since the last review, and move
 *    `KOBLENZ_ANNOUNCEMENTS_REVIEWED_THROUGH` to the date you read up to.
 *
 * Until that is done the application reports limited coverage past `coverage.to`. It does **not**
 * extrapolate the parity rule, which the operator states per year and not as a standing rule.
 */

export const KOBLENZ_SCHEDULE_PAGE_URL =
  'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine/';

/**
 * The published table, as the schedule page links it.
 *
 * The query string is part of the operator's own link. It is kept exactly as published rather than
 * trimmed, because the URL is an allowlisted constant here and must be the one the operator serves.
 */
export const KOBLENZ_HOUSEHOLD_TABLE_URL =
  'https://servicebetrieb.koblenz.de/downloads/abfallratgeber-zusatzinformationen/feiertagsverlegungen-2026.jpg?cid=3mpm.ivdzs';

/**
 * SHA-256 of the published 2026 table as retrieved on 2026-09-23, when the rows below were transcribed.
 *
 * The whole value of this constant is that it is **not** derived from anything at runtime: it is the
 * fingerprint of the document a person actually read.
 */
export const KOBLENZ_HOUSEHOLD_TABLE_DIGEST =
  '92337b89b01dd1c17d009dbc11a7fa70e0ecf7847347f4607efe9399a3b50df8';

/** Bumped whenever the rows below change, independently of whether the source did. */
export const KOBLENZ_HOUSEHOLD_RULES_REVISION = '2026.1';

/**
 * The parity claim as the schedule page stated it on 2026-09-23, reduced to the facts it asserts:
 * `gilt-fuer:2026|geraden:braune|ungeraden:grauen`.
 *
 * A digest of those three facts rather than of the page, because a page carries navigation and notices
 * that change constantly — a fingerprint of all that would report a change every week until nobody
 * looked. This changes when the rule changes, or when the **year** it is stated for changes, and not
 * otherwise. The operator writes "Grundsätzlich gilt für 2026", so the year is part of the claim.
 */
export const KOBLENZ_PARITY_CLAIM_DIGEST =
  '9b87516b0eec76388b4d9db89c7a89c04b3f628aea8607a630627d3418cce754';

/**
 * The date through which the operator's announcements were read for amendments to the table.
 *
 * Nothing automatic covers this. The per-holiday notices are prose on a news page: a parser guessing at
 * them would be a machine inventing collection dates, and a notice that *amends* a row rather than
 * restating it would look exactly like one that restates it. So it is human work, recorded as data, and
 * a client is told how current that reading is.
 */
export const KOBLENZ_ANNOUNCEMENTS_REVIEWED_THROUGH = '2026-09-23';

/**
 * Builds the replacement rows for one holiday.
 *
 * Written as the published table is read — a list of dates in order, each moving to the next one along
 * in the direction the arrows point — so a transcription error is visible as a wrong date rather than
 * hidden in an index. `later` walks forwards (Nachverlegung), `earlier` walks backwards
 * (Vorverlegung).
 */
const shift = (
  reason: string,
  direction: 'later' | 'earlier',
  /** The nominal dates the operator moves, in calendar order, and the date the first one moves to. */
  { target, nominal }: { readonly target: string; readonly nominal: readonly string[] },
): CollectionDateReplacement[] => {
  const chain = direction === 'later' ? [...nominal, target] : [target, ...nominal];

  return nominal.map((nominalDate, index) => ({
    nominalDate,
    actualDate: direction === 'later' ? (chain[index + 1] as string) : (chain[index] as string),
    reason,
  }));
};

/**
 * Every row of "Feiertagsverlegungen 2026", in the operator's order.
 *
 * Each entry names the holiday exactly as the table does. The cross-check against the press notices is
 * recorded in [AR-007](../../../../../docs/tasks/AR-007-household-bin-schedules.md); where a notice
 * exists, it states the same mapping.
 */
const KOBLENZ_REPLACEMENTS_2026: readonly CollectionDateReplacement[] = [
  // Neujahr, Thursday 01.01.: the Thursday and Friday routes move one day later.
  ...shift('Neujahr', 'later', { nominal: ['2026-01-01', '2026-01-02'], target: '2026-01-03' }),
  // Rosenmontag, Monday 16.02.: the whole week moves one day later.
  ...shift('Rosenmontag', 'later', {
    nominal: ['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20'],
    target: '2026-02-21',
  }),
  /*
   * Karfreitag, Friday 03.04.: the whole week moves one day **earlier**, so the Monday route is
   * collected on the Saturday before. The operator's notice of 2026-03-20 states this row exactly:
   * "Die Biotonnen der Montagsreviere werden somit bereits am Samstag, den 28.03.2026 entleert".
   */
  ...shift('Karfreitag', 'earlier', {
    target: '2026-03-28',
    nominal: ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03'],
  }),
  // Ostermontag, Monday 06.04.: the whole week moves one day later.
  ...shift('Ostermontag', 'later', {
    nominal: ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'],
    target: '2026-04-11',
  }),
  // Maifeiertag, Friday 01.05.: only the Friday route moves.
  ...shift('Maifeiertag', 'later', { nominal: ['2026-05-01'], target: '2026-05-02' }),
  // Christi Himmelfahrt, Thursday 14.05.: the Thursday and Friday routes move one day later.
  ...shift('Christi Himmelfahrt', 'later', {
    nominal: ['2026-05-14', '2026-05-15'],
    target: '2026-05-16',
  }),
  // Pfingstmontag, Monday 25.05.: the whole week moves one day later.
  ...shift('Pfingstmontag', 'later', {
    nominal: ['2026-05-25', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29'],
    target: '2026-05-30',
  }),
  // Fronleichnam, Thursday 04.06.: the Thursday and Friday routes move one day later.
  ...shift('Fronleichnam', 'later', {
    nominal: ['2026-06-04', '2026-06-05'],
    target: '2026-06-06',
  }),
  // Weihnachten I, Friday 25.12.: the whole week moves one day earlier, Monday onto the Saturday before.
  ...shift('Weihnachten I', 'earlier', {
    target: '2026-12-19',
    nominal: ['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25'],
  }),
];

/**
 * The rules as served, minus the verification state, which only a fetch can establish.
 *
 * **Coverage ends on 2026-12-26, and that is this implementation's own conservative cutoff rather than
 * something the operator states.** What the operator actually publishes is this:
 *
 * - both 2026 tables — the linked image and page 23 of the 2026 brochure — end with a "Weihnachten I"
 *   row describing the week to Saturday 26.12.2026, and neither carries a row after it;
 * - the parity rule is written for a named year ("Grundsätzlich gilt für 2026"), not as a standing rule;
 * - nothing published for 2026 describes the week beginning Monday 28.12.2026.
 *
 * What is therefore **unverified**: whether collections in that last week are moved at all. It contains
 * Neujahr 2027, and the operator does move such weeks — the 2026 table's own first row moves the week
 * containing 01.01.2026, and that row reaches back into December 2025. That pattern suggests the week of
 * 28.12.2026 will appear in the 2027 table, which does not exist yet; it is an inference from how the
 * operator lays these tables out, not a statement anybody published.
 *
 * Note also that 2026-12-28 is in ISO week 53 **of 2026**, not of 2027, so the cutoff is not a calendar
 * year boundary and must not be described as one.
 *
 * Stopping at the last described day is the conservative reading: generating into a week nobody
 * published rules for would produce dates indistinguishable, on screen, from transcribed ones.
 */
export const KOBLENZ_HOUSEHOLD_RULES: Omit<
  HouseholdCollectionRules,
  'checkedAt' | 'verification' | 'checks'
> = {
  providerId: KOBLENZ_PROVIDER_ID,
  cityId: KOBLENZ_CITY_ID,
  coverage: { from: '2026-01-01', to: '2026-12-26' },
  /*
   * "in geraden Kalenderwochen: Braune Tonne" and "in ungeraden Kalenderwochen: Graue Tonne", as the
   * schedule page states it. ISO weeks, which is what a German municipal calendar means by
   * Kalenderwoche.
   */
  parity: { even: 'bio', odd: 'residual' },
  replacements: [...KOBLENZ_REPLACEMENTS_2026],
  announcementsReviewedThrough: KOBLENZ_ANNOUNCEMENTS_REVIEWED_THROUGH,
  source: {
    name: 'Kommunaler Servicebetrieb',
    attribution: 'Kommunaler Servicebetrieb, Koblenz',
    landingPageUrl: KOBLENZ_SCHEDULE_PAGE_URL,
    replacementsSourceUrl: KOBLENZ_HOUSEHOLD_TABLE_URL,
    parityRuleSourceUrl: KOBLENZ_SCHEDULE_PAGE_URL,
    timeZone: 'Europe/Berlin',
  },
  revision: KOBLENZ_HOUSEHOLD_RULES_REVISION,
};
