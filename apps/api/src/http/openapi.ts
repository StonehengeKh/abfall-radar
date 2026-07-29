import fastifySwagger, { type SwaggerTransformObject } from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { createJsonSchemaTransform, jsonSchemaTransformObject } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { PROBLEM_CONTENT_TYPE } from './error-handler';

export const DOCS_ROUTE_PREFIX = '/docs';

export const OPENAPI_DOCUMENT_ROUTE = '/openapi.json';

const JSON_CONTENT_TYPE = 'application/json';

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/** `@fastify/swagger` falls back to this string when it cannot resolve a response description. */
const DEFAULT_RESPONSE_DESCRIPTION = 'Default Response';

/**
 * Replaces the library default, which assumes a `/documentation` prefix and would otherwise leave
 * the documentation routes themselves in the generated contract.
 */
const DOCS_SKIP_LIST = [
  DOCS_ROUTE_PREFIX,
  `${DOCS_ROUTE_PREFIX}/`,
  `${DOCS_ROUTE_PREFIX}/*`,
  `${DOCS_ROUTE_PREFIX}/json`,
  `${DOCS_ROUTE_PREFIX}/yaml`,
  `${DOCS_ROUTE_PREFIX}/uiConfig`,
  `${DOCS_ROUTE_PREFIX}/initOAuth`,
  `${DOCS_ROUTE_PREFIX}/static/*`,
  OPENAPI_DOCUMENT_ROUTE,
] as const;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface ResponseEntry {
  readonly status: number;
  readonly response: Record<string, unknown>;
}

/**
 * The passes below take `unknown` and narrow with guards so no part of the generated document is
 * read through an unchecked cast. They mutate the document in place; callers pass a clone.
 */
const eachResponse = (document: unknown): ResponseEntry[] => {
  if (!isRecord(document)) {
    return [];
  }

  const paths = document.paths;

  if (!isRecord(paths)) {
    return [];
  }

  const entries: ResponseEntry[] = [];

  for (const pathItem of Object.values(paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];

      if (!isRecord(operation)) {
        continue;
      }

      const responses = operation.responses;

      if (!isRecord(responses)) {
        continue;
      }

      for (const [statusCode, response] of Object.entries(responses)) {
        const status = Number.parseInt(statusCode, 10);

        if (!Number.isInteger(status) || !isRecord(response)) {
          continue;
        }

        entries.push({ status, response });
      }
    }
  }

  return entries;
};

const findResponseSchemaRef = (response: Record<string, unknown>): string | undefined => {
  const content = response.content;

  if (!isRecord(content)) {
    return undefined;
  }

  for (const media of Object.values(content)) {
    if (!isRecord(media)) {
      continue;
    }

    const schema = media.schema;

    if (isRecord(schema) && typeof schema.$ref === 'string') {
      return schema.$ref;
    }
  }

  return undefined;
};

/**
 * `@fastify/swagger` resolves a referenced schema's description through its own `$ref` resolver,
 * which only knows Fastify shared schemas. Components contributed by the Zod transform are injected
 * during this same `transformObject` step, so they are invisible at that point and every referenced
 * response falls back to `Default Response`. This pass performs the lookup the library intended.
 */
export const resolveResponseDescriptions = (document: unknown): void => {
  if (!isRecord(document)) {
    return;
  }

  const components = document.components;
  const schemas = isRecord(components) && isRecord(components.schemas) ? components.schemas : {};

  for (const { response } of eachResponse(document)) {
    if (
      typeof response.description === 'string' &&
      response.description !== DEFAULT_RESPONSE_DESCRIPTION
    ) {
      continue;
    }

    const ref = findResponseSchemaRef(response);

    if (ref === undefined || !ref.startsWith(SCHEMA_REF_PREFIX)) {
      continue;
    }

    const schema = schemas[ref.slice(SCHEMA_REF_PREFIX.length)];

    if (isRecord(schema) && typeof schema.description === 'string') {
      response.description = schema.description;
    }
  }
};

