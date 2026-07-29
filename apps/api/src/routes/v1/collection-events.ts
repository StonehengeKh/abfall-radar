import type { CollectionEvent } from '@abfall-radar/domain';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import {
  ApiProblem,
  CollectionEventsNotFoundProblemSchema,
  ProblemDetailsSchema,
  ScheduleRangeNotCoveredProblemSchema,
  UpstreamSourceInvalidProblemSchema,
  UpstreamSourceUnavailableProblemSchema,
  ValidationProblemSchema,
} from '../../http/problem-details';
import { findProviderEntry } from '../../providers/provider-catalogue';
import {
  CollectionEventListResponseSchema,
  CollectionEventParamsSchema,
  CollectionEventQuerySchema,
} from './collection-events.schemas';

/**
 * Maps a domain event onto the transport model: `districtId` becomes `serviceAreaId` and `type` becomes
 * `wasteType`. Nothing provider-specific crosses this boundary — no `UID`, `DTSTAMP`, `DESCRIPTION`,
 * recurrence rule, or upstream URL exists to expose, because the adapter never returns one.
 */
const toTransportEvent = (event: CollectionEvent) => {
  const shared = {
    id: event.id,
    serviceAreaId: event.districtId,
    wasteType: event.type,
    date: event.date,
    title: event.title,
    source: event.source,
  };

  return event.collectionMode === 'mobile_drop_off'
    ? {
        ...shared,
        collectionMode: event.collectionMode,
        timing: event.timing,
        location: event.location,
      }
    : { ...shared, collectionMode: event.collectionMode, timing: event.timing };
};

export const collectionEventRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/providers/:providerId/service-areas/:serviceAreaId/collection-events',
    {
      schema: {
        operationId: 'listCollectionEvents',
        summary: 'List official collection events for a service area',
        description: [
          'Returns the collection events the responsible municipal operator published for the selected service area, filtered to the requested inclusive range.',
          'Each event is one of two variants, discriminated by `collectionMode`: a `curbside` event has an `all_day` timing and no location, and a `mobile_drop_off` event has a `time_window` timing with `startsAt`, `endsAt`, and `timeZone`, plus a location. No other combination is ever returned, so a client can switch on `collectionMode` and rely on the rest of the shape.',
          'Events are filtered on their local `date`, so a timed drop-off belongs to the day a person would look for it under rather than to the day of its UTC instant.',
          '`meta` states where the data came from, when it was retrieved, which period the source covers, whether it is fresh or stale, and which waste types the source declares. `id` is opaque: its readable prefix exists for operators, and clients must not parse it.',
        ].join('\n\n'),
        tags: ['Schedules'],
        params: CollectionEventParamsSchema,
        querystring: CollectionEventQuerySchema,
        response: {
          200: CollectionEventListResponseSchema,
          400: ValidationProblemSchema,
          // One entry per status code: an operation cannot document three separate 404 responses, so the
          // three reasons travel as a `oneOf` discriminated on `code`.
          404: CollectionEventsNotFoundProblemSchema,
          422: ScheduleRangeNotCoveredProblemSchema,
          500: ProblemDetailsSchema,
          502: UpstreamSourceInvalidProblemSchema,
          503: UpstreamSourceUnavailableProblemSchema,
        },
      },
    },
    async (request) => {
      const { providerId, serviceAreaId } = request.params;
      const { from, to } = request.query;

      const entry = findProviderEntry(app.providerCatalogue, providerId);

      if (entry === undefined) {
        throw ApiProblem.providerNotFound();
      }

      // The demo provider publishes no official calendar for any area, so the resource genuinely does
      // not exist for it. Serving generated data here would require inventing a retrieval time and a
      // validity window, which would present demo data in official clothing.
      if (entry.sourceKind !== 'official_ics') {
        const areas = await entry.provider.getDistricts();

        throw areas.some((area) => area.id === serviceAreaId)
          ? ApiProblem.collectionEventsNotAvailable()
          : ApiProblem.serviceAreaNotFound();
      }

      const manifest = entry.provider.findManifest(serviceAreaId);

      if (manifest === undefined) {
        throw ApiProblem.serviceAreaNotFound();
      }

      // Decided from the declared validity window alone, before any upstream request. A source that
      // legitimately contains no collection in a covered range returns an empty list instead.
      if (from < manifest.validFrom || to > manifest.validTo) {
        throw ApiProblem.scheduleRangeNotCovered();
      }

      let schedule: Awaited<ReturnType<typeof entry.provider.getCollectionSchedule>>;

      try {
        schedule = await entry.provider.getCollectionSchedule(serviceAreaId);
      } catch (error) {
        const problem = ApiProblem.fromUnknown(error);

        // An unexpected error is rethrown untouched so the single error boundary logs it in full and
        // returns a sanitized 500, rather than it being reported as an upstream fault.
        if (problem === undefined) {
          throw error;
        }

        // Logged in full, returned sanitized: `err` carries the upstream reason and its cause for an
        // operator, while the response the client receives is built from the problem catalogue alone.
        request.log.error(
          {
            err: error,
            requestId: request.id,
            providerId: manifest.providerId,
            serviceAreaId: manifest.serviceAreaId,
          },
          'Official source refresh failed and no valid schedule was available',
        );

        throw problem;
      }

      if (schedule.freshness === 'stale') {
        request.log.warn(
          {
            requestId: request.id,
            providerId: manifest.providerId,
            serviceAreaId: manifest.serviceAreaId,
            reason: schedule.staleWarning?.reason,
            retrievedAt: schedule.retrievedAt,
          },
          'Serving a stale official schedule because the last refresh failed',
        );
      }

      // Filtered on the local calendar date. ISO dates sort lexicographically, so this needs no parsing
      // and cannot be shifted by a time zone.
      const events = schedule.events.filter((event) => event.date >= from && event.date <= to);

      return {
        data: events.map(toTransportEvent),
        meta: {
          provider: {
            id: entry.provider.id,
            name: entry.provider.name,
            sourceKind: entry.sourceKind,
          },
          serviceArea: {
            id: manifest.serviceAreaId,
            locality: manifest.locality,
            name: manifest.areaName,
          },
          source: schedule.provenance,
          retrievedAt: schedule.retrievedAt,
          validFrom: schedule.validFrom,
          validTo: schedule.validTo,
          freshness: schedule.freshness,
          coverage: { wasteTypes: [...schedule.coverage.wasteTypes] },
          range: { from, to },
        },
      };
    },
  );
};
