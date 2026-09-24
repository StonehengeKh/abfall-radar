import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  HOUSEHOLD_SETUP_STORAGE_KEY,
  type HouseholdSetupStore,
  parseHouseholdSetup,
  type StoredHouseholdSetup,
  setupFor,
} from '@/src/adapters/household-setup-store';
import type { HouseholdRules, ScheduleGateway } from '@/src/adapters/schedule-gateway';
import { useHouseholdSchedule } from './use-household-schedule';

/**
 * The website's household bins: what is remembered, what is read, and what happens when either fails.
 *
 * The calculation itself belongs to `@abfall-radar/schedule-format` and is tested there. What is tested
 * here is the part the web owns — a weekday bound to one district, rules re-read every visit, and an
 * optional extra that fails without taking the official schedule with it.
 */

const SELECTION = { providerId: 'koblenz-servicebetrieb', serviceAreaId: 'koblenz-neuendorf' };

const RULES: HouseholdRules = {
  providerId: 'koblenz-servicebetrieb',
  cityId: 'koblenz',
  coverage: { from: '2026-01-01', to: '2026-12-26' },
  parity: { even: 'bio', odd: 'residual' },
  replacements: [{ nominalDate: '2026-03-30', actualDate: '2026-03-28', reason: 'Karfreitag' }],
  source: {
    name: 'Kommunaler Servicebetrieb',
    attribution: 'Kommunaler Servicebetrieb, Koblenz',
    landingPageUrl: 'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine/',
    replacementsSourceUrl: 'https://servicebetrieb.koblenz.de/downloads/x.jpg',
    parityRuleSourceUrl: 'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine/',
    timeZone: 'Europe/Berlin',
  },
  revision: '2026.1',
  checkedAt: '2026-09-23T08:00:00.000Z',
  announcementsReviewedThrough: '2026-09-23',
  checks: { table: 'verified', parityRule: 'verified', tableLink: 'verified' },
  verification: 'verified',
};

/** A store backed by a plain record, so a test states what was remembered rather than mocking storage. */
const storeWith = (initial: StoredHouseholdSetup | null) => {
  let value = initial;

  return {
    store: {
      read: () => value,
      write: (setup) => {
        value = { version: 1, ...setup };
      },
      clear: () => {
        value = null;
      },
    } satisfies HouseholdSetupStore,
    current: () => value,
  };
};

const gatewayWith = (
  answer: Awaited<ReturnType<ScheduleGateway['getHouseholdRules']>>,
): { gateway: ScheduleGateway; calls: () => number } => {
  let calls = 0;

  return {
    gateway: {
      getHouseholdRules: async () => {
        calls += 1;

        return answer;
      },
    } as unknown as ScheduleGateway,
    calls: () => calls,
  };
};

const ok = { ok: true as const, data: { data: RULES } };

const render = (
  overrides: Partial<Parameters<typeof useHouseholdSchedule>[0]> = {},
  store = storeWith(null).store,
) =>
  renderHook(() =>
    useHouseholdSchedule({
      selection: SELECTION,
      range: { from: '2026-09-21', to: '2026-10-12' },
      gateway: gatewayWith(ok).gateway,
      store,
      ...overrides,
    }),
  );

describe('the stored setup', () => {
  it('is off until somebody confirms a weekday', () => {
    expect(render().result.current.state).toEqual({ status: 'off' });
  });

  it('calculates the confirmed household’s collections once the rules arrive', async () => {
    const { result } = render({}, storeWith({ version: 1, ...SELECTION, weekday: 1 }).store);

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    const state = result.current.state;
    const dates =
      state.status === 'ready'
        ? state.schedule.collections.map((collection) => `${collection.date} ${collection.type}`)
        : [];

    // The household's own confirmed dates: odd weeks grey, even weeks brown.
    expect(dates).toEqual([
      '2026-09-21 residual',
      '2026-09-28 bio',
      '2026-10-05 residual',
      '2026-10-12 bio',
    ]);
  });

  it('remembers a weekday against the district it was confirmed for', () => {
    const backing = storeWith(null);
    const { result } = render({}, backing.store);

    act(() => {
      result.current.enable(4);
    });

    expect(backing.current()).toEqual({ version: 1, ...SELECTION, weekday: 4 });
  });

  it('ignores a setup stored for another district rather than applying it here', () => {
    const elsewhere = storeWith({
      version: 1,
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-stadtmitte',
      weekday: 1,
    });
    const { result } = render({}, elsewhere.store);

    // A weekday is a fact about one address; carrying it would produce confident dates for another route.
    expect(result.current.state).toEqual({ status: 'off' });
  });

  it('forgets the weekday when the bins are switched off', () => {
    const backing = storeWith({ version: 1, ...SELECTION, weekday: 1 });
    const { result } = render({}, backing.store);

    act(() => {
      result.current.disable();
    });

    expect(backing.current()).toBeNull();
    expect(result.current.state).toEqual({ status: 'off' });
  });
});

