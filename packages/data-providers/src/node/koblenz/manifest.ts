import type { WasteType } from '@abfall-radar/domain';
import type { CollectionSourceManifest } from '../../source';

/**
 * The verified Kommunaler Servicebetrieb Koblenz sources.
 *
 * Stadtmitte was recorded from a manual verification of the live source on 2026-07-29, as documented in
 * `docs/tasks/AR-003-official-ics-provider.md`. The remaining areas were added on 2026-09-16 by
 * retrieving the operator's published area list and then requesting **each** area's own 2026 calendar:
 * every entry below was confirmed to answer `200 text/calendar` at the exact URL it carries, and its
 * `coverage` is the set of waste types that area's own file actually publishes. Nothing is copied from
 * another area, and no URL, date, identifier, or interval is constructed from a pattern alone.
 *
 * `X-WR-CALNAME` is the single character `1` or `2` in every file, so it attests neither the area nor
 * the year; the area name comes from the operator's published list and the year from the directory the
 * operator publishes under. If the operator republishes elsewhere, that derivation needs re-verifying.
 *
 * The volatile observations of a retrieval — the `cid` query value and the matching `ETag` — belong to
 * neither this manifest nor the public contract.
 */
export const KOBLENZ_PROVIDER_ID = 'koblenz-servicebetrieb';

export const KOBLENZ_PROVIDER_NAME = 'Kommunaler Servicebetrieb';

/** The city this adapter integrates, with a stable identifier of its own. */
export const KOBLENZ_CITY_ID = 'koblenz';

export const KOBLENZ_CITY_NAME = 'Koblenz';

const KOBLENZ_LANDING_PAGE_URL =
  'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/';

const CALENDAR_BASE_URL =
  'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/entsorgungstermine-2026-digital/';

const KOBLENZ_ORIGIN = {
  scheme: 'https',
  hostname: 'servicebetrieb.koblenz.de',
  port: 443,
} as const;

/** Exactly the narrow set observed during verification: `text/calendar`, with no `charset` parameter. */
const ACCEPTED_CONTENT_TYPES = ['text/calendar'] as const;

const VALID_FROM = '2026-01-01';

const VALID_TO = '2026-12-31';

/**
 * One verified area.
 *
 * `file` is the operator's own file name, recorded per area rather than derived: `Industriegebiet
 * Rheinhafen` is published as `ics-industriegebiet.ics`, which no naming rule would produce.
 */
interface VerifiedArea {
  readonly slug: string;
  readonly areaName: string;
  readonly file: string;
  readonly coverage: readonly WasteType[];
}

