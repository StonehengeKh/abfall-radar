import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import {
  ApiProblem,
  ProblemDetailsSchema,
  ProviderNotFoundProblemSchema,
  ValidationProblemSchema,
} from '../../http/problem-details';
import {
  findProviderEntry,
  listProviders,
  listServiceAreas,
} from '../../providers/provider-catalogue';
import {
  ProviderIdParamsSchema,
  ProviderListResponseSchema,
  ServiceAreaListResponseSchema,
} from './providers.schemas';

const DEMO_DATA_NOTICE =
  'A provider whose `sourceKind` is `demo` returns generated sample data, which must never be presented as official municipal data.';

export const providerRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/providers',
    {
      schema: {
        operationId: 'listProviders',
        summary: 'List schedule providers',
        description: `Returns the providers this API can serve, without provider-specific implementation fields. ${DEMO_DATA_NOTICE}`,
        tags: ['Providers'],
        response: {
          200: ProviderListResponseSchema,
          500: ProblemDetailsSchema,
        },
      },
    },
    async () => ({ data: listProviders(app.providerCatalogue) }),
  );

  app.get(
    '/providers/:providerId/service-areas',
    {
      schema: {
        operationId: 'listProviderServiceAreas',
        summary: 'List the service areas of a provider',
        description: [
          'Returns the normalized service areas of the selected provider.',
          '`collectionEvents` states whether this provider publishes an official collection calendar for the area, discriminated on `availability`. An `available` area carries the zone the source publishes in and the validity window a collection-events request must stay inside, so a client can derive a correct range before asking for one. An `unavailable` area carries nothing else: the area exists and is served, but this provider has no calendar behind it, so requesting its events would fail.',
          DEMO_DATA_NOTICE,
          'Every demo area is therefore `unavailable`, with no invented zone and no invented window.',
        ].join('\n\n'),
        tags: ['Providers'],
        params: ProviderIdParamsSchema,
        response: {
          200: ServiceAreaListResponseSchema,
          400: ValidationProblemSchema,
          404: ProviderNotFoundProblemSchema,
          500: ProblemDetailsSchema,
        },
      },
    },
    async (request) => {
      const entry = findProviderEntry(app.providerCatalogue, request.params.providerId);

      if (entry === undefined) {
        throw ApiProblem.providerNotFound();
      }

      return { data: await listServiceAreas(entry) };
    },
  );
};
