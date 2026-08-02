import type { CacheFailure, GatewayFailure, SettingsFailure } from '@/src/messaging/contract';

/**
 * Structured logging for the worker boundary, with the safe field set decided here rather than at each
 * call site.
 *
 * What must never appear in a log line: `detail`, `instance`, `errors`, any server-supplied message, an
 * upstream URL, a request payload, a stack trace, or the kind of a refused message. `detail` is
 * diagnostic API copy, `instance` is an internal request path, `errors` can carry request input, and a
 * refused kind is untrusted input — and a browser console is not a private place to put any of them.
 *
 * `requestId` alone is enough for correlation, because the API already logs the full failure, including
 * its underlying cause, against that identifier.
 */

export interface GatewayLogger {
  readonly warn: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

export const consoleGatewayLogger: GatewayLogger = {
  warn: (message, fields) => {
    console.warn(message, fields);
  },
};

/**
 * Projects a failure onto exactly the fields that are safe to log.
 *
 * Written as an explicit per-branch list rather than a spread, so a member added to a failure cannot start
 * being logged by accident. `unsupported_message` logs its kind alone: there is no trustworthy operation
 * to name, and echoing the refused kind would log the untrusted string the message was refused for.
 */
export const toLogFields = (failure: GatewayFailure): Record<string, unknown> => {
  switch (failure.kind) {
    case 'problem':
      return {
        kind: failure.kind,
        operation: failure.operation,
        status: failure.status,
        code: failure.code,
        requestId: failure.requestId,
      };
    case 'timeout':
      return {
        kind: failure.kind,
        operation: failure.operation,
        // The configured budget that was exceeded, never a measured duration.
        timeoutMs: failure.timeoutMs,
      };
    case 'invalid_response':
      return { kind: failure.kind, operation: failure.operation, status: failure.status };
    case 'network':
    case 'cancelled':
      return { kind: failure.kind, operation: failure.operation };
    case 'unsupported_message':
      return { kind: failure.kind };
  }
};

export const logFailure = (logger: GatewayLogger, failure: GatewayFailure): void => {
  logger.warn('AbfallRadar request failed', toLogFields(failure));
};

/**
 * Projects a settings failure onto the fields that are safe to log, which is its kind alone.
 *
 * There is nothing else that is both true and safe. A settings command performs no HTTP request, so it has no
 * operation, no status and no request identifier — and the underlying storage rejection could name an internal
 * path or carry a stack. A log line inventing any of those would send an operator looking for a request that was
 * never made.
 */
export const toSettingsLogFields = (failure: SettingsFailure): Record<string, unknown> => ({
  kind: failure.kind,
});

export const logSettingsFailure = (logger: GatewayLogger, failure: SettingsFailure): void => {
  logger.warn('AbfallRadar settings command failed', toSettingsLogFields(failure));
};

/**
 * Projects a cache failure onto its kind alone, for the same reasons.
 *
 * Dropping a stored entry performs no HTTP request, so it has no operation, no status and no request identifier —
 * and the storage rejection underneath could name an internal path. This used to be logged as
 * `operation: 'listCollectionEvents'`, which named a request that was never made and sent anyone reading the line
 * looking for a response that never existed.
 */
export const toCacheLogFields = (failure: CacheFailure): Record<string, unknown> => ({
  kind: failure.kind,
});

export const logCacheFailure = (logger: GatewayLogger, failure: CacheFailure): void => {
  logger.warn('AbfallRadar could not discard the stored schedule', toCacheLogFields(failure));
};
