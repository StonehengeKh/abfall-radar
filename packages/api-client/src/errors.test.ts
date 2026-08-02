import { describe, expect, it } from 'vitest';
import { ApiFailureSchema, DEFAULT_TIMEOUT_MS, TimeoutMsSchema } from './errors';

describe('ApiFailureSchema', () => {
  it.each([
    [
      'problem',
      {
        kind: 'problem',
        operation: 'listProviders',
        status: 422,
        code: 'SCHEDULE_RANGE_NOT_COVERED',
        requestId: 'req-1',
      },
    ],
    ['network', { kind: 'network', operation: 'listProviders' }],
    ['timeout', { kind: 'timeout', operation: 'listProviders', timeoutMs: 8000 }],
    ['cancelled', { kind: 'cancelled', operation: 'listProviders' }],
    ['invalid_response', { kind: 'invalid_response', operation: 'listProviders', status: 500 }],
  ])('parses a %s failure', (_kind, failure) => {
    expect(ApiFailureSchema.parse(failure)).toEqual(failure);
  });

  it.each([
    ['network', { kind: 'network', operation: 'listProviders' }],
    ['timeout', { kind: 'timeout', operation: 'listProviders', timeoutMs: 8000 }],
    ['cancelled', { kind: 'cancelled', operation: 'listProviders' }],
    ['invalid_response', { kind: 'invalid_response', operation: 'listProviders', status: 500 }],
  ])('refuses a request identifier on a %s failure', (_kind, failure) => {
    // Not "ignores": a failure that never reached a server has no identifier to carry, so the schema
    // makes carrying one impossible rather than merely discouraged.
    expect(ApiFailureSchema.safeParse({ ...failure, requestId: 'req-1' }).success).toBe(false);
    expect(ApiFailureSchema.safeParse({ ...failure, requestId: '' }).success).toBe(false);
    expect(ApiFailureSchema.safeParse({ ...failure, requestId: '-' }).success).toBe(false);
  });

  it('has no requestId member on any non-problem branch after parsing', () => {
    for (const failure of [
      { kind: 'network', operation: 'listProviders' },
      { kind: 'timeout', operation: 'listProviders', timeoutMs: 8000 },
      { kind: 'cancelled', operation: 'listProviders' },
      { kind: 'invalid_response', operation: 'listProviders', status: 500 },
    ]) {
      // Asserted on the key set rather than on a value, so an empty string or a placeholder fails.
      expect(Object.keys(ApiFailureSchema.parse(failure))).not.toContain('requestId');
    }
  });

  it('rejects an unrecognized failure kind', () => {
    expect(
      ApiFailureSchema.safeParse({ kind: 'exploded', operation: 'listProviders' }).success,
    ).toBe(false);
  });

  it('rejects an unrecognized operation', () => {
    expect(
      ApiFailureSchema.safeParse({ kind: 'network', operation: 'listEverything' }).success,
    ).toBe(false);
  });

  it('rejects the manufactured unknown operation', () => {
    // `operation: 'unknown'` would read like a real operation while describing nothing, and would push
    // every consumer into handling a sentinel.
    expect(ApiFailureSchema.safeParse({ kind: 'network', operation: 'unknown' }).success).toBe(
      false,
    );
  });

  it('rejects a timeout that carries no deadline', () => {
    expect(
      ApiFailureSchema.safeParse({ kind: 'timeout', operation: 'listProviders' }).success,
    ).toBe(false);
  });

  it.each(['deadlineMs', 'elapsed', 'elapsedMs'])(
    'rejects %s as a synonym for the configured deadline',
    (synonym) => {
      expect(
        ApiFailureSchema.safeParse({
          kind: 'timeout',
          operation: 'listProviders',
          [synonym]: 8000,
        }).success,
      ).toBe(false);
    },
  );
});

describe('TimeoutMsSchema', () => {
  it('accepts the documented default', () => {
    expect(TimeoutMsSchema.parse(DEFAULT_TIMEOUT_MS)).toBe(8000);
    expect(DEFAULT_TIMEOUT_MS).toBe(8000);
  });

  it.each([
    ['a missing value', undefined],
    ['a null value', null],
    ['a fractional value', 1500.5],
    ['zero', 0],
    ['a negative value', -1],
    ['a numeric string', '8000'],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s rather than defaulting it', (_reason, value) => {
    // Each of these describes a deadline that could never have been enforced.
    expect(TimeoutMsSchema.safeParse(value).success).toBe(false);
  });
});
