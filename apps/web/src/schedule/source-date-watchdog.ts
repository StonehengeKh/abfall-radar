import { deriveSourceToday, type IsoDate } from '@abfall-radar/schedule-format';
import type { Clock, LifecycleSignal, TimerApi, TimerHandle } from '@/src/schedule/lifecycle';

/** How often a source-date check is **requested**. Delivery timing belongs to the browser. */
export const SOURCE_DATE_WATCH_INTERVAL_MS = 1000;

export interface SourceDateWatchdogOptions {
  readonly timers: TimerApi;
  readonly clock: Clock;
  readonly isVisible: () => boolean;
  /** The accepted schedule's source zone and checked date. A provisional capability never owns one. */
  readonly timeZone: string;
  readonly sourceToday: IsoDate;
  /** The derived date differs, in either direction. The watchdog has already stopped itself. */
  readonly onChanged: () => void;
  /** `deriveSourceToday` failed. The watchdog has already stopped itself. */
  readonly onDerivationFailed: () => void;
}

/**
 * Observes the source date for one accepted schedule/capability pair. It never predicts a transition:
 * `formattedDate !== sourceToday` is not monotonic — `America/Creston` repeated a date in 1944 — so
 * there is no boundary to search for, only the current date to derive.
 *
 * A same-date check changes nothing and ensures exactly one pending timeout while visible. A disposed
 * watchdog arms nothing, which is what keeps a stale owner from rearming after it was replaced.
 */
export class SourceDateWatchdog {
  #timer: TimerHandle | undefined;
  #disposed = false;
  /** True while a wake burst is already waiting to be checked once. */
  #coalescing = false;

  constructor(private readonly options: SourceDateWatchdogOptions) {}

  start(): void {
    this.#ensureTimer();
  }

  get hasPendingTimer(): boolean {
    return this.#timer !== undefined;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  signal(signal: LifecycleSignal): void {
    if (this.#disposed) {
      return;
    }

    if (signal === 'hidden') {
      this.#cancelTimer();
      return;
    }

    this.#coalesceCheck();
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancelTimer();
  }

  /**
   * One wake burst, one check.
   *
   * Returning to a page delivers `visible`, `pageshow`, and `focus` in the same task. Checking on each
   * read the clock and derived the date three times for one return. They are collapsed into a single
   * microtask, which still runs before anything can await a result, so the ownership check, the change
   * detection, and the single rearmed timer are unchanged — only the repetition is gone. A `hidden`
   * signal within the same burst cancels the timer, and the pending check then rearms nothing because
   * the document is no longer visible.
   */
  #coalesceCheck(): void {
    if (this.#coalescing) {
      return;
    }

    this.#coalescing = true;
    queueMicrotask(() => {
      this.#coalescing = false;
      this.#check();
    });
  }

  #check(): void {
    // Ownership first: a replaced or stopped watchdog neither derives nor arms.
    if (this.#disposed) {
      return;
    }

    const derived = deriveSourceToday(this.options.timeZone, this.options.clock.now());

    if (!derived.ok) {
      this.dispose();
      this.options.onDerivationFailed();
      return;
    }

    if (derived.date !== this.options.sourceToday) {
      this.dispose();
      this.options.onChanged();
      return;
    }

    this.#ensureTimer();
  }

  #ensureTimer(): void {
    if (this.#disposed || this.#timer !== undefined || !this.options.isVisible()) {
      return;
    }

    this.#timer = this.options.timers.setTimeout(() => {
      this.#timer = undefined;
      this.#check();
    }, SOURCE_DATE_WATCH_INTERVAL_MS);
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      this.options.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
