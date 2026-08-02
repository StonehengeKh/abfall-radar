import { z } from 'zod';
import { ProviderSchema } from './providers';
import { TimeZoneSchema } from './time-zone';
import { WebUrlSchema } from './web-url';

/**
 * Official collection events for one service area, with the provenance of the source they came from.
 *
 * The waste-type and event vocabularies are restated here rather than imported from
 * `@abfall-radar/domain` on purpose: this package owns the wire shape, the domain owns the business
 * model, and neither is expressed in terms of the other. The duplication is made safe by the
 * compile-time compatibility check, which pins each validator to the type OpenAPI generated.
 */

export const WasteTypeTransportSchema = z.enum([
  'residual',
  'bio',
  'paper',
  'yellow_bag',
  'green_waste',
  'christmas_tree',
  'hazardous',
  'small_electronics',
]);

export type WasteTypeTransport = z.infer<typeof WasteTypeTransportSchema>;

export const AllDayTimingSchema = z.object({
  kind: z.literal('all_day'),
});

/**
 * A drop-off window, whose end may not precede its start.
 *
 * Two valid instants do not make a valid window. An inverted one passed transport validation, was cached, and
 * then threw inside `toDomainCollectionEvents` — the domain has always refused it — so the failure surfaced
 * during React rendering or inside the alarm handler rather than at the boundary that accepted it. Refusing it
 * here means an inverted window becomes an `invalid_response` before it can be mapped, rendered, reminded about,
 * or written to the cache.
 *
 * Compared as **parsed instants** rather than as strings. It happens to be equivalent today, because
 * `z.iso.datetime()` accepts only a `Z` designator and rejects offsets, so every accepted value is already UTC —
 * but lexical order still breaks on fractional seconds (`...:00.500Z` sorts before `...:00Z`), and it would break
 * outright if the offset policy ever widened. Epoch comparison is correct under both.
 *
 * Inclusive, exactly as the domain is: a zero-length window is a real thing a source can publish, and the two
 * validators must not disagree about whether it is representable.
 */
export const TimeWindowTimingSchema = z
  .object({
    kind: z.literal('time_window'),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    /** The zone a drop-off window is rendered in, so an unusable one would throw while formatting it. */
    timeZone: TimeZoneSchema,
  })
  .refine(({ startsAt, endsAt }) => Date.parse(endsAt) >= Date.parse(startsAt), {
    error: 'endsAt must not precede startsAt.',
    path: ['endsAt'],
  });

/**
 * Where a mobile drop-off happens, in its **canonical** spelling.
 *
 * An untrimmed name is rejected rather than trimmed and accepted. Normalizing here would leave two packages
 * disagreeing about what a name is: this validator would say `' Rizzastraße '` is fine and hand on `'Rizzastraße'`,
 * while `@abfall-radar/domain` — which refuses the untrimmed form outright — would be mapping a value the transport
 * had silently altered. One canonical form means a place cannot arrive under two spellings, and the boundary that
 * *produced* the value is the one that has to fix it.
 *
 * Whitespace-only is refused by the same rule: it trims to nothing, and a location whose name is empty is not a
 * place anyone can be told to go to.
 *
 * Duplicated from the domain deliberately. This package is the transport boundary and depends on `zod` alone: it
 * owns the wire shape, the domain owns the business model, and adding that dependency to share one refinement would
 * couple every consumer of the transport to the domain package. `compatibility.test.ts` is what stops the two
 * definitions drifting.
 */
export const CollectionLocationSchema = z.object({
  name: z
    .string()
    .min(1)
    .refine((value) => value === value.trim(), {
      error: 'A location name must not carry leading or trailing whitespace.',
    })
    .refine((value) => value.trim() !== '', {
      error: 'A location name must not be blank.',
    }),
});

const collectionEventBaseShape = {
  /** Opaque. The readable prefix exists for operators, so nothing here parses either part. */
  id: z.string().min(1),
  serviceAreaId: z.string().min(1),
  wasteType: WasteTypeTransportSchema,
  date: z.iso.date(),
  title: z.string().min(1),
  source: z.enum(['demo', 'municipal_ics', 'user_rule']),
};

export const CurbsideCollectionEventSchema = z.object({
  ...collectionEventBaseShape,
  collectionMode: z.literal('curbside'),
  timing: AllDayTimingSchema,
});

export const MobileDropOffCollectionEventSchema = z.object({
  ...collectionEventBaseShape,
  collectionMode: z.literal('mobile_drop_off'),
  timing: TimeWindowTimingSchema,
  location: CollectionLocationSchema,
});

/**
 * A closed variant set, which means a genuinely new `collectionMode` fails validation loudly. That is
 * the intended cost of making an incomplete event unrepresentable: the alternative is a client rendering
 * "bring something somewhere" with no window and no place.
 */
export const CollectionEventSchema = z.discriminatedUnion('collectionMode', [
  CurbsideCollectionEventSchema,
  MobileDropOffCollectionEventSchema,
]);

export type CollectionEventTransport = z.infer<typeof CollectionEventSchema>;

export const ScheduleServiceAreaSchema = z.object({
  id: z.string().min(1),
  locality: z.string().min(1),
  name: z.string().min(1),
});

