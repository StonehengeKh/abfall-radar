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
  'Only the demo provider is available. Demo data is generated sample data and must never be presented as official municipal data.';

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
    async () => ({ data: listProviders() }),
  );

  app.get(
    '/providers/:providerId/service-areas',
    {
      schema: {
        operationId: 'listProviderServiceAreas',
        summary: 'List the service areas of a provider',
        description: `Returns the normalized service areas of the selected provider. ${DEMO_DATA_NOTICE}`,
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
      const entry = findProviderEntry(request.params.providerId);

      if (entry === undefined) {
        throw ApiProblem.providerNotFound();
      }

      return { data: await listServiceAreas(entry) };
    },
  );
};
