import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    API_DOCS_ENABLED: z.enum(['true', 'false']).optional(),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    // Documentation is opt-out everywhere and off by default in production, so route code never
    // needs to know which environment it runs in.
    docsEnabled:
      env.API_DOCS_ENABLED === undefined
        ? env.NODE_ENV !== 'production'
        : env.API_DOCS_ENABLED === 'true',
  }));

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly docsEnabled: boolean;
}

export class EnvironmentValidationError extends Error {
  constructor(details: string) {
    super(`Invalid API environment configuration:\n${details}`);
    this.name = 'EnvironmentValidationError';
  }
}

export const loadEnv = (source: NodeJS.ProcessEnv): Env => {
  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentValidationError(z.prettifyError(result.error));
  }

  return result.data;
};

export const toAppConfig = (env: Env): AppConfig => ({
  nodeEnv: env.nodeEnv,
  logLevel: env.logLevel,
  docsEnabled: env.docsEnabled,
});
