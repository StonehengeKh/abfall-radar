import type { HouseholdBinSetup } from '@abfall-radar/domain';
import {
  type HouseholdScheduleResult,
  householdCollectionsIn,
} from '@abfall-radar/schedule-format';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  browserHouseholdSetupStore,
  type HouseholdSetupStore,
  type StoredWeekday,
  setupFor,
} from '@/src/adapters/household-setup-store';
import type { HouseholdRules, ScheduleGateway } from '@/src/adapters/schedule-gateway';

/**
 * The optional household bins: the stored weekday, the municipal rules, and what the two produce.
 *
 * Deliberately outside the schedule controller. The official schedule is a chain of reads whose failures
 * decide what the whole page shows; this is an opt-in extra whose failure must change none of that. So it
 * has its own request, its own state, and its own way of being switched off — and the controller keeps
 * working exactly as it did when nobody has enabled it.
 *
 * The rules are re-read on every visit rather than remembered: they carry a coverage window and a
 * verification state that both age, and a stored copy would let last year's holiday table produce this
 * year's dates.
 */

export type HouseholdState =
  /** Nobody has confirmed a weekday for the selected district. */
  | { readonly status: 'off' }
  | { readonly status: 'loading'; readonly weekday: StoredWeekday }
  | {
      readonly status: 'ready';
      readonly weekday: StoredWeekday;
      readonly rules: HouseholdRules;
      readonly schedule: HouseholdScheduleResult;
    }
  /**
   * The rules could not be read, or this provider has none.
   *
   * The setup is kept: an outage is not a reason to forget what somebody confirmed, and the bins come
   * back by themselves when the source does.
   */
  | {
      readonly status: 'unavailable';
      readonly weekday: StoredWeekday;
      readonly retryable: boolean;
    };

export interface HouseholdSelection {
  readonly providerId: string;
  readonly serviceAreaId: string;
}

export interface UseHouseholdScheduleInput {
  /** The confirmed selection, or `null` while nothing is confirmed. */
  readonly selection: HouseholdSelection | null;
  /** The window the schedule surface is showing, so the calculation covers exactly it. */
  readonly range: { readonly from: string; readonly to: string } | null;
  readonly gateway: ScheduleGateway | null;
  readonly store?: HouseholdSetupStore;
}

export interface UseHouseholdScheduleResult {
  readonly state: HouseholdState;
  /** Confirms a weekday for the current selection and switches the bins on. */
  readonly enable: (weekday: StoredWeekday) => void;
  /** Switches them off and forgets the weekday. */
  readonly disable: () => void;
  readonly retry: () => void;
}

export const useHouseholdSchedule = ({
  selection,
  range,
  gateway,
  store = browserHouseholdSetupStore,
}: UseHouseholdScheduleInput): UseHouseholdScheduleResult => {
  /**
   * The weekday for *this* selection, or `null`.
   *
   * Read through `setupFor`, so a setup stored for another district is not applied here. Held in state
   * as well as storage because switching it on must re-render immediately.
   */
  const [weekday, setWeekday] = useState<StoredWeekday | null>(
    () => setupFor(store.read(), selection)?.weekday ?? null,
  );
  const [rules, setRules] = useState<HouseholdRules | null>(null);
  const [failed, setFailed] = useState<{ readonly retryable: boolean } | null>(null);
  /** Bumped by Retry, which is the only thing that re-reads rules that already failed. */
  const [attempt, setAttempt] = useState(0);
  const storeRef = useRef(store);

  storeRef.current = store;

  // A changed selection re-reads the stored setup: the previous district's weekday must not carry over.
  useEffect(() => {
    setWeekday(setupFor(storeRef.current.read(), selection)?.weekday ?? null);
    setRules(null);
    setFailed(null);
  }, [selection]);

  useEffect(() => {
    if (selection === null || weekday === null || gateway === null) {
      return;
    }

    const controller = new AbortController();

    void gateway.getHouseholdRules(selection.providerId, controller.signal).then((result) => {
      if (controller.signal.aborted) {
        return;
      }

      if (result.ok) {
        setRules(result.data.data);
        setFailed(null);

        return;
      }

      /*
       * A `404` means this provider has no transcribed rules — retrying cannot change that, and offering
       * a Retry that can only fail again is worse than saying so. Everything else is a transport failure
       * the person can reasonably try again.
       */
      setRules(null);
      setFailed({
        retryable: !(result.failure.kind === 'problem' && result.failure.status === 404),
      });
    });

    return () => {
      controller.abort();
    };
  }, [selection, weekday, gateway, attempt]);

  const enable = useCallback(
    (chosen: StoredWeekday) => {
      if (selection === null) {
        return;
      }

      storeRef.current.write({ ...selection, weekday: chosen });
      setWeekday(chosen);
      setFailed(null);
    },
    [selection],
  );

  const disable = useCallback(() => {
    storeRef.current.clear();
    setWeekday(null);
    setRules(null);
    setFailed(null);
  }, []);

  const retry = useCallback(() => {
    setFailed(null);
    setAttempt((current) => current + 1);
  }, []);

  const state = ((): HouseholdState => {
    if (weekday === null || selection === null) {
      return { status: 'off' };
    }

    if (failed !== null) {
      return { status: 'unavailable', weekday, retryable: failed.retryable };
    }

    if (rules === null || range === null) {
      return { status: 'loading', weekday };
    }

    const setup: HouseholdBinSetup = { ...selection, weekday };

    return {
      status: 'ready',
      weekday,
      rules,
      schedule: householdCollectionsIn(rules, setup, range),
    };
  })();

  return { state, enable, disable, retry };
};
