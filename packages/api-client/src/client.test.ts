import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from './client';
import { ApiClientConfigurationError } from './errors';
import {
  COLLECTION_EVENTS_BODY,
  mutableCopy,
  PROBLEM_BODY,
  PROVIDER_LIST_BODY,
  SERVICE_AREA_LIST_BODY,
} from './test/response-fixtures';

const BASE_URL = 'http://127.0.0.1:3000';

const RANGE = { from: '2026-01-01', to: '2026-12-31' } as const;

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const jsonResponse = (
  body: unknown,
  { status = 200, contentType = 'application/json' } = {},
): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });

const problemResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const recordingFetch = (respond: (request: RecordedRequest) => Response | Promise<Response>) => {
  const requests: RecordedRequest[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const request = { url, init };

    requests.push(request);

    return respond(request);
  };

  return { fetchImpl, requests };
};

const clientWith = (fetchImpl: FetchLike, timeoutMs?: number) =>
  createApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

const expectFailure = <Data>(
  result: { ok: true; data: Data } | { ok: false; failure: unknown },
): Record<string, unknown> => {
  if (result.ok) {
    throw new Error('The request was expected to fail.');
  }

  const { failure } = result;

  if (typeof failure !== 'object' || failure === null) {
    throw new Error('A failure is expected to be an object.');
  }

  return { ...failure };
};

describe('createApiClient configuration', () => {
  it.each([
    ['a path', 'http://127.0.0.1:3000/api'],
    ['a query', 'http://127.0.0.1:3000?token=1'],
    ['a fragment', 'http://127.0.0.1:3000#x'],
    ['credentials', 'http://user:secret@127.0.0.1:3000'],
    ['a malformed value', 'not a url'],
  ])('refuses a base URL carrying %s', (_reason, baseUrl) => {
    expect(() => createApiClient({ baseUrl })).toThrow(ApiClientConfigurationError);
  });

  it('exposes the normalized origin a consumer keys its cache by', () => {
    expect(createApiClient({ baseUrl: 'https://api.example.test:443/' }).origin).toBe(
      'https://api.example.test',
    );
  });

  it('defaults the deadline to 8000 milliseconds', () => {
    expect(createApiClient({ baseUrl: BASE_URL }).timeoutMs).toBe(8000);
  });

  it.each([
    ['a fractional deadline', 1500.5],
    ['a zero deadline', 0],
    ['a negative deadline', -1],
    ['not a number', Number.NaN],
  ])('refuses %s at construction rather than defaulting it', (_reason, timeoutMs) => {
    expect(() => createApiClient({ baseUrl: BASE_URL, timeoutMs })).toThrow(
      ApiClientConfigurationError,
    );
  });
});

describe('request construction', () => {
  it('builds every URL from the exact configured base URL, including its port', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonResponse(PROVIDER_LIST_BODY));
    const client = clientWith(fetchImpl);

    await client.listProviders();

    expect(requests[0]?.url).toBe('http://127.0.0.1:3000/api/v1/providers');
  });

  it('builds the service-areas URL for the selected provider', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonResponse(SERVICE_AREA_LIST_BODY));

    await clientWith(fetchImpl).listServiceAreas('koblenz-servicebetrieb');

    expect(requests[0]?.url).toBe(
      'http://127.0.0.1:3000/api/v1/providers/koblenz-servicebetrieb/service-areas',
    );
  });

  it('builds the collection-events URL with an explicit bounded range', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonResponse(COLLECTION_EVENTS_BODY));

    await clientWith(fetchImpl).listCollectionEvents({
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-stadtmitte',
      range: RANGE,
    });

    expect(requests[0]?.url).toBe(
      'http://127.0.0.1:3000/api/v1/providers/koblenz-servicebetrieb/service-areas/koblenz-stadtmitte/collection-events?from=2026-01-01&to=2026-12-31',
    );
  });

  it('keeps a caller-supplied identifier inside its own path segment', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonResponse(SERVICE_AREA_LIST_BODY));

    await clientWith(fetchImpl).listServiceAreas('../../health');

    expect(requests[0]?.url).toBe(
      'http://127.0.0.1:3000/api/v1/providers/..%2F..%2Fhealth/service-areas',
    );
  });

  it('sends a GET that accepts JSON and Problem Details', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonResponse(PROVIDER_LIST_BODY));

    await clientWith(fetchImpl).listProviders();

    expect(requests[0]?.init?.method).toBe('GET');
    expect(requests[0]?.init?.headers).toEqual({
      accept: 'application/json, application/problem+json',
    });
  });

  it('builds a URL against a configured origin with a different port', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonResponse(PROVIDER_LIST_BODY));

    await createApiClient({
      baseUrl: 'https://api.example.test:8443',
      fetch: fetchImpl,
    }).listProviders();

    expect(requests[0]?.url).toBe('https://api.example.test:8443/api/v1/providers');
  });
});

describe('successful responses', () => {
  it('returns the validated provider catalogue', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(PROVIDER_LIST_BODY));
    const result = await clientWith(fetchImpl).listProviders();

    expect(result).toEqual({ ok: true, data: PROVIDER_LIST_BODY });
  });

  it('returns the validated service areas with their capability', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(SERVICE_AREA_LIST_BODY));
    const result = await clientWith(fetchImpl).listServiceAreas('koblenz-servicebetrieb');

    expect(result.ok && result.data.data[0]?.collectionEvents).toEqual({
      availability: 'available',
      timeZone: 'Europe/Berlin',
      validity: { from: '2026-01-01', to: '2026-12-31' },
    });
  });

  it('returns the validated schedule with its provenance', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(COLLECTION_EVENTS_BODY));
    const result = await clientWith(fetchImpl).listCollectionEvents({
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-stadtmitte',
      range: RANGE,
    });

    expect(result.ok && result.data.meta.freshness).toBe('fresh');
    expect(result.ok && result.data.data).toHaveLength(2);
  });

  it('rejects a success response whose content type is not JSON', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    expect(expectFailure(await clientWith(fetchImpl).listProviders())).toEqual({
      kind: 'invalid_response',
      operation: 'listProviders',
      status: 200,
    });
  });

  it('rejects a success response carrying no content type', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('{}', { status: 200 }));

    expect(expectFailure(await clientWith(fetchImpl).listProviders()).kind).toBe(
      'invalid_response',
    );
  });

  it('rejects a success body that is not valid JSON', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response('{ not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    expect(expectFailure(await clientWith(fetchImpl).listProviders()).kind).toBe(
      'invalid_response',
    );
  });

  it('rejects a success body that does not satisfy the contract', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ data: [{ id: 'demo' }] }));

    expect(expectFailure(await clientWith(fetchImpl).listProviders())).toEqual({
      kind: 'invalid_response',
      operation: 'listProviders',
      status: 200,
    });
  });
});