export const ScheduleSourceSchema = z.object({
  name: z.string().min(1),
  /** Shown as a clickable link, so only an http(s) address without credentials is acceptable. */
  landingPageUrl: WebUrlSchema,
  attribution: z.string().min(1),
  /**
   * The provenance zone, which is what the reminder day and every relative date label are computed in.
   *
   * A reminder is unprompted and tells someone to act, so this value reaching storage unusable is the worst
   * of the three: the throw would surface in the background worker, where nobody sees it.
   */
  timeZone: TimeZoneSchema,
});

export type ScheduleSource = z.infer<typeof ScheduleSourceSchema>;

/**
 * The source's own declaration, never inferred from the events returned. An empty result inside a
 * covered range means "no collection in this period"; a waste type absent from this list means "this
 * source does not publish it". Those are different statements and a surface must not conflate them.
 */
export const ScheduleCoverageSchema = z.object({
  wasteTypes: z.array(WasteTypeTransportSchema),
});

export const ScheduleRangeSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
});

export type ScheduleRange = z.infer<typeof ScheduleRangeSchema>;

/**
 * The metadata of a schedule response, with the relations between its dates enforced.
 *
 * Four valid dates do not make a coherent answer. Each relation below is a way a schema-valid response could
 * contradict itself, and every one of them is load-bearing downstream:
 *
 * - `validFrom` after `validTo` is a declared window that contains no day at all. The requested range is clamped
 *   into that window, so an inverted one makes every derivation meaningless and produces an empty range that
 *   reads as "no collection scheduled".
 * - a `range` whose start follows its end is the same contradiction one level down, and the cache stores it as
 *   the range it was served for.
 * - a `range` reaching outside the declared window is the server claiming to have filtered on a period its own
 *   source says it does not cover. The cache records that range as covered, the display range is derived from
 *   it, and the absence of events in the part beyond the window is then presented as "nothing scheduled" rather
 *   than "no data".
 *
 * The remaining two relations — that the range equals the range *requested*, and that every event falls inside
 * it — need the request to check against, so they live in the client rather than here.
 */
export const CollectionEventMetaSchema = z
  .object({
    provider: ProviderSchema,
    serviceArea: ScheduleServiceAreaSchema,
    source: ScheduleSourceSchema,
    /** The last *successful* retrieval, preserved across a failed refresh, so it never overstates itself. */
    retrievedAt: z.iso.datetime(),
    validFrom: z.iso.date(),
    validTo: z.iso.date(),
    freshness: z.enum(['fresh', 'stale']),
    coverage: ScheduleCoverageSchema,
    range: ScheduleRangeSchema,
  })
  // ISO dates sort lexicographically, so these are calendar comparisons with no instant and no zone involved.
  .refine(({ validFrom, validTo }) => validFrom <= validTo, {
    error: 'validFrom must not follow validTo.',
    path: ['validTo'],
  })
  .refine(({ range }) => range.from <= range.to, {
    error: 'The served range must not start after it ends.',
    path: ['range'],
  })
  .refine(({ range, validFrom }) => range.from >= validFrom, {
    error: 'The served range must not begin before the declared validity window.',
    path: ['range', 'from'],
  })
  .refine(({ range, validTo }) => range.to <= validTo, {
    error: 'The served range must not end after the declared validity window.',
    path: ['range', 'to'],
  });

export type CollectionEventMeta = z.infer<typeof CollectionEventMetaSchema>;

/**
 * The response as a whole, with the one relation that spans its two halves enforced.
 *
 * `coverage.wasteTypes` is the source's **own declaration** of what it publishes, and every surface treats it as
 * exactly that: an empty result inside a covered range means "no collection in this period", while a waste type
 * absent from the list means "this source does not publish it". An event whose type is not declared makes those two
 * statements contradict each other — the schedule contains a collection the source says it does not publish — and
 * every reader then has to decide which half to believe. The dashboard would render the event while telling the
 * person that type is not covered; the reminder would notify about a collection of a type it also reports as
 * unavailable.
 *
 * Checked here rather than inside either half, because neither can see the other, and only after both have parsed
 * — an unparsed event has no trustworthy `wasteType` to look up, and an unparsed coverage list is nothing to look
 * it up in. `superRefine` reports at the **offending event's own** `wasteType` path, so a build or a log names the
 * event that is wrong rather than the response that contains it.
 *
 * One offending event rejects the whole response. Coverage is a claim about the entire answer, so a response that
 * contradicts it cannot be partially trusted: dropping the event would silently change what the source said, and
 * keeping it would present data the source disclaimed.
 *
 * Deliberately **not** inferred the other way round. Declared types with no events stay valid — that is the
 * ordinary case for a quiet period — and coverage may legitimately be a superset of what the range contains.
 */
export const CollectionEventListResponseSchema = z
  .object({
    data: z.array(CollectionEventSchema),
    meta: CollectionEventMetaSchema,
  })
  .superRefine((response, ctx) => {
    const declared = new Set(response.meta.coverage.wasteTypes);

    response.data.forEach((event, index) => {
      if (declared.has(event.wasteType)) {
        return;
      }

      ctx.addIssue({
        code: 'custom',
        path: ['data', index, 'wasteType'],
        message: 'The event carries a waste type the source does not declare it publishes.',
      });
    });
  });

export type CollectionEventListResponse = z.infer<typeof CollectionEventListResponseSchema>;
