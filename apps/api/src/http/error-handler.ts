import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from '@fastify/type-provider-zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiProblem,
  buildProblem,
  type ProblemCode,
  type ValidationIssue,
} from './problem-details';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

interface SendProblemOptions {
  readonly status?: number;
  readonly errors?: readonly ValidationIssue[];
}

const sendProblem = (
  request: FastifyRequest,
  reply: FastifyReply,
  code: ProblemCode,
  options: SendProblemOptions = {},
): FastifyReply => {
  const problem = buildProblem({
    code,
    instance: request.url,
    requestId: request.id,
    ...options,
  });

  return reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
};

/**
 * `params` is intentionally dropped from every issue: it carries raw Zod internals such as the
 * compiled pattern, which must not reach a client.
 */
const toValidationIssues = (
  validation: readonly { instancePath: string; keyword: string; message?: string | undefined }[],
): ValidationIssue[] =>
  validation.map((issue) => ({
    path: issue.instancePath,
    code: issue.keyword,
    message: issue.message ?? 'Invalid value.',
  }));

export const createErrorHandler =
  () =>
  (error: FastifyError, request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return sendProblem(request, reply, 'VALIDATION_ERROR', {
        errors: toValidationIssues(error.validation),
      });
    }

    if (error instanceof ApiProblem) {
      return sendProblem(request, reply, error.code, {
        status: error.status,
        ...(error.errors === undefined ? {} : { errors: error.errors }),
      });
    }

    if (isResponseSerializationError(error)) {
      request.log.error(
        { err: error, requestId: request.id, issues: error.cause.issues },
        'Response did not match its documented schema',
      );

      return sendProblem(request, reply, 'INTERNAL_SERVER_ERROR');
    }

    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn(
        {
          requestId: request.id,
          statusCode: error.statusCode,
          frameworkErrorCode: error.code,
          frameworkErrorMessage: error.message,
        },
        'Request rejected by the HTTP framework',
      );

      return sendProblem(request, reply, 'REQUEST_ERROR', { status: error.statusCode });
    }

    request.log.error(
      { err: error, requestId: request.id },
      'Unexpected error while handling a request',
    );

    return sendProblem(request, reply, 'INTERNAL_SERVER_ERROR');
  };

export const createNotFoundHandler =
  () =>
  (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    sendProblem(request, reply, 'ROUTE_NOT_FOUND');