/**
 * A schema-valid body is not automatically an answer to the request that was made.
 *
 * A shared proxy serving a stale entry, or a server-side mix-up between two concurrent requests, produces a
 * perfectly well-formed response describing a different provider, area, or range. Accepting it means it is
 * cached under the requested key, presented under the requested area's name, and turned into reminders for
 * dates nobody asked about — and once cached, nothing downstream can tell it apart from a genuine answer.
 *
 * So the check lives here, at the transport boundary, and rejects the **whole** response. Filtering the
 * mismatched parts out would present what remained as a complete schedule for the range, which is a
 * confident claim assembled from a reply already known to be about something else.
 */
describe('collection-events request and response identity', () => {
  const REQUEST = {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-stadtmitte',
    range: RANGE,
  } as const;

  /** One mismatch applied to an otherwise genuine body, so each test isolates a single field. */
  const bodyWithMeta = (overrides: Record<string, unknown>): Record<string, unknown> => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);

    body.meta = { ...mutableCopy(COLLECTION_EVENTS_BODY.meta), ...overrides };

    return body;
  };

  const expectRejected = async (body: unknown): Promise<void> => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(body));

    expect(expectFailure(await clientWith(fetchImpl).listCollectionEvents(REQUEST))).toEqual({
      kind: 'invalid_response',
      operation: 'listCollectionEvents',
      // The status the server really sent. The reply arrived; it is simply unusable.
      status: 200,
    });
  };

  /**
   * A place name that is not canonical makes the whole response unusable.
   *
   * `invalid_response` rather than a trimmed success, because the alternative is worse than a refusal: the caller
   * would receive a value this validator had altered, and the same place could reach the domain under a spelling it
   * refuses. The reply arrived and the status was 200 — it is simply not something this client may hand on.
   */
  describe('a mobile-drop-off location that is not canonical', () => {
    const bodyWithLocationName = (name: string): Record<string, unknown> => {
      const body = mutableCopy(COLLECTION_EVENTS_BODY);
      const events = body.data as Record<string, unknown>[];

      body.data = events.map((event) =>
        event.collectionMode === 'mobile_drop_off' ? { ...event, location: { name } } : event,
      );

      return body;
    };

    it.each([
      ['leading whitespace', ' Rizzastraße Ecke Südallee'],
      ['trailing whitespace', 'Rizzastraße Ecke Südallee '],
      ['whitespace at both ends', ' Rizzastraße Ecke Südallee '],
      ['nothing but whitespace', '   '],
      ['nothing at all', ''],
    ])('becomes an invalid response for %s', async (_reason, name) => {
      await expectRejected(bodyWithLocationName(name));
    });

    it('returns no data at all, so nothing untrimmed can be read from the result', async () => {
      const { fetchImpl } = recordingFetch(() =>
        jsonResponse(bodyWithLocationName(' Rizzastraße ')),
      );
      const result = await clientWith(fetchImpl).listCollectionEvents(REQUEST);

      expect(result.ok).toBe(false);
      // Nothing to mistake for a schedule: there is no `data` on a failure at all.
      expect(JSON.stringify(result)).not.toContain('Rizzastraße');
    });

    it('still accepts a canonical name with internal spaces and German characters', async () => {
      // The counterweight, so the rule is refusing the right thing rather than everything.
      const { fetchImpl } = recordingFetch(() =>
        jsonResponse(bodyWithLocationName('Löhrstraße/Görgenstraße, Tor 2')),
      );
      const result = await clientWith(fetchImpl).listCollectionEvents(REQUEST);

      expect(result.ok).toBe(true);
    });
  });

  it('rejects a response whose event carries an undeclared waste type', async () => {
    /**
     * The response contradicts itself: it contains a collection the source says it does not publish. `data` is not
     * returned at all, so no caller can pick a half to believe.
     */
    const body = mutableCopy(COLLECTION_EVENTS_BODY);

    body.meta = {
      ...mutableCopy(COLLECTION_EVENTS_BODY.meta),
      coverage: { wasteTypes: ['bio'] },
    };

    await expectRejected(body);
  });

  it('returns nothing a caller could read the undeclared event from', async () => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);

    body.meta = {
      ...mutableCopy(COLLECTION_EVENTS_BODY.meta),
      coverage: { wasteTypes: ['bio'] },
    };

    const { fetchImpl } = recordingFetch(() => jsonResponse(body));
    const result = await clientWith(fetchImpl).listCollectionEvents(REQUEST);

    expect(result.ok).toBe(false);
    expect('data' in result).toBe(false);
  });

  it('rejects a response describing another provider', async () => {
    await expectRejected(
      bodyWithMeta({
        provider: { id: 'somebody-else', name: 'Anderer Betrieb', sourceKind: 'official_ics' },
      }),
    );
  });

  it('rejects a response whose service-area metadata names another area', async () => {
    await expectRejected(
      bodyWithMeta({
        serviceArea: { id: 'koblenz-oberwerth', locality: 'Koblenz', name: 'Oberwerth' },
      }),
    );
  });

  it('rejects a response served for another range start', async () => {
    await expectRejected(bodyWithMeta({ range: { from: '2026-02-01', to: RANGE.to } }));
  });

  it('rejects a response served for another range end', async () => {
    await expectRejected(bodyWithMeta({ range: { from: RANGE.from, to: '2026-11-30' } }));
  });

  it('rejects the whole response when one event belongs to another service area', async () => {
    // Not filtered down to the events that match: the remainder would be presented as the complete schedule
    // for the requested range, which claims coverage this reply cannot support.
    const body = mutableCopy(COLLECTION_EVENTS_BODY);

    body.data = [
      { ...mutableCopy(COLLECTION_EVENTS_BODY.data[0]) },
      { ...mutableCopy(COLLECTION_EVENTS_BODY.data[1]), serviceAreaId: 'koblenz-oberwerth' },
    ];

    await expectRejected(body);
  });

  it('accepts a fully matching response', async () => {
    // The mirror image, so none of the rejections above can pass by everything being refused.
    const { fetchImpl } = recordingFetch(() => jsonResponse(COLLECTION_EVENTS_BODY));
    const result = await clientWith(fetchImpl).listCollectionEvents(REQUEST);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.data).toHaveLength(2);
    expect(result.ok && result.data.meta.serviceArea.id).toBe('koblenz-stadtmitte');
  });

  /**
   * `meta.range` agreeing is the server's *claim* about what it filtered. An event outside that range is
   * proof it did not.
   *
   * The date is what everything downstream trusts: the cache records the served range as covering it, the
   * display range is derived from that range, and a reminder fires on whichever day an event names. An event
   * outside the window therefore becomes a notification for a day the source never scheduled — told to a
   * person who did not ask to be told anything.
   */
  describe('an event outside the requested range', () => {
    /** Replaces the event list, leaving the metadata genuine so only the dates are under test. */
    const bodyWithEventDates = (dates: readonly string[]): Record<string, unknown> => {
      const body = mutableCopy(COLLECTION_EVENTS_BODY);

      body.data = dates.map((date) => ({
        ...mutableCopy(COLLECTION_EVENTS_BODY.data[0]),
        id: `koblenz-servicebetrieb-koblenz-stadtmitte-paper-${date}`,
        date,
      }));

      return body;
    };

    it('rejects a response carrying an event before the range start', async () => {
      // One day earlier. The range is a closed interval, so this is outside it.
      await expectRejected(bodyWithEventDates(['2025-12-31']));
    });

    it('rejects a response carrying an event after the range end', async () => {
      await expectRejected(bodyWithEventDates(['2027-01-01']));
    });

    it('rejects the whole response when valid and out-of-range events are mixed', async () => {
      // Not narrowed to the events inside the window: the remainder would then be presented as the complete
      // schedule for the range, which is a claim this reply has already disproved.
      await expectRejected(bodyWithEventDates(['2026-03-05', '2027-04-15', '2026-03-20']));
    });

    it('accepts events on both inclusive boundaries', async () => {
      // `from` and `to` are the days that were asked for, so an event on either is exactly what was wanted.
      const { fetchImpl } = recordingFetch(() =>
        jsonResponse(bodyWithEventDates([RANGE.from, RANGE.to])),
      );
      const result = await clientWith(fetchImpl).listCollectionEvents(REQUEST);

      expect(result.ok).toBe(true);
      expect(result.ok && result.data.data.map((event) => event.date)).toEqual([
        RANGE.from,
        RANGE.to,
      ]);
    });

    it('accepts a single-day range whose one event falls on it', async () => {
      // The degenerate closed interval, where `from` and `to` are the same day.
      const sameDay = { from: '2026-03-15', to: '2026-03-15' } as const;
      const body = mutableCopy(COLLECTION_EVENTS_BODY);
      const meta = mutableCopy(COLLECTION_EVENTS_BODY.meta);

      meta.range = sameDay;
      body.meta = meta;
      body.data = [{ ...mutableCopy(COLLECTION_EVENTS_BODY.data[0]), date: '2026-03-15' }];

      const { fetchImpl } = recordingFetch(() => jsonResponse(body));
      const result = await clientWith(fetchImpl).listCollectionEvents({
        ...REQUEST,
        range: sameDay,
      });

      expect(result.ok).toBe(true);
    });
  });

  it('accepts a matching response that carries no events at all', async () => {
    // An empty result inside a covered range is a real answer — "no collection in this period" — and the
    // identity rule must not turn it into a failure.
    const body = mutableCopy(COLLECTION_EVENTS_BODY);

    body.data = [];

    const { fetchImpl } = recordingFetch(() => jsonResponse(body));
    const result = await clientWith(fetchImpl).listCollectionEvents(REQUEST);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.data).toEqual([]);
  });
});

