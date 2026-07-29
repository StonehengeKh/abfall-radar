import { afterEach, describe, expect, it } from 'vitest';
import { type ApiApp, REQUEST_ID_HEADER } from '../app';
import { buildTestApp, ECHO_ROUTE, FAILING_ROUTE, FAILURE_MESSAGE } from '../test/build-test-app';
import { createLogCollector, type LogCollector } from '../test/log-collector';
import { PROBLEM_CONTENT_TYPE } from './error-handler';

interface TestContext {
  readonly app: ApiApp;
  readonly logs: LogCollector;
}

let context: TestContext | undefined;

const setUp = async (): Promise<TestContext> => {
  const logs = createLogCollector();
  const app = await buildTestApp({
    config: { logLevel: 'trace' },
    logDestination: logs.stream,
    withFailingRoutes: true,
  });

  context = { app, logs };

  return context;
};

afterEach(async () => {
  await context?.app.close();
  context = undefined;
});

describe('unexpected errors', () => {
  it('returns a sanitized 500 problem that leaks no internals', async () => {
    const { app } = await setUp();
    const response = await app.inject({ method: 'GET', url: FAILING_ROUTE });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toEqual({
      type: 'urn:abfall-radar:problem:internal-server-error',
      title: 'Internal server error',
      status: 500,
      detail: 'The request could not be completed because of an unexpected server error.',
      instance: FAILING_ROUTE,
      code: 'INTERNAL_SERVER_ERROR',
      requestId: response.headers[REQUEST_ID_HEADER],
    });

    expect(response.body).not.toContain(FAILURE_MESSAGE);
    expect(response.body).not.toContain('confidential');
    expect(response.body).not.toContain('stack');
    expect(response.body).not.toContain('    at ');
  });

  it('logs the failure with the request identifier that the client received', async () => {
    const { app, logs } = await setUp();
    const response = await app.inject({ method: 'GET', url: FAILING_ROUTE });
    const requestId = response.headers[REQUEST_ID_HEADER];

    const logged = logs.find(
      (line) => line.msg === 'Unexpected error while handling a request' && line.err !== undefined,
    );

    expect(requestId).toEqual(expect.any(String));
    expect(logged).toBeDefined();
    expect(logged?.requestId).toBe(requestId);
    expect(response.json<{ requestId: string }>().requestId).toBe(requestId);
  });
});

describe('framework client errors', () => {
  it('returns an unsupported media type as a problem without leaking framework internals', async () => {
    const { app } = await setUp();
    const response = await app.inject({
      method: 'POST',
      url: ECHO_ROUTE,
      headers: { 'content-type': 'application/xml' },
      payload: '<value>demo</value>',
    });

    expect(response.statusCode).toBe(415);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toEqual({
      type: 'urn:abfall-radar:problem:request-error',
      title: 'Request error',
      status: 415,
      detail: 'The request could not be processed as sent.',
      instance: ECHO_ROUTE,
      code: 'REQUEST_ERROR',
      requestId: response.headers[REQUEST_ID_HEADER],
    });

    expect(response.body).not.toContain('FST_ERR');
    expect(response.body).not.toContain('application/xml');
  });

  it('logs the framework error code instead of returning it', async () => {
    const { app, logs } = await setUp();
    const response = await app.inject({
      method: 'POST',
      url: ECHO_ROUTE,
      headers: { 'content-type': 'application/xml' },
      payload: '<value>demo</value>',
    });

    const logged = logs.find((line) => line.msg === 'Request rejected by the HTTP framework');

    expect(logged).toBeDefined();
    expect(logged?.requestId).toBe(response.headers[REQUEST_ID_HEADER]);
    expect(logged?.frameworkErrorCode).toBe('FST_ERR_CTP_INVALID_MEDIA_TYPE');
  });
});

describe('unknown routes', () => {
  it('returns a problem response without leaking internals', async () => {
    const { app } = await setUp();
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toEqual({
      type: 'urn:abfall-radar:problem:route-not-found',
      title: 'Route not found',
      status: 404,
      detail: 'The requested route does not exist on this API.',
      instance: '/nope',
      code: 'ROUTE_NOT_FOUND',
      requestId: response.headers[REQUEST_ID_HEADER],
    });
  });

  it('reports the request identifier on the not-found path too', async () => {
    const { app } = await setUp();
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
    expect(response.json<{ requestId: string }>().requestId).toBe(
      response.headers[REQUEST_ID_HEADER],
    );
  });
});
