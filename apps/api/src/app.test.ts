import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app';
import { PROBLEM_CONTENT_TYPE } from './http/error-handler';
import { COLLECTION_EVENTS_PATH, DOCS_ROUTE_PREFIX, OPENAPI_DOCUMENT_ROUTE } from './http/openapi';
import { buildTestApp } from './test/build-test-app';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** The generated contract is validated at runtime because it is generated, not hand-written. */
const OpenApiDocumentSchema = z.looseObject({
  openapi: z.string(),
  info: z.looseObject({ title: z.string(), version: z.string(), description: z.string() }),
  tags: z.array(z.looseObject({ name: z.string(), description: z.string() })),
  paths: z.record(
    z.string(),
    z.record(
      z.string(),
      z.looseObject({
        operationId: z.string(),
        summary: z.string(),
        description: z.string(),
        tags: z.array(z.string()),
        responses: z.record(
          z.string(),
          z.looseObject({
            description: z.string(),
            content: z.record(z.string(), z.looseObject({ schema: z.looseObject({}) })).optional(),
          }),
        ),
      }),
    ),
  ),
  components: z.looseObject({
    schemas: z.record(z.string(), z.looseObject({ description: z.string().optional() })),
  }),
});

type OpenApiDocument = z.infer<typeof OpenApiDocumentSchema>;

const fetchDocument = async (): Promise<OpenApiDocument> => {
  const app = await buildTestApp();

  try {
    const response = await app.inject({ method: 'GET', url: OPENAPI_DOCUMENT_ROUTE });

    expect(response.statusCode).toBe(200);

    return OpenApiDocumentSchema.parse(response.json());
  } finally {
    await app.close();
  }
};