/**
 * The audit counterpart: the only other read whose contract ties the body back to the request.
 *
 * Every `ServiceArea` states its own `providerId`, so a response listing another provider's areas is
 * checkable and refused. The provider catalogue carries no such field — it is not requested *for* anything —
 * so there is nothing to compare there, and inventing a comparison would assert something the contract does
 * not express.
 */
describe('service-areas request and response identity', () => {
  it('rejects a response whose areas belong to another provider', async () => {
    const body = mutableCopy(SERVICE_AREA_LIST_BODY);

    body.data = [{ ...mutableCopy(SERVICE_AREA_LIST_BODY.data[0]), providerId: 'somebody-else' }];

    const { fetchImpl } = recordingFetch(() => jsonResponse(body));

    expect(
      expectFailure(await clientWith(fetchImpl).listServiceAreas('koblenz-servicebetrieb')),
    ).toEqual({
      kind: 'invalid_response',
      operation: 'listServiceAreas',
      status: 200,
    });
  });

  it('accepts a response whose areas all belong to the requested provider', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(SERVICE_AREA_LIST_BODY));
    const result = await clientWith(fetchImpl).listServiceAreas('koblenz-servicebetrieb');

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.data).toHaveLength(1);
  });

  it('accepts an empty area list, which is an answer rather than a mismatch', async () => {
    const body = mutableCopy(SERVICE_AREA_LIST_BODY);

    body.data = [];

    const { fetchImpl } = recordingFetch(() => jsonResponse(body));

    expect((await clientWith(fetchImpl).listServiceAreas('koblenz-servicebetrieb')).ok).toBe(true);
  });
});

