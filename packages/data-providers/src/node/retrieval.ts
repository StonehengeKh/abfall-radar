import { type CollectionSourceManifest, SourceFailureError, type SourceOrigin } from '../source';
import type { FetchLike } from './dependencies';

/**
 * Bounded retrieval of an allowlisted calendar file.
 *
 * Every byte from a municipal host is untrusted input. This module is the only place that talks to
 * one, and it is deliberately narrow: it takes a server-owned manifest and an injected `fetch`, and
 * nothing else. There is no parameter through which a request could influence the URL, the host, or
 * the port, which is the entire security model of ADR 0003.
 */

/** A deadline for the whole retrieval, not a timeout per hop, so a slow chain cannot add up. */
export const RETRIEVAL_DEADLINE_MS = 5_000;

export const MAX_BODY_BYTES = 1024 * 1024;

export const MAX_REDIRECT_HOPS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DEFAULT_PORTS = new Map([
  ['https:', 443],
  ['http:', 80],
]);

const effectivePort = (url: URL): number | undefined =>
  url.port === '' ? DEFAULT_PORTS.get(url.protocol) : Number(url.port);

/**
 * Compares parsed URL components against the approved origin. Never a substring or suffix test: a
 * `hostname.endsWith('koblenz.de')` check is satisfied by `evil-koblenz.de`, and a bare hostname
 * comparison would still allow an HTTP downgrade or a different port on the same name.
 */
const assertApprovedOrigin = (url: URL, origin: SourceOrigin): void => {
  const port = effectivePort(url);

  if (
    url.protocol !== `${origin.scheme}:` ||
    url.hostname !== origin.hostname ||
    port !== origin.port
  ) {
    throw new SourceFailureError('redirect-off-origin');
  }
};

/**
 * Releases a response body this retrieval will never read, so the socket is not left open.
 *
 * A cleanup failure is swallowed on purpose. Every caller is on its way to throwing a classified
 * `SourceFailureError`, and that classification is contract-visible: it decides whether a client sees a
 * `502` or a `503`. Letting a failed cancellation propagate would replace a precise reason with an
 * incidental one, and a body that cannot be cancelled is already unusable either way.
 */
const cancelResponseBody = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

/** The reader equivalent, for a body already locked by an in-progress read. */
const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
  await reader.cancel().catch(() => undefined);
};

const isAcceptedContentType = (response: Response, manifest: CollectionSourceManifest): boolean => {
  const header = response.headers.get('content-type');
  const mediaType = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  return manifest.acceptedContentTypes.some((candidate) => candidate.toLowerCase() === mediaType);
};

/**
 * Streams the body and stops the moment it exceeds the limit, so an endless response cannot exhaust
 * memory before a length check would have run. A declared `content-length` over the limit
 * short-circuits before a single chunk is read.
 */
const readBoundedText = async (response: Response): Promise<string> => {
  const declared = response.headers.get('content-length');

  if (declared !== null) {
    const size = Number(declared);

    if (Number.isFinite(size) && size > MAX_BODY_BYTES) {
      await cancelResponseBody(response);
      throw new SourceFailureError('body-limit-exceeded');
    }
  }

  const body = response.body;

  if (body === null) {
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      received += value.byteLength;

      if (received > MAX_BODY_BYTES) {
        await cancelReader(reader);
        throw new SourceFailureError('body-limit-exceeded');
      }

      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by `cancel()`.
    }
  }
};

export interface RetrieveCalendarOptions {
  readonly manifest: CollectionSourceManifest;
  readonly fetch: FetchLike;
}

const followAndRead = async (
  manifest: CollectionSourceManifest,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<string> => {
  let target = new URL(manifest.calendarUrl);

  assertApprovedOrigin(target, manifest.origin);

  // Seeded with the initial URL so a redirect back to the start is caught as a loop.
  const visited = new Set<string>([target.href]);

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    // Manual redirects: the chain has to be counted and each target re-checked against the approved
    // origin, which automatic following would do silently and without either guarantee.
    const response = await fetchImpl(target, {
      redirect: 'manual',
      signal,
      headers: { accept: manifest.acceptedContentTypes.join(', ') },
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      await cancelResponseBody(response);

      if (hop === MAX_REDIRECT_HOPS) {
        throw new SourceFailureError('redirect-limit-exceeded');
      }

      const location = response.headers.get('location');

      if (location === null || location.trim() === '') {
        throw new SourceFailureError('status-rejected');
      }

      let next: URL;

      try {
        next = new URL(location, target);
      } catch {
        throw new SourceFailureError('redirect-off-origin');
      }

      assertApprovedOrigin(next, manifest.origin);

      if (visited.has(next.href)) {
        throw new SourceFailureError('redirect-loop');
      }

      visited.add(next.href);
      target = next;
      continue;
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new SourceFailureError('status-rejected');
    }

    // Rejected before a single byte is read, so the cleanup is this branch's own responsibility.
    if (!isAcceptedContentType(response, manifest)) {
      await cancelResponseBody(response);
      throw new SourceFailureError('content-type-rejected');
    }

    return await readBoundedText(response);
  }

  throw new SourceFailureError('redirect-limit-exceeded');
};

/**
 * A body-limit abort raises its own typed failure before the shared signal is ever consulted, so an
 * oversized response is reported as an invalid source and never mistaken for the deadline.
 */
const toFailure = (error: unknown, signal: AbortSignal): SourceFailureError => {
  if (error instanceof SourceFailureError) {
    return error;
  }

  // Anything else thrown here is a connection failure as far as this boundary can tell: a real network
  // fault is exactly how the built-in `fetch` reports itself. The original error travels as `cause` so a
  // defect in this module stays diagnosable in the server log without reaching a client.
  return new SourceFailureError(signal.aborted ? 'deadline-exceeded' : 'network-error', {
    cause: error,
  });
};

export const retrieveCalendar = async ({
  manifest,
  fetch: fetchImpl,
}: RetrieveCalendarOptions): Promise<string> => {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, RETRIEVAL_DEADLINE_MS);

  try {
    return await followAndRead(manifest, fetchImpl, controller.signal);
  } catch (error) {
    throw toFailure(error, controller.signal);
  } finally {
    clearTimeout(deadline);
  }
};
