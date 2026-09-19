import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIRMED_SELECTION_STORAGE_KEY,
  CONFIRMED_SELECTION_VERSION,
} from '@/src/adapters/confirmed-selection-store';
import { App } from '@/src/app/app';
import { MESSAGES } from '@/src/i18n/messages';
import {
  AREA_ID,
  area,
  areas,
  cities,
  curbside,
  DEMO_PROVIDER,
  events,
  KOBLENZ_CITY,
  OFFICIAL_PROVIDER,
  PROVIDER_ID,
  providers,
  SECOND_PROVIDER,
  SECOND_PROVIDER_ID,
  TWO_PROVIDER_CITY,
} from '@/src/test/fixtures';

/** The default locale: every assertion below is written in the language the app starts in. */
const DE = MESSAGES.de;

/**
 * The real composition, exercised end to end.
 *
 * Nothing here is substituted except `fetch`: `App` mounts `useAppController`, which resolves the
 * browsing origin, builds the real web API client through `withNoStore`, and wraps it in the real
 * schedule gateway. That is the boundary these cases are about — the component tests drive a controller
 * the test constructs, so they cannot show that the wiring in between works, and the render loop and the
 * Strict Mode restart both lived exactly there.
 *
 * Every response is scripted from the recorded request, so the assertions describe what the product
 * asked for rather than what a fixture assumed.
 */

interface RecordedRequest {
  readonly url: URL;
  readonly init: RequestInit | undefined;
}

const recorded: RecordedRequest[] = [];
let respond: (request: RecordedRequest) => Promise<Response>;

const CITIES_PATH = '/api/v1/cities';
const PROVIDERS_PATH = '/api/v1/providers';
const AREAS_PATH = `/api/v1/providers/${PROVIDER_ID}/service-areas`;
const EVENTS_PATH = `/api/v1/providers/${PROVIDER_ID}/service-areas/${AREA_ID}/collection-events`;

