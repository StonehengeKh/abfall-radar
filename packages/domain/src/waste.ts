import { z } from 'zod';

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

export type WasteType = z.infer<typeof WasteTypeSchema>;

/**
 * An all-day collection: the calendar date is the whole statement, so there is no window and no
 * place to go.
 */
export const AllDayTimingSchema = z.strictObject({
  kind: z.literal('all_day'),
});

/**
 * A bounded window in a named zone. The zone travels with the instants because the same pair of
 * instants under a different zone is a different local appointment to the person reading it.
 */
export const TimeWindowTimingSchema = z
  .strictObject({
    kind: z.literal('time_window'),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    timeZone: z.string().min(1),
  })
  .refine(({ startsAt, endsAt }) => Date.parse(endsAt) >= Date.parse(startsAt), {
    error: 'endsAt must not precede startsAt.',
    path: ['endsAt'],
  });

export const CollectionTimingSchema = z.union([AllDayTimingSchema, TimeWindowTimingSchema]);

export type CollectionTiming = z.infer<typeof CollectionTimingSchema>;

export const CollectionLocationSchema = z.strictObject({
  // Untrimmed names are rejected rather than trimmed here: normalizing at the boundary that produced
  // the value keeps one canonical form, so the same place cannot arrive under two spellings.
  name: z
    .string()
    .min(1)
    .refine((value) => value === value.trim(), {
      error: 'A location name must not carry leading or trailing whitespace.',
    }),
});

export type CollectionLocation = z.infer<typeof CollectionLocationSchema>;

const collectionEventBaseShape = {
  id: z.string().min(1),
  districtId: z.string().min(1),
  type: WasteTypeSchema,
  date: z.iso.date(),
  title: z.string().min(1),
  source: z.enum(['demo', 'municipal_ics', 'user_rule']),
};

/**
 * Every variant is a strict object on purpose. A non-strict object would silently *strip* an extra
 * member, so a curbside event carrying a location would parse successfully and the invalid
 * combination would survive as an unnoticed no-op instead of failing.
 */
export const CurbsideCollectionEventSchema = z.strictObject({
  ...collectionEventBaseShape,
  collectionMode: z.literal('curbside'),
  timing: AllDayTimingSchema,
});

export type CurbsideCollectionEvent = z.infer<typeof CurbsideCollectionEventSchema>;

export const MobileDropOffCollectionEventSchema = z.strictObject({
  ...collectionEventBaseShape,
  collectionMode: z.literal('mobile_drop_off'),
  timing: TimeWindowTimingSchema,
  location: CollectionLocationSchema,
});

export type MobileDropOffCollectionEvent = z.infer<typeof MobileDropOffCollectionEventSchema>;

/**
 * A closed set of variants rather than a record with optional timing, mode, and location members.
 * Timing, mode, and place are not independent: an incomplete combination — "bring something
 * somewhere" with no window or no address — must be unrepresentable, because a product surface would
 * render it as an instruction nobody can act on. There is deliberately no default either, since an
 * absent timing could only be filled in by inference.
 */
export const CollectionEventSchema = z.discriminatedUnion('collectionMode', [
  CurbsideCollectionEventSchema,
  MobileDropOffCollectionEventSchema,
]);

export type CollectionEvent = z.infer<typeof CollectionEventSchema>;

export const DistrictSchema = z.object({
  id: z.string().min(1),
  city: z.string().min(1),
  name: z.string().min(1),
  providerId: z.string().min(1),
});

export type District = z.infer<typeof DistrictSchema>;

export const wasteLabels: Record<WasteType, string> = {
  residual: 'Restabfall',
  bio: 'Biotonne',
  paper: 'Altpapier',
  yellow_bag: 'Gelber Sack',
  green_waste: 'Grünschnitt',
  christmas_tree: 'Weihnachtsbaum',
  hazardous: 'Schadstoffe',
  small_electronics: 'Elektrokleinteile',
};

export const wasteDescriptions: Record<WasteType, string> = {
  residual: 'Graue Tonne',
  bio: 'Braune Tonne',
  paper: 'Papier und Karton',
  yellow_bag: 'Leichtverpackungen',
  green_waste: 'Gartenabfälle',
  christmas_tree: 'Saisonale Sammlung',
  hazardous: 'Mobile Sammlung',
  small_electronics: 'Kleine Elektrogeräte',
};
