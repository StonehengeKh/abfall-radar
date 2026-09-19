import type { LifecycleSignal, TimerApi, TimerHandle } from '@/src/schedule/lifecycle';

/** An AR-005 product and network trade-off, not an API contract. */
export const RANGE_RECOVERY_INTERVAL_MS = 15 * 60 * 1000;

/**
 * What one recovery cycle concluded:
 * - `uncovered`: still no requestable range, or a transient failure; schedule the next attempt;
 * - `replace`: the final source-date gate saw a changed date; run one immediate replacement cycle;
 * - `finished`: the episode ended — a schedule was accepted or the selection was invalidated.
 */
export type RecoveryOutcome = 'uncovered' | 'replace' | 'finished';

export interface RecoveryCycle {
  readonly signal: AbortSignal;
  /** False once this cycle was superseded or the coordinator was stopped. */
  readonly isCurrent: () => boolean;
}

export interface RangeRecoveryCoordinatorOptions {
  readonly timers: TimerApi;
  readonly isVisible: () => boolean;
  readonly runCycle: (cycle: RecoveryCycle) => Promise<RecoveryOutcome>;
}

/**
 * Asks, for a confirmed selection stuck in `range_not_covered`, whether a requestable range exists yet.
 *
 * It never authorizes rendering a schedule. It schedules the next attempt only after the previous one
 * settles — never `setInterval`, never two attempts in flight — pauses while hidden, and coalesces
 * lifecycle signals into one attempt. A manual retry supersedes a running attempt instead.
 */
export class RangeRecoveryCoordinator {
  #timer: TimerHandle | undefined;
  #controller: AbortController | undefined;
  #token = 0;
  #disposed = false;

  constructor(private readonly options: RangeRecoveryCoordinatorOptions) {}

  get running(): boolean {
    return this.#controller !== undefined;
  }

  get hasPendingTimer(): boolean {
    return this.#timer !== undefined;
  }

  /**
   * With qualifying entry evidence the producing flow's completed reads count as the initial cycle, so
   * only the next deadline is scheduled. Without it, one immediate complete cycle runs.
   */
  start({ reuseEntryRevalidation }: { readonly reuseEntryRevalidation: boolean }): void {
    if (reuseEntryRevalidation) {
      this.#scheduleNext();
    } else {
      this.#trigger(false);
    }
  }

  signal(signal: LifecycleSignal): void {
    if (this.#disposed) {
      return;
    }

    if (signal === 'hidden') {
      this.#cancelTimer();
      return;
    }

    this.#trigger(false);
  }

  retry(): void {
    this.#trigger(true);
  }

  dispose(): void {
    this.#disposed = true;
    this.#token += 1;
    this.#controller?.abort();
    this.#controller = undefined;
    this.#cancelTimer();
  }

  #trigger(supersede: boolean): void {
    if (this.#disposed) {
      return;
    }

    if (this.#controller !== undefined) {
      if (!supersede) {
        // Coalesced into the attempt already in flight.
        return;
      }

      this.#controller.abort();
    }

    this.#cancelTimer();
    this.#token += 1;
    const token = this.#token;
    const controller = new AbortController();
    this.#controller = controller;
    const isCurrent = (): boolean => !this.#disposed && this.#token === token;

    void this.options.runCycle({ signal: controller.signal, isCurrent }).then((outcome) => {
      if (!isCurrent()) {
        return;
      }

      this.#controller = undefined;

      if (outcome === 'replace') {
        this.#trigger(false);
      } else if (outcome === 'uncovered') {
        this.#scheduleNext();
      }
    });
  }

  #scheduleNext(): void {
    this.#cancelTimer();

    if (this.#disposed || !this.options.isVisible()) {
      return;
    }

    this.#timer = this.options.timers.setTimeout(() => {
      this.#timer = undefined;
      this.#trigger(false);
    }, RANGE_RECOVERY_INTERVAL_MS);
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      this.options.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
