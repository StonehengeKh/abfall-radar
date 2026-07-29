import type { Writable } from 'node:stream';
import { z } from 'zod';
import { type ApiApp, buildApp } from '../app';
import type { AppConfig } from '../config/env';

export const FAILING_ROUTE = '/__unexpected';

export const ECHO_ROUTE = '/__echo';

/** Distinct from the route path so a leak assertion cannot pass by accident. */
export const FAILURE_MESSAGE = 'confidential upstream detail that must never reach a client';

export interface BuildTestAppOptions {
  readonly config?: Partial<AppConfig>;
  readonly logDestination?: Writable;
  /**
   * Adds hidden routes that make the error boundary observable: one that throws an unexpected error
   * and one that accepts a body so the HTTP framework can reject an unsupported media type.
   */
  readonly withFailingRoutes?: boolean;
}

const baseConfig: AppConfig = {
  nodeEnv: 'test',
  logLevel: 'silent',
  docsEnabled: true,
};

export const buildTestApp = async (options: BuildTestAppOptions = {}): Promise<ApiApp> => {
  const app = await buildApp(
    { ...baseConfig, ...options.config },
    options.logDestination === undefined ? {} : { logDestination: options.logDestination },
  );

  if (options.withFailingRoutes === true) {
    app.get(FAILING_ROUTE, { schema: { hide: true } }, async () => {
      throw new Error(FAILURE_MESSAGE);
    });

    app.post(
      ECHO_ROUTE,
      { schema: { hide: true, body: z.object({ value: z.string() }) } },
      async (request) => request.body,
    );
  }

  return app;
};
