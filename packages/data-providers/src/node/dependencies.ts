/**
 * The two runtime capabilities the Node-only provider boundary needs from its host.
 *
 * Both are injected rather than reached for directly, so tests never touch the network and never wait
 * for a real clock. The defaults are the real implementations, so nothing has to be configured in
 * production and there is no test-only switch to leave enabled by accident.
 */

/** Typed against the Node 24 built-in, so no separate HTTP client enters the dependency graph. */
export type FetchLike = typeof globalThis.fetch;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const systemFetch: FetchLike = (...args) => globalThis.fetch(...args);
