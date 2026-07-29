import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiApp } from '../app';
import { REQUEST_ID_HEADER } from '../app';
import { buildTestApp } from '../test/build-test-app';

describe('GET /health', () => {
  let app: ApiApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the documented operational response', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const body: unknown = response.json();

    expect(body).toMatchObject({ status: 'ok', service: 'abfall-radar-api' });
  });

  it('generates the timestamp at request time as ISO-8601 in UTC', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const { timestamp } = response.json<{ timestamp: string }>();

    // Shape rather than wall clock: the value must round-trip through Date unchanged.
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  it('serializes no field the response schema does not document', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(Object.keys(response.json<Record<string, unknown>>()).toSorted()).toEqual([
      'service',
      'status',
      'timestamp',
    ]);
  });

  it('returns the request identifier header', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
  });
});