describe('buildApp', () => {
  it('does not bind a network port', async () => {
    const app = await buildApp({ nodeEnv: 'test', logLevel: 'silent', docsEnabled: false });

    try {
      expect(app.server.listening).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('does not register process signal handlers', async () => {
    const before = SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal));

    const app = await buildApp({ nodeEnv: 'test', logLevel: 'silent', docsEnabled: false });

    try {
      expect(SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it('serves the documented routes', async () => {
    const app = await buildTestApp();

    try {
      const health = await app.inject({ method: 'GET', url: '/health' });
      const providers = await app.inject({ method: 'GET', url: '/api/v1/providers' });

      expect(health.statusCode).toBe(200);
      expect(providers.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('documentation endpoints', () => {
  it('serves Swagger UI and the OpenAPI document when documentation is enabled', async () => {
    const app = await buildTestApp({ config: { docsEnabled: true } });

    try {
      const ui = await app.inject({ method: 'GET', url: `${DOCS_ROUTE_PREFIX}/` });
      const document = await app.inject({ method: 'GET', url: OPENAPI_DOCUMENT_ROUTE });

      expect(ui.statusCode).toBe(200);
      expect(ui.headers['content-type']).toContain('text/html');
      expect(document.statusCode).toBe(200);
      expect(document.headers['content-type']).toContain('application/json');
    } finally {
      await app.close();
    }
  });

  it.each([DOCS_ROUTE_PREFIX, `${DOCS_ROUTE_PREFIX}/`, OPENAPI_DOCUMENT_ROUTE])(
    'returns a problem response for %s when documentation is disabled',
    async (url) => {
      const app = await buildTestApp({ config: { docsEnabled: false } });

      try {
        const response = await app.inject({ method: 'GET', url });

        expect(response.statusCode).toBe(404);
        expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
        expect(response.json()).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
      } finally {
        await app.close();
      }
    },
  );
});

describe('generated OpenAPI contract', () => {
  it('declares OpenAPI 3.1 with service metadata and tags', async () => {
    const document = await fetchDocument();

    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('AbfallRadar API');
    expect(document.info.description).toContain('never be presented as official municipal data');
    expect(document.tags.map((tag) => tag.name)).toEqual(['Operations', 'Providers', 'Schedules']);
  });

  it('documents exactly the implemented operations', async () => {
    const document = await fetchDocument();

    expect(Object.keys(document.paths).toSorted()).toEqual([
      '/api/v1/providers',
      '/api/v1/providers/{providerId}/service-areas',
      COLLECTION_EVENTS_PATH,
      '/health',
    ]);
  });

  it('excludes the documentation endpoints from the contract', async () => {
    const document = await fetchDocument();

    for (const path of Object.keys(document.paths)) {
      expect(path).not.toContain(DOCS_ROUTE_PREFIX);
      expect(path).not.toBe(OPENAPI_DOCUMENT_ROUTE);
    }
  });

  it.each([
    ['/health', 'getHealth', 'Operations', ['200', '500']],
    ['/api/v1/providers', 'listProviders', 'Providers', ['200', '500']],
    [
      '/api/v1/providers/{providerId}/service-areas',
      'listProviderServiceAreas',
      'Providers',
      ['200', '400', '404', '500'],
    ],
    [
      COLLECTION_EVENTS_PATH,
      'listCollectionEvents',
      'Schedules',
      ['200', '400', '404', '422', '500', '502', '503'],
    ],
  ] as const)(
    'documents %s with an operation identifier, summary, tag, and response set',
    async (path, operationId, tag, statusCodes) => {
      const document = await fetchDocument();
      const operation = document.paths[path]?.get;

      expect(operation).toBeDefined();
      expect(operation?.operationId).toBe(operationId);
      expect(operation?.summary).not.toBe('');
      expect(operation?.description).not.toBe('');
      expect(operation?.tags).toEqual([tag]);
      expect(Object.keys(operation?.responses ?? {}).toSorted()).toEqual([...statusCodes]);
    },
  );

  it('gives every documented response a real description', async () => {
    const document = await fetchDocument();

    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        for (const [statusCode, response] of Object.entries(operation.responses)) {
          expect(response.description, `${method.toUpperCase()} ${path} -> ${statusCode}`).not.toBe(
            'Default Response',
          );
          expect(response.description.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('documents every failure as application/problem+json and every success as JSON', async () => {
    const document = await fetchDocument();

    for (const pathItem of Object.values(document.paths)) {
      for (const operation of Object.values(pathItem)) {
        for (const [statusCode, response] of Object.entries(operation.responses)) {
          const mediaTypes = Object.keys(response.content ?? {});

          expect(mediaTypes).toEqual(
            Number(statusCode) >= 400 ? [PROBLEM_CONTENT_TYPE] : ['application/json'],
          );
        }
      }
    }
  });

  it('reuses component schemas and prunes the ones no operation can return', async () => {
    const document = await fetchDocument();
    const schemaNames = Object.keys(document.components.schemas).toSorted();

    for (const name of [
      'ProblemDetails',
      'ValidationProblem',
      'ProviderNotFoundProblem',
      'ServiceAreaNotFoundProblem',
      'CollectionEventsNotAvailableProblem',
      'CollectionEventsNotFoundProblem',
      'ScheduleRangeNotCoveredProblem',
      'UpstreamSourceInvalidProblem',
      'UpstreamSourceUnavailableProblem',
      'Provider',
      'ServiceArea',
      'ServiceAreaCollectionEvents',
      'ServiceAreaCollectionEventsAvailable',
      'ServiceAreaCollectionEventsUnavailable',
      'ServiceAreaValidity',
      'CollectionEvent',
      'CurbsideCollectionEvent',
      'MobileDropOffCollectionEvent',
      'CollectionEventListResponse',
      'CollectionEventMeta',
    ]) {
      expect(schemaNames, name).toContain(name);
    }

    for (const name of schemaNames) {
      expect(name).not.toMatch(/Input$/);
    }
  });

  it('publishes realistic examples for every success and error schema', async () => {
    const document = await fetchDocument();
    const schemas = document.components.schemas;

    const examplesFor = (name: string): unknown => {
      const schema = schemas[name];

      return schema === undefined ? undefined : schema.examples;
    };

    for (const name of [
      'HealthResponse',
      'ProviderListResponse',
      'ServiceAreaListResponse',
      'CollectionEventListResponse',
      'CurbsideCollectionEvent',
      'MobileDropOffCollectionEvent',
      'ProblemDetails',
      'ValidationProblem',
      'ProviderNotFoundProblem',
      'ServiceAreaNotFoundProblem',
      'CollectionEventsNotAvailableProblem',
      'ScheduleRangeNotCoveredProblem',
      'UpstreamSourceInvalidProblem',
      'UpstreamSourceUnavailableProblem',
      'ServiceAreaCollectionEventsAvailable',
      'ServiceAreaCollectionEventsUnavailable',
    ]) {
      expect(examplesFor(name), name).toEqual(expect.any(Array));
    }

    // The examples are the values the providers really return: the official provider publishes a
    // calendar for its verified area, and the demo provider publishes none for any of its areas.
    expect(examplesFor('ServiceAreaListResponse')).toMatchObject([
      {
        data: [
          {
            id: 'koblenz-stadtmitte',
            providerId: 'koblenz-servicebetrieb',
            locality: 'Koblenz',
            name: 'Stadtmitte',
            collectionEvents: {
              availability: 'available',
              timeZone: 'Europe/Berlin',
              validity: { from: '2026-01-01', to: '2026-12-31' },
            },
          },
        ],
      },
      {
        data: [
          {
            id: 'koblenz-stadtmitte',
            providerId: 'demo',
            locality: 'Koblenz',
            name: 'Stadtmitte',
            collectionEvents: { availability: 'unavailable' },
          },
          {
            id: 'koblenz-metternich-1',
            providerId: 'demo',
            locality: 'Koblenz',
            name: 'Metternich 1',
            collectionEvents: { availability: 'unavailable' },
          },
        ],
      },
    ]);
    expect(examplesFor('ProviderListResponse')).toMatchObject([
      { data: [{ id: 'demo', name: 'Demo provider', sourceKind: 'demo' }] },
    ]);
  });

  it('documents the provider identifier transport constraint', async () => {
    const document = await fetchDocument();
    const operation = document.paths['/api/v1/providers/{providerId}/service-areas']?.get;
    const parameters: unknown = operation?.parameters;

    expect(parameters).toEqual(expect.any(Array));
    expect(JSON.stringify(parameters)).toContain('maxLength');
    expect(JSON.stringify(parameters)).toContain('pattern');
  });

  it('documents the event as a oneOf discriminated on collectionMode', async () => {
    const document = await fetchDocument();
    const event = document.components.schemas.CollectionEvent as
      | { oneOf?: { $ref?: string }[]; anyOf?: unknown; discriminator?: unknown }
      | undefined;

    expect(event?.anyOf).toBeUndefined();
    expect(event?.oneOf?.map((branch) => branch.$ref)).toEqual([
      '#/components/schemas/CurbsideCollectionEvent',
      '#/components/schemas/MobileDropOffCollectionEvent',
    ]);
    expect(event?.discriminator).toEqual({
      propertyName: 'collectionMode',
      mapping: {
        curbside: '#/components/schemas/CurbsideCollectionEvent',
        mobile_drop_off: '#/components/schemas/MobileDropOffCollectionEvent',
      },
    });
  });

  it('documents the service-area capability as a oneOf discriminated on availability', async () => {
    const document = await fetchDocument();
    const capability = document.components.schemas.ServiceAreaCollectionEvents as
      | { oneOf?: { $ref?: string }[]; anyOf?: unknown; discriminator?: unknown }
      | undefined;

    expect(capability?.anyOf).toBeUndefined();
    expect(capability?.oneOf?.map((branch) => branch.$ref)).toEqual([
      '#/components/schemas/ServiceAreaCollectionEventsAvailable',
      '#/components/schemas/ServiceAreaCollectionEventsUnavailable',
    ]);
    expect(capability?.discriminator).toEqual({
      propertyName: 'availability',
      mapping: {
        available: '#/components/schemas/ServiceAreaCollectionEventsAvailable',
        unavailable: '#/components/schemas/ServiceAreaCollectionEventsUnavailable',
      },
    });
  });

  it('permits no invented zone or window on the unavailable capability branch', async () => {
    const document = await fetchDocument();
    const branchOf = (name: string) =>
      document.components.schemas[name] as
        | { required?: string[]; properties?: Record<string, unknown> }
        | undefined;

    const available = branchOf('ServiceAreaCollectionEventsAvailable');
    const unavailable = branchOf('ServiceAreaCollectionEventsUnavailable');

    // The branch that states a calendar exists must state which zone and which window it covers.
    expect(available?.required).toEqual(
      expect.arrayContaining(['availability', 'timeZone', 'validity']),
    );
    expect(
      (document.components.schemas.ServiceAreaValidity as { required?: string[] } | undefined)
        ?.required,
    ).toEqual(expect.arrayContaining(['from', 'to']));

    // And the branch that states none has nowhere to put either.
    expect(Object.keys(unavailable?.properties ?? {})).toEqual(['availability']);
  });

  it('requires the capability on every service area', async () => {
    const document = await fetchDocument();
    const serviceArea = document.components.schemas.ServiceArea as
      | { required?: string[] }
      | undefined;

    expect(serviceArea?.required).toEqual(expect.arrayContaining(['collectionEvents']));
  });

  it('permits no incomplete mobile drop-off in either event branch', async () => {
    const document = await fetchDocument();
    const branchOf = (name: string) =>
      document.components.schemas[name] as
        | { required?: string[]; properties?: Record<string, unknown> }
        | undefined;

    const mobile = branchOf('MobileDropOffCollectionEvent');
    const curbside = branchOf('CurbsideCollectionEvent');

    // The window, the zone, and the place are all mandatory on the branch that tells someone to travel.
    expect(mobile?.required).toEqual(expect.arrayContaining(['timing', 'location']));
    expect(
      (document.components.schemas.TimeWindowTiming as { required?: string[] } | undefined)
        ?.required,
    ).toEqual(expect.arrayContaining(['startsAt', 'endsAt', 'timeZone']));

    // And the branch that does not has nowhere to put one.
    expect(Object.keys(curbside?.properties ?? {})).not.toContain('location');
  });

  it('documents one 404 covering all three reasons, discriminated on code', async () => {
    const document = await fetchDocument();
    const responses = document.paths[COLLECTION_EVENTS_PATH]?.get?.responses ?? {};

    // An operation permits a single entry per status code, so the three reasons must share one response.
    expect(Object.keys(responses).filter((status) => status === '404')).toHaveLength(1);

    const notFound = document.components.schemas.CollectionEventsNotFoundProblem as
      | { oneOf?: { $ref?: string }[]; discriminator?: { mapping?: Record<string, string> } }
      | undefined;

    expect(notFound?.oneOf).toHaveLength(3);
    expect(Object.keys(notFound?.discriminator?.mapping ?? {}).toSorted()).toEqual([
      'COLLECTION_EVENTS_NOT_AVAILABLE',
      'PROVIDER_NOT_FOUND',
      'SERVICE_AREA_NOT_FOUND',
    ]);
  });

  it.each([
    [200, ['fresh', 'stale']],
    [404, ['collectionEventsNotAvailable', 'providerNotFound', 'serviceAreaNotFound']],
  ] as const)(
    'publishes named %s examples on the collection-events operation',
    async (status, names) => {
      const document = await fetchDocument();
      const response = document.paths[COLLECTION_EVENTS_PATH]?.get?.responses?.[String(status)];
      const media = Object.values(response?.content ?? {})[0] as
        | { examples?: Record<string, { value?: unknown }> }
        | undefined;

      expect(Object.keys(media?.examples ?? {}).toSorted()).toEqual([...names]);

      for (const example of Object.values(media?.examples ?? {})) {
        expect(example.value).toBeDefined();
      }
    },
  );

  it('states the freshness difference between the two success examples', async () => {
    const document = await fetchDocument();
    const media = Object.values(
      document.paths[COLLECTION_EVENTS_PATH]?.get?.responses?.['200']?.content ?? {},
    )[0] as
      | { examples?: Record<string, { value?: { meta?: Record<string, unknown> } }> }
      | undefined;

    expect(media?.examples?.fresh?.value?.meta?.freshness).toBe('fresh');
    expect(media?.examples?.stale?.value?.meta?.freshness).toBe('stale');
    // The stale example keeps the earlier retrieval timestamp rather than pretending to be current.
    expect(media?.examples?.stale?.value?.meta?.retrievedAt).not.toBe(
      media?.examples?.fresh?.value?.meta?.retrievedAt,
    );
  });

  it('never advertises the direct calendar download URL', async () => {
    const document = await fetchDocument();

    expect(JSON.stringify(document)).not.toContain('ics-stadtmitte.ics');
  });

  it('prevents undocumented fields in every response schema', async () => {
    const document = await fetchDocument();

    for (const [name, schema] of Object.entries(document.components.schemas)) {
      if (schema.type !== 'object') {
        continue;
      }

      expect(schema.additionalProperties, name).toBe(false);
    }
  });
});
