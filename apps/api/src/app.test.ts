import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app';
import { PROBLEM_CONTENT_TYPE } from './http/error-handler';
import { DOCS_ROUTE_PREFIX, OPENAPI_DOCUMENT_ROUTE } from './http/openapi';
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
    expect(document.tags.map((tag) => tag.name)).toEqual(['Operations', 'Providers']);
  });

  it('documents exactly the implemented operations', async () => {
    const document = await fetchDocument();

    expect(Object.keys(document.paths).toSorted()).toEqual([
      '/api/v1/providers',
      '/api/v1/providers/{providerId}/service-areas',
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

    expect(schemaNames).toContain('ProblemDetails');
    expect(schemaNames).toContain('ValidationProblem');
    expect(schemaNames).toContain('ProviderNotFoundProblem');
    expect(schemaNames).toContain('Provider');
    expect(schemaNames).toContain('ServiceArea');

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
      'ProblemDetails',
      'ValidationProblem',
      'ProviderNotFoundProblem',
    ]) {
      expect(examplesFor(name), name).toEqual(expect.any(Array));
    }

    // The examples are the values the existing demo provider really returns.
    expect(examplesFor('ServiceAreaListResponse')).toMatchObject([
      {
        data: [
          { id: 'koblenz-stadtmitte', providerId: 'demo', locality: 'Koblenz', name: 'Stadtmitte' },
          {
            id: 'koblenz-metternich-1',
            providerId: 'demo',
            locality: 'Koblenz',
            name: 'Metternich 1',
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
