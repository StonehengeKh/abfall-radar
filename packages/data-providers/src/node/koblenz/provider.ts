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
import { KOBLENZ_PROVIDER_ID, KOBLENZ_PROVIDER_NAME, koblenzManifests } from './manifest';
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
  city: manifest.locality,
  // Official naming wins. The identifier coinciding with a demo district is a consequence of the area
  // genuinely being called Stadtmitte; service areas are namespaced by provider, so the two never
  // collide and the demo entry is left exactly as it is.
  name: manifest.areaName,
  providerId: manifest.providerId,
});

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
      return koblenzManifests.map(toDistrict);
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
