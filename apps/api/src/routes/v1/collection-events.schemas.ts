import { WasteTypeSchema } from '@abfall-radar/domain';
import { z } from 'zod';
import { PROVIDER_ID_MAX_LENGTH, PROVIDER_ID_PATTERN, ProviderSchema } from './providers.schemas';

/** An inclusive range may span at most this many days. */
export const MAX_RANGE_DAYS = 366;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Both dates are read as UTC midnight, so no ambient zone can change the span by a day. */
export const inclusiveRangeDays = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MILLISECONDS_PER_DAY + 1;

const transportIdentifier = (description: string, example: string) =>
  z
    .string()
    .max(PROVIDER_ID_MAX_LENGTH)
    .regex(PROVIDER_ID_PATTERN)
    .meta({ description, examples: [example] });

/**
 * Deliberately not registered with an `id`: `@fastify/swagger` expands parameter schemas into an
 * OpenAPI `parameters` array, which cannot be done through a `$ref`.
 */
export const CollectionEventParamsSchema = z.object({
  providerId: transportIdentifier(
    'Identifier of a provider returned by `GET /api/v1/providers`.',
    'koblenz-servicebetrieb',
  ),
  serviceAreaId: transportIdentifier(
    'Identifier of a service area returned by `GET /api/v1/providers/{providerId}/service-areas`.',
    'koblenz-stadtmitte',
  ),
});

export const CollectionEventQuerySchema = z
  .object({
    from: z.iso.date().meta({
      description: 'First calendar date of the inclusive range.',
      examples: ['2026-03-01'],
    }),
    to: z.iso.date().meta({
      description: 'Last calendar date of the inclusive range.',
      examples: ['2026-03-31'],
    }),
  })
  .superRefine((value, ctx) => {
    if (value.from > value.to) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: '`to` must not be earlier than `from`.',
      });

      return;
    }

    if (inclusiveRangeDays(value.from, value.to) > MAX_RANGE_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `The inclusive range must not exceed ${MAX_RANGE_DAYS} days.`,
      });
    }
  });

export const AllDayTimingTransportSchema = z.object({ kind: z.literal('all_day') }).meta({
  id: 'AllDayTiming',
  description: 'The collection happens on the calendar date, with no window inside the day.',
  examples: [{ kind: 'all_day' }],
});

export const TimeWindowTimingTransportSchema = z
  .object({
    kind: z.literal('time_window'),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    timeZone: z.string().min(1),
  })
  .meta({
    id: 'TimeWindowTiming',
    description:
      'A bounded window in a named IANA time zone. The zone travels with the instants because it decides the local time a person is told to show up, and the daylight-saving rules that move it.',
    examples: [
      {
        kind: 'time_window',
        startsAt: '2026-03-21T10:00:00Z',
        endsAt: '2026-03-21T12:00:00Z',
        timeZone: 'Europe/Berlin',
      },
    ],
  });

export const CollectionLocationTransportSchema = z.object({ name: z.string().min(1) }).meta({
  id: 'CollectionLocation',
  description: 'The place to bring something to, as the source names it.',
  examples: [{ name: 'Rizzastraße Ecke Südallee' }],
});

const collectionEventBaseShape = {
  /**
   * Opaque. The readable prefix exists for operator legibility only, and the suffix is a digest of the
   * event's identity, so clients must not parse either part.
   */
  id: z.string().min(1),
  serviceAreaId: z.string().min(1),
  wasteType: WasteTypeSchema,
  date: z.iso.date(),
  title: z.string().min(1),
  source: z.enum(['demo', 'municipal_ics', 'user_rule']),
};

const CURBSIDE_EXAMPLE = {
  id: 'koblenz-servicebetrieb-koblenz-stadtmitte-paper-2026-08-14-9f2c1d7ab3e45608',
  serviceAreaId: 'koblenz-stadtmitte',
  wasteType: 'paper',
  date: '2026-08-14',
  title: 'Altpapier',
  source: 'municipal_ics',
  collectionMode: 'curbside',
  timing: { kind: 'all_day' },
} as const;

const MOBILE_DROP_OFF_EXAMPLE = {
  id: 'koblenz-servicebetrieb-koblenz-stadtmitte-hazardous-2026-03-21-4b81e0c6f2a97d35',
  serviceAreaId: 'koblenz-stadtmitte',
  wasteType: 'hazardous',
  date: '2026-03-21',
  title: 'Schadstoffe / Elektrokleinteile',
  source: 'municipal_ics',
  collectionMode: 'mobile_drop_off',
  timing: {
    kind: 'time_window',
    startsAt: '2026-03-21T10:00:00Z',
    endsAt: '2026-03-21T12:00:00Z',
    timeZone: 'Europe/Berlin',
  },
  location: { name: 'Rizzastraße Ecke Südallee' },
} as const;

export const CurbsideCollectionEventTransportSchema = z
  .object({
    ...collectionEventBaseShape,
    collectionMode: z.literal('curbside'),
    timing: AllDayTimingTransportSchema,
  })
  .meta({
    id: 'CurbsideCollectionEvent',
    description:
      'Put the bin out for the day. Carries an `all_day` timing and never a location: there is nowhere to go.',
    examples: [CURBSIDE_EXAMPLE],
  });

export const MobileDropOffCollectionEventTransportSchema = z
  .object({
    ...collectionEventBaseShape,
    collectionMode: z.literal('mobile_drop_off'),
    timing: TimeWindowTimingTransportSchema,
    location: CollectionLocationTransportSchema,
  })
  .meta({
    id: 'MobileDropOffCollectionEvent',
    description:
      'Bring something to a place inside a window. The window, the zone, and the location are all required, so this branch can never describe a drop-off a person could not act on.',
    examples: [MOBILE_DROP_OFF_EXAMPLE],
  });