describe('problem responses', () => {
  it('projects a validated Problem Details body onto the safe subset', async () => {
    const { fetchImpl } = recordingFetch(() => problemResponse(PROBLEM_BODY, 422));
    const failure = expectFailure(
      await clientWith(fetchImpl).listCollectionEvents({
        providerId: 'koblenz-servicebetrieb',
        serviceAreaId: 'koblenz-stadtmitte',
        range: RANGE,
      }),
    );

    expect(failure).toEqual({
      kind: 'problem',
      operation: 'listCollectionEvents',
      status: 422,
      code: 'SCHEDULE_RANGE_NOT_COVERED',
      requestId: 'req-1',
    });
  });

  it('carries no server-supplied message, path, or input across the boundary', async () => {
    const { fetchImpl } = recordingFetch(() =>
      problemResponse(
        {
          ...mutableCopy(PROBLEM_BODY),
          detail: 'confidential diagnostic copy',
          instance: '/internal/path',
          errors: [{ path: '/from', code: 'custom', message: 'leaked request input' }],
        },
        422,
      ),
    );
    const failure = expectFailure(await clientWith(fetchImpl).listProviders());

    expect(JSON.stringify(failure)).not.toContain('confidential diagnostic copy');
    expect(JSON.stringify(failure)).not.toContain('/internal/path');
    expect(JSON.stringify(failure)).not.toContain('leaked request input');
  });

  it('degrades an unrecognized problem code instead of failing validation', async () => {
    const { fetchImpl } = recordingFetch(() =>
      problemResponse({ ...mutableCopy(PROBLEM_BODY), code: 'SOME_FUTURE_PROBLEM' }, 409),
    );
    const failure = expectFailure(await clientWith(fetchImpl).listProviders());

    expect(failure).toEqual({
      kind: 'problem',
      operation: 'listProviders',
      status: 409,
      code: 'SOME_FUTURE_PROBLEM',
      requestId: 'req-1',
    });
  });

  it('turns a malformed Problem Details body into an invalid-response failure', async () => {
    const { fetchImpl } = recordingFetch(() => problemResponse({ message: 'oops' }, 500));

    expect(expectFailure(await clientWith(fetchImpl).listProviders())).toEqual({
      kind: 'invalid_response',
      operation: 'listProviders',
      status: 500,
    });
  });

  it('turns a non-problem error body into an invalid-response failure', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response('Bad Gateway', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
    );

    expect(expectFailure(await clientWith(fetchImpl).listProviders())).toEqual({
      kind: 'invalid_response',
      operation: 'listProviders',
      status: 502,
    });
  });

  it('turns an unparseable problem body into an invalid-response failure', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response('{ not json', {
          status: 500,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );

    expect(expectFailure(await clientWith(fetchImpl).listProviders()).kind).toBe(
      'invalid_response',
    );
  });
});

describe('network failures', () => {
  it('reports a thrown fetch as a network failure with no request identifier', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    const failure = expectFailure(await clientWith(fetchImpl).listProviders());

    expect(failure).toEqual({ kind: 'network', operation: 'listProviders' });
    expect(Object.keys(failure)).not.toContain('requestId');
  });
});