const VERIFIED_AREAS: readonly VerifiedArea[] = [
  {
    slug: 'altstadt',
    areaName: 'Altstadt',
    file: 'ics-altstadt.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'arenberg',
    areaName: 'Arenberg',
    file: 'ics-arenberg.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'arzheim',
    areaName: 'Arzheim',
    file: 'ics-arzheim.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'asterstein',
    areaName: 'Asterstein',
    file: 'ics-asterstein.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'bubenheim',
    areaName: 'Bubenheim',
    file: 'ics-bubenheim.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'ehrenbreitstein',
    areaName: 'Ehrenbreitstein',
    file: 'ics-ehrenbreitstein.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'goldgrube',
    areaName: 'Goldgrube',
    file: 'ics-goldgrube.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'guels-1',
    areaName: 'Güls 1',
    file: 'ics-guels-1.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'guels-2',
    areaName: 'Güls 2',
    file: 'ics-guels-2.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'horchheim',
    areaName: 'Horchheim',
    file: 'ics-horchheim.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'immendorf',
    areaName: 'Immendorf',
    file: 'ics-immendorf.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'industriegebiet-rheinhafen',
    areaName: 'Industriegebiet Rheinhafen',
    file: 'ics-industriegebiet.ics',
    coverage: ['paper', 'yellow_bag', 'green_waste'],
  },
  {
    slug: 'karthause-1',
    areaName: 'Karthause 1',
    file: 'ics-karthause-1.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'karthause-2',
    areaName: 'Karthause 2',
    file: 'ics-karthause-2.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'karthause-3',
    areaName: 'Karthause 3',
    file: 'ics-karthause-3.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'kesselheim',
    areaName: 'Kesselheim',
    file: 'ics-kesselheim.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'lay',
    areaName: 'Lay',
    file: 'ics-lay.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'luetzel',
    areaName: 'Lützel',
    file: 'ics-luetzel.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'metternich-1',
    areaName: 'Metternich 1',
    file: 'ics-metternich-1.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'metternich-2',
    areaName: 'Metternich 2',
    file: 'ics-metternich-2.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'moselweiss',
    areaName: 'Moselweiss',
    file: 'ics-moselweiss.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'neuendorf',
    areaName: 'Neuendorf',
    file: 'ics-neuendorf.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'niederberg',
    areaName: 'Niederberg',
    file: 'ics-niederberg.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'oberwerth',
    areaName: 'Oberwerth',
    file: 'ics-oberwerth.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'pfaffendorf',
    areaName: 'Pfaffendorf',
    file: 'ics-pfaffendorf.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'pfaffendorfer-hoehe',
    areaName: 'Pfaffendorfer Höhe',
    file: 'ics-pfaffendorfer-hoehe.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'rauental',
    areaName: 'Rauental',
    file: 'ics-rauental.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'ruebenach-1',
    areaName: 'Rübenach 1',
    file: 'ics-ruebenach-1.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'ruebenach-2',
    areaName: 'Rübenach 2',
    file: 'ics-ruebenach-2.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'stadtmitte',
    areaName: 'Stadtmitte',
    file: 'ics-stadtmitte.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'stolzenfels',
    areaName: 'Stolzenfels',
    file: 'ics-stolzenfels.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'vorstadt',
    areaName: 'Vorstadt',
    file: 'ics-vorstadt.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
  {
    slug: 'wallersheim',
    areaName: 'Wallersheim',
    file: 'ics-wallersheim.ics',
    coverage: [
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
      'hazardous',
      'small_electronics',
    ],
  },
];

const toManifest = (area: VerifiedArea): CollectionSourceManifest => ({
  providerId: KOBLENZ_PROVIDER_ID,
  serviceAreaId: `${KOBLENZ_CITY_ID}-${area.slug}`,
  locality: KOBLENZ_CITY_NAME,
  areaName: area.areaName,
  sourceName: KOBLENZ_PROVIDER_NAME,
  attribution: 'Kommunaler Servicebetrieb, Koblenz',
  landingPageUrl: KOBLENZ_LANDING_PAGE_URL,
  calendarUrl: `${CALENDAR_BASE_URL}${area.file}`,
  origin: KOBLENZ_ORIGIN,
  acceptedContentTypes: ACCEPTED_CONTENT_TYPES,
  timeZone: 'Europe/Berlin',
  validFrom: VALID_FROM,
  validTo: VALID_TO,
  // Declared per area from that area's own published calendar, never from another area's entry.
  // `residual` and `bio` are genuinely absent from this source: the official guide expresses them as
  // odd/even week rules rather than per-area dates, and nothing here generates them.
  coverage: area.coverage,
});

export const koblenzManifests: readonly CollectionSourceManifest[] = VERIFIED_AREAS.map(toManifest);

export const koblenzStadtmitteManifest: CollectionSourceManifest = (() => {
  const stadtmitte = koblenzManifests.find(
    (manifest) => manifest.serviceAreaId === `${KOBLENZ_CITY_ID}-stadtmitte`,
  );

  /* c8 ignore next 3 -- the list above always contains it; the guard keeps the export non-optional. */
  if (stadtmitte === undefined) {
    throw new Error('The Koblenz manifest list must contain Stadtmitte.');
  }

  return stadtmitte;
})();

/**
 * Official areas the operator lists but publishes **no** 2026 calendar for.
 *
 * Kept in the catalogue deliberately. Dropping such an area would imply the municipality does not serve
 * it, and borrowing a neighbouring area's calendar would present one district's collection days as
 * another's. Having no manifest is exactly what makes the API report `availability: 'unavailable'`.
 */
export interface DeclaredArea {
  readonly slug: string;
  readonly areaName: string;
}

export const koblenzUnavailableAreas: readonly DeclaredArea[] = [
  { slug: 'horchheimer-hoehe', areaName: 'Horchheimer Höhe' },
];

/** Every official area, available or not, in the operator's own alphabetical order. */
export const koblenzAreaIds: readonly string[] = [
  ...koblenzManifests.map((manifest) => manifest.serviceAreaId),
  ...koblenzUnavailableAreas.map((area) => `${KOBLENZ_CITY_ID}-${area.slug}`),
].sort((left, right) => left.localeCompare(right, 'de'));
