import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessagingClient, MessagingResult } from '@/src/messaging/client';
import type { GatewayFailure, ServiceAreaSummary } from '@/src/messaging/contract';
import {
  AVAILABLE_AREA,
  CATALOGUE_WITH_DEMO,
  MIXED_AREAS,
  OFFICIAL_PROVIDER,
  OFFICIAL_PROVIDER_ID,
  settingsOperationsRefused,
} from '@/src/test/fixtures';
import {
  type ProviderCatalogueState,
  useCatalogue,
  verificationSignature,
  verifyProvider,
} from './use-catalogue';

/**
 * A stored provider identifier is not evidence that the provider is offered.
 *
 * The verification exists so no provider-specific request is issued for a demo or withdrawn provider, and so
 * an unreachable catalogue is never mistaken for a verdict about one.
 */

const LOADED: ProviderCatalogueState = { kind: 'loaded', providers: CATALOGUE_WITH_DEMO };

const NETWORK_FAILURE: GatewayFailure = { kind: 'network', operation: 'listProviders' };

describe('verifyProvider', () => {
  it('offers a provider the catalogue lists as official', () => {
    expect(verifyProvider(LOADED, OFFICIAL_PROVIDER_ID)).toEqual({
      kind: 'offered',
      provider: OFFICIAL_PROVIDER,
    });
  });

  it('rejects a stored provider the catalogue lists as demo data', () => {
    // Asserted against a catalogue that really contains a demo provider.
    expect(CATALOGUE_WITH_DEMO.some((provider) => provider.sourceKind === 'demo')).toBe(true);
    expect(verifyProvider(LOADED, 'demo')).toEqual({ kind: 'rejected' });
  });

  it('rejects a stored provider the catalogue does not list at all', () => {
    expect(verifyProvider(LOADED, 'gone-away')).toEqual({ kind: 'rejected' });
  });

  it('stays pending while the catalogue is still loading', () => {
    // Not a conclusion, so it may neither invalidate a selection nor destroy a valid cache.
    expect(verifyProvider({ kind: 'loading' }, OFFICIAL_PROVIDER_ID)).toEqual({ kind: 'pending' });
  });

  it('stays pending with no stored provider', () => {
    expect(verifyProvider(LOADED, null)).toEqual({ kind: 'pending' });
  });

  it('reports an unreachable catalogue as a failure rather than concluding about the provider', () => {
    // The load-bearing half of this claim is the second assertion. An unreachable catalogue is *not*
    // evidence that the provider is gone, so it must never reject — but it is not nothing either, and
    // reporting it as pending was what left the schedule waiting on an answer that was never coming.
    const verification = verifyProvider({ kind: 'failed', failure: NETWORK_FAILURE }, 'gone-away');

    expect(verification).toEqual({ kind: 'failed', failure: NETWORK_FAILURE });
    expect(verification.kind).not.toBe('rejected');
  });

  it('treats a successful but empty catalogue as a conclusion', () => {
    // A `loaded` state says the API answered. An empty answer is therefore an answer: this provider is not
    // offered. Only `loading` means "nothing has arrived yet", which is why that state exists separately.
    expect(verifyProvider({ kind: 'loaded', providers: [] }, OFFICIAL_PROVIDER_ID)).toEqual({
      kind: 'rejected',
    });
  });
});