describe('the deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A fetch that only settles when its signal aborts, which is what a stalled request looks like.
   *
   * An already-aborted signal rejects immediately rather than waiting for an event that will never
   * fire again, matching what a real `fetch` does.
   */
  const stallingFetch: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      const abort = (): void => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };

      if (init?.signal?.aborted === true) {
        abort();

        return;
      }

      init?.signal?.addEventListener('abort', abort, { once: true });
    });

  it('reports a timeout carrying exactly the configured deadline', async () => {
    const result = clientWith(stallingFetch).listProviders();

    await vi.advanceTimersByTimeAsync(8000);

    const failure = expectFailure(await result);

    expect(failure).toEqual({ kind: 'timeout', operation: 'listProviders', timeoutMs: 8000 });
    expect(Object.keys(failure).toSorted()).toEqual(['kind', 'operation', 'timeoutMs']);
  });

  it('reports the configured deadline rather than a measured elapsed duration', async () => {
    const result = clientWith(stallingFetch, 2000).listProviders();

    // Advanced well past the deadline: a measured duration would report roughly 30000 here, so this is
    // what makes the distinction observable rather than assumed.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(expectFailure(await result).timeoutMs).toBe(2000);
  });

  it('does not fire before its deadline', async () => {
    const client = clientWith(stallingFetch, 5000);
    const result = client.listProviders();
    let settled = false;

    void result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(expectFailure(await result).kind).toBe('timeout');
  });

  it('reports a caller cancellation as cancelled rather than as a timeout', async () => {
    const controller = new AbortController();
    const result = clientWith(stallingFetch).listProviders({ signal: controller.signal });

    controller.abort();

    const failure = expectFailure(await result);

    expect(failure).toEqual({ kind: 'cancelled', operation: 'listProviders' });
    expect(Object.keys(failure)).not.toContain('requestId');
    expect(Object.keys(failure)).not.toContain('timeoutMs');
  });

  it('reports a cancellation even when the signal was already aborted', async () => {
    const controller = new AbortController();

    controller.abort();

    expect(
      expectFailure(await clientWith(stallingFetch).listProviders({ signal: controller.signal }))
        .kind,
    ).toBe('cancelled');
  });

  it('still reports a timeout when a caller signal exists but never aborts', async () => {
    const controller = new AbortController();
    const result = clientWith(stallingFetch).listProviders({ signal: controller.signal });

    await vi.advanceTimersByTimeAsync(8000);

    expect(expectFailure(await result).kind).toBe('timeout');
  });

  it('stops its timer once a request has settled, so no later firing can reclassify it', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(PROVIDER_LIST_BODY));
    const result = await clientWith(fetchImpl, 1000).listProviders();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the deadline during a body read', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Headers arrive at once; the body stays pending until the signal aborts.
   *
   * This is what a stalled or superseded streaming response really looks like, and it is the case the
   * deadline has to keep covering: reading a body is part of the operation, not something after it.
   *
   * A minimal stand-in is used rather than a real `Response`, because a real one cannot be constructed with a
   * body that hangs and then rejects on abort. Only the four members the client touches are provided, which
   * is the documented reason for the assertion on the return type.
   */
  const pendingBodyFetch = ({ status = 200, contentType = 'application/json' } = {}): FetchLike => {
    return async (_url, init) => {
      const stub = {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ 'content-type': contentType }),
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            const abort = (): void => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            };

            if (init?.signal?.aborted === true) {
              abort();

              return;
            }

            init?.signal?.addEventListener('abort', abort, { once: true });
          }),
      };

      return stub as unknown as Response;
    };
  };

  it('reports a timeout while a success body is still being read', async () => {
    const result = clientWith(pendingBodyFetch()).listProviders();

    await vi.advanceTimersByTimeAsync(8000);

    const failure = expectFailure(await result);

    expect(failure).toEqual({ kind: 'timeout', operation: 'listProviders', timeoutMs: 8000 });
    expect(Object.keys(failure).toSorted()).toEqual(['kind', 'operation', 'timeoutMs']);
  });

  it('reports the configured deadline, not the time spent reading the body', async () => {
    const result = clientWith(pendingBodyFetch(), 2000).listProviders();

    await vi.advanceTimersByTimeAsync(45_000);

    expect(expectFailure(await result).timeoutMs).toBe(2000);
  });

  it('reports a caller cancellation while a success body is still being read', async () => {
    const controller = new AbortController();
    const result = clientWith(pendingBodyFetch()).listProviders({ signal: controller.signal });

    controller.abort();

    const failure = expectFailure(await result);

    expect(failure).toEqual({ kind: 'cancelled', operation: 'listProviders' });
    expect(Object.keys(failure)).not.toContain('timeoutMs');
    expect(Object.keys(failure)).not.toContain('requestId');
  });

  it('reports a timeout while a Problem Details body is still being read', async () => {
    const result = clientWith(
      pendingBodyFetch({ status: 503, contentType: 'application/problem+json' }),
    ).listProviders();

    await vi.advanceTimersByTimeAsync(8000);

    expect(expectFailure(await result)).toEqual({
      kind: 'timeout',
      operation: 'listProviders',
      timeoutMs: 8000,
    });
  });

  it('reports a caller cancellation while a Problem Details body is still being read', async () => {
    const controller = new AbortController();
    const result = clientWith(
      pendingBodyFetch({ status: 503, contentType: 'application/problem+json' }),
    ).listProviders({ signal: controller.signal });

    controller.abort();

    expect(expectFailure(await result)).toEqual({ kind: 'cancelled', operation: 'listProviders' });
  });

  it('still reports malformed JSON as an invalid response when nothing aborted', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response('{ not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    expect(expectFailure(await clientWith(fetchImpl).listProviders())).toEqual({
      kind: 'invalid_response',
      operation: 'listProviders',
      status: 200,
    });
  });

  it('reports an unrelated body-read failure as an invalid response', async () => {
    const failingBody: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.reject(new TypeError('body stream already read')),
      }) as unknown as Response;

    expect(expectFailure(await clientWith(failingBody).listProviders())).toEqual({
      kind: 'invalid_response',
      operation: 'listProviders',
      status: 200,
    });
  });

  it('prefers the timeout when the deadline and a caller abort land close together', async () => {
    const controller = new AbortController();
    const result = clientWith(pendingBodyFetch(), 1000).listProviders({
      signal: controller.signal,
    });

    // The deadline elapses first; the caller then aborts before the rejection has been classified.
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();

    expect(expectFailure(await result).kind).toBe('timeout');
  });

  it('disposes the timer and the caller listener exactly once for the whole operation', async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const result = clientWith(pendingBodyFetch()).listProviders({ signal: controller.signal });

    await vi.advanceTimersByTimeAsync(8000);
    await result;

    // No timer is left behind to fire later and reclassify a settled request.
    expect(vi.getTimerCount()).toBe(0);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('lets no rejection escape from a stalled body read', async () => {
    const result = clientWith(pendingBodyFetch()).listProviders();

    await vi.advanceTimersByTimeAsync(8000);

    await expect(result).resolves.toMatchObject({ ok: false });
  });
});

/**
 * A media type is matched exactly, not by substring.
 *
 * RFC 9110 puts optional parameters after the media type and makes the type case-insensitive, so
 * `application/json; charset=utf-8` is the documented type and has to be accepted. Everything else that merely
 * *contains* the documented type is a different thing: `application/jsonp` is another format,
 * `text/application/json` is a text document mentioning it, and `application/json, text/plain` is a malformed
 * header naming two. A substring test accepted all of them and then parsed the body as the documented
 * contract — so a body that happened to satisfy the schema would have been trusted as an official schedule.
 */
