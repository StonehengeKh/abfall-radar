import type { HouseholdBinSetup } from '@abfall-radar/domain';
import {
  type HouseholdScheduleResult,
  householdCollectionsIn,
} from '@abfall-radar/schedule-format';
import { useEffect, useState } from 'react';
import { createMessagingClient, type MessagingClient } from '@/src/messaging/client';
import type { HouseholdRulesSummary } from '@/src/messaging/contract';
import type { HouseholdSetup, ServiceAreaSelection } from '@/src/storage/settings';

/**
 * The optional household bins in the popup: the stored weekday, the municipal rules, and what they make.
 *
 * The weekday is already in this extension's settings — the worker owns that write — so this hook only
 * reads the rules and calculates. Deliberately separate from `useSchedule`: the official schedule is what
 * the popup is *for*, and an optional extra whose source is unreachable must not change any of its
 * states.
 *
 * The rules are never cached here. They carry a coverage window and a verification state that both age,
 * and the worker already coalesces identical reads, so a fresh answer per popup opening is both correct
 * and cheap.
 */

export type HouseholdState =
  /** No weekday is confirmed for the selected district, so nothing is calculated. */
  | { readonly status: 'off' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly rules: HouseholdRulesSummary;
      readonly schedule: HouseholdScheduleResult;
    }
  /**
   * The rules could not be read, or this provider has none.
   *
   * The stored weekday is untouched: an outage is not a reason to forget what somebody confirmed, and
   * the bins return by themselves when the source does.
   */
  | { readonly status: 'unavailable'; readonly retryable: boolean };

export interface UseHouseholdInput {
  /** The stored setup, or `null` when the bins are off. */
  readonly household: HouseholdSetup | null;
  /** The confirmed selection, so a setup stored for another district is never applied here. */
  readonly selection: ServiceAreaSelection | null;
  /** The window the dashboard is showing, so the calculation covers exactly it. */
  readonly range: { readonly from: string; readonly to: string } | null;
  readonly client?: MessagingClient;
}

/**
 * The setup, but only when it belongs to the district currently selected.
 *
 * A weekday is a fact about one address on one operator's route. Applying it to another district would
 * produce dates that look exactly as confident as the right ones, so a mismatch reads as "off" and the
 * person is asked to confirm a weekday for the new district.
 */
export const setupAppliesTo = (
  household: HouseholdSetup | null,
  selection: ServiceAreaSelection | null,
): HouseholdSetup | null =>
  household !== null &&
  selection !== null &&
  household.providerId === selection.providerId &&
  household.serviceAreaId === selection.serviceAreaId
    ? household
    : null;

export const useHousehold = ({
  household,
  selection,
  range,
  client,
}: UseHouseholdInput): HouseholdState => {
  const setup = setupAppliesTo(household, selection);
  const [rules, setRules] = useState<HouseholdRulesSummary | null>(null);
  const [failed, setFailed] = useState<{ readonly retryable: boolean } | null>(null);
  const providerId = setup?.providerId ?? null;

  useEffect(() => {
    if (providerId === null) {
      // Switched off, or the setup belongs to another district: nothing to read and nothing to keep.
      setRules(null);
      setFailed(null);

      return;
    }

    let superseded = false;
    const messaging = client ?? createMessagingClient();

    void messaging.getHouseholdRules(providerId).then((result) => {
      if (superseded) {
        return;
      }

      if (result.ok) {
        setRules(result.data);
        setFailed(null);

        return;
      }

      /*
       * A `404` means this provider has no transcribed rules, which retrying cannot change. Everything
       * else is a transport failure that a later opening may well get past.
       */
      setRules(null);
      setFailed({
        retryable: !(result.failure.kind === 'problem' && result.failure.status === 404),
      });
    });

    return () => {
      superseded = true;
    };
  }, [providerId, client]);

  if (setup === null) {
    return { status: 'off' };
  }

  if (failed !== null) {
    return { status: 'unavailable', retryable: failed.retryable };
  }

  if (rules === null || range === null) {
    return { status: 'loading' };
  }

  const binSetup: HouseholdBinSetup = {
    providerId: setup.providerId,
    serviceAreaId: setup.serviceAreaId,
    weekday: setup.weekday,
  };

  return { status: 'ready', rules, schedule: householdCollectionsIn(rules, binSetup, range) };
};

/**
 * Whether calculated collections may be shown at all.
 *
 * `changed` is the one verification state that means "these would be plausible and wrong": the operator
 * has published something other than what was transcribed, so the dates are withheld everywhere — the
 * dashboard, the list and the reminder — and the surface says why instead.
 */
export const calculatedToShow = (state: HouseholdState): HouseholdScheduleResult | null =>
  state.status === 'ready' && state.rules.verification !== 'changed' ? state.schedule : null;
