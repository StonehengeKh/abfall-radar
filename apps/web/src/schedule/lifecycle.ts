/** Injected so every lifecycle test runs on fake timers and a fake document, with no real waiting. */

export type TimerHandle = unknown;

export interface TimerApi {
  readonly setTimeout: (callback: () => void, milliseconds: number) => TimerHandle;
  readonly clearTimeout: (handle: TimerHandle) => void;
}

export type LifecycleSignal = 'visible' | 'hidden' | 'pageshow' | 'focus';

export interface DocumentLifecycle {
  readonly isVisible: () => boolean;
  /** Returns the function that removes every listener it added. */
  readonly subscribe: (listener: (signal: LifecycleSignal) => void) => () => void;
}

export interface Clock {
  readonly now: () => Date;
}

export const browserTimers: TimerApi = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const browserClock: Clock = { now: () => new Date() };

export const browserDocumentLifecycle = (target: Window): DocumentLifecycle => ({
  isVisible: () => target.document.visibilityState === 'visible',
  subscribe: (listener) => {
    const onVisibility = (): void =>
      listener(target.document.visibilityState === 'visible' ? 'visible' : 'hidden');
    const onPageShow = (): void => listener('pageshow');
    const onFocus = (): void => listener('focus');

    target.document.addEventListener('visibilitychange', onVisibility);
    target.addEventListener('pageshow', onPageShow);
    target.addEventListener('focus', onFocus);

    return () => {
      target.document.removeEventListener('visibilitychange', onVisibility);
      target.removeEventListener('pageshow', onPageShow);
      target.removeEventListener('focus', onFocus);
    };
  },
});
