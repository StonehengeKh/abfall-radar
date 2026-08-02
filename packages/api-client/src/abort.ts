/**
 * Links a caller's `AbortSignal` to a deadline of this client's own.
 *
 * Written from `AbortController`, `setTimeout`, and one event listener rather than from
 * `AbortSignal.timeout` or `AbortSignal.any`, so there is no runtime feature check and the behavior is
 * identical in the service worker and in tests driven by fake timers.
 *
 * The reason the two are tracked separately is that they mean different things to a person: a timeout is
 * a stall worth reporting, and a cancellation is work the user themselves superseded. Collapsing them
 * would either show an error for a superseded request or hide a real stall.
 */

export interface Deadline {
  readonly signal: AbortSignal;
  /** True only when this deadline aborted the request, so a caller cancellation stays distinguishable. */
  readonly hasExpired: () => boolean;
  /** Clears the timer and detaches the listener. Always call it once the request has settled. */
  readonly dispose: () => void;
}

export const startDeadline = (timeoutMs: number, callerSignal?: AbortSignal): Deadline => {
  const controller = new AbortController();
  let expired = false;

  const timer = setTimeout(() => {
    // Already aborted means the caller got there first, so this deadline did not decide the outcome and
    // must not claim it did.
    if (controller.signal.aborted) {
      return;
    }

    expired = true;
    controller.abort();
  }, timeoutMs);

  const abortFromCaller = (): void => {
    controller.abort();
  };

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    }
  }

  return {
    signal: controller.signal,
    hasExpired: () => expired,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
};
