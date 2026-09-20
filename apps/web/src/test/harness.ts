import type { ConfirmedSelectionStore } from '@/src/adapters/confirmed-selection-store';
import type {
  ApiFailure,
  ApiResult,
  CityListResponse,
  CollectionEventListResponse,
  ProviderListResponse,
  ScheduleGateway,
  ScheduleRange,
  ServiceAreaListResponse,
} from '@/src/adapters/schedule-gateway';
import {
  AppController,
  type ControllerEnvironment,
  type Snapshot,
} from '@/src/hooks/app-controller';
import type { Clock, DocumentLifecycle, LifecycleSignal, TimerApi } from '@/src/schedule/lifecycle';
import { cities, KOBLENZ_CITY } from '@/src/test/fixtures';

/**
 * Deterministic doubles for the controller tests.
 *
 * Every outcome is scripted, the clock is set rather than waited on, and timers are driven by hand, so
 * no test reaches the network, sleeps, or depends on real scheduling.
 */

export const ok = <Data>(data: Data): ApiResult<Data> => ({ ok: true, data });
export const fail = <Data>(failure: ApiFailure): ApiResult<Data> => ({ ok: false, failure });

export const CANCELLED = (operation: ApiFailure['operation']): ApiFailure => ({
  kind: 'cancelled',
  operation,
});

type CitiesOutcome = ApiResult<CityListResponse>;
type ProvidersOutcome = ApiResult<ProviderListResponse>;
type AreasOutcome = ApiResult<ServiceAreaListResponse>;
type EventsOutcome = ApiResult<CollectionEventListResponse>;

export type GatewayOperation =
  | 'listCities'
  | 'listProviders'
  | 'listServiceAreas'
  | 'listCollectionEvents';

export interface RecordedEventsCall {
  readonly providerId: string;
  readonly serviceAreaId: string;
  readonly range: ScheduleRange;
}

/**
 * A gateway whose every call resolves from a queue. A queue with one entry left keeps returning it, so a
 * test scripts only the outcomes it cares about.
 */
export class FakeGateway implements ScheduleGateway {
  readonly calls: string[] = [];
  readonly eventsCalls: RecordedEventsCall[] = [];
  readonly areasCalls: string[] = [];
  /** Every signal handed to the gateway, in call order, so abort can be asserted directly. */
  readonly signals: Array<{ readonly operation: string; readonly signal: AbortSignal }> = [];
  #ignoreAbort = new Set<string>();
  #cities: CitiesOutcome[] = [];
  #providers: ProvidersOutcome[] = [];
  #areas: AreasOutcome[] = [];
  #events: EventsOutcome[] = [];
  /** Resolvers for calls held open, so a test can interleave work while a request is in flight. */
  #deferred: Array<() => void> = [];
  #deferredOperations = new Set<string>();

  queueCities(...outcomes: CitiesOutcome[]): this {
    this.#cities.push(...outcomes);
    return this;
  }

  queueProviders(...outcomes: ProvidersOutcome[]): this {
    this.#providers.push(...outcomes);
    return this;
  }

  queueAreas(...outcomes: AreasOutcome[]): this {
    this.#areas.push(...outcomes);
    return this;
  }

  queueEvents(...outcomes: EventsOutcome[]): this {
    this.#events.push(...outcomes);
    return this;
  }

  /** Holds the next call to `operation` open until `release()`, naming it so no other call is caught. */
  defer(operation: GatewayOperation): this {
    this.#deferredOperations.add(operation);
    return this;
  }

  /**
   * Delivers the scripted outcome for `operations` even after their signal aborted.
   *
   * Turning an aborted call into `cancelled` is what a real client does, but a test that relies on it
   * proves the *gateway* discarded the answer, not the controller. These operations answer with a real
   * success instead, so only the controller's own ownership checks can keep it off the screen.
   */
  ignoreAbort(
    ...operations: Array<'listProviders' | 'listServiceAreas' | 'listCollectionEvents'>
  ): this {
    for (const operation of operations) {
      this.#ignoreAbort.add(operation);
    }

    return this;
  }

  signalsOf(
    operation: 'listProviders' | 'listServiceAreas' | 'listCollectionEvents',
  ): AbortSignal[] {
    return this.signals
      .filter((entry) => entry.operation === operation)
      .map((entry) => entry.signal);
  }

  /** Replaces a queue outright, so the next call answers with these outcomes rather than the old tail. */
  replaceCities(...outcomes: CitiesOutcome[]): this {
    this.#cities = [...outcomes];
    return this;
  }

  replaceProviders(...outcomes: ProvidersOutcome[]): this {
    this.#providers = [...outcomes];
    return this;
  }

  replaceAreas(...outcomes: AreasOutcome[]): this {
    this.#areas = [...outcomes];
    return this;
  }

  replaceEvents(...outcomes: EventsOutcome[]): this {
    this.#events = [...outcomes];
    return this;
  }