describe('verificationSignature', () => {
  it('is equal for two separately derived verdicts about the same catalogue', () => {
    // The property the schedule effect depends on: deriving the verdict again on the next render must not
    // look like news. Without it, every unrelated state update restarted the whole schedule attempt.
    const first = verifyProvider(LOADED, OFFICIAL_PROVIDER_ID);
    const second = verifyProvider(LOADED, OFFICIAL_PROVIDER_ID);

    expect(first).not.toBe(second);
    expect(verificationSignature(first)).toBe(verificationSignature(second));
  });

  it('differs for every verdict that says something different', () => {
    const signatures = [
      verificationSignature({ kind: 'pending' }),
      verificationSignature({ kind: 'offered', provider: OFFICIAL_PROVIDER }),
      verificationSignature({ kind: 'rejected' }),
      verificationSignature({ kind: 'failed', failure: NETWORK_FAILURE }),
    ];

    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('distinguishes two different failures, so new news still reaches the surface', () => {
    expect(verificationSignature({ kind: 'failed', failure: NETWORK_FAILURE })).not.toBe(
      verificationSignature({
        kind: 'failed',
        failure: { kind: 'timeout', operation: 'listProviders', timeoutMs: 8000 },
      }),
    );
  });

  it('distinguishes a different offered provider', () => {
    expect(verificationSignature({ kind: 'offered', provider: OFFICIAL_PROVIDER })).not.toBe(
      verificationSignature({
        kind: 'offered',
        provider: { ...OFFICIAL_PROVIDER, id: 'somebody-else' },
      }),
    );
  });
});

/**
 * The area request is counted, not merely observed.
 *
 * "It loaded eventually" is compatible with a component that asked four times, and with one that can never
 * ask again after a failure. Both were real defects, so every test here asserts an exact call count.
 */
interface AreaStubOptions {
  /** One entry per call, so a retry can answer differently from the attempt before it. */
  readonly replies?: readonly MessagingResult<ServiceAreaSummary[]>[];
  readonly catalogue?: MessagingResult<typeof CATALOGUE_WITH_DEMO>;
}

const AREA_FAILURE: GatewayFailure = { kind: 'network', operation: 'listServiceAreas' };

const AREAS_FAILED: MessagingResult<ServiceAreaSummary[]> = {
  ok: false,
  failure: AREA_FAILURE,
};

/**
 * The three operations the catalogue hook must never perform.
 *
 * Thrown rather than stubbed silently, so a hook that started reaching for the schedule fails a test
 * instead of quietly widening its responsibilities.
 */
const scheduleOperationsRefused = {
  async listCollectionEvents(): Promise<never> {
    throw new Error('The catalogue hook is not expected to request collection events.');
  },
  async restoreCachedSchedule(): Promise<never> {
    throw new Error('The catalogue hook is not expected to restore a cached schedule.');
  },
  async invalidateCachedSchedule(): Promise<never> {
    throw new Error('The catalogue hook is not expected to invalidate a cached schedule.');
  },
} satisfies Pick<
  MessagingClient,
  'listCollectionEvents' | 'restoreCachedSchedule' | 'invalidateCachedSchedule'
>;

const AREAS_OK: MessagingResult<ServiceAreaSummary[]> = { ok: true, data: MIXED_AREAS };

const createStubClient = ({ replies = [AREAS_OK], catalogue }: AreaStubOptions = {}) => {
  const areaCalls: string[] = [];

  const client: MessagingClient = {
    ...settingsOperationsRefused,
    ...scheduleOperationsRefused,
    async listProviders() {
      return catalogue ?? { ok: true, data: CATALOGUE_WITH_DEMO };
    },
    async listServiceAreas(providerId) {
      areaCalls.push(providerId);

      // The last reply repeats, so "still failing" is expressible without listing a reply per attempt.
      return replies[Math.min(areaCalls.length - 1, replies.length - 1)] ?? AREAS_OK;
    },
  };

  return { client, areaCalls };
};

const renderCatalogue = (options: AreaStubOptions = {}) => {
  const { client, areaCalls } = createStubClient(options);
  const view = renderHook(() => useCatalogue({ client }));

  return { ...view, areaCalls };
};

describe('requesting the areas of a provider', () => {
  it('issues exactly one request and reports the areas', async () => {
    const { result, areaCalls } = renderCatalogue();

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('loaded');
    });

    act(() => {
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.areaState).toMatchObject({ kind: 'loaded', areas: MIXED_AREAS });
    });

    expect(areaCalls).toEqual([OFFICIAL_PROVIDER_ID]);
  });

  it('issues no request for a demo provider and records the refusal', async () => {
    const { result, areaCalls } = renderCatalogue();

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('loaded');
    });

    act(() => {
      result.current.requestAreas('demo');
    });

    // Recorded rather than left idle, so a caller that asked once does not keep asking.
    expect(result.current.areaState).toEqual({ kind: 'not_offered', providerId: 'demo' });
    expect(areaCalls).toEqual([]);
  });

  it('asks again for nobody when the same provider is requested repeatedly', async () => {
    // Both calls happen in one tick, which is the case the committed state cannot see: it is assigned
    // during render, so the second caller used to find a state that still said `idle` and issue a duplicate
    // request. Two surfaces' effects landing in the same commit for the same provider is exactly this.
    const { result, areaCalls } = renderCatalogue();

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('loaded');
    });

    act(() => {
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.areaState.kind).toBe('loaded');
    });

    act(() => {
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    expect(areaCalls).toEqual([OFFICIAL_PROVIDER_ID]);
  });
});