const CATALOGUE = providers(OFFICIAL_PROVIDER, SECOND_PROVIDER);
const AREAS = areas(area());
/** The single officially supported city, served by one official provider. */
const CITIES = cities(KOBLENZ_CITY);

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const problem = (status: number, body: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({
      type: 'https://abfall-radar.example.test/problems/generic',
      title: 'Failure',
      status,
      detail: 'urn:abfall-radar:internal-diagnostic',
      instance: '/api/v1/providers',
      ...body,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

/** Echoes the requested window, so the response answers the request the product actually made. */
const eventsFor = (url: URL): Response => {
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';

  return json(events([curbside({ id: `paper-${from}`, date: from })], { range: { from, to } }));
};

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

/** A promise a test settles by hand, so two completions can be ordered against each other. */
const gate = (): { readonly promise: Promise<void>; readonly open: () => void } => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
};

/**
 * Routes by the read the product is performing, with a queue per read.
 *
 * A queue with one entry left keeps answering with it, so a test scripts only the turns it cares
 * about. Matching is on the request the product actually built, which is why the second provider's
 * areas resolve here too.
 */
const routed = (routes: {
  readonly cities?: readonly Handler[];
  readonly providers?: readonly Handler[];
  readonly areas?: readonly Handler[];
  readonly events?: readonly Handler[];
}): ((request: RecordedRequest) => Promise<Response>) => {
  const queues = {
    cities: [...(routes.cities ?? [() => json(CITIES)])],
    providers: [...(routes.providers ?? [])],
    areas: [...(routes.areas ?? [])],
    events: [...(routes.events ?? [])],
  };

  return async (request) => {
    const { pathname } = request.url;
    const key =
      pathname === CITIES_PATH
        ? 'cities'
        : pathname === PROVIDERS_PATH
          ? 'providers'
          : pathname.endsWith('/service-areas')
            ? 'areas'
            : pathname.endsWith('/collection-events')
              ? 'events'
              : undefined;
    const queue = key === undefined ? [] : queues[key];
    const handler = queue.length > 1 ? queue.shift() : queue[0];

    if (handler === undefined) {
      throw new Error(`unscripted ${pathname}`);
    }

    return handler(request);
  };
};

const catalogueOnly = async (request: RecordedRequest): Promise<Response> => {
  if (request.url.pathname === CITIES_PATH) {
    return json(CITIES);
  }

  return request.url.pathname === PROVIDERS_PATH
    ? json(CATALOGUE)
    : Promise.reject(new Error(`unscripted ${request.url.pathname}`));
};

const wholeFlow = async (request: RecordedRequest): Promise<Response> => {
  switch (request.url.pathname) {
    case CITIES_PATH:
      return json(CITIES);
    case PROVIDERS_PATH:
      return json(CATALOGUE);
    case AREAS_PATH:
      return json(AREAS);
    case EVENTS_PATH:
      return eventsFor(request.url);
    default:
      return Promise.reject(new Error(`unscripted ${request.url.pathname}`));
  }
};

const pathsOf = (): string[] => recorded.map((request) => request.url.pathname);

/**
 * A fixed instant inside the fixture capability's validity window (`2026-01-01`…`2026-12-31`).
 *
 * The real `App` reads `browserClock.now()`, so an unpinned suite asserted a schedule that the product
 * would correctly refuse to request once the calendar year moved past that window: the same unchanged
 * file failed when run with a 2027 system date. Only `Date` is faked, so `setTimeout`, microtasks, and
 * the testing-library waits the real composition depends on keep running normally.
 */
const IN_RANGE_INSTANT = new Date('2026-06-15T09:00:00Z');
/** Past the fixture capability, where refusing to request events is the documented behaviour. */
const OUT_OF_RANGE_INSTANT = new Date('2027-01-02T12:00:00Z');

const freezeClock = (instant: Date): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(instant);
};

beforeEach(() => {
  freezeClock(IN_RANGE_INSTANT);
  /*
   * A fresh browser for every case. These mount the real composition root, which remembers a confirmed
   * selection in `localStorage`; without this, a case that confirms one would restore it in the next
   * and the reads under test would be a second visit's.
   */
  window.localStorage.clear();
  recorded.length = 0;
  respond = (request) => Promise.reject(new Error(`unscripted ${request.url.pathname}`));

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: new URL(String(input)), init };

    recorded.push(request);

    return respond(request);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the mounted application', () => {
  it('mounts under root Strict Mode with an unresolved request and renders the loading state once', async () => {
    respond = () => new Promise<Response>(() => undefined);

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // A controller rebuilt on every render published state that rendered again: the loop exceeded
    // React's update depth before any response existed. A bounded request count is the observable proof.
    await waitFor(() => {
      expect(recorded.length).toBeGreaterThan(0);
    });
    expect(recorded.length).toBeLessThanOrEqual(2);
    expect(pathsOf().every((path) => path === CITIES_PATH)).toBe(true);
    expect(screen.getByTestId('live-region').textContent).toBe(
      DE.states.needs_selection.announcement,
    );
  });

  it('uses the result of the Strict Mode restart instead of discarding it', async () => {
    respond = catalogueOnly;

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // The second setup must own a live controller: a disposed one fetched the catalogue and dropped it,
    // leaving the catalogue loading forever.
    expect(await screen.findByRole('button', { name: KOBLENZ_CITY.name })).toBeInTheDocument();
  });

  it('reads providers, areas, and events through the real client, each bypassing the HTTP cache', async () => {
    respond = wholeFlow;

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await userEvent.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));

    expect(await screen.findByRole('heading', { name: DE.states.live.heading })).toBeVisible();

    // Selection reads first, then the authoritative pipeline re-reads both before asking for events.
    expect(pathsOf()).toEqual([
      CITIES_PATH,
      PROVIDERS_PATH,
      AREAS_PATH,
      PROVIDERS_PATH,
      AREAS_PATH,
      EVENTS_PATH,
    ]);

    for (const request of recorded) {
      expect(request.init?.cache).toBe('no-store');
      expect(new Headers(request.init?.headers).get('accept')).toBe(
        'application/json, application/problem+json',
      );
    }

    // The window came from the product's own clock and clamping, not from the response.
    const eventsRequest = recorded.at(-1);

    expect(eventsRequest?.url.searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(eventsRequest?.url.searchParams.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('aborts its request on unmount and publishes nothing from a late success', async () => {
    let settle: (response: Response) => void = () => undefined;

    respond = () =>
      new Promise<Response>((resolve) => {
        settle = resolve;
      });

    const view = render(<App />);

    await waitFor(() => {
      expect(recorded.length).toBeGreaterThan(0);
    });

    const signal = recorded[0]?.init?.signal;

    expect(signal?.aborted).toBe(false);
    view.unmount();

    // The cleanup aborts the in-flight read rather than leaving it to finish unobserved.
    expect(signal?.aborted).toBe(true);

    const requestsBefore = recorded.length;

    // A success delivered anyway must publish nothing and start nothing: an empty body after unmount
    // would be true either way, so the request count and the absence of a re-render are what count.
    await act(async () => {
      settle(json(CATALOGUE));
      await Promise.resolve();
    });

    expect(recorded.length).toBe(requestsBefore);
    expect(screen.queryByRole('button', { name: OFFICIAL_PROVIDER.name })).not.toBeInTheDocument();
    expect(document.body.textContent).toBe('');
  });
});

describe('a confirmed selection across a reload', () => {
  /** A reload is a fresh composition over the same browser storage: unmount, then mount again. */
  it('restores the schedule without the selection flow, and re-reads it from the API', async () => {
    respond = wholeFlow;

    const first = render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await userEvent.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));

    expect(await screen.findByRole('heading', { name: DE.states.live.heading })).toBeVisible();

    first.unmount();
    recorded.length = 0;

    render(<App />);

    // No city and no district was chosen again: the schedule comes back on its own.
    expect(await screen.findByRole('heading', { name: DE.states.live.heading })).toBeVisible();
    expect(screen.getByTestId('header-place').textContent).toContain('Stadtmitte');
    // The same reads a confirmation makes, and the schedule itself is fetched afresh rather than stored.
    expect(pathsOf()).toEqual([
      CITIES_PATH,
      PROVIDERS_PATH,
      AREAS_PATH,
      PROVIDERS_PATH,
      AREAS_PATH,
      EVENTS_PATH,
    ]);
  });

  it('writes the versioned record through the production wiring, and no schedule with it', async () => {
    /*
     * The composition root itself, not an injected store: `App` mounts `useAppController`, which builds
     * the controller with `browserConfirmedSelectionStore()`. Only `fetch` is substituted, so a root
     * that fell back to the no-op store would leave storage empty and fail here — which is the point of
     * this case, beside the shape assertions the unit tests already make.
     */
    respond = wholeFlow;

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await userEvent.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));

    expect(await screen.findByRole('heading', { name: DE.states.live.heading })).toBeVisible();

    const stored = Object.fromEntries(
      Array.from({ length: window.localStorage.length }, (_, index) => {
        const key = window.localStorage.key(index) ?? '';

        return [key, window.localStorage.getItem(key) ?? ''];
      }),
    );

    expect(Object.keys(stored)).toEqual([CONFIRMED_SELECTION_STORAGE_KEY]);
    expect(JSON.parse(stored[CONFIRMED_SELECTION_STORAGE_KEY] ?? 'null')).toEqual({
      version: CONFIRMED_SELECTION_VERSION,
      cityId: KOBLENZ_CITY.id,
      providerId: PROVIDER_ID,
      serviceAreaId: AREA_ID,
    });

    const everything = JSON.stringify(stored);

    // Identity only: no event, date, waste type, provenance, or transient controller state.
    for (const forbidden of [
      '2026-08-14',
      'paper',
      'Altpapier',
      OFFICIAL_PROVIDER.name,
      'collectionEvents',
      'retrievedAt',
      'draft',
      'loading',
      'error',
      'scroll',
      'focus',
    ]) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it('writes nothing through the production wiring for a district that was never confirmed', async () => {
    respond = wholeFlow;

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await userEvent.click(await screen.findByRole('button', { name: /Stadtmitte/ }));

    // Drafted, not confirmed: the confirmation bar is waiting, and storage stays empty.
    expect(screen.getByRole('button', { name: DE.actions.confirm })).toBeVisible();
    expect(window.localStorage.getItem(CONFIRMED_SELECTION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it('starts at the city step when the catalogue no longer lists the remembered city', async () => {
    respond = wholeFlow;

    const first = render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await userEvent.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));
    await screen.findByRole('heading', { name: DE.states.live.heading });
    first.unmount();

    /*
     * The catalogue now publishes a different city. That is a statement about the remembered one —
     * unlike an empty catalogue, which says only that nothing is published at the moment.
     */
    recorded.length = 0;
    respond = routed({
      cities: [
        () =>
          json({
            data: [{ id: 'trier', name: 'Trier', providers: [OFFICIAL_PROVIDER] }],
          }),
      ],
    });

    render(<App />);

    // The city choice, with its heading — not a spinner — and the record does not survive it.
    expect(await screen.findByRole('button', { name: 'Trier' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: DE.states.live.heading })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('abfall-radar.confirmed-selection')).toBeNull();
    expect(pathsOf()).toEqual([CITIES_PATH]);
  });
});

describe('an unknown problem code through the real client', () => {
  for (const code of ['__proto__', 'constructor', 'toString']) {
    it(`renders the generic message and keeps the identifier for code ${code}`, async () => {
      respond = async () => problem(500, { code, requestId: `req-${code}` });

      render(<App />);

      // An object lookup returned an inherited member here: a function, or `Object.prototype`, which
      // React then refused to render at all.
      expect(await screen.findByText(DE.failures.problem)).toBeInTheDocument();
      expect(screen.getByText(`req-${code}`)).toBeInTheDocument();
      expect(screen.getByTestId('live-region').textContent).toContain(DE.failures.problem);
      expect(document.body.textContent).not.toContain('urn:abfall-radar');
    });
  }
});

describe('focus after an asynchronous transition', () => {
  it('moves focus to the heading of the surface that replaced the area step', async () => {
    respond = routed({
      providers: [() => json(CATALOGUE)],
      areas: [() => problem(500, { code: 'INTERNAL_SERVER_ERROR', requestId: 'req-areas' })],
    });

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));

    const heading = await screen.findByRole('heading', { name: DE.states.error.heading });

    // The area heading focus was published for a surface that the failure then removed, which dropped
    // keyboard focus to `body`.
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  it('returns focus to the provider that opened the area step, not to the first one', async () => {
    // A city served by two providers is what makes a provider step exist at all.
    respond = routed({
      cities: [() => json(cities(TWO_PROVIDER_CITY))],
      providers: [() => json(CATALOGUE)],
      areas: [() => json(areas(area({ providerId: SECOND_PROVIDER_ID, id: 'zweite-lage' })))],
    });

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));

    const second = await screen.findByRole('button', { name: SECOND_PROVIDER.name });

    await userEvent.click(second);
    await userEvent.click(await screen.findByRole('button', { name: DE.actions.back }));

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: SECOND_PROVIDER.name }),
      );
    });
  });

  it('returns from the area step to the city that opened it when the city has one provider', async () => {
    respond = wholeFlow;

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await screen.findByRole('button', { name: /Stadtmitte/ });
    await userEvent.click(screen.getByRole('button', { name: DE.actions.back }));

    // One step back, and onto the choice that opened the step — not the first control on the page.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    });
  });
});

