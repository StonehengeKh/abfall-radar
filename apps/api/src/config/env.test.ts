import { describe, expect, it } from 'vitest';
import { EnvironmentValidationError, loadEnv, toAppConfig } from './env';

describe('loadEnv', () => {
  it('applies a default for every variable when nothing is configured', () => {
    expect(loadEnv({})).toEqual({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      docsEnabled: true,
    });
  });

  it('reads configured values and coerces the port to a number', () => {
    expect(
      loadEnv({ NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '8080', LOG_LEVEL: 'warn' }),
    ).toEqual({
      nodeEnv: 'production',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'warn',
      docsEnabled: false,
    });
  });

  it('ignores unrelated process environment entries', () => {
    expect(loadEnv({ PATH: '/usr/bin', UNRELATED: 'value' }).port).toBe(3000);
  });

  it.each([
    ['PORT', { PORT: 'abc' }],
    ['PORT', { PORT: '0' }],
    ['PORT', { PORT: '65536' }],
    ['PORT', { PORT: '3000.5' }],
    ['NODE_ENV', { NODE_ENV: 'staging' }],
    ['LOG_LEVEL', { LOG_LEVEL: 'verbose' }],
    ['HOST', { HOST: '' }],
    ['API_DOCS_ENABLED', { API_DOCS_ENABLED: 'yes' }],
  ])('rejects invalid %s with a message naming the variable', (variable, source) => {
    expect(() => loadEnv(source)).toThrow(EnvironmentValidationError);

    try {
      loadEnv(source);
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).toContain('Invalid API environment configuration');
      expect((error as Error).message).toContain(variable);
    }
  });
});

describe('documentation toggle', () => {
  it.each([
    ['development', undefined, true],
    ['test', undefined, true],
    ['production', undefined, false],
    ['development', 'false', false],
    ['production', 'true', true],
  ] as const)('resolves docsEnabled to %s / %s -> %s', (nodeEnv, apiDocsEnabled, expected) => {
    const env = loadEnv({
      NODE_ENV: nodeEnv,
      ...(apiDocsEnabled === undefined ? {} : { API_DOCS_ENABLED: apiDocsEnabled }),
    });

    expect(env.docsEnabled).toBe(expected);
  });
});

describe('toAppConfig', () => {
  it('exposes only what the application factory needs', () => {
    expect(toAppConfig(loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }))).toEqual({
      nodeEnv: 'test',
      logLevel: 'silent',
      docsEnabled: true,
    });
  });
});
