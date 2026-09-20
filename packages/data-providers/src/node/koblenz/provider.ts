import type { District } from '@abfall-radar/domain';
import {
  type CollectionSourceManifest,
  type OfficialScheduleProvider,
  type OfficialScheduleResult,
  SourceFailureError,
  toSourceCoverage,
  toSourceProvenance,
} from '../../source';
import { parseCalendar } from '../calendar';
import { type Clock, type FetchLike, systemClock, systemFetch } from '../dependencies';
import { normalizeCalendar } from '../normalize';
import { retrieveCalendar } from '../retrieval';
import { createScheduleCache } from '../source-cache';
import {
  KOBLENZ_CITY_ID,
  KOBLENZ_CITY_NAME,
  KOBLENZ_PROVIDER_ID,
  KOBLENZ_PROVIDER_NAME,
  koblenzManifests,
  koblenzUnavailableAreas,
} from './manifest';
import { koblenzSummaryMapping } from './summary-mapping';

/**
 * The `koblenz-servicebetrieb` adapter: retrieval, caching, parsing, and normalization composed behind
 * the official provider contract.
 *
 * All Koblenz-specific knowledge lives in this folder — the manifest and the summary table. The
 * surrounding modules are manifest-driven and carry no municipal name, so a second municipality is a
 * new folder rather than a change to the ingestion machinery.
 */

export interface KoblenzProviderOptions {
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
}

const toDistrict = (manifest: CollectionSourceManifest): District => ({
  id: manifest.serviceAreaId,
  cityId: KOBLENZ_CITY_ID,
  city: manifest.locality,
  // Official naming wins. The identifier coinciding with a demo district is a consequence of the area
  // genuinely being called Stadtmitte; service areas are namespaced by provider, so the two never
  // collide and the demo entry is left exactly as it is.
  name: manifest.areaName,
  providerId: manifest.providerId,
});

/**
 * Every official area this provider serves, in the operator's own alphabetical order.
 *
 * An area the operator lists but publishes no calendar for is present **without** a manifest, which is
 * what makes the API report it as `unavailable`. Omitting it would imply the municipality does not
 * serve it, and giving it a neighbouring area's manifest would present one district's collection days
 * as another's.
 */
const koblenzDistricts: readonly District[] = [
  ...koblenzManifests.map(toDistrict),
  ...koblenzUnavailableAreas.map((area) => ({
    id: `${KOBLENZ_CITY_ID}-${area.slug}`,
    cityId: KOBLENZ_CITY_ID,
    city: KOBLENZ_CITY_NAME,
    name: area.areaName,
    providerId: KOBLENZ_PROVIDER_ID,
  })),
].sort((left, right) => left.name.localeCompare(right.name, 'de'));

export const createKoblenzScheduleProvider = ({
  fetch: fetchImpl = systemFetch,
  clock = systemClock,
}: KoblenzProviderOptions = {}): OfficialScheduleProvider => {
  const cache = createScheduleCache({
    clock,
    refresh: async (manifest) => {
      const body = await retrieveCalendar({ manifest, fetch: fetchImpl });
      const calendar = parseCalendar(body, manifest);

      return normalizeCalendar({ manifest, mapping: koblenzSummaryMapping, calendar });
    },
  });

  const findManifest = (serviceAreaId: string): CollectionSourceManifest | undefined =>
    koblenzManifests.find((manifest) => manifest.serviceAreaId === serviceAreaId);

  return {
    id: KOBLENZ_PROVIDER_ID,
    name: KOBLENZ_PROVIDER_NAME,

    async getDistricts() {
      return [...koblenzDistricts];
    },

    findManifest,

    async getCollectionSchedule(serviceAreaId): Promise<OfficialScheduleResult> {
      const manifest = findManifest(serviceAreaId);

      if (manifest === undefined) {
        // Unreachable through the HTTP surface, which resolves the area first. Guarded anyway so a
        // direct caller cannot retrieve an area this provider does not serve.
        throw new SourceFailureError('event-invalid');
      }

      const cached = await cache.read(manifest);

      return {
        events: cached.events,
        provenance: toSourceProvenance(manifest),
        coverage: toSourceCoverage(manifest),
        retrievedAt: cached.retrievedAt.toISOString(),
        validFrom: manifest.validFrom,
        validTo: manifest.validTo,
        freshness: cached.freshness,
        ...(cached.staleWarning === undefined ? {} : { staleWarning: cached.staleWarning }),
      };
    },
  };
};
