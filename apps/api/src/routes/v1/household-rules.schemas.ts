import { z } from 'zod';

/**
 * The wire shape of the municipal rules for the two household bins.
 *
 * These are **rules, not dates**. The operator publishes no calendar for the Braune and Graue Tonne, so
 * there is nothing to retrieve per district: what exists is a parity rule, a table of holiday
 * replacements, and a weekday that only the household knows. This endpoint serves the first two and
 * says where they came from; the client supplies the third and does the arithmetic.
 *
 * Every field a client needs in order to *disclose* what it is showing is part of the contract:
 * `verification`, `checkedAt`, `revision` and both source URLs. A client that could not say
 * "calculated from rules published here, last checked then" would have to present calculated dates as
 * though they were retrieved ones.
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

export const WasteTypeSchema = z.enum([
  'residual',
  'bio',
  'paper',
  'yellow_bag',
  'green_waste',
  'christmas_tree',
  'hazardous',
  'small_electronics',
]);

export const WeekParityRuleSchema = z.object({ even: WasteTypeSchema, odd: WasteTypeSchema }).meta({
  id: 'WeekParityRule',
  description:
    'Which bin the operator empties in an even ISO calendar week and which in an odd one. Stated as data because it is a municipal rule, not a property of waste collection.',
  examples: [{ even: 'bio', odd: 'residual' }],
});

export const CollectionDateReplacementSchema = z
  .object({
    nominalDate: z.iso.date(),
    actualDate: z.iso.date(),
    reason: z.string().min(1),
  })
  .meta({
    id: 'CollectionDateReplacement',
    description:
      'One published change of collection date, keyed by the date the regular rule would produce. `actualDate` may be earlier (Vorverlegung) or later (Nachverlegung) and may fall in another ISO week; the waste type is still decided by the nominal week. A client applies at most one replacement per nominal date and never chains them.',
    examples: [
      { nominalDate: '2026-03-30', actualDate: '2026-03-28', reason: 'Karfreitag' },
      { nominalDate: '2026-05-14', actualDate: '2026-05-15', reason: 'Christi Himmelfahrt' },
    ],
  });

export const HouseholdRuleChecksSchema = z
  .object({
    table: z.enum(['verified', 'unverified', 'changed']),
    parityRule: z.enum(['verified', 'unverified', 'changed']),
    tableLink: z.enum(['verified', 'unverified', 'changed']),
  })
  .meta({
    id: 'HouseholdRuleChecks',
    description: [
      'The checks behind `verification`, reported separately because they fail separately and mean different things.',
      '`table`: the published document the replacements were read from is byte-for-byte unchanged. `parityRule`: the page still states the same week-parity rule, for the same year. `tableLink`: the page still points at that same document rather than a newer one.',
      "A client must not describe a schedule as freshly verified on the strength of one of these. The operator can change the sentence without touching the document, or publish next year's table and stop linking the old one.",
      "**Not covered at all:** the operator's per-holiday announcements, which restate and could amend a row. They are prose on a news page; `announcementsReviewedThrough` says how far a person has read them.",
    ].join('\n\n'),
  });

export const RuleVerificationSchema = z.enum(['verified', 'unverified', 'changed']).meta({
  id: 'RuleVerification',
  description: [
    'How the served rules stand against the document they were transcribed from.',
    '`verified`: the published document was retrieved and still matches the digest recorded when it was transcribed.',
    '`unverified`: it could not be retrieved, which is evidence of nothing — the rules are served unchanged and the client says they could not be checked.',
    '`changed`: it was retrieved and differs. The operator has published something new, so the transcription is out of date and a client must not present its dates as current.',
  ].join('\n\n'),
});

export const HouseholdRuleSourceSchema = z
  .object({
    name: z.string().min(1),
    attribution: z.string().min(1),
    landingPageUrl: z.url(),
    replacementsSourceUrl: z.url(),
    parityRuleSourceUrl: z.url(),
    timeZone: z.string().min(1),
  })
  .meta({
    id: 'HouseholdRuleSource',
    description:
      'Where the rules were transcribed from. `replacementsSourceUrl` is the document carrying the holiday table — for Koblenz an image, which is why this is a maintained transcription rather than an extraction.',
  });

export const HouseholdRulesSchema = z
  .object({
    providerId: z.string().min(1),
    cityId: z.string().min(1),
    coverage: z.object({ from: z.iso.date(), to: z.iso.date() }),
    parity: WeekParityRuleSchema,
    replacements: z.array(CollectionDateReplacementSchema),
    source: HouseholdRuleSourceSchema,
    revision: z.string().min(1),
    checkedAt: z.iso.datetime(),
    announcementsReviewedThrough: z.iso.date(),
    checks: HouseholdRuleChecksSchema,
    verification: RuleVerificationSchema,
  })
  .meta({
    id: 'HouseholdRules',
    description: [
      'The municipal rules a client calculates household collections from, for one provider and one period.',
      '`coverage` is a hard boundary: the operator publishes holiday replacements one year at a time, so beyond `coverage.to` nothing is known about whether a week is moved. A client must report limited coverage there rather than extending the parity rule.',
    ].join('\n\n'),
  });

export type HouseholdRules = z.infer<typeof HouseholdRulesSchema>;

export const HouseholdRulesResponseSchema = z.object({ data: HouseholdRulesSchema }).meta({
  id: 'HouseholdRulesResponse',
  description:
    'The municipal rules for the household bins this provider publishes no calendar for, with the period they cover and how they stand against the documents they were transcribed from.',
});
