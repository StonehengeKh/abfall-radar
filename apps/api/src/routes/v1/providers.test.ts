import { demoDistricts } from '@abfall-radar/data-providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, REQUEST_ID_HEADER } from '../../app';
import { PROBLEM_CONTENT_TYPE } from '../../http/error-handler';
import { toServiceArea } from '../../providers/provider-catalogue';
import { buildTestApp } from '../../test/build-test-app';

const SERVICE_AREAS_URL = '/api/v1/providers/demo/service-areas';

describe('provider catalogue routes', () => {
  let app: ApiApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/providers', () => {
    it('returns the explicitly labelled demo provider', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/providers' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: [{ id: 'demo', name: 'Demo provider', sourceKind: 'demo' }],
      });
    });

    it('serializes no provider-specific implementation field', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/providers' });
      const { data } = response.json<{ data: Record<string, unknown>[] }>();

      for (const provider of data) {
        expect(Object.keys(provider).toSorted()).toEqual(['id', 'name', 'sourceKind']);
      }
    });
  });

  describe('GET /api/v1/providers/{providerId}/service-areas', () => {
    it('returns the normalized demo service areas', async () => {
      const response = await app.inject({ method: 'GET', url: SERVICE_AREAS_URL });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: demoDistricts.map(toServiceArea) });
    });

    it('maps the domain district city onto locality', async () => {
      const response = await app.inject({ method: 'GET', url: SERVICE_AREAS_URL });
      const { data } = response.json<{ data: Record<string, unknown>[] }>();

      expect(data[0]).toEqual({
        id: 'koblenz-stadtmitte',
        providerId: 'demo',
        locality: 'Koblenz',
        name: 'Stadtmitte',
      });

      for (const serviceArea of data) {
        expect(Object.keys(serviceArea).toSorted()).toEqual([
          'id',
          'locality',
          'name',
          'providerId',
        ]);
      }
    });

    it.each([
      ['an uppercase character', 'Invalid_ID'],
      ['an underscore', 'demo_provider'],
      ['a leading hyphen', '-demo'],
      ['a trailing hyphen', 'demo-'],
      ['more than 64 characters', 'd'.repeat(65)],
    ])('rejects %s with a documented 400 problem', async (_reason, providerId) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/providers/${providerId}/service-areas`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(response.json()).toMatchObject({
        type: 'urn:abfall-radar:problem:validation-error',
        title: 'Invalid request',
        status: 400,
        code: 'VALIDATION_ERROR',
        instance: `/api/v1/providers/${providerId}/service-areas`,
        requestId: response.headers[REQUEST_ID_HEADER],
      });
    });

    it('reports field-level validation details without exposing internals', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/providers/Invalid_ID/service-areas',
      });

      const { errors } = response.json<{
        errors: { path: string; code: string; message: string }[];
      }>();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.path).toBe('/providerId');
      expect(errors[0]?.code).toEqual(expect.any(String));
      expect(Object.keys(errors[0] ?? {}).toSorted()).toEqual(['code', 'message', 'path']);
    });

    it('returns a documented 404 problem for a well formed but unknown provider', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/providers/unknown/service-areas',
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(response.json()).toEqual({
        type: 'urn:abfall-radar:problem:provider-not-found',
        title: 'Provider not found',
        status: 404,
        detail: 'No schedule provider exists for the supplied identifier.',
        instance: '/api/v1/providers/unknown/service-areas',
        code: 'PROVIDER_NOT_FOUND',
        requestId: response.headers[REQUEST_ID_HEADER],
      });
    });

    it('returns the request identifier header on success and on failure', async () => {
      const success = await app.inject({ method: 'GET', url: SERVICE_AREAS_URL });
      const failure = await app.inject({
        method: 'GET',
        url: '/api/v1/providers/unknown/service-areas',
      });

      expect(success.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
      expect(failure.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
      expect(failure.json<{ requestId: string }>().requestId).toBe(
        failure.headers[REQUEST_ID_HEADER],
      );
    });
  });
});
