import { buildApp } from './app';
import { loadEnv, toAppConfig } from './config/env';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const env = (() => {
  try {
    return loadEnv(process.env);
  } catch (error) {
    // The logger is not available yet, so report the actionable message and stop before Fastify is
    // constructed rather than starting with an unusable configuration.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
})();

const app = await buildApp(toAppConfig(env));

let shuttingDown = false;

const shutdown = async (reason: string, exitCode: number): Promise<never> => {
  if (shuttingDown) {
    return process.exit(exitCode);
  }

  shuttingDown = true;
  app.log.info({ reason }, 'Shutting down');

  // Never let a hung connection block the process indefinitely.
  const timeout = setTimeout(() => {
    app.log.error({ reason, timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Forcing shutdown after timeout');
    process.exit(exitCode === 0 ? 1 : exitCode);
  }, SHUTDOWN_TIMEOUT_MS);

  timeout.unref();

  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, 'Failed to close the server cleanly');

    return process.exit(1);
  }

  clearTimeout(timeout);

  return process.exit(exitCode);
};

for (const signal of SHUTDOWN_SIGNALS) {
  process.on(signal, () => {
    void shutdown(signal, 0);
  });
}

process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'Unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});

try {
  await app.listen({ host: env.host, port: env.port });
} catch (error) {
  app.log.fatal({ err: error }, 'Failed to start the API');
  process.exit(1);
}
