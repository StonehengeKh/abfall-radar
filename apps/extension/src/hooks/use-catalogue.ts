import { useCallback, useEffect, useRef, useState } from 'react';
import { createMessagingClient, type MessagingClient } from '@/src/messaging/client';
import {
  failureSignature,
  type GatewayFailure,
  type ProviderSummary,
  type ServiceAreaSummary,
} from '@/src/messaging/contract';

/**
 * The provider catalogue and the areas of one provider.
 *
 * Two things live here rather than in the surfaces that read them, and both for the same reason: they are
 * *states*, and inferring them from the shape of the data was how a request got issued for a provider nobody
 * had confirmed, and how an empty area list turned into an endless request loop.
 *
 * 1. **Whether a provider may be used at all.** A stored selection is schema-valid but its provider is still
 *    just an identifier: it can name a demo provider or one the API no longer offers. Requesting that
 *    provider's areas or events would either put demo data on a surface a person reads as official, or chase
 *    a provider that no longer exists.
 * 2. **How far the area request for one provider has got.** Keyed by provider, so "no areas yet" is
 *    distinguishable from "asked and got none", and a rerender can never start a second request.
 *
 * A provider whose `sourceKind` is `demo` is still reported in `providers` exactly as the API returned it;
 * the selection surfaces filter it out. Keeping the filter at the surface rather than hiding it in transport
 * means the exclusion is visible where it matters and testable against a catalogue that contains one.
 */

/**
 * Whether the stored provider may be used for provider-specific requests.
 *
 * A discriminated union rather than a bare string, because the failed case has to carry the failure. Without
 * it, a `listProviders` failure was indistinguishable from a catalogue that had not answered yet, and the
 * schedule stayed pending forever: the popup would sit on a loading spinner with no way to say the API was
 * unreachable and no way to fall back to the cache with an honest label.
 *
 * `pending` means nothing has been established — the request is in flight, or there is no provider to check.
 * It is deliberately **not** a conclusion, so it can neither invalidate a selection nor destroy an otherwise
 * valid last-known official cache.
 */
export type ProviderVerification =
  | { readonly kind: 'pending' }
  /** A successful catalogue offers this provider and it is not demo data. */
  | { readonly kind: 'offered'; readonly provider: ProviderSummary }
  /** A successful catalogue says this provider is demo data or is no longer offered. Authoritative. */
  | { readonly kind: 'rejected' }
  /** The catalogue could not be read. Not evidence about the provider, but not nothing either. */
  | { readonly kind: 'failed'; readonly failure: GatewayFailure };

/**
 * How far the area request for one provider has got.
 *
 * Every member except `idle` names the provider it is about, so a reply for an older provider is recognizable
 * as stale rather than being read as the current provider's answer, and an empty `loaded` list is a real
 * answer rather than a reason to ask again.
 */
export type AreaCatalogueState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly providerId: string }
  | {
      readonly kind: 'loaded';
      readonly providerId: string;
      readonly areas: readonly ServiceAreaSummary[];
    }
  | { readonly kind: 'failed'; readonly providerId: string; readonly failure: GatewayFailure }
  /**
   * The catalogue does not offer this provider, so **no request was issued**.
   *
   * Recorded rather than left `idle`, so a caller that asked once does not keep asking — and so the refusal
   * is visible instead of looking like a request that never started.
   */
  | { readonly kind: 'not_offered'; readonly providerId: string };

/** The provider an area state is about, or `null` when it is about nobody. */
export const areaStateProviderId = (state: AreaCatalogueState): string | null =>
  state.kind === 'idle' ? null : state.providerId;

/**
 * The areas of exactly this provider, or none.
 *
 * Never a filter over a list that might belong to someone else: the state says whose areas it holds, so an
 * identifier can not be carried across providers by accident.
 */
export const areasOf = (
  state: AreaCatalogueState,
  providerId: string | null,
): readonly ServiceAreaSummary[] =>
  state.kind === 'loaded' && providerId !== null && state.providerId === providerId
    ? state.areas
    : [];

/** Demo data must never appear on a surface a person reads as official. */
export const offerableProviders = (providers: readonly ProviderSummary[]): ProviderSummary[] =>
  providers.filter((provider) => provider.sourceKind !== 'demo');

/** The provider catalogue itself, so "not answered yet" and "could not be read" stay distinguishable. */
export type ProviderCatalogueState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly providers: readonly ProviderSummary[] }
  | { readonly kind: 'failed'; readonly failure: GatewayFailure };

export const verifyProvider = (
  catalogue: ProviderCatalogueState,
  providerId: string | null,
): ProviderVerification => {
  if (providerId === null) {
    return { kind: 'pending' };
  }

  if (catalogue.kind === 'loading') {
    return { kind: 'pending' };
  }

  if (catalogue.kind === 'failed') {
    // The failure travels with the verdict, so the schedule can state that the API is unreachable rather
    // than waiting on an answer that is never coming.
    return { kind: 'failed', failure: catalogue.failure };
  }

  const provider = catalogue.providers.find((candidate) => candidate.id === providerId);

  // A successful catalogue that does not offer it, or offers it as demo data, is a conclusion.
  return provider !== undefined && provider.sourceKind !== 'demo'
    ? { kind: 'offered', provider }
    : { kind: 'rejected' };
};

