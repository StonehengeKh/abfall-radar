import { z } from 'zod';
import { WasteTypeSchema } from './waste';

/**
 * The municipal rules a household collection is calculated from.
 *
 * Two of the bins a municipality empties are not in any machine-readable feed. Koblenz publishes the
 * rule for them in prose — brown bin in even calendar weeks, grey bin in odd ones — states that the
 * weekday depends on the household and is only available by telephone, and publishes the holiday
 * replacements for the year as an **image**. So a date for these bins is not retrieved; it is
 * *calculated* from three things: a published parity rule, a published table of replacements, and a
 * weekday the person confirmed.
 *
 * This shape is what the server hands a client to do that calculation with. It is deliberately data
 * rather than dates: the server cannot know the household's weekday, and a client must never invent the
 * rules. Everything here is transcribed from one named source and carries what is needed to say so —
 * where it came from, what period it covers, and whether the published source still matches the
 * transcription.
 */

/** ISO-8601 calendar date, `YYYY-MM-DD`. Never an instant: a collection day is a date, not a moment. */
export const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date must be written as YYYY-MM-DD');

/**
 * ISO-8601 weekday numbering: 1 is Monday and 7 is Sunday.
 *
 * The ISO numbering rather than `Date.getDay()`, because every other calculation here is ISO — the week
 * number, the week's parity, and the weekday — and mixing the two numbering schemes is how a Sunday
 * becomes a Monday.
 */
export const IsoWeekdaySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);

export type IsoWeekday = z.infer<typeof IsoWeekdaySchema>;

/**
 * Which bin is emptied in an even ISO week and which in an odd one.
 *
 * Stated as data rather than written into the calculation, because it is the municipality's rule and a
 * second municipality may well state the opposite one — or none at all.
 */
export const WeekParityRuleSchema = z.strictObject({
  even: WasteTypeSchema,
  odd: WasteTypeSchema,
});

export type WeekParityRule = z.infer<typeof WeekParityRuleSchema>;

/**
 * One published replacement: the date a collection would nominally fall on, and the date the operator
 * actually collects instead.
 *
 * Keyed by the **nominal** date, which is what keeps a cascade from chaining. In a week where the
 * Thursday route moves to Friday and the Friday route moves to Saturday, both entries are present and
 * each is applied to its own nominal date; nothing is applied twice.
 */
export const CollectionDateReplacementSchema = z.strictObject({
  /** The date the parity rule and the household's weekday would otherwise produce. */
  nominalDate: CalendarDateSchema,
  /** The date the operator publishes instead. May be earlier or later, and may cross a week boundary. */
  actualDate: CalendarDateSchema,
  /** The holiday the operator names for this row, as published. */
  reason: z.string().min(1),
});

export type CollectionDateReplacement = z.infer<typeof CollectionDateReplacementSchema>;

/**
 * How the transcription stands against the source it was taken from.
 *
 * `verified` means the published source was fetched and still matches the digest recorded when it was
 * transcribed. `unverified` means it could not be reached, which is not evidence of anything. `changed`
 * means it was reached and no longer matches — the strongest statement of the three, and the one that
 * must stop the rules being presented as current.
 */
export const RuleVerificationSchema = z.enum(['verified', 'unverified', 'changed']);

export type RuleVerification = z.infer<typeof RuleVerificationSchema>;

/**
 * The individual checks behind that one word, because they fail separately and mean different things.
 *
 * - `table`: the published document the replacements were read from is byte-for-byte unchanged.
 * - `parityRule`: the page still states the same week-parity rule, for the same year.
 * - `tableLink`: the page still points at that same document, rather than at a newer one.
 *
 * Reported individually so a surface can say what was actually established. A digest check of one image
 * does not make a schedule "freshly verified": the operator can change the sentence without touching the
 * image, or publish next year's table beside the old one and simply stop linking it.
 *
 * **Not represented here, because it is not automated:** the operator's per-holiday announcements, which
 * restate and could amend a row. They are prose on a news page; a machine guessing at them would be
 * inventing collection dates. `announcementsReviewedThrough` records how far a person has read them.
 */
export const HouseholdRuleChecksSchema = z.strictObject({
  table: RuleVerificationSchema,
  parityRule: RuleVerificationSchema,
  tableLink: RuleVerificationSchema,
});

export type HouseholdRuleChecks = z.infer<typeof HouseholdRuleChecksSchema>;

export const HouseholdRuleSourceSchema = z.strictObject({
  name: z.string().min(1),
  attribution: z.string().min(1),
  /** The public page a client attributes, never a download URL. */
  landingPageUrl: z.string().url(),
  /** The published document the replacements were transcribed from. */
  replacementsSourceUrl: z.string().url(),
  /** The published page the parity rule was transcribed from. */
  parityRuleSourceUrl: z.string().url(),
  /** The zone every date in these rules is a calendar date in. */
  timeZone: z.string().min(1),
});

export type HouseholdRuleSource = z.infer<typeof HouseholdRuleSourceSchema>;

/**
 * The complete rule set for one provider and one period.
 *
 * `coverage` is a hard boundary, not a hint. The published table states the replacements for a year and
 * stops; the week after its last row may or may not be moved by the next year's holidays, and nobody
 * can tell from this document which. Generating past `coverage.to` would be inventing dates that look
 * exactly as trustworthy as the transcribed ones.
 */
export const HouseholdCollectionRulesSchema = z.strictObject({
  providerId: z.string().min(1),
  cityId: z.string().min(1),
  /** The period the replacements are complete for, inclusive. */
  coverage: z.strictObject({ from: CalendarDateSchema, to: CalendarDateSchema }),
  parity: WeekParityRuleSchema,
  replacements: z.array(CollectionDateReplacementSchema),
  source: HouseholdRuleSourceSchema,
  /**
   * The transcription's own identity, so a client can tell one revision from another and a cache can be
   * invalidated when the transcription changes rather than only when the source does.
   */
  revision: z.string().min(1),
  /** When the automatic checks last ran against the published sources. */
  checkedAt: z.string().datetime(),
  /**
   * The date through which a person has read the operator's announcements for amendments to the table.
   *
   * Human work, stated as data, because nothing automatic covers it: an announcement published after
   * this date could amend a row and this build would not know.
   */
  announcementsReviewedThrough: CalendarDateSchema,
  checks: HouseholdRuleChecksSchema,
  /** The three checks in one word: `changed` if any changed, `verified` only if all three verified. */
  verification: RuleVerificationSchema,
});

export type HouseholdCollectionRules = z.infer<typeof HouseholdCollectionRulesSchema>;

/**
 * A household's own setting: the weekday the operator told them, and nothing else.
 *
 * Bound to the confirmed location by `providerId` and `serviceAreaId`, because a weekday is a fact
 * about one address. Carrying it to another district — let alone another municipality — would produce
 * confident dates for a route nobody checked.
 */
export const HouseholdBinSetupSchema = z.strictObject({
  providerId: z.string().min(1),
  serviceAreaId: z.string().min(1),
  weekday: IsoWeekdaySchema,
});

export type HouseholdBinSetup = z.infer<typeof HouseholdBinSetupSchema>;