describe('the same wrapped client boundary carries every later read', () => {
  const noStore = (): void => {
    for (const request of recorded) {
      expect(request.init?.cache).toBe('no-store');
      expect(request.init?.method).toBe('GET');
      expect(new Headers(request.init?.headers).get('accept')).toBe(
        'application/json, application/problem+json',
      );
      expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    }
  };

  it('preserves the supplied members and sets the cache mode last on every read', async () => {
    respond = wholeFlow;

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await userEvent.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));
    await screen.findByRole('heading', { name: DE.states.live.heading });

    noStore();
    // Nothing else is invented: the wrapper copies what the client passed and adds only `cache`.
    expect(Object.keys(recorded[0]?.init ?? {}).toSorted()).toEqual([
      'cache',
      'headers',
      'method',
      'signal',
    ]);
  });

  it('routes Retry through it after a rejected fetch', async () => {
    respond = routed({
      cities: [
        () => {
          throw new TypeError('Failed to fetch');
        },
        () => json(CITIES),
      ],
    });

    render(<App />);

    // A rejected fetch — no HTTP response ever exists — is the network state, with no identifier.
    expect(await screen.findByText(DE.failures.network)).toBeInTheDocument();
    expect(screen.queryByText(/Kennung/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: DE.actions.retry }));
    await screen.findByRole('button', { name: KOBLENZ_CITY.name });

    // The city catalogue is the first read, so that is exactly what Retry re-reads.
    expect(pathsOf()).toEqual([CITIES_PATH, CITIES_PATH]);
    noStore();
  });

  it('routes the one reconciled events retry through it after the first exact 422', async () => {
    respond = routed({
      providers: [() => json(CATALOGUE)],
      areas: [() => json(AREAS)],
      events: [
        () => problem(422, { code: 'SCHEDULE_RANGE_NOT_COVERED', requestId: 'req-first-422' }),
        (request) => eventsFor(request.url),
      ],
    });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await userEvent.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));
    await screen.findByRole('heading', { name: DE.states.live.heading });

    // Reconciliation repeats the authoritative sequence rather than retrying the events call alone.
    expect(pathsOf()).toEqual([
      CITIES_PATH,
      PROVIDERS_PATH,
      AREAS_PATH,
      PROVIDERS_PATH,
      AREAS_PATH,
      EVENTS_PATH,
      PROVIDERS_PATH,
      AREAS_PATH,
      EVENTS_PATH,
    ]);
    noStore();
  });

  it('routes a range-recovery cycle through it on a lifecycle signal', async () => {
    const expired = areas(
      area({
        collectionEvents: {
          availability: 'available',
          timeZone: 'Europe/Berlin',
          validity: { from: '2020-01-01', to: '2020-12-31' },
        },
      }),
    );

    respond = routed({ providers: [() => json(CATALOGUE)], areas: [() => json(expired)] });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await userEvent.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));
    await screen.findByRole('heading', { name: DE.states.range_not_covered.heading });

    const beforeRecovery = recorded.length;

    // The coordinator revalidates immediately on a real lifecycle event, without waiting for its timer.
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(recorded.length).toBeGreaterThan(beforeRecovery);
    });

    expect(pathsOf().slice(beforeRecovery)).toEqual([PROVIDERS_PATH, AREAS_PATH]);
    expect(
      screen.getByRole('heading', { name: DE.states.range_not_covered.heading }),
    ).toBeInTheDocument();
    noStore();
  });
});

