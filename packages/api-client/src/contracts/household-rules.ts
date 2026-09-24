import { z } from 'zod';
import { WasteTypeTransportSchema } from './collection-events';

/**
 * The municipal rules for the two household bins, as they arrive over HTTP.
 *
 * Hand-written and validated for the same reason every other contract here is: a response is untrusted
 * input, and these rules decide dates a person will put a bin outside for. A malformed replacement or a
 * missing coverage bound must fail validation rather than reach a calculation, because the output of
 * that calculation is indistinguishable, on screen, from a date the operator published.
 *
 * Unknown members are stripped, so a server that adds a field cannot break an installed client.
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

export const WeekParityRuleSchema = z.object({
  even: WasteTypeTransportSchema,
  odd: WasteTypeTransportSchema,
});

export const CollectionDateReplacementSchema = z.object({
  nominalDate: z.iso.date(),
  actualDate: z.iso.date(),
  reason: z.string().min(1),
});

export type CollectionDateReplacement = z.infer<typeof CollectionDateReplacementSchema>;

/**
 * Closed rather than open, unlike a problem code.
 *
 * A verification state a build does not understand cannot be degraded to something harmless: the three
 * values mean "trust these dates", "say they could not be checked" and "do not present these dates as
 * current", and guessing between them is exactly the mistake this field exists to prevent.
 */
export const RuleVerificationSchema = z.enum(['verified', 'unverified', 'changed']);

export type RuleVerification = z.infer<typeof RuleVerificationSchema>;

/**
 * The three checks behind that one word.
 *
 * Carried separately so a client can say what was actually established rather than implying the whole
 * schedule was re-read: the bytes of the published table, the parity sentence on the page, and the fact
 * that the page still links that table rather than a newer one.
 */
export const HouseholdRuleChecksSchema = z.object({
  table: RuleVerificationSchema,
  parityRule: RuleVerificationSchema,
  tableLink: RuleVerificationSchema,
});

export type HouseholdRuleChecks = z.infer<typeof HouseholdRuleChecksSchema>;

export const HouseholdRuleSourceSchema = z.object({
  name: z.string().min(1),
  attribution: z.string().min(1),
  landingPageUrl: z.string().min(1),
  replacementsSourceUrl: z.string().min(1),
  parityRuleSourceUrl: z.string().min(1),
  timeZone: z.string().min(1),
});

export const HouseholdRulesSchema = z.object({
  providerId: z.string().min(1),
  cityId: z.string().min(1),
  coverage: z.object({ from: z.iso.date(), to: z.iso.date() }),
  parity: WeekParityRuleSchema,
  replacements: z.array(CollectionDateReplacementSchema),
  source: HouseholdRuleSourceSchema,
  revision: z.string().min(1),
  checkedAt: z.iso.datetime(),
  /** How far a person has read the operator's announcements; nothing automatic covers them. */
  announcementsReviewedThrough: z.iso.date(),
  checks: HouseholdRuleChecksSchema,
  verification: RuleVerificationSchema,
});

export type HouseholdRules = z.infer<typeof HouseholdRulesSchema>;

export const HouseholdRulesResponseSchema = z.object({
  data: HouseholdRulesSchema,
});

export type HouseholdRulesResponse = z.infer<typeof HouseholdRulesResponseSchema>;