/**
 * Exactly two variants, discriminated by `collectionMode`, so a client can switch on that one member and
 * rely on the rest of the shape. No other combination exists in this contract: there is no curbside
 * event with a window, and no mobile drop-off missing its window or its location.
 */
export const CollectionEventTransportSchema = z
  .discriminatedUnion('collectionMode', [
    CurbsideCollectionEventTransportSchema,
    MobileDropOffCollectionEventTransportSchema,
  ])
  .meta({
    id: 'CollectionEvent',
    description:
      'One collection. `collectionMode` selects the variant: `curbside` is an all-day collection at the address, `mobile_drop_off` is a staffed window at a named place.',
  });

export const ScheduleServiceAreaSchema = z
  .object({
    id: z.string().min(1),
    locality: z.string().min(1),
    name: z.string().min(1),
  })
  .meta({
    id: 'ScheduleServiceArea',
    description:
      'The service area these events belong to, using the official naming the source publishes.',
    examples: [{ id: 'koblenz-stadtmitte', locality: 'Koblenz', name: 'Stadtmitte' }],
  });

export const ScheduleSourceSchema = z
  .object({
    name: z.string().min(1),
    landingPageUrl: z.url(),
    attribution: z.string().min(1),
    timeZone: z.string().min(1),
  })
  .meta({
    id: 'ScheduleSource',
    description:
      'Where the data came from. `landingPageUrl` is the operator’s public page; the direct calendar download is deliberately not part of this contract, so retrieval can change without breaking a client.',
    examples: [
      {
        name: 'Kommunaler Servicebetrieb',
        landingPageUrl:
          'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
        attribution: 'Kommunaler Servicebetrieb, Koblenz',
        timeZone: 'Europe/Berlin',
      },
    ],
  });

export const ScheduleCoverageSchema = z.object({ wasteTypes: z.array(WasteTypeSchema) }).meta({
  id: 'ScheduleCoverage',
  description:
    'The waste types the source declares it contains. Declared by the source catalogue, never inferred from the events returned: an empty `data` array with a non-empty coverage list means "no collection in this range", which is a different statement from "this source does not cover this waste type".',
  examples: [
    {
      wasteTypes: [
        'paper',
        'yellow_bag',
        'green_waste',
        'christmas_tree',
        'hazardous',
        'small_electronics',
      ],
    },
  ],
});

export const ScheduleRangeSchema = z.object({ from: z.iso.date(), to: z.iso.date() }).meta({
  id: 'ScheduleRange',
  description: 'The inclusive range that was requested and filtered on.',
  examples: [{ from: '2026-03-01', to: '2026-03-31' }],
});

export const CollectionEventMetaSchema = z
  .object({
    provider: ProviderSchema,
    serviceArea: ScheduleServiceAreaSchema,
    source: ScheduleSourceSchema,
    retrievedAt: z.iso.datetime(),
    validFrom: z.iso.date(),
    validTo: z.iso.date(),
    freshness: z.enum(['fresh', 'stale']),
    coverage: ScheduleCoverageSchema,
    range: ScheduleRangeSchema,
  })
  .meta({
    id: 'CollectionEventMeta',
    description:
      'Provenance for the events in this response. `freshness` is `stale` when the last refresh failed and a previously retrieved schedule is being served; `retrievedAt` then remains the timestamp of that last successful retrieval, so a response never claims to be newer than it is.',
  });

const FRESH_META = {
  provider: {
    id: 'koblenz-servicebetrieb',
    name: 'Kommunaler Servicebetrieb',
    sourceKind: 'official_ics',
  },
  serviceArea: { id: 'koblenz-stadtmitte', locality: 'Koblenz', name: 'Stadtmitte' },
  source: {
    name: 'Kommunaler Servicebetrieb',
    landingPageUrl:
      'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
    attribution: 'Kommunaler Servicebetrieb, Koblenz',
    timeZone: 'Europe/Berlin',
  },
  retrievedAt: '2026-07-29T08:14:02.000Z',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  freshness: 'fresh',
  coverage: {
    wasteTypes: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  range: { from: '2026-01-01', to: '2026-12-31' },
} as const;

/** Published as the named `fresh` and `stale` response examples. */
export const COLLECTION_EVENTS_EXAMPLES = {
  fresh: {
    summary: 'Fresh official data',
    description:
      'The source was refreshed successfully. The combined hazardous and small-electronics entry appears as two events sharing their date, window, and location while carrying different identifiers.',
    value: {
      data: [CURBSIDE_EXAMPLE, MOBILE_DROP_OFF_EXAMPLE],
      meta: FRESH_META,
    },
  },
  stale: {
    summary: 'Stale official data',
    description:
      'The last refresh failed while a previously retrieved schedule was still valid. The shape is identical; only `freshness` and the preserved `retrievedAt` differ. A structured warning is logged with the request identifier.',
    value: {
      data: [CURBSIDE_EXAMPLE, MOBILE_DROP_OFF_EXAMPLE],
      meta: { ...FRESH_META, freshness: 'stale', retrievedAt: '2026-07-27T05:02:11.000Z' },
    },
  },
} as const;

export const CollectionEventListResponseSchema = z
  .object({
    data: z.array(CollectionEventTransportSchema),
    meta: CollectionEventMetaSchema,
  })
  .meta({
    id: 'CollectionEventListResponse',
    description:
      'The official collection events inside the requested range, with the provenance of the source they came from.',
    examples: [COLLECTION_EVENTS_EXAMPLES.fresh.value, COLLECTION_EVENTS_EXAMPLES.stale.value],
  });
