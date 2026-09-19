import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createWebApiClient } from '@/src/adapters/api-client';
import { resolveBrowserOrigin } from '@/src/adapters/browser-origin';
import { browserConfirmedSelectionStore } from '@/src/adapters/confirmed-selection-store';
import { createScheduleGateway, type ScheduleGateway } from '@/src/adapters/schedule-gateway';
import { AppController, type Snapshot } from '@/src/hooks/app-controller';
import { browserClock, browserDocumentLifecycle, browserTimers } from '@/src/schedule/lifecycle';

/**
 * Binds the controller to React.
 *
 * The controller owns every request, token, and timer; the component tree only subscribes. The gateway
 * is resolved once: a browsing context without a usable origin produces `null`, and the controller
 * renders `configuration_error` instead of constructing a client or issuing a request.
 */

export const resolveGateway = (): ScheduleGateway | null => {
  const resolved = resolveBrowserOrigin(globalThis.origin, globalThis.location.origin);

  if (!resolved.ok) {
    return null;
  }

  return createScheduleGateway(createWebApiClient({ origin: resolved.origin }));
};

const createBrowserController = (): AppController =>
  new AppController({
    gateway: resolveGateway(),
    clock: browserClock,
    timers: browserTimers,
    lifecycle: browserDocumentLifecycle(window),
    selectionStore: browserConfirmedSelectionStore(),
  });

/**
 * The controller is created **once per mount** and held in a ref.
 *
 * `useMemo(create, [create])` was wrong: a default factory expression is a new function on every
 * render, so the memo re-ran, built another controller, and its `start()` published state — which
 * rendered again, forever. The factory is therefore read only on the first render, and a later
 * identity change is deliberately ignored.
 *
 * `start()` and `stop()` are paired with the effect rather than with the object's whole existence, so
 * React's Strict Mode setup → cleanup → setup sequence leaves a working controller. `stop()` advances
 * the attempt tokens, so results from the previous lifecycle are discarded rather than revived.
 */
export const useAppController = (
  create: () => AppController = createBrowserController,
): { readonly snapshot: Snapshot; readonly controller: AppController } => {
  const held = useRef<AppController | null>(null);

  if (held.current === null) {
    held.current = create();
  }

  const controller = held.current;

  useEffect(() => {
    controller.start();

    return () => {
      controller.stop();
    };
  }, [controller]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return { snapshot, controller };
};
