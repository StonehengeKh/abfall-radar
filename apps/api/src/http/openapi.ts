import fastifySwagger, { type SwaggerTransformObject } from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { createJsonSchemaTransform, jsonSchemaTransformObject } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { COLLECTION_EVENTS_EXAMPLES } from '../routes/v1/collection-events.schemas';
import { PROBLEM_CONTENT_TYPE } from './error-handler';
import { COLLECTION_EVENTS_NOT_FOUND_EXAMPLES } from './problem-details';

export const COLLECTION_EVENTS_PATH =
  '/api/v1/providers/{providerId}/service-areas/{serviceAreaId}/collection-events';

/** Unions whose branches are decided by one property, republished as a discriminated `oneOf`. */
const DISCRIMINATORS: readonly DiscriminatorSpec[] = [
  { schema: 'CollectionEvent', propertyName: 'collectionMode' },
  { schema: 'CollectionEventsNotFoundProblem', propertyName: 'code' },
];

const RESPONSE_EXAMPLES: readonly ResponseExampleSpec[] = [
  {
    path: COLLECTION_EVENTS_PATH,
    method: 'get',
    status: 200,
    examples: COLLECTION_EVENTS_EXAMPLES,
  },
  {
    path: COLLECTION_EVENTS_PATH,
    method: 'get',
    status: 404,
    examples: COLLECTION_EVENTS_NOT_FOUND_EXAMPLES,
  },
];

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

export interface DiscriminatorSpec {
  /** The registered component schema name. */
  readonly schema: string;
  readonly propertyName: string;
}

/** Zod emits a literal as `const`; older emitters use a single-member `enum`. Both are read here. */
const literalValueOf = (schema: unknown, propertyName: string): string | undefined => {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return undefined;
  }

  const property = schema.properties[propertyName];

  if (!isRecord(property)) {
    return undefined;
  }

  if (typeof property.const === 'string') {
    return property.const;
  }

  return Array.isArray(property.enum) &&
    property.enum.length === 1 &&
    typeof property.enum[0] === 'string'
    ? property.enum[0]
    : undefined;
};

/**
 * Republishes a union component as an OpenAPI `oneOf` with a discriminator.
 *
 * Zod emits a discriminated union as `anyOf` with no discriminator, which is weaker than the contract
 * these unions actually satisfy: exactly one branch matches, and one property decides which. Stating
 * that lets a generated client produce an exhaustive switch instead of a best-effort guess.
 *
 * The mapping is derived from each branch's own literal rather than hand-written, so a new branch cannot
 * be added to a union and left out of the discriminator.
 */
export const applyOneOfDiscriminators = (
  document: unknown,
  specs: readonly DiscriminatorSpec[],
): void => {
  if (
    !isRecord(document) ||
    !isRecord(document.components) ||
    !isRecord(document.components.schemas)
  ) {
    return;
  }

  const schemas = document.components.schemas;

  for (const spec of specs) {
    const schema = schemas[spec.schema];

    if (!isRecord(schema)) {
      continue;
    }

    const branches = schema.anyOf ?? schema.oneOf;

    if (!Array.isArray(branches)) {
      continue;
    }

    const mapping: Record<string, string> = {};

    for (const branch of branches) {
      if (!isRecord(branch) || typeof branch.$ref !== 'string') {
        continue;
      }

      const name = branch.$ref.startsWith(SCHEMA_REF_PREFIX)
        ? branch.$ref.slice(SCHEMA_REF_PREFIX.length)
        : undefined;
      const value =
        name === undefined ? undefined : literalValueOf(schemas[name], spec.propertyName);

      if (value !== undefined) {
        mapping[value] = branch.$ref;
      }
    }

    // Leave the union untouched unless every branch contributed, so an incomplete mapping surfaces as a
    // failing contract test rather than as a discriminator that quietly omits a variant.
    if (Object.keys(mapping).length !== branches.length) {
      continue;
    }

    delete schema.anyOf;
    schema.oneOf = branches;
    schema.discriminator = { propertyName: spec.propertyName, mapping };
  }
};

export interface NamedExample {
  readonly summary?: string;
  readonly description?: string;
  readonly value: unknown;
}

export interface ResponseExampleSpec {
  readonly path: string;
  readonly method: (typeof HTTP_METHODS)[number];
  readonly status: number;
  readonly examples: Readonly<Record<string, NamedExample>>;
}

/**
 * Attaches named examples to a response's media type.
 *
 * A schema-level `examples` array cannot label its entries, so it cannot express "this is the fresh
 * response and that is the stale one", or which of three reasons a 404 shows. Named response examples
 * can, and Swagger UI offers them in a picker.
 *
 * Runs after the Problem Details media type is corrected, so it writes to whichever media type the
 * response really has.
 */
export const applyNamedResponseExamples = (
  document: unknown,
  specs: readonly ResponseExampleSpec[],
): void => {
  if (!isRecord(document) || !isRecord(document.paths)) {
    return;
  }

  for (const spec of specs) {
    const pathItem = document.paths[spec.path];

    if (!isRecord(pathItem)) {
      continue;
    }

    const operation = pathItem[spec.method];

    if (!isRecord(operation) || !isRecord(operation.responses)) {
      continue;
    }

    const response = operation.responses[String(spec.status)];

    if (!isRecord(response) || !isRecord(response.content)) {
      continue;
    }

    for (const media of Object.values(response.content)) {
      if (isRecord(media)) {
        media.examples = { ...spec.examples };
      }
    }
  }
};

export const createDocumentTransform =
  (
    discriminators: readonly DiscriminatorSpec[],
    responseExamples: readonly ResponseExampleSpec[],
  ): SwaggerTransformObject =>
  (documentObject) => {
    const document = structuredClone(jsonSchemaTransformObject(documentObject));

    resolveResponseDescriptions(document);
    applyProblemDetailsMediaType(document);
    applyOneOfDiscriminators(document, discriminators);
    applyNamedResponseExamples(document, responseExamples);
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
          'Provider-neutral waste collection contract for the AbfallRadar browser extension, web application, and mobile application.\n\nThe `v1` path segment versions the public HTTP contract; operational endpoints stay unversioned. Expected failures use RFC 9457 Problem Details with the `application/problem+json` media type.\n\nOfficial collection schedules come from the responsible municipal operator and carry their source, retrieval time, validity window, freshness state, and declared waste-type coverage. A provider whose `sourceKind` is `demo` returns generated sample data, which must never be presented as official municipal data.\n\nEvent identifiers are opaque. Their readable prefix exists for operators; clients must not parse them.',
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
        {
          name: 'Schedules',
          description:
            'Official collection events for a service area, with the provenance and freshness of the source they came from.',
        },
      ],
    },
    transform: createJsonSchemaTransform({ skipList: [...DOCS_SKIP_LIST] }),
    transformObject: createDocumentTransform(DISCRIMINATORS, RESPONSE_EXAMPLES),
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: DOCS_ROUTE_PREFIX,
    staticCSP: true,
    uiConfig: { deepLinking: true, docExpansion: 'list' },
  });

  // Hidden so the contract does not document the endpoint that serves the contract.
  app.get(OPENAPI_DOCUMENT_ROUTE, { schema: { hide: true } }, async () => app.swagger());
};