describe('a failed area request', () => {
  const renderFailed = async (options: AreaStubOptions) => {
    const view = renderCatalogue(options);

    await waitFor(() => {
      expect(view.result.current.catalogue.kind).toBe('loaded');
    });

    act(() => {
      view.result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(view.result.current.areaState.kind).toBe('failed');
    });

    return view;
  };

  it('records the failure with the provider it is about', async () => {
    const { result, areaCalls } = await renderFailed({ replies: [AREAS_FAILED] });

    expect(result.current.areaState).toEqual({
      kind: 'failed',
      providerId: OFFICIAL_PROVIDER_ID,
      failure: AREA_FAILURE,
    });
    expect(areaCalls).toHaveLength(1);
  });

  it('is not retried by an ordinary request, so a rerender cannot loop against a failing API', async () => {
    const { result, areaCalls, rerender } = await renderFailed({ replies: [AREAS_FAILED] });

    rerender();
    rerender();

    act(() => {
      // Exactly what a surface's effect does on every render. It must not count as a retry.
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    expect(areaCalls).toHaveLength(1);
    expect(result.current.areaState.kind).toBe('failed');
  });

  it('issues exactly one more request per explicit retry', async () => {
    const { result, areaCalls } = await renderFailed({ replies: [AREAS_FAILED, AREAS_OK] });

    act(() => {
      result.current.retryAreas(OFFICIAL_PROVIDER_ID);
    });

    // The state moves through loading, so the surface can say an attempt is running rather than repeating
    // the error while it is.
    expect(result.current.areaState).toEqual({
      kind: 'loading',
      providerId: OFFICIAL_PROVIDER_ID,
    });

    await waitFor(() => {
      expect(result.current.areaState).toMatchObject({ kind: 'loaded', areas: MIXED_AREAS });
    });

    expect(areaCalls).toEqual([OFFICIAL_PROVIDER_ID, OFFICIAL_PROVIDER_ID]);
  });

  it('stays retryable after retrying and failing again', async () => {
    const { result, areaCalls } = await renderFailed({ replies: [AREAS_FAILED] });

    act(() => {
      result.current.retryAreas(OFFICIAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(areaCalls).toHaveLength(2);
    });
    await waitFor(() => {
      expect(result.current.areaState.kind).toBe('failed');
    });

    act(() => {
      result.current.retryAreas(OFFICIAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(areaCalls).toHaveLength(3);
    });
  });

  it('ignores a retry for a provider the failure is not about', async () => {
    const { result, areaCalls } = await renderFailed({ replies: [AREAS_FAILED] });

    act(() => {
      result.current.retryAreas('somebody-else');
    });

    expect(areaCalls).toHaveLength(1);
  });

  it('ignores a retry when nothing has failed', async () => {
    const { result, areaCalls } = renderCatalogue();

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('loaded');
    });

    act(() => {
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.areaState.kind).toBe('loaded');
    });

    act(() => {
      result.current.retryAreas(OFFICIAL_PROVIDER_ID);
    });

    expect(areaCalls).toHaveLength(1);
  });
});

describe('the provider catalogue itself', () => {
  it('reports a failure as its own state rather than as an empty catalogue', async () => {
    const { result } = renderCatalogue({
      catalogue: { ok: false, failure: NETWORK_FAILURE },
    });

    await waitFor(() => {
      expect(result.current.catalogue).toEqual({ kind: 'failed', failure: NETWORK_FAILURE });
    });

    // An unreachable catalogue offers nothing, but it is distinguishable from one that offered nothing.
    expect(result.current.providers).toEqual([]);
  });

  it('issues no area request while the catalogue has not answered', async () => {
    const { result, areaCalls } = renderCatalogue({
      catalogue: { ok: false, failure: NETWORK_FAILURE },
    });

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('failed');
    });

    act(() => {
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    expect(areaCalls).toEqual([]);
  });

  it('forgets a held area list when a provider stops being usable', async () => {
    const { result } = renderCatalogue();

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('loaded');
    });

    act(() => {
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.areaState.kind).toBe('loaded');
    });

    act(() => {
      result.current.forgetAreas();
    });

    expect(result.current.areaState).toEqual({ kind: 'idle' });
  });

  it('discards a reply for a provider that is no longer the newest', async () => {
    // `runtime.sendMessage` offers the sender no cancellation, so an older provider's areas must be
    // recognized as stale rather than overwriting a newer selection.
    const areaCalls: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const client: MessagingClient = {
      ...settingsOperationsRefused,
      ...scheduleOperationsRefused,
      async listProviders() {
        return { ok: true, data: [...CATALOGUE_WITH_DEMO, { ...OFFICIAL_PROVIDER, id: 'second' }] };
      },
      async listServiceAreas(providerId) {
        areaCalls.push(providerId);

        if (providerId === OFFICIAL_PROVIDER_ID) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }

        return { ok: true, data: [{ ...AVAILABLE_AREA, providerId }] };
      },
    };

    const { result } = renderHook(() => useCatalogue({ client }));

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('loaded');
    });

    act(() => {
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(releaseFirst).toBeDefined();
    });

    act(() => {
      result.current.requestAreas('second');
    });

    await waitFor(() => {
      expect(result.current.areaState).toMatchObject({ kind: 'loaded', providerId: 'second' });
    });

    releaseFirst?.();
    await act(async () => {});

    // The superseded first reply has now arrived and must not have replaced the newer provider's answer.
    expect(result.current.areaState).toMatchObject({ kind: 'loaded', providerId: 'second' });
    expect(areaCalls).toEqual([OFFICIAL_PROVIDER_ID, 'second']);
  });
});