/**
 * Everything a verification *says*, as one primitive value.
 *
 * `verifyProvider` derives a fresh object on every render, so an effect that depended on the object
 * re-ran whenever anything else in the component changed. That is the defect this exists to close: a
 * schedule state update re-rendered the popup, produced an equal-but-new verdict, and the schedule effect
 * treated it as new work — resetting the phase to pending, superseding the attempt already in flight, and
 * issuing the service-area and collection-events requests a second time.
 *
 * The failure branch carries the failure's own signature rather than being collapsed to `failed`, because
 * a *different* failure genuinely is different news and has to reach the surface. The switch is
 * exhaustive, so a new member cannot be added without deciding what it says here.
 */
export const verificationSignature = (verification: ProviderVerification): string => {
  switch (verification.kind) {
    case 'pending':
      return 'pending';
    case 'offered':
      return `offered:${verification.provider.id}:${verification.provider.sourceKind}`;
    case 'rejected':
      return 'rejected';
    case 'failed':
      return `failed:${failureSignature(verification.failure)}`;
  }
};

export interface UseCatalogueInput {
  readonly client?: MessagingClient;
}

export interface UseCatalogueResult {
  readonly catalogue: ProviderCatalogueState;
  readonly providers: readonly ProviderSummary[];
  readonly areaState: AreaCatalogueState;
  /**
   * Requests the areas of a provider, **once**.
   *
   * Refuses any provider the loaded catalogue does not offer, which is what makes the gate mechanical: every
   * caller — the stored-selection hydration, the settings surface, the onboarding surface — is covered by
   * construction rather than by remembering to check. Asking again for the provider a request is already in
   * flight for, or already answered for, does nothing.
   */
  readonly requestAreas: (providerId: string) => void;
  /**
   * Reads the provider catalogue again after a **failed** attempt.
   *
   * The retry that actually retries the failed resource. A schedule refresh cannot stand in for it: that
   * re-runs the schedule with the same unchanged verification and asks the catalogue nothing.
   */
  readonly retryProviders: () => void;
  /**
   * Requests the areas of a provider again after a **failed** attempt for that same provider.
   *
   * Separate from `requestAreas` on purpose. `requestAreas` has to refuse a provider it already answered
   * for, or a rerender would start a second request — but that refusal also made a failure permanent, so a
   * person whose connection dropped for one moment had no way back other than reopening the popup. This is
   * the deliberate way back: it issues a request only from a failed state for that provider, so a retry is
   * always something a person did and never something a render did.
   */
  readonly retryAreas: (providerId: string) => void;
  /** Drops whatever area list is held. Used when a provider stops being usable. */
  readonly forgetAreas: () => void;
}