  release(): void {
    const pending = [...this.#deferred];
    this.#deferred = [];

    for (const resolve of pending) {
      resolve();
    }
  }

  /** Releases the most recently held call, so replies can be made to resolve out of order. */
  releaseNewest(): void {
    this.#deferred.pop()?.();
  }

  /** Releases the longest-held call. */
  releaseOldest(): void {
    this.#deferred.shift()?.();
  }

  get pendingCount(): number {
    return this.#deferred.length;
  }

  countOf(operation: GatewayOperation): number {
    return this.calls.filter((call) => call === operation).length;
  }

  async #answer<Outcome>(
    queue: Outcome[],
    operation: string,
    signal: AbortSignal,
  ): Promise<Outcome> {
    this.calls.push(operation);
    this.signals.push({ operation, signal });
    const scripted = queue.length > 1 ? (queue.shift() as Outcome) : (queue[0] as Outcome);
    /*
     * The city catalogue answers with the single officially supported city unless a test scripts it.
     * Every flow starts there, so requiring each test to restate it would bury the behaviour actually
     * under test; a test that cares about the city read queues its own outcomes as usual.
     */
    const outcome =
      scripted ??
      (operation === 'listCities' ? (ok(cities(KOBLENZ_CITY)) as Outcome) : (undefined as never));

    if (outcome === undefined) {
      throw new Error(`No scripted outcome for ${operation}`);
    }

    if (this.#deferredOperations.has(operation)) {
      this.#deferredOperations.delete(operation);
      await new Promise<void>((resolve) => {
        this.#deferred.push(resolve);
      });
    }

    // A caller that aborted before the outcome arrives sees a cancellation, as the real client reports —
    // unless the test asked for the raw success, to exercise the controller's own ownership checks.
    if (signal.aborted && !this.#ignoreAbort.has(operation)) {
      return { ok: false, failure: { kind: 'cancelled', operation } } as Outcome;
    }

    return outcome;
  }

  listCities(signal: AbortSignal): Promise<CitiesOutcome> {
    return this.#answer(this.#cities, 'listCities', signal);
  }

  listProviders(signal: AbortSignal): Promise<ProvidersOutcome> {
    return this.#answer(this.#providers, 'listProviders', signal);
  }

  listServiceAreas(providerId: string, signal: AbortSignal): Promise<AreasOutcome> {
    this.areasCalls.push(providerId);
    return this.#answer(this.#areas, 'listServiceAreas', signal);
  }

  listCollectionEvents(query: RecordedEventsCall, signal: AbortSignal): Promise<EventsOutcome> {
    this.eventsCalls.push(query);
    return this.#answer(this.#events, 'listCollectionEvents', signal);
  }
}

export class FakeClock implements Clock {
  #instant: Date;
  /** How often the clock was read, so a coalesced wake burst can be counted rather than assumed. */
  reads = 0;

  constructor(iso: string) {
    this.#instant = new Date(iso);
  }

  now = (): Date => {
    this.reads += 1;

    return this.#instant;
  };

  set(iso: string): void {
    this.#instant = new Date(iso);
  }

  advanceHours(hours: number): void {
    this.#instant = new Date(this.#instant.getTime() + hours * 60 * 60 * 1000);
  }
}

interface ScheduledTimer {
  readonly id: number;
  readonly callback: () => void;
  readonly delay: number;
}

/** Timers driven by hand: nothing waits, and a test can assert exactly how many are pending. */
export class FakeTimers implements TimerApi {
  #next = 1;
  #pending = new Map<number, ScheduledTimer>();

  setTimeout = (callback: () => void, delay: number): unknown => {
    const id = this.#next;
    this.#next += 1;
    this.#pending.set(id, { id, callback, delay });

    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.#pending.delete(handle as number);
  };

  get pending(): ScheduledTimer[] {
    return [...this.#pending.values()];
  }

  countWithDelay(delay: number): number {
    return this.pending.filter((timer) => timer.delay === delay).length;
  }

  /** Fires every timer scheduled with `delay`, in insertion order. */
  fire(delay: number): void {
    for (const timer of this.pending.filter((candidate) => candidate.delay === delay)) {
      this.#pending.delete(timer.id);
      timer.callback();
    }
  }
}

export class FakeLifecycle implements DocumentLifecycle {
  #visible = true;
  #listeners = new Set<(signal: LifecycleSignal) => void>();
  unsubscribeCount = 0;

  isVisible = (): boolean => this.#visible;

  subscribe = (listener: (signal: LifecycleSignal) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.unsubscribeCount += 1;
      this.#listeners.delete(listener);
    };
  };

  get listenerCount(): number {
    return this.#listeners.size;
  }

  emit(signal: LifecycleSignal): void {
    if (signal === 'hidden') {
      this.#visible = false;
    }

    if (signal === 'visible' || signal === 'pageshow' || signal === 'focus') {
      this.#visible = true;
    }

    for (const listener of [...this.#listeners]) {
      listener(signal);
    }
  }

  hide(): void {
    this.emit('hidden');
  }

  show(): void {
    this.emit('visible');
  }
}

export interface Harness {
  readonly controller: AppController;
  readonly gateway: FakeGateway;
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  readonly lifecycle: FakeLifecycle;
  readonly snapshot: () => Snapshot;
  readonly view: () => Snapshot['view'];
  /** Lets every already-resolved promise settle. */
  readonly flush: () => Promise<void>;
}

export const createHarness = (
  options: {
    readonly gateway?: FakeGateway | null;
    readonly clock?: FakeClock;
    readonly timers?: FakeTimers;
    readonly lifecycle?: FakeLifecycle;
    readonly selectionStore?: ConfirmedSelectionStore;
  } = {},
): Harness => {
  const gateway = options.gateway === undefined ? new FakeGateway() : options.gateway;
  const clock = options.clock ?? new FakeClock('2026-08-02T10:30:00Z');
  const timers = options.timers ?? new FakeTimers();
  const lifecycle = options.lifecycle ?? new FakeLifecycle();
  const environment: ControllerEnvironment = {
    gateway,
    clock,
    timers,
    lifecycle,
    ...(options.selectionStore === undefined ? {} : { selectionStore: options.selectionStore }),
  };
  const controller = new AppController(environment);

  return {
    controller,
    gateway: gateway ?? new FakeGateway(),
    clock,
    timers,
    lifecycle,
    snapshot: () => controller.getSnapshot(),
    view: () => controller.getSnapshot().view,
    flush: async () => {
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    },
  };
};
