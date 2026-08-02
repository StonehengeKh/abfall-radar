import { describe, expect, it } from 'vitest';
import { mutableCopy, PROBLEM_BODY } from '../test/response-fixtures';
import { ProblemDetailsSchema, toProblemFailure } from './problem-details';

const parseProblem = (body: unknown) => {
  const parsed = ProblemDetailsSchema.safeParse(body);

  if (!parsed.success) {
    throw new Error('The body was expected to parse as Problem Details.');
  }

  return parsed.data;
};

describe('ProblemDetailsSchema', () => {
  it('parses a documented problem body in full', () => {
    expect(parseProblem(PROBLEM_BODY)).toEqual(PROBLEM_BODY);
  });

  it('parses a body whose code is newer than this build, so it can degrade to a generic message', () => {
    const body = { ...mutableCopy(PROBLEM_BODY), code: 'SOME_FUTURE_PROBLEM' };

    expect(parseProblem(body).code).toBe('SOME_FUTURE_PROBLEM');
  });

  it('parses a validation problem carrying field-level errors', () => {
    const body = {
      ...mutableCopy(PROBLEM_BODY),
      code: 'VALIDATION_ERROR',
      errors: [{ path: '/providerId', code: 'invalid_format', message: 'Invalid string' }],
    };

    expect(parseProblem(body).errors).toHaveLength(1);
  });

  it.each([
    ['a missing request identifier', 'requestId'],
    ['a missing code', 'code'],
    ['a missing type', 'type'],
    ['a missing status', 'status'],
  ])('rejects a body with %s', (_reason, member) => {
    const body = mutableCopy(PROBLEM_BODY);

    delete body[member];

    expect(ProblemDetailsSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['a wrong-typed status', { status: '422' }],
    ['a non-integer status', { status: 422.5 }],
    ['an empty request identifier', { requestId: '' }],
    ['an empty code', { code: '' }],
  ])('rejects %s', (_reason, override) => {
    expect(
      ProblemDetailsSchema.safeParse({ ...mutableCopy(PROBLEM_BODY), ...override }).success,
    ).toBe(false);
  });

  it.each([
    ['an arbitrary JSON object', { message: 'something went wrong' }],
    ['a JSON array', []],
    ['a string', 'error'],
    ['null', null],
  ])('rejects %s, which a caller turns into an invalid-response failure', (_reason, body) => {
    expect(ProblemDetailsSchema.safeParse(body).success).toBe(false);
  });
});

describe('toProblemFailure', () => {
  it('projects exactly the safe subset', () => {
    const failure = toProblemFailure({
      operation: 'listCollectionEvents',
      status: 422,
      problem: parseProblem(PROBLEM_BODY),
    });

    expect(failure).toEqual({
      kind: 'problem',
      operation: 'listCollectionEvents',
      status: 422,
      code: 'SCHEDULE_RANGE_NOT_COVERED',
      requestId: 'req-1',
    });
  });

  it.each(['detail', 'instance', 'errors', 'type', 'title'])(
    'discards %s at the parse site',
    (member) => {
      // These are diagnostic API copy, an internal request path, and possibly request input. None
      // belongs in a user-visible message, and a browser console is not a private place either.
      const failure = toProblemFailure({
        operation: 'listCollectionEvents',
        status: 422,
        problem: parseProblem({
          ...mutableCopy(PROBLEM_BODY),
          errors: [{ path: '/from', code: 'custom', message: 'leaked input' }],
        }),
      });

      expect(Object.keys(failure)).not.toContain(member);
      expect(JSON.stringify(failure)).not.toContain('leaked input');
    },
  );

  it('takes the status from the response rather than from the body', () => {
    // The body's own `status` is untrusted input like every other member; the transport status is what
    // actually happened.
    const failure = toProblemFailure({
      operation: 'listProviders',
      status: 503,
      problem: parseProblem({ ...mutableCopy(PROBLEM_BODY), status: 422 }),
    });

    expect(failure.status).toBe(503);
  });

  it('has exactly the documented key set', () => {
    const failure = toProblemFailure({
      operation: 'listProviders',
      status: 500,
      problem: parseProblem(PROBLEM_BODY),
    });

    expect(Object.keys(failure).toSorted()).toEqual([
      'code',
      'kind',
      'operation',
      'requestId',
      'status',
    ]);
  });
});
