import type { CollectionSourceManifest } from '../../source';

/**
 * The verified Koblenz Stadtmitte source.
 *
 * Every value below was recorded from a manual verification of the live source on 2026-07-29, as
 * documented in `docs/tasks/AR-003-official-ics-provider.md`. None is inferred from a URL pattern, a
 * naming convention, or another area's entry, and adding an area is a verification step rather than a
 * configuration guess.
 *
 * The volatile observations of that retrieval — the `cid` query value and the matching `ETag` — belong
 * to neither this manifest nor the public contract, so they appear nowhere in this repository outside
 * the task's verification record.
 */
export const KOBLENZ_PROVIDER_ID = 'koblenz-servicebetrieb';

export const KOBLENZ_PROVIDER_NAME = 'Kommunaler Servicebetrieb';

const KOBLENZ_LANDING_PAGE_URL =
  'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/';

export const koblenzStadtmitteManifest: CollectionSourceManifest = {
  providerId: KOBLENZ_PROVIDER_ID,
  serviceAreaId: 'koblenz-stadtmitte',
  locality: 'Koblenz',
  // The official area name and the validity window are derived from the URL path and the landing page,
  // not read from the payload: the file's `X-WR-CALNAME` is the single character `2`, so it attests
  // neither. If the operator republishes under a different path, that derivation needs re-verifying.
  areaName: 'Stadtmitte',
  sourceName: KOBLENZ_PROVIDER_NAME,
  attribution: 'Kommunaler Servicebetrieb, Koblenz',
  landingPageUrl: KOBLENZ_LANDING_PAGE_URL,
  // The stable no-query form. Retrieval uses it verbatim.
  calendarUrl:
    'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/entsorgungstermine-2026-digital/ics-stadtmitte.ics',
  origin: {
    scheme: 'https',
    hostname: 'servicebetrieb.koblenz.de',
    port: 443,
  },
  // Exactly the narrow set observed during verification: `text/calendar`, with no `charset` parameter.
  acceptedContentTypes: ['text/calendar'],
  timeZone: 'Europe/Berlin',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  // Declared, never inferred from the events in a response. `residual` and `bio` are genuinely absent
  // from this source: the official guide expresses them as odd/even week rules rather than per-area
  // dates, and nothing here generates them.
  coverage: [
    'paper',
    'yellow_bag',
    'green_waste',
    'christmas_tree',
    'hazardous',
    'small_electronics',
  ],
};

export const koblenzManifests: readonly CollectionSourceManifest[] = [koblenzStadtmitteManifest];