export const useCatalogue = ({ client }: UseCatalogueInput = {}): UseCatalogueResult => {
  const [catalogue, setCatalogue] = useState<ProviderCatalogueState>({ kind: 'loading' });
  const [areaState, setAreaState] = useState<AreaCatalogueState>({ kind: 'idle' });

  const messagingRef = useRef(client);

  messagingRef.current = client;

  /** The newest area attempt. A reply carrying anything older is discarded. */
  const latestAreaAttempt = useRef(0);

  /**
   * Read inside `requestAreas` without making it a dependency.
   *
   * `requestAreas` is called from effects in the surfaces above; if its identity changed every time the
   * catalogue did, those effects would re-run for a reason that has nothing to do with what they are
   * watching.
   */
  const catalogueRef = useRef(catalogue);

  catalogueRef.current = catalogue;

  const areaStateRef = useRef(areaState);

  areaStateRef.current = areaState;

  /**
   * The provider the newest area attempt was made for, recorded **as it is made**.
   *
   * Distinct from `areaState` because that only tells the truth one commit later: it is assigned during
   * render, so two calls in the same tick — App's hydration effect and the settings surface's effect both
   * landing in one commit for the same provider — each saw a state that still said `idle` and each issued a
   * request. Recording the attempt synchronously is what makes "once" mean once rather than "once per
   * commit".
   *
   * `null` means no attempt has been made since the last `forgetAreas`.
   */
  const issuedForRef = useRef<string | null>(null);

  /** The newest catalogue attempt. A reply carrying anything older is discarded. */
  const latestCatalogueAttempt = useRef(0);

  /**
   * Whether a catalogue read is in flight, recorded **as it starts**.
   *
   * `catalogue` only tells the truth one commit later: it is assigned during render, so two presses in the same
   * tick both saw a state that still said `failed` and both issued a read. A person double-pressing a retry
   * button is exactly that.
   */
  const catalogueInFlightRef = useRef(false);

  /**
   * The one place a provider-catalogue request is issued.
   *
   * Shared by the mount effect and by `retryProviders`, so both reach the same state transitions — `loading`
   * first, then exactly one of `loaded` or `failed` — and a retry cannot take a different path from the
   * initial read.
   */
  const issueCatalogueRequest = useCallback(() => {
    latestCatalogueAttempt.current += 1;
    catalogueInFlightRef.current = true;

    const thisAttempt = latestCatalogueAttempt.current;
    const messaging = messagingRef.current ?? createMessagingClient();

    setCatalogue({ kind: 'loading' });

    void messaging.listProviders().then((result) => {
      // A reply from a superseded attempt is discarded, so a slow first read cannot overwrite a retry's answer.
      if (latestCatalogueAttempt.current !== thisAttempt) {
        return;
      }

      catalogueInFlightRef.current = false;

      setCatalogue(
        result.ok
          ? { kind: 'loaded', providers: result.data }
          : { kind: 'failed', failure: result.failure },
      );
    });
  }, []);

  useEffect(() => {
    issueCatalogueRequest();

    return () => {
      // Bumping the counter is what supersedes a reply still in flight.
      latestCatalogueAttempt.current += 1;
    };
  }, [issueCatalogueRequest]);

  const forgetAreas = useCallback(() => {
    latestAreaAttempt.current += 1;
    issuedForRef.current = null;
    setAreaState({ kind: 'idle' });
  }, []);

  /**
   * The one place a service-area request is issued.
   *
   * Both entry points share it, so the gate below — no request for a provider a successful catalogue does
   * not offer — is stated once and cannot be bypassed by whichever of them a surface happens to call. What
   * differs between them is only *when* they are allowed to reach this, which is the guard each one owns.
   */
  const issueAreaRequest = useCallback((providerId: string) => {
    const offered = catalogueRef.current;

    // Recorded before anything can await, so a second caller in this same tick is refused.
    issuedForRef.current = providerId;

    if (offered.kind !== 'loaded') {
      // Nothing was established and nothing was asked, so this must not count as an attempt — otherwise the
      // provider would be locked out of ever being requested once the catalogue does answer.
      issuedForRef.current = null;

      // Nothing has confirmed this provider, so nothing is requested. The caller sees `idle` and can ask
      // again once the catalogue answers, which is what the verification-driven effects above do.
      return;
    }

    const provider = offered.providers.find((candidate) => candidate.id === providerId);

    if (provider === undefined || provider.sourceKind === 'demo') {
      // The mechanical half of the gate: no service-area request is issued for a provider the catalogue does
      // not offer, whichever surface asked and whatever it believed.
      latestAreaAttempt.current += 1;
      setAreaState({ kind: 'not_offered', providerId });

      return;
    }

    latestAreaAttempt.current += 1;

    const thisAttempt = latestAreaAttempt.current;
    const messaging = messagingRef.current ?? createMessagingClient();

    setAreaState({ kind: 'loading', providerId });

    void messaging.listServiceAreas(providerId).then((result) => {
      // A reply from a superseded attempt is discarded, so an older provider's areas can never overwrite a
      // newer selection.
      if (latestAreaAttempt.current !== thisAttempt) {
        return;
      }

      setAreaState(
        result.ok
          ? { kind: 'loaded', providerId, areas: result.data }
          : { kind: 'failed', providerId, failure: result.failure },
      );
    });
  }, []);

  const requestAreas = useCallback(
    (providerId: string) => {
      // Already attempted for this provider, whatever came of it. An empty `loaded` list is an answer, not a
      // reason to ask again; an in-flight request is not a reason either; and neither is a failure — a failed
      // attempt is retried deliberately through `retryAreas`, never by a component rendering again.
      if (issuedForRef.current === providerId) {
        return;
      }

      issueAreaRequest(providerId);
    },
    [issueAreaRequest],
  );

  /**
   * Reads the catalogue again after a **failed** attempt.
   *
   * The counterpart of `retryAreas`, and it exists for the same reason plus one more: without it, the only
   * retry a surface could offer when `listProviders` had failed was the schedule's `refresh` — which re-runs
   * the schedule effect with the very same failed verification and asks the catalogue nothing at all. The
   * button appeared to do something and the popup stayed exactly as broken.
   *
   * Guarded on the failed state so a rerender cannot trigger it: the catalogue effect runs once on mount, and
   * every subsequent read is something a person asked for.
   */
  const retryProviders = useCallback(() => {
    // Checked before the committed state, because it is the only one of the two that is true *now*: a second
    // press in the same tick would otherwise still see `failed` and start a second read.
    if (catalogueInFlightRef.current || catalogueRef.current.kind !== 'failed') {
      // In flight, or already answered. Re-reading would be a request nobody asked for.
      return;
    }

    issueCatalogueRequest();
  }, [issueCatalogueRequest]);

  const retryAreas = useCallback(
    (providerId: string) => {
      const current = areaStateRef.current;

      // Only a failed attempt for this same provider is retryable. Anything else is either already
      // answered, already in flight, or about somebody else, and re-requesting it would turn one press into
      // a second request for a question that was not asked.
      if (current.kind !== 'failed' || current.providerId !== providerId) {
        return;
      }

      issueAreaRequest(providerId);
    },
    [issueAreaRequest],
  );

  return {
    catalogue,
    providers: catalogue.kind === 'loaded' ? catalogue.providers : [],
    areaState,
    requestAreas,
    retryProviders,
    retryAreas,
    forgetAreas,
  };
};