describe('media-type matching', () => {
  const ACCEPTED_JSON = [
    ['the exact documented type', 'application/json'],
    ['a charset parameter', 'application/json; charset=utf-8'],
    ['an upper-case charset parameter', 'application/json; charset=UTF-8'],
    ['no space before the parameter', 'application/json;charset=utf-8'],
    ['surrounding whitespace', '  application/json  '],
    ['an upper-case media type', 'APPLICATION/JSON'],
    ['a mixed-case media type', 'Application/Json; charset=utf-8'],
  ] as const;

  const REJECTED_JSON = [
    ['a different format that contains the type', 'application/jsonp'],
    ['a text document naming the type', 'text/application/json'],
    ['a suffixed type', 'application/json-seq'],
    ['two types in one header', 'application/json, text/plain'],
    ['the problem type on the success path', 'application/problem+json'],
    ['another undeclared +json type', 'application/vnd.api+json'],
    ['an empty header', ''],
    ['only whitespace', '   '],
    ['a bare subtype', 'json'],
  ] as const;

  describe('on the documented success path', () => {
    it.each(ACCEPTED_JSON)('accepts %s', async (_reason, contentType) => {
      const { fetchImpl } = recordingFetch(
        () =>
          new Response(JSON.stringify(PROVIDER_LIST_BODY), {
            status: 200,
            headers: { 'content-type': contentType },
          }),
      );

      expect(await clientWith(fetchImpl).listProviders()).toEqual({
        ok: true,
        data: PROVIDER_LIST_BODY,
      });
    });

    it.each(REJECTED_JSON)('rejects %s', async (_reason, contentType) => {
      // The body is a perfectly valid provider catalogue, so only the header decides.
      const { fetchImpl } = recordingFetch(
        () =>
          new Response(JSON.stringify(PROVIDER_LIST_BODY), {
            status: 200,
            headers: { 'content-type': contentType },
          }),
      );

      expect(expectFailure(await clientWith(fetchImpl).listProviders())).toEqual({
        kind: 'invalid_response',
        operation: 'listProviders',
        status: 200,
      });
    });

    it('rejects a success response carrying no content-type header at all', async () => {
      const { fetchImpl } = recordingFetch(
        () => new Response(JSON.stringify(PROVIDER_LIST_BODY), { status: 200 }),
      );

      expect(expectFailure(await clientWith(fetchImpl).listProviders()).kind).toBe(
        'invalid_response',
      );
    });
  });

  describe('on the Problem Details path', () => {
    const ACCEPTED_PROBLEM = [
      ['the exact documented type', 'application/problem+json'],
      ['a charset parameter', 'application/problem+json; charset=utf-8'],
      ['an upper-case charset parameter', 'application/problem+json; charset=UTF-8'],
      ['an upper-case media type', 'APPLICATION/PROBLEM+JSON'],
      ['surrounding whitespace', ' application/problem+json '],
    ] as const;

    const REJECTED_PROBLEM = [
      ['a suffixed type', 'application/problem+json-extra'],
      ['a text document naming the type', 'text/application/problem+json'],
      ['two types in one header', 'application/problem+json, text/plain'],
      ['the plain JSON type on the problem path', 'application/json'],
      ['another undeclared +json type', 'application/vnd.error+json'],
      ['an empty header', ''],
    ] as const;

    it.each(ACCEPTED_PROBLEM)(
      'projects a problem body declared as %s',
      async (_reason, contentType) => {
        const { fetchImpl } = recordingFetch(
          () =>
            new Response(JSON.stringify(PROBLEM_BODY), {
              status: 422,
              headers: { 'content-type': contentType },
            }),
        );

        // The documented type, so the body is trusted as Problem Details and its code reaches the caller.
        expect(expectFailure(await clientWith(fetchImpl).listProviders())).toMatchObject({
          kind: 'problem',
          code: 'SCHEDULE_RANGE_NOT_COVERED',
          status: 422,
        });
      },
    );

    it.each(REJECTED_PROBLEM)(
      'refuses to read a problem body declared as %s',
      async (_reason, contentType) => {
        const { fetchImpl } = recordingFetch(
          () =>
            new Response(JSON.stringify(PROBLEM_BODY), {
              status: 422,
              headers: { 'content-type': contentType },
            }),
        );

        // Never parsed as Problem Details, so no `code` and no `requestId` are taken from it.
        expect(expectFailure(await clientWith(fetchImpl).listProviders())).toEqual({
          kind: 'invalid_response',
          operation: 'listProviders',
          status: 422,
        });
      },
    );
  });

  it('checks the media type on every operation, not only the catalogue', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(JSON.stringify(COLLECTION_EVENTS_BODY), {
          status: 200,
          headers: { 'content-type': 'application/jsonp' },
        }),
    );

    expect(
      expectFailure(
        await clientWith(fetchImpl).listCollectionEvents({
          providerId: 'koblenz-servicebetrieb',
          serviceAreaId: 'koblenz-stadtmitte',
          range: RANGE,
        }),
      ).kind,
    ).toBe('invalid_response');
  });
});

/**
 * A schedule this client returns is presented as **official municipal data**, so it has to be exactly that.
 *
 * Every surface above puts what comes back under the operator's name with their attribution link. Two things
 * could break that promise while remaining perfectly schema-valid: a provider whose `sourceKind` is `demo`, and
 * an event whose `source` is `demo` or `user_rule`. Either makes the response untrustworthy as a whole.
 */
describe('the official-source boundary', () => {
  const REQUEST = {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-stadtmitte',
    range: RANGE,
  } as const;

  /** Replaces the provider metadata, leaving everything else genuine. */
  const bodyWithProvider = (provider: Record<string, unknown>): Record<string, unknown> => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);

    body.meta = { ...mutableCopy(COLLECTION_EVENTS_BODY.meta), provider };

    return body;
  };

  /** Replaces the event list with curbside events carrying the given sources. */
  const bodyWithEventSources = (sources: readonly string[]): Record<string, unknown> => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);

    body.data = sources.map((source, index) => ({
      ...mutableCopy(COLLECTION_EVENTS_BODY.data[0]),
      id: `koblenz-servicebetrieb-koblenz-stadtmitte-paper-2026-0${index + 1}-14`,
      date: `2026-0${index + 1}-14`,
      source,
    }));

    return body;
  };

  const expectRejectedBody = async (body: unknown): Promise<void> => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(body));

    expect(expectFailure(await clientWith(fetchImpl).listCollectionEvents(REQUEST))).toEqual({
      kind: 'invalid_response',
      operation: 'listCollectionEvents',
      status: 200,
    });
  };

  it('accepts an official provider whose events are all municipal', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(bodyWithEventSources(['municipal_ics', 'municipal_ics'])),
    );
    const result = await clientWith(fetchImpl).listCollectionEvents(REQUEST);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.data).toHaveLength(2);
  });

  it('accepts an official provider with no events at all', async () => {
    // An empty result inside a covered range is a real answer: "no collection in this period".
    const body = mutableCopy(COLLECTION_EVENTS_BODY);

    body.data = [];

    const { fetchImpl } = recordingFetch(() => jsonResponse(body));

    expect((await clientWith(fetchImpl).listCollectionEvents(REQUEST)).ok).toBe(true);
  });

  it('rejects a demo provider, whose events are sample data by construction', async () => {
    await expectRejectedBody(
      bodyWithProvider({ id: 'koblenz-servicebetrieb', name: 'Demo provider', sourceKind: 'demo' }),
    );
  });

  it('rejects a response carrying one demo event', async () => {
    await expectRejectedBody(bodyWithEventSources(['demo']));
  });

  it('rejects a response carrying one user-rule event', async () => {
    // Something a person entered themselves is not what the operator published.
    await expectRejectedBody(bodyWithEventSources(['user_rule']));
  });

  it('rejects the whole response when municipal and demo events are mixed', async () => {
    // Not filtered down to the municipal ones: the remainder would be presented as the complete official
    // schedule for the range, and the gap left behind would read as "no collection scheduled".
    await expectRejectedBody(bodyWithEventSources(['municipal_ics', 'demo', 'municipal_ics']));
  });

  it('rejects the whole response when municipal and user-rule events are mixed', async () => {
    await expectRejectedBody(bodyWithEventSources(['municipal_ics', 'user_rule']));
  });
});