describe('a capability the current date has outgrown', () => {
  it('renders the uncovered state and issues no collection-events request', async () => {
    freezeClock(OUT_OF_RANGE_INSTANT);
    respond = wholeFlow;

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));
    await userEvent.click(await screen.findByRole('button', { name: /Stadtmitte/ }));
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));

    expect(
      await screen.findByRole('heading', { name: DE.states.range_not_covered.heading }),
    ).toBeInTheDocument();
    // Refusing to request a window the calendar cannot cover is the product's own decision, and the
    // in-range scenarios above pin their own instant rather than depending on this one.
    expect(pathsOf()).not.toContain(EVENTS_PATH);
  });
});

describe('focus when a surface the application focused is replaced', () => {
  it('moves focus to the replacement heading after a failed catalogue refresh', async () => {
    const areasGate = gate();
    const refreshGate = gate();

    respond = routed({
      providers: [
        () => json(CATALOGUE),
        async () => {
          await refreshGate.promise;
          throw new TypeError('Failed to fetch');
        },
      ],
      areas: [
        async () => {
          await areasGate.promise;

          return problem(404, { code: 'PROVIDER_NOT_FOUND', requestId: 'req-gone' });
        },
      ],
    });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));

    // The area step owns focus while its request is in flight.
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('area-heading');
    });

    await act(async () => {
      areasGate.open();
      await areasGate.promise;
    });

    // The invalidated provider sends the user back to a mounted, focused provider step.
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('provider-heading');
    });

    await act(async () => {
      refreshGate.open();
      await refreshGate.promise;
    });

    const heading = await screen.findByRole('heading', { name: DE.states.error.heading });

    // Replacing that step with the failure surface used to drop focus to `body`.
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(screen.getByTestId('live-region').textContent).toContain(DE.failures.network);
  });

  it('moves focus to the replacement heading when the refreshed catalogue is empty', async () => {
    respond = routed({
      providers: [() => json(CATALOGUE), () => json(providers(DEMO_PROVIDER))],
      areas: [() => problem(404, { code: 'PROVIDER_NOT_FOUND', requestId: 'req-gone' })],
    });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));

    const heading = await screen.findByRole('heading', {
      name: DE.states.no_official_providers.heading,
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  it('moves focus to the replacement heading when the refreshed catalogue repeats an id', async () => {
    respond = routed({
      providers: [
        () => json(CATALOGUE),
        () => json({ data: [{ ...OFFICIAL_PROVIDER }, { ...OFFICIAL_PROVIDER, name: 'Doppelt' }] }),
      ],
      areas: [() => problem(404, { code: 'PROVIDER_NOT_FOUND', requestId: 'req-gone' })],
    });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: KOBLENZ_CITY.name }));

    const heading = await screen.findByRole('heading', { name: DE.states.error.heading });

    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(screen.getByText(DE.failures.invalid_response)).toBeInTheDocument();
  });

  it('takes no focus on a first load that fails before the application ever moved it', async () => {
    respond = () => {
      throw new TypeError('Failed to fetch');
    };

    render(<App />);
    await screen.findByText(DE.failures.network);

    // Nothing was focused yet, so the page must not pull focus away from where the browser left it.
    expect(document.activeElement).toBe(document.body);
  });
});