/**
 * A failed catalogue read must be retryable, and the retry must read the catalogue.
 *
 * Before this existed, the only retry a surface could offer was the schedule's `refresh` — which re-runs the
 * schedule with the same unchanged failed verification and asks the catalogue nothing at all. The control
 * appeared to work and the popup stayed exactly as broken.
 */
describe('a failed provider catalogue', () => {
  /** Fails the first read, then answers, so a retry has somewhere to succeed. */
  const createFlakyClient = (replies: readonly MessagingResult<typeof CATALOGUE_WITH_DEMO>[]) => {
    const calls: number[] = [];

    const client: MessagingClient = {
      ...settingsOperationsRefused,
      ...scheduleOperationsRefused,
      async listProviders() {
        calls.push(calls.length);

        return replies[Math.min(calls.length - 1, replies.length - 1)] ?? AREAS_OK_CATALOGUE;
      },
      async listServiceAreas() {
        return { ok: true, data: MIXED_AREAS };
      },
    };

    return { client, catalogueCalls: () => calls.length };
  };

  const AREAS_OK_CATALOGUE: MessagingResult<typeof CATALOGUE_WITH_DEMO> = {
    ok: true,
    data: CATALOGUE_WITH_DEMO,
  };

  const CATALOGUE_FAILED: MessagingResult<typeof CATALOGUE_WITH_DEMO> = {
    ok: false,
    failure: NETWORK_FAILURE,
  };

  const renderFailedCatalogue = async (
    replies: readonly MessagingResult<typeof CATALOGUE_WITH_DEMO>[],
  ) => {
    const { client, catalogueCalls } = createFlakyClient(replies);
    const view = renderHook(() => useCatalogue({ client }));

    await waitFor(() => {
      expect(view.result.current.catalogue.kind).toBe('failed');
    });

    return { ...view, catalogueCalls };
  };

  it('records the failure with the failure that caused it', async () => {
    const { result, catalogueCalls } = await renderFailedCatalogue([CATALOGUE_FAILED]);

    expect(result.current.catalogue).toEqual({ kind: 'failed', failure: NETWORK_FAILURE });
    expect(catalogueCalls()).toBe(1);
  });

  it('issues no second read merely because the hook rerendered', async () => {
    const { rerender, catalogueCalls } = await renderFailedCatalogue([CATALOGUE_FAILED]);

    rerender();
    rerender();
    rerender();

    // The catalogue effect runs once on mount; every later read is something a person asked for.
    expect(catalogueCalls()).toBe(1);
  });

  it('issues exactly one more read per explicit retry, passing through loading', async () => {
    const { result, catalogueCalls } = await renderFailedCatalogue([
      CATALOGUE_FAILED,
      AREAS_OK_CATALOGUE,
    ]);

    act(() => {
      result.current.retryProviders();
    });

    // failed -> loading, so the surface can say an attempt is running rather than repeating the error.
    expect(result.current.catalogue).toEqual({ kind: 'loading' });

    await waitFor(() => {
      expect(result.current.catalogue).toEqual({
        kind: 'loaded',
        providers: CATALOGUE_WITH_DEMO,
      });
    });

    expect(catalogueCalls()).toBe(2);
  });

  it('makes the providers available again after a successful retry', async () => {
    const { result } = await renderFailedCatalogue([CATALOGUE_FAILED, AREAS_OK_CATALOGUE]);

    expect(result.current.providers).toEqual([]);

    act(() => {
      result.current.retryProviders();
    });

    await waitFor(() => {
      expect(result.current.providers).toEqual(CATALOGUE_WITH_DEMO);
    });
  });

  it('lets a stored selection reach its areas after a successful retry', async () => {
    const { result } = await renderFailedCatalogue([CATALOGUE_FAILED, AREAS_OK_CATALOGUE]);

    act(() => {
      result.current.retryProviders();
    });

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('loaded');
    });

    // The gate is open again, so the area request that was refused while the catalogue was unread now proceeds.
    act(() => {
      result.current.requestAreas(OFFICIAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.areaState).toMatchObject({ kind: 'loaded', areas: MIXED_AREAS });
    });
  });

  it('stays retryable after retrying and failing again', async () => {
    const { result, catalogueCalls } = await renderFailedCatalogue([CATALOGUE_FAILED]);

    act(() => {
      result.current.retryProviders();
    });

    await waitFor(() => {
      expect(catalogueCalls()).toBe(2);
    });
    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('failed');
    });

    act(() => {
      result.current.retryProviders();
    });

    await waitFor(() => {
      expect(catalogueCalls()).toBe(3);
    });
  });

  it('ignores a retry while a read is already in flight', async () => {
    const { result, catalogueCalls } = await renderFailedCatalogue([
      CATALOGUE_FAILED,
      AREAS_OK_CATALOGUE,
    ]);

    act(() => {
      result.current.retryProviders();
      // Already loading. A second press must not start a second read.
      result.current.retryProviders();
    });

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('loaded');
    });

    expect(catalogueCalls()).toBe(2);
  });

  it('ignores a retry when the catalogue was read successfully', async () => {
    const { client, catalogueCalls } = createFlakyClient([AREAS_OK_CATALOGUE]);
    const { result } = renderHook(() => useCatalogue({ client }));

    await waitFor(() => {
      expect(result.current.catalogue.kind).toBe('loaded');
    });

    act(() => {
      result.current.retryProviders();
    });

    expect(catalogueCalls()).toBe(1);
  });
});