/**
 * Two valid instants do not make a valid window.
 *
 * An inverted one passed transport validation, was cached, and then threw inside the domain adapter — during
 * React rendering, or inside the alarm handler where nobody would see it. Refusing it here makes it an
 * `invalid_response` before it can be mapped, rendered, reminded about, or stored.
 */
describe('a mobile drop-off window', () => {
  const REQUEST = {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-stadtmitte',
    range: RANGE,
  } as const;

  /** One drop-off event with the given window, alongside nothing else. */
  const bodyWithWindow = (startsAt: string, endsAt: string): Record<string, unknown> => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);
    const dropOff = mutableCopy(COLLECTION_EVENTS_BODY.data[1]);

    dropOff.timing = { ...mutableCopy(COLLECTION_EVENTS_BODY.data[1].timing), startsAt, endsAt };
    body.data = [dropOff];

    return body;
  };

  const parse = async (body: unknown) => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(body));

    return clientWith(fetchImpl).listCollectionEvents(REQUEST);
  };

  it('rejects a window whose end precedes its start', async () => {
    expect(
      expectFailure(await parse(bodyWithWindow('2026-03-21T12:00:00Z', '2026-03-21T10:00:00Z'))),
    ).toEqual({ kind: 'invalid_response', operation: 'listCollectionEvents', status: 200 });
  });

  it('accepts a window whose end follows its start', async () => {
    expect((await parse(bodyWithWindow('2026-03-21T10:00:00Z', '2026-03-21T12:00:00Z'))).ok).toBe(
      true,
    );
  });

  it('accepts equal instants, exactly as the domain does', async () => {
    // A zero-length window is a real thing a source can publish, and the two validators must not disagree
    // about whether it is representable.
    expect((await parse(bodyWithWindow('2026-03-21T10:00:00Z', '2026-03-21T10:00:00Z'))).ok).toBe(
      true,
    );
  });

  it('accepts an end that is lexically earlier but chronologically later', async () => {
    // Fractional seconds break string ordering: `...:00.500Z` sorts before `...:00Z` while being later. This is
    // why the comparison is on parsed instants rather than on the strings.
    const startsAt = '2026-03-21T10:00:00Z';
    const endsAt = '2026-03-21T10:00:00.500Z';

    expect(endsAt < startsAt).toBe(true);
    expect((await parse(bodyWithWindow(startsAt, endsAt))).ok).toBe(true);
  });

  it('rejects an inverted window expressed with fractional seconds', async () => {
    // The mirror image, so the case above cannot pass by fractional seconds being ignored.
    expect(
      (await parse(bodyWithWindow('2026-03-21T10:00:00.500Z', '2026-03-21T10:00:00Z'))).ok,
    ).toBe(false);
  });

  it.each([
    ['a positive offset', '2026-03-21T11:00:00+01:00', '2026-03-21T13:00:00+01:00'],
    ['a zero offset', '2026-03-21T10:00:00+00:00', '2026-03-21T12:00:00+00:00'],
  ])(
    'rejects a window written with %s, which this contract does not accept',
    async (_reason, startsAt, endsAt) => {
      /**
       * Documented rather than assumed: `z.iso.datetime()` accepts only a `Z` designator, so an offset-bearing
       * instant never reaches the inversion check — it fails the datetime validation first.
       *
       * The outcome is the required one either way, and it is *why* the comparison uses parsed instants: the day
       * this contract widens to accept offsets, lexical ordering would silently start being wrong.
       */
      expect((await parse(bodyWithWindow(startsAt, endsAt))).ok).toBe(false);
    },
  );

  it('rejects the whole response when one event among valid ones is inverted', async () => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);
    const inverted = mutableCopy(COLLECTION_EVENTS_BODY.data[1]);

    inverted.id = 'inverted-drop-off';
    inverted.timing = {
      ...mutableCopy(COLLECTION_EVENTS_BODY.data[1].timing),
      startsAt: '2026-03-21T12:00:00Z',
      endsAt: '2026-03-21T10:00:00Z',
    };
    body.data = [mutableCopy(COLLECTION_EVENTS_BODY.data[0]), inverted];

    const { fetchImpl } = recordingFetch(() => jsonResponse(body));

    expect(expectFailure(await clientWith(fetchImpl).listCollectionEvents(REQUEST)).kind).toBe(
      'invalid_response',
    );
  });
});

/**
 * A source link becomes an `href` on a user-visible link, so its scheme is a trust boundary.
 *
 * `z.url()` accepts any parseable URL, including schemes that are not addresses: `javascript:` would put script
 * execution one click away, and `data:`/`blob:` would let a response render arbitrary content under the
 * extension's own origin. React escaping is no help — it escapes text, and this value is an attribute whose
 * scheme decides what activating it does.
 */
