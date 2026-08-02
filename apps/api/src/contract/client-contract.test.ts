import {
  CollectionEventListResponseSchema,
  ProblemDetailsSchema,
  ProviderListResponseSchema,
  ServiceAreaListResponseSchema,
} from '@abfall-radar/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiApp } from '../app';
import { buildTestApp } from '../test/build-test-app';

/**
 * Parses real responses from this API through the hand-written validators in `@abfall-radar/api-client`.
 *
 * The generated types and the drift check keep the *shape* of the contract aligned. This closes the
 * remaining gap: it proves the runtime validators actually accept what the running application really
 * serializes, so the client's own fixtures cannot quietly diverge from the contract they claim to mirror.
 *
 * `@abfall-radar/api-client` is a test-only devDependency here, so the production bundle and its
 * externals guard are unaffected. Responses come from Fastify injection: no port is bound and no
 * municipal source is contacted, because none of these three resources reaches one.
 */

const OFFICIAL_PROVIDER_ID = 'koblenz-servicebetrieb';

const OFFICIAL_SERVICE_AREA_ID = 'koblenz-stadtmitte';

describe('the api-client validators against real API responses', () => {
  let app: ApiApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('parses the provider catalogue', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/providers' });

    expect(response.statusCode).toBe(200);

    const parsed = ProviderListResponseSchema.parse(response.json());

    expect(parsed.data.map((provider) => provider.sourceKind).toSorted()).toEqual([
      'demo',
      'official_ics',
    ]);
  });

  it('parses the official service-area list with its available capability', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/providers/${OFFICIAL_PROVIDER_ID}/service-areas`,
    });

    expect(response.statusCode).toBe(200);

    const parsed = ServiceAreaListResponseSchema.parse(response.json());
    const capability = parsed.data[0]?.collectionEvents;

    expect(capability).toEqual({
      availability: 'available',
      timeZone: 'Europe/Berlin',
      validity: { from: '2026-01-01', to: '2026-12-31' },
    });
  });

  it('parses the demo service-area list, whose areas all report no calendar', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/providers/demo/service-areas',
    });

    expect(response.statusCode).toBe(200);

    const parsed = ServiceAreaListResponseSchema.parse(response.json());

    expect(parsed.data.length).toBeGreaterThan(0);

    for (const area of parsed.data) {
      // The strict unavailable branch is what would reject an invented zone or window here.
      expect(area.collectionEvents).toEqual({ availability: 'unavailable' });
    }
  });

  it('parses a Problem Details body', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/providers/unknown/service-areas',
    });

    expect(response.statusCode).toBe(404);

    const parsed = ProblemDetailsSchema.parse(response.json());

    expect(parsed.code).toBe('PROVIDER_NOT_FOUND');
    expect(parsed.requestId).toEqual(expect.any(String));
  });

  it('parses the 422 body a range outside the declared window returns', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/providers/${OFFICIAL_PROVIDER_ID}/service-areas/${OFFICIAL_SERVICE_AREA_ID}/collection-events?from=2025-01-01&to=2025-12-31`,
    });

    expect(response.statusCode).toBe(422);
    expect(ProblemDetailsSchema.parse(response.json()).code).toBe('SCHEDULE_RANGE_NOT_COVERED');
  });

  it('parses the validation problem an ill-formed identifier returns', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/providers/Invalid_ID/service-areas',
    });

    expect(response.statusCode).toBe(400);

    const parsed = ProblemDetailsSchema.parse(response.json());

    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.errors).toEqual(expect.any(Array));
  });

  it('parses a collection-events response with both event variants', async () => {
    const app404 = await app.inject({
      method: 'GET',
      url: `/api/v1/providers/demo/service-areas/${OFFICIAL_SERVICE_AREA_ID}/collection-events?from=2026-03-01&to=2026-03-31`,
    });

    // The demo provider publishes no official calendar, so this resource genuinely does not exist for
    // it. That body is Problem Details, and it must parse as such rather than as a schedule.
    expect(app404.statusCode).toBe(404);
    expect(ProblemDetailsSchema.parse(app404.json()).code).toBe('COLLECTION_EVENTS_NOT_AVAILABLE');

    // The success shape is asserted against the published contract example, which the OpenAPI tests
    // already pin to what the route really returns. Retrieving the live official schedule here would
    // reach a municipal host, which no test does.
    const example = CollectionEventListResponseSchema.parse(
      publishedCollectionEventsExample(await documentOf(app)),
    );

    expect(example.data.map((event) => event.collectionMode)).toEqual([
      'curbside',
      'mobile_drop_off',
    ]);
    expect(example.meta.source.timeZone).toBe('Europe/Berlin');
  });
});

const documentOf = async (app: ApiApp): Promise<unknown> => {
  const response = await app.inject({ method: 'GET', url: '/openapi.json' });

  expect(response.statusCode).toBe(200);

  return response.json();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the `fresh` named example off the published contract without an unchecked cast. */
const publishedCollectionEventsExample = (document: unknown): unknown => {
  if (!isRecord(document) || !isRecord(document.components)) {
    throw new Error('The contract document is expected to carry component schemas.');
  }

  const schemas = document.components.schemas;

  if (!isRecord(schemas) || !isRecord(schemas.CollectionEventListResponse)) {
    throw new Error('The contract is expected to publish CollectionEventListResponse.');
  }

  const examples = schemas.CollectionEventListResponse.examples;

  if (!Array.isArray(examples) || examples.length === 0) {
    throw new Error('CollectionEventListResponse is expected to publish an example.');
  }

  return examples[0];
};
