import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { ProblemDetailsSchema } from '../http/problem-details';

export const SERVICE_NAME = 'abfall-radar-api' as const;

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    service: z.literal(SERVICE_NAME),
    timestamp: z.iso.datetime(),
  })
  .meta({
    id: 'HealthResponse',
    description: 'The service is running. `timestamp` is generated when the request is handled.',
    examples: [{ status: 'ok', service: SERVICE_NAME, timestamp: '2026-07-28T12:00:00.000Z' }],
  });

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        operationId: 'getHealth',
        summary: 'Report service health',
        description:
          'Unversioned operational endpoint used by local development and future deployment probes. It reports process liveness only and does not check any provider.',
        tags: ['Operations'],
        response: {
          200: HealthResponseSchema,
          500: ProblemDetailsSchema,
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: SERVICE_NAME,
      timestamp: new Date().toISOString(),
    }),
  );
};
