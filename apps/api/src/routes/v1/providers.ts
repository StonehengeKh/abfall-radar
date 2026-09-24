import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import {
  ApiProblem,
  ProblemDetailsSchema,
  ProviderNotFoundProblemSchema,
  ValidationProblemSchema,
} from '../../http/problem-details';
import {
  findHouseholdRules,
  findProviderEntry,
  listCities,
  listProviders,
  listServiceAreas,
} from '../../providers/provider-catalogue';
import { HouseholdRulesResponseSchema } from './household-rules.schemas';
import {
  CityListResponseSchema,
  ProviderIdParamsSchema,
  ProviderListResponseSchema,
  ServiceAreaListResponseSchema,
} from './providers.schemas';

const DEMO_DATA_NOTICE =
  'A provider whose `sourceKind` is `demo` returns generated sample data, which must never be presented as official municipal data.';

export const providerRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/cities',
    {
      schema: {
        operationId: 'listCities',
        summary: 'List the cities this API serves',
        description: [
          'Returns each city together with the official providers behind it, so a client can offer a city before a district and resolve the responsible provider without a separate lookup.',
          'A city appears only when at least one official provider serves it. Demo providers are excluded: generated sample data is not a municipality’s waste service.',
        ].join('\n\n'),
        tags: ['Providers'],
        response: {
          200: CityListResponseSchema,
          500: ProblemDetailsSchema,
        },
      },
    },
    async () => ({ data: await listCities(app.providerCatalogue) }),
  );

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

  app.get(
    '/providers/:providerId/household-rules',
    {
      schema: {
        operationId: 'getProviderHouseholdRules',
        summary:
          'Get the municipal rules for the household bins a provider publishes no calendar for',
        description: [
          'Returns the rules a client calculates Bioabfall and Restabfall collections from: which bin an even and an odd ISO calendar week carries, the published table of holiday date replacements, and the period those replacements are complete for.',
          'This endpoint serves **rules, not dates**. The operator publishes no calendar for these two bins and no per-address weekday — the weekday comes from the household and stays on the client, so nothing here identifies an address.',
          "The rules are a maintained transcription of the operator's own publications, one of which is an image. `verification` reports whether that published document still matches the digest recorded when it was transcribed, so a client can refuse to present dates from a transcription the operator has moved on from. It is not evidence of a rule being wrong when it says `unverified`: that only means the document could not be retrieved.",
          'A provider that publishes an official calendar for these bins, or for which no rules have been transcribed, answers `404`. That is a statement that this API cannot calculate them, never a reason for a client to invent them.',
        ].join('\n\n'),
        tags: ['Providers'],
        params: ProviderIdParamsSchema,
        response: {
          200: HouseholdRulesResponseSchema,
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

      const rules = await findHouseholdRules(entry);

      if (rules === undefined) {
        // No transcription exists for this provider. Saying so is the whole point: the alternative is a
        // client applying another municipality's parity rule to this one's bins.
        throw ApiProblem.providerNotFound();
      }

      return { data: rules };
    },
  );
};
