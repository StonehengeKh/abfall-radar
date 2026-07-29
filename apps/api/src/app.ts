import type { Writable } from 'node:stream';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from '@fastify/type-provider-zod';
import Fastify, { LogController } from 'fastify';
import type { AppConfig } from './config/env';
import { createErrorHandler, createNotFoundHandler } from './http/error-handler';
import { registerDocs } from './http/openapi';
import {
  createProviderCatalogue,
  type ProviderCatalogue,
  type ProviderRuntime,
} from './providers/provider-catalogue';
import { healthRoutes } from './routes/health';
import { collectionEventRoutes } from './routes/v1/collection-events';
import { providerRoutes } from './routes/v1/providers';

export const API_V1_PREFIX = '/api/v1';

export const REQUEST_ID_HEADER = 'x-request-id';

declare module 'fastify' {
  interface FastifyInstance {
    providerCatalogue: ProviderCatalogue;
  }
}

export interface BuildAppOptions {
  /** Test seam for asserting what the API logs. Production uses Pino's default destination. */
  readonly logDestination?: Writable;
  /**
   * Retrieval and clock seams handed to the provider adapters. Tests inject a scripted fetch and a
   * controllable clock so upstream failure, stale data, cache expiry, and refresh coalescing are all
   * deterministic; production leaves this unset and gets the real implementations.
   */
  readonly providerRuntime?: ProviderRuntime;
}

/**
 * Builds a fully configured instance without touching the process: it never listens on a port,
 * registers a signal handler, or calls `ready()`. Tests use `inject()` against the returned
 * instance; `server.ts` owns the runtime lifecycle.
 */
export const buildApp = async (config: AppConfig, options: BuildAppOptions = {}) => {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(options.logDestination === undefined ? {} : { stream: options.logDestination }),
    },
    // Request identifiers are always server-generated: an inbound header would be untrusted input
    // echoed into responses and logs, and generated identifiers keep tests deterministic.
    requestIdHeader: false,
    // The top-level requestIdLogLabel option is deprecated in Fastify 5 and removed in Fastify 6.
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Registered before any route so every route and the unmatched-route path inherit them.
  app.setErrorHandler(createErrorHandler());
  app.setNotFoundHandler(createNotFoundHandler());

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  // Built once per instance and decorated rather than kept as module state, so each test app owns its
  // own provider cache and no cached schedule leaks between tests.
  app.decorate('providerCatalogue', createProviderCatalogue(options.providerRuntime ?? {}));

  if (config.docsEnabled) {
    // Must precede the routes: @fastify/swagger collects schemas through the onRoute hook.
    await registerDocs(app);
  }

  await app.register(healthRoutes);
  await app.register(providerRoutes, { prefix: API_V1_PREFIX });
  await app.register(collectionEventRoutes, { prefix: API_V1_PREFIX });

  return app;
};

/** Inferred so the Zod type provider stays attached wherever the instance is passed. */
export type ApiApp = Awaited<ReturnType<typeof buildApp>>;