/**
 * The Zod transform cannot express a per-media-type response schema, so every response is generated
 * as `application/json`. The error boundary sends RFC 9457 Problem Details, so the documented media
 * type of every failure has to be corrected to match what clients actually receive.
 */
export const applyProblemDetailsMediaType = (document: unknown): void => {
  for (const { status, response } of eachResponse(document)) {
    if (status < 400) {
      continue;
    }

    const content = response.content;

    if (!isRecord(content)) {
      continue;
    }

    const jsonMedia = content[JSON_CONTENT_TYPE];

    if (jsonMedia === undefined) {
      continue;
    }

    delete content[JSON_CONTENT_TYPE];
    content[PROBLEM_CONTENT_TYPE] = jsonMedia;
  }
};

const collectSchemaRefs = (value: unknown, into: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSchemaRefs(item, into);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === '$ref' && typeof nested === 'string' && nested.startsWith(SCHEMA_REF_PREFIX)) {
      into.add(nested.slice(SCHEMA_REF_PREFIX.length));
      continue;
    }

    collectSchemaRefs(nested, into);
  }
};

/**
 * The Zod transform emits an input and an output component for every registered schema. All schemas
 * in this API are output-only, so the unused input twins would appear in the contract as schemas no
 * operation can ever return.
 */
export const pruneUnreferencedComponentSchemas = (document: unknown): void => {
  if (!isRecord(document)) {
    return;
  }

  const components = document.components;

  if (!isRecord(components) || !isRecord(components.schemas)) {
    return;
  }

  const schemas = components.schemas;
  const referenced = new Set<string>();

  for (const [key, value] of Object.entries(document)) {
    if (key !== 'components') {
      collectSchemaRefs(value, referenced);
    }
  }

  for (const [key, value] of Object.entries(components)) {
    if (key !== 'schemas') {
      collectSchemaRefs(value, referenced);
    }
  }

  const pending = [...referenced];

  while (pending.length > 0) {
    const name = pending.pop();

    if (name === undefined) {
      continue;
    }

    const nested = new Set<string>();

    collectSchemaRefs(schemas[name], nested);

    for (const ref of nested) {
      if (!referenced.has(ref)) {
        referenced.add(ref);
        pending.push(ref);
      }
    }
  }

  for (const name of Object.keys(schemas)) {
    if (!referenced.has(name)) {
      delete schemas[name];
    }
  }
};

export const createDocumentTransform = (): SwaggerTransformObject => (documentObject) => {
  const document = structuredClone(jsonSchemaTransformObject(documentObject));

  resolveResponseDescriptions(document);
  applyProblemDetailsMediaType(document);
  pruneUnreferencedComponentSchemas(document);

  return document;
};

export const registerDocs = async (app: FastifyInstance): Promise<void> => {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AbfallRadar API',
        version: '0.1.0',
        description:
          'Provider-neutral waste collection contract for the AbfallRadar browser extension, web application, and mobile application.\n\nThe `v1` path segment versions the public HTTP contract; operational endpoints stay unversioned. Expected failures use RFC 9457 Problem Details with the `application/problem+json` media type.\n\nOnly the demo provider is available today. Demo data is generated sample data and must never be presented as official municipal data.',
      },
      servers: [{ url: '/', description: 'The origin serving this document.' }],
      tags: [
        {
          name: 'Operations',
          description: 'Operational endpoints outside the versioned product contract.',
        },
        {
          name: 'Providers',
          description: 'The schedule provider catalogue and the service areas of each provider.',
        },
      ],
    },
    transform: createJsonSchemaTransform({ skipList: [...DOCS_SKIP_LIST] }),
    transformObject: createDocumentTransform(),
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: DOCS_ROUTE_PREFIX,
    staticCSP: true,
    uiConfig: { deepLinking: true, docExpansion: 'list' },
  });

  // Hidden so the contract does not document the endpoint that serves the contract.
  app.get(OPENAPI_DOCUMENT_ROUTE, { schema: { hide: true } }, async () => app.swagger());
};