describe('when the rules cannot be read', () => {
  it('keeps the confirmed weekday and offers a retry', async () => {
    const backing = storeWith({ version: 1, ...SELECTION, weekday: 1 });
    const { result } = render(
      {
        gateway: gatewayWith({
          ok: false,
          failure: { kind: 'network', operation: 'getHouseholdRules' },
        }).gateway,
      },
      backing.store,
    );

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'unavailable', weekday: 1, retryable: true });
    });
    // An outage is not a reason to forget what somebody confirmed.
    expect(backing.current()).not.toBeNull();
  });

  it('offers no retry when this operator simply has no rules', async () => {
    const { result } = render(
      {
        gateway: gatewayWith({
          ok: false,
          failure: {
            kind: 'problem',
            operation: 'getHouseholdRules',
            status: 404,
            code: 'PROVIDER_NOT_FOUND',
            requestId: 'req-1',
          },
        }).gateway,
      },
      storeWith({ version: 1, ...SELECTION, weekday: 1 }).store,
    );

    await waitFor(() => {
      expect(result.current.state).toMatchObject({ status: 'unavailable', retryable: false });
    });
  });

  it('reads the rules again when Retry is pressed', async () => {
    const gateway = gatewayWith({
      ok: false,
      failure: { kind: 'network', operation: 'getHouseholdRules' },
    });
    const { result } = render(
      { gateway: gateway.gateway },
      storeWith({ version: 1, ...SELECTION, weekday: 1 }).store,
    );

    await waitFor(() => {
      expect(result.current.state.status).toBe('unavailable');
    });

    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(gateway.calls()).toBe(2);
    });
  });
});

describe('the stored record', () => {
  it('refuses a record of another version rather than repairing it', () => {
    expect(
      parseHouseholdSetup(JSON.stringify({ version: 2, ...SELECTION, weekday: 1 })),
    ).toBeNull();
  });

  it('refuses a weekday with no district, which would be applied to whichever is selected', () => {
    expect(parseHouseholdSetup(JSON.stringify({ version: 1, weekday: 1 }))).toBeNull();
  });

  it.each([['not json'], [JSON.stringify({ version: 1, ...SELECTION, weekday: 9 })]])(
    'refuses %s',
    (raw) => {
      expect(parseHouseholdSetup(raw)).toBeNull();
    },
  );

  it('matches a setup only against the district it names', () => {
    const stored: StoredHouseholdSetup = { version: 1, ...SELECTION, weekday: 1 };

    expect(setupFor(stored, SELECTION)).toBe(stored);
    expect(setupFor(stored, { ...SELECTION, serviceAreaId: 'koblenz-stadtmitte' })).toBeNull();
    expect(setupFor(stored, null)).toBeNull();
  });

  it('is stored under its own key, never inside the confirmed selection', () => {
    // Separate keys, because one is identity the API validates and the other is a household's own setting.
    expect(HOUSEHOLD_SETUP_STORAGE_KEY).toBe('abfall-radar.household-setup');
  });
});

describe('a changed transcription', () => {
  it('is reported as ready so the surface can explain it, and the page withholds the dates', async () => {
    const changed: HouseholdRules = {
      ...RULES,
      verification: 'changed',
      checks: { ...RULES.checks, table: 'changed' },
    };
    const { result } = render(
      { gateway: gatewayWith({ ok: true, data: { data: changed } }).gateway },
      storeWith({ version: 1, ...SELECTION, weekday: 1 }).store,
    );

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    /*
     * The hook still calculates — the panel needs the rules to say what happened — and the decision to
     * withhold the dates belongs to the surface, which reads `verification`. This asserts the contract
     * the app relies on rather than the app's own branch.
     */
    const state = result.current.state;

    expect(state.status === 'ready' && state.rules.verification).toBe('changed');
  });
});

describe('the gateway', () => {
  it('asks for a provider’s rules and nothing about the household', async () => {
    const asked: string[] = [];
    const gateway = {
      getHouseholdRules: async (providerId: string) => {
        asked.push(providerId);

        return ok;
      },
    } as unknown as ScheduleGateway;

    render({ gateway }, storeWith({ version: 1, ...SELECTION, weekday: 1 }).store);

    await waitFor(() => {
      expect(asked).toEqual(['koblenz-servicebetrieb']);
    });
  });

  it('asks for nothing at all while the bins are off', async () => {
    const gateway = gatewayWith(ok);

    render({ gateway: gateway.gateway });

    await vi.waitFor(() => {
      expect(gateway.calls()).toBe(0);
    });
  });
});