describe('the source landing-page link', () => {
  const REQUEST = {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-stadtmitte',
    range: RANGE,
  } as const;

  const bodyWithLink = (landingPageUrl: string): Record<string, unknown> => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);
    const meta = mutableCopy(COLLECTION_EVENTS_BODY.meta);

    meta.source = { ...mutableCopy(COLLECTION_EVENTS_BODY.meta.source), landingPageUrl };
    body.meta = meta;

    return body;
  };

  const parse = async (landingPageUrl: string) => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(bodyWithLink(landingPageUrl)));

    return clientWith(fetchImpl).listCollectionEvents(REQUEST);
  };

  it.each([
    ['plain HTTP', 'http://servicebetrieb.koblenz.de/'],
    ['HTTPS', 'https://servicebetrieb.koblenz.de/'],
    [
      'the official Koblenz landing page, path intact',
      'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
    ],
    ['a query', 'https://servicebetrieb.koblenz.de/termine?bezirk=stadtmitte'],
    ['a fragment', 'https://servicebetrieb.koblenz.de/termine#stadtmitte'],
    ['a port', 'https://servicebetrieb.koblenz.de:8443/termine'],
  ])('accepts %s', async (_reason, url) => {
    const result = await parse(url);

    expect(result.ok).toBe(true);
    // Preserved exactly: normalizing it would misrepresent the address the operator published.
    expect(result.ok && result.data.meta.source.landingPageUrl).toBe(url);
  });

  it.each([
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a file: path', 'file:///etc/passwd'],
    ['an ftp: address', 'ftp://servicebetrieb.koblenz.de/termine'],
    ['a blob: URL', 'blob:https://servicebetrieb.koblenz.de/1234'],
    ['an HTTPS URL carrying a username', 'https://user@servicebetrieb.koblenz.de/'],
    ['an HTTPS URL carrying credentials', 'https://user:secret@servicebetrieb.koblenz.de/'],
    ['an HTTP URL carrying credentials', 'http://user:secret@servicebetrieb.koblenz.de/'],
    ['a malformed value', 'not a url'],
    ['a scheme-relative value', '//servicebetrieb.koblenz.de/'],
    ['an empty value', ''],
  ])('rejects %s as an invalid response', async (_reason, url) => {
    expect(expectFailure(await parse(url))).toEqual({
      kind: 'invalid_response',
      operation: 'listCollectionEvents',
      status: 200,
    });
  });
});

/**
 * Four valid dates do not make a coherent answer.
 *
 * The requested range is clamped into the declared window, the cache records the served range as covered, and the
 * display range is derived from it — so a range reaching outside the window turns "no data" into "nothing
 * scheduled", and an inverted window makes every derivation empty.
 */
describe('validity-window consistency', () => {
  const REQUEST_RANGE = { from: '2026-03-01', to: '2026-03-31' } as const;

  const REQUEST = {
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-stadtmitte',
    range: REQUEST_RANGE,
  } as const;

  /** A response for the March range, with the validity window and served range under test. */
  const bodyWith = ({
    validFrom = '2026-01-01',
    validTo = '2026-12-31',
    range = REQUEST_RANGE,
  }: {
    validFrom?: string;
    validTo?: string;
    range?: { from: string; to: string };
  } = {}) => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);
    const meta = mutableCopy(COLLECTION_EVENTS_BODY.meta);

    meta.validFrom = validFrom;
    meta.validTo = validTo;
    meta.range = range;
    body.meta = meta;
    // One event inside the requested range, so only the relations under test decide the outcome.
    body.data = [{ ...mutableCopy(COLLECTION_EVENTS_BODY.data[0]), date: '2026-03-14' }];

    return body;
  };

  const parse = async (body: unknown) => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(body));

    return clientWith(fetchImpl).listCollectionEvents(REQUEST);
  };

  it('rejects an inverted validity window', async () => {
    expect((await parse(bodyWith({ validFrom: '2026-12-31', validTo: '2026-01-01' }))).ok).toBe(
      false,
    );
  });

  it('rejects a served range that begins before the declared window', async () => {
    expect((await parse(bodyWith({ validFrom: '2026-03-15' }))).ok).toBe(false);
  });

  it('rejects a served range that ends after the declared window', async () => {
    expect((await parse(bodyWith({ validTo: '2026-03-15' }))).ok).toBe(false);
  });

  it('accepts a window whose boundaries are exactly the served range', async () => {
    // A range equal to the window at both ends is inside it, so the comparison is inclusive.
    expect(
      (await parse(bodyWith({ validFrom: REQUEST_RANGE.from, validTo: REQUEST_RANGE.to }))).ok,
    ).toBe(true);
  });

  it('accepts a served range that is a proper subrange of the window', async () => {
    expect((await parse(bodyWith())).ok).toBe(true);
  });

  it('rejects an inverted served range, which can no longer match the request either', async () => {
    expect(
      (await parse(bodyWith({ range: { from: REQUEST_RANGE.to, to: REQUEST_RANGE.from } }))).ok,
    ).toBe(false);
  });

  it('reports every one of these as an invalid response rather than a problem', async () => {
    // No Problem Details body was involved, so no code and no request identifier is invented for it.
    const failure = expectFailure(await parse(bodyWith({ validTo: '2026-03-15' })));

    expect(failure).toEqual({
      kind: 'invalid_response',
      operation: 'listCollectionEvents',
      status: 200,
    });
  });
});

describe('the service-area capability window', () => {
  const bodyWithValidity = (validity: { from: string; to: string }): Record<string, unknown> => {
    const body = mutableCopy(SERVICE_AREA_LIST_BODY);
    const area = mutableCopy(SERVICE_AREA_LIST_BODY.data[0]);

    area.collectionEvents = { availability: 'available', timeZone: 'Europe/Berlin', validity };
    body.data = [area];

    return body;
  };

  it('rejects an inverted window before any range could be derived from it', async () => {
    // `deriveTargetRange` clamps into this window, so an inverted one would silently produce an empty range and
    // read as the source publishing nothing.
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(bodyWithValidity({ from: '2026-12-31', to: '2026-01-01' })),
    );

    expect(
      expectFailure(await clientWith(fetchImpl).listServiceAreas('koblenz-servicebetrieb')),
    ).toEqual({ kind: 'invalid_response', operation: 'listServiceAreas', status: 200 });
  });

  it('accepts a window whose ends are the same day', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(bodyWithValidity({ from: '2026-03-01', to: '2026-03-01' })),
    );

    expect((await clientWith(fetchImpl).listServiceAreas('koblenz-servicebetrieb')).ok).toBe(true);
  });

  it('accepts an ordinary window', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(bodyWithValidity({ from: '2026-01-01', to: '2026-12-31' })),
    );

    expect((await clientWith(fetchImpl).listServiceAreas('koblenz-servicebetrieb')).ok).toBe(true);
  });
});
