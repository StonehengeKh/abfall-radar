import type { Clock, FetchLike } from '../node/dependencies';

/**
 * A scripted `fetch` and a controllable clock.
 *
 * No test performs network access, and none waits on a real clock. Both seams are ordinary parameters
 * of the code under test, so nothing here has an equivalent in a production code path.
 */

export interface ScriptedHop {
  readonly status?: number;
  readonly location?: string;
  readonly contentType?: string | null;
  readonly body?: string;
  readonly contentLength?: string;
  /** Streamed instead of `body`, to exercise the incremental size limit. */
  readonly chunks?: readonly Uint8Array[];
  /** Simulated latency, driven by fake timers rather than a real wait. */
  readonly delayMs?: number;
  readonly networkError?: boolean;
}

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly calls: () => string[];
  readonly callCount: () => number;
}

const abortable = (ms: number, signal: AbortSignal | null | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const fail = (): void => {
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    if (signal?.aborted === true) {
      fail();

      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        fail();
      },
      { once: true },
    );
  });

const toResponse = (hop: ScriptedHop): Response => {
  const status = hop.status ?? 200;
  const headers = new Headers();

  if (hop.location !== undefined) {
    headers.set('location', hop.location);
  }

  if (hop.contentType !== null) {
    headers.set('content-type', hop.contentType ?? 'text/calendar');
  }

  if (hop.contentLength !== undefined) {
    headers.set('content-length', hop.contentLength);
  }

  if (hop.chunks !== undefined) {
    const remaining = [...hop.chunks];

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = remaining.shift();

        if (next === undefined) {
          controller.close();

          return;
        }

        controller.enqueue(next);
      },
    });

    return new Response(stream, { status, headers });
  }

  // A 204/304 cannot carry a body, and a redirect body is never read anyway.
  const body = status === 204 || status === 304 ? null : (hop.body ?? '');

  return new Response(body, { status, headers });
};

/**
 * Replays `hops` in order, one per call. The last hop repeats if called again, so a redirect loop
 * fixture does not run out of script.
 */
export const createFakeFetch = (hops: readonly ScriptedHop[]): FakeFetch => {
  const calls: string[] = [];

  const fetch: FetchLike = async (input, init) => {
    const url = input instanceof URL ? input.href : String(input);

    calls.push(url);

    const hop = hops[Math.min(calls.length - 1, hops.length - 1)] ?? {};

    if (hop.delayMs !== undefined) {
      await abortable(hop.delayMs, init?.signal);
    }

    if (hop.networkError === true) {
      throw new TypeError('fetch failed');
    }

    return toResponse(hop);
  };

  return {
    fetch,
    calls: () => [...calls],
    callCount: () => calls.length,
  };
};

export interface MutableClock extends Clock {
  advance(milliseconds: number): void;
  set(value: Date): void;
}

export const createMutableClock = (start: Date): MutableClock => {
  let current = start.getTime();

  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current += milliseconds;
    },
    set: (value) => {
      current = value.getTime();
    },
  };
};
