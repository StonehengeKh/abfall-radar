import {
  type ApiClient,
  type ApiFailure,
  type ApiResult,
  type CollectionEventListResponse,
  createApiClient,
  type ProviderListResponse,
  type ServiceAreaListResponse,
} from '@abfall-radar/api-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  GatewayFailureSchema,
  ProvidersResponseSchema,
  RestoredScheduleResponseSchema,
  ScheduleResponseSchema,
  ServiceAreasResponseSchema,
  SettingsWriteResponseSchema,
} from '@/src/messaging/contract';
import { readCacheEntry, writeCacheEntry } from '@/src/storage/schedule-cache';
import { defaultSettings, type ServiceAreaSelection } from '@/src/storage/settings';
import {
  invalidateSelectionIfMatches,
  readSettings,
  writeSettings,
} from '@/src/storage/settings-repository';
import {
  AVAILABLE_CAPABILITY,
  CATALOGUE_WITH_DEMO,
  curbsideEvent,
  evidenceFor,
  MIXED_AREAS,
  mobileDropOffEvent,
  OFFICIAL_AREA_ID,
  OFFICIAL_PROVIDER_ID,
  schedule,
  UNAVAILABLE_CAPABILITY,
} from '@/src/test/fixtures';
import { createGateway } from './gateway';
import { showReminder } from './reminder';
import type { GatewayLogger } from './logger';

const ORIGIN = 'http://127.0.0.1:3000';

const NOW = new Date('2026-03-01T09:00:00.000Z');

const RANGE = { from: '2026-03-01', to: '2026-05-30' } as const;

const SCHEDULE_REQUEST = {
  kind: 'list_collection_events',
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: OFFICIAL_AREA_ID,
  ...RANGE,
} as const;

const RESTORE_REQUEST = {
  kind: 'restore_cached_schedule',
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: OFFICIAL_AREA_ID,
} as const;

const ok = <Data>(data: Data): ApiResult<Data> => ({ ok: true, data });

const failed = <Data>(failure: ApiFailure): ApiResult<Data> => ({ ok: false, failure });

/**
 * The transport response the API really returns for a schedule, before the worker flattens it.
 *
 * `serviceAreaId` threads through the metadata **and** the default events, because a response whose events
 * name a different area than its metadata is one the real client refuses outright — so a fixture that mixed
 * them could not stand in for a working server.
 */
const collectionEventsResponse = ({
  retrievedAt = '2026-03-01T08:14:02.000Z',
  freshness = 'fresh' as 'fresh' | 'stale',
  range = RANGE as { readonly from: string; readonly to: string },
  serviceAreaId = OFFICIAL_AREA_ID,
  // Widened from the default rather than inferred, so a drop-off can be served too. Inference from a
  // curbside-only default narrowed this parameter to that one variant.
  events = [
    curbsideEvent('2026-03-10', 'paper', serviceAreaId),
  ] as CollectionEventListResponse['data'],
} = {}): CollectionEventListResponse => ({
  data: events,
  meta: {
    provider: {
      id: OFFICIAL_PROVIDER_ID,
      name: 'Kommunaler Servicebetrieb',
      sourceKind: 'official_ics' as const,
    },
    serviceArea: { id: serviceAreaId, locality: 'Koblenz', name: 'Stadtmitte' },
    source: {
      name: 'Kommunaler Servicebetrieb',
      landingPageUrl:
        'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
      attribution: 'Kommunaler Servicebetrieb, Koblenz',
      timeZone: 'Europe/Berlin',
    },
    retrievedAt,
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    freshness,
    coverage: { wasteTypes: ['paper', 'hazardous'] },
    range: { from: range.from, to: range.to },
  },
});

interface StubOptions {
  readonly providers?: () => ApiResult<ProviderListResponse>;
  readonly serviceAreas?: () => ApiResult<ServiceAreaListResponse>;
  readonly collectionEvents?: () => ApiResult<CollectionEventListResponse>;
}

const createStubClient = (options: StubOptions = {}) => {
  const calls = { listProviders: 0, listServiceAreas: 0, listCollectionEvents: 0 };

  const client: ApiClient = {
    origin: ORIGIN,
    timeoutMs: 8000,
    async listProviders() {
      calls.listProviders += 1;

      return options.providers?.() ?? ok({ data: CATALOGUE_WITH_DEMO });
    },
    async listServiceAreas() {
      calls.listServiceAreas += 1;

      return options.serviceAreas?.() ?? ok({ data: MIXED_AREAS });
    },
    async listCollectionEvents(query) {
      calls.listCollectionEvents += 1;

      // Answers the request it was given, as a real server does. Returning a fixed area regardless of what was
      // asked for made this stub incapable of representing a correct response for any other area.
      return (
        options.collectionEvents?.() ??
        ok(collectionEventsResponse({ serviceAreaId: query.serviceAreaId, range: query.range }))
      );
    },
  };

  return { client, calls };
};

const createRecordingLogger = () => {
  const lines: { message: string; fields: Record<string, unknown> }[] = [];

  const logger: GatewayLogger = {
    warn: (message, fields) => {
      lines.push({ message, fields: { ...fields } });
    },
  };

  return { logger, lines };
};

const gatewayWith = (options: StubOptions = {}, now: Date = NOW) => {
  const { client, calls } = createStubClient(options);
  const { logger, lines } = createRecordingLogger();

  return { gateway: createGateway({ client, logger, now: () => now }), calls, lines };
};

describe('the providers operation', () => {
  it('answers with a validated envelope that still labels the demo provider', async () => {
    const { gateway } = gatewayWith();
    const response = await gateway.handle({ kind: 'list_providers' });

    // Filtering demo out is the selection surface's job; the boundary reports what the API said.
    expect(ProvidersResponseSchema.parse(response)).toEqual({
      ok: true,
      data: CATALOGUE_WITH_DEMO,
    });
  });
});

describe('the service-areas operation', () => {
  it('answers with both capability branches intact', async () => {
    const { gateway } = gatewayWith();
    const response = await gateway.handle({
      kind: 'list_service_areas',
      providerId: OFFICIAL_PROVIDER_ID,
    });

    const parsed = ServiceAreasResponseSchema.parse(response);

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.data.map((area) => area.collectionEvents)).toEqual([
        AVAILABLE_CAPABILITY,
        UNAVAILABLE_CAPABILITY,
      ]);
    }
  });
});

describe('the collection-events operation', () => {
  it('flattens the response onto the schedule payload with its provenance', async () => {
    const { gateway } = gatewayWith();
    const parsed = ScheduleResponseSchema.parse(await gateway.handle(SCHEDULE_REQUEST));

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      // Answered as `live`, which is the discriminant that lets the popup label it as the current response.
      // Reading the schedule without checking it is what allowed a restored entry to be labelled that way.
      expect(parsed.data.kind).toBe('live');
    }

    if (parsed.ok && parsed.data.kind === 'live') {
      expect(parsed.data.schedule.provenance).toMatchObject({
        sourceName: 'Kommunaler Servicebetrieb',
        timeZone: 'Europe/Berlin',
        retrievedAt: '2026-03-01T08:14:02.000Z',
        freshness: 'fresh',
        coverage: ['paper', 'hazardous'],
        validity: { from: '2026-01-01', to: '2026-12-31' },
      });
      expect(parsed.data.schedule.servedRange).toEqual(RANGE);
    }
  });

  it('caches a validated response', async () => {
    const { gateway } = gatewayWith();

    await gateway.handle(SCHEDULE_REQUEST);

    const entry = await readCacheEntry(
      { origin: ORIGIN, providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      NOW,
    );

    expect(entry?.schedule.servedRange).toEqual(RANGE);
    expect(entry?.storedAt).toBe(NOW.toISOString());
  });

  it('writes nothing when the refresh fails, preserving a still-usable entry', async () => {
    await writeCacheEntry({
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule(),
      now: NOW,
    });

    const { gateway } = gatewayWith({
      collectionEvents: () => failed({ kind: 'network', operation: 'listCollectionEvents' }),
    });

    const response = await gateway.handle(SCHEDULE_REQUEST);

    expect(response.ok).toBe(false);

    const entry = await readCacheEntry(
      { origin: ORIGIN, providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      NOW,
    );

    expect(entry).toBeDefined();
    expect(entry?.schedule.events).toHaveLength(2);
  });
});

describe('failure envelopes', () => {
  it.each([
    [
      'a problem',
      {
        kind: 'problem' as const,
        operation: 'listCollectionEvents' as const,
        status: 422,
        code: 'SCHEDULE_RANGE_NOT_COVERED',
        requestId: 'req-1',
      },
    ],
    ['a network failure', { kind: 'network' as const, operation: 'listCollectionEvents' as const }],
    [
      'a timeout',
      {
        kind: 'timeout' as const,
        operation: 'listCollectionEvents' as const,
        timeoutMs: 8000,
      },
    ],
    ['a cancellation', { kind: 'cancelled' as const, operation: 'listCollectionEvents' as const }],
    [
      'an invalid response',
      {
        kind: 'invalid_response' as const,
        operation: 'listCollectionEvents' as const,
        status: 500,
      },
    ],
  ])('carries %s across the boundary unchanged', async (_reason, failure) => {
    const { gateway } = gatewayWith({ collectionEvents: () => failed(failure) });
    const response = await gateway.handle(SCHEDULE_REQUEST);

    expect(response).toEqual({ ok: false, failure });
    expect(GatewayFailureSchema.parse(failure)).toEqual(failure);
  });

  it('carries no request identifier on a non-problem failure', async () => {
    for (const failure of [
      { kind: 'network' as const, operation: 'listCollectionEvents' as const },
      { kind: 'timeout' as const, operation: 'listCollectionEvents' as const, timeoutMs: 8000 },
      { kind: 'cancelled' as const, operation: 'listCollectionEvents' as const },
      {
        kind: 'invalid_response' as const,
        operation: 'listCollectionEvents' as const,
        status: 503,
      },
    ]) {
      const { gateway } = gatewayWith({ collectionEvents: () => failed(failure) });
      const response = await gateway.handle(SCHEDULE_REQUEST);

      expect(response.ok).toBe(false);

      if (!response.ok) {
        // Asserted on the key set, so an empty string or a placeholder fails the test.
        expect(Object.keys(response.failure)).not.toContain('requestId');
      }
    }
  });

  it('reports a timeout carrying the configured deadline rather than a measured duration', async () => {
    const { gateway } = gatewayWith({
      collectionEvents: () =>
        failed({ kind: 'timeout', operation: 'listCollectionEvents', timeoutMs: 8000 }),
    });

    const response = await gateway.handle(SCHEDULE_REQUEST);

    expect(response.ok).toBe(false);

    if (!response.ok) {
      expect(Object.keys(response.failure).toSorted()).toEqual(['kind', 'operation', 'timeoutMs']);
      expect(response.failure).toMatchObject({ timeoutMs: 8000 });
    }
  });

  it('carries no server message, path, or input in any envelope', async () => {
    const { gateway } = gatewayWith({
      collectionEvents: () =>
        failed({
          kind: 'problem',
          operation: 'listCollectionEvents',
          status: 422,
          code: 'SCHEDULE_RANGE_NOT_COVERED',
          requestId: 'req-1',
        }),
    });

    const serialized = JSON.stringify(await gateway.handle(SCHEDULE_REQUEST));

    for (const forbidden of ['detail', 'instance', 'errors', 'urn:', 'http']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('an unrecognized message', () => {
  it.each([
    ['an unknown kind', { kind: 'list_everything' }],
    ['a malformed payload', { kind: 'list_service_areas' }],
    ['a message that is not an object', 'list_providers'],
    ['a message with no kind at all', { providerId: OFFICIAL_PROVIDER_ID }],
    ['null', null],
    ['an array', []],
    ['an extra member on a known kind', { kind: 'list_providers', extra: true }],
  ])('answers %s with a kind-only failure', async (_reason, message) => {
    const { gateway } = gatewayWith();
    const response = await gateway.handle(message);

    expect(response).toEqual({ ok: false, failure: { kind: 'unsupported_message' } });

    if (!response.ok) {
      // No operation, no request identifier, no echo of the refused kind, and no copy of the payload.
      expect(Object.keys(response.failure)).toEqual(['kind']);
    }
  });

  it('never reaches the API', async () => {
    const { gateway, calls } = gatewayWith();

    await gateway.handle({ kind: 'list_everything' });

    expect(calls).toEqual({ listProviders: 0, listServiceAreas: 0, listCollectionEvents: 0 });
  });

  it('echoes nothing about the refused message, in the envelope or the log line', async () => {
    const { gateway, lines } = gatewayWith();

    await gateway.handle({ kind: 'exfiltrate', secret: 'do-not-echo-this' });

    expect(JSON.stringify(lines)).not.toContain('do-not-echo-this');
    expect(JSON.stringify(lines)).not.toContain('exfiltrate');
    expect(lines.at(0)?.fields).toEqual({ kind: 'unsupported_message' });
  });
});

describe('logging', () => {
  it('logs the safe fields of a problem failure, including its request identifier', async () => {
    const { gateway, lines } = gatewayWith({
      collectionEvents: () =>
        failed({
          kind: 'problem',
          operation: 'listCollectionEvents',
          status: 422,
          code: 'SCHEDULE_RANGE_NOT_COVERED',
          requestId: 'req-42',
        }),
    });

    await gateway.handle(SCHEDULE_REQUEST);

    expect(lines.at(0)?.fields).toEqual({
      kind: 'problem',
      operation: 'listCollectionEvents',
      status: 422,
      code: 'SCHEDULE_RANGE_NOT_COVERED',
      requestId: 'req-42',
    });
  });

  it('logs no request identifier for a failure that never reached a server', async () => {
    const { gateway, lines } = gatewayWith({
      collectionEvents: () => failed({ kind: 'network', operation: 'listCollectionEvents' }),
    });

    await gateway.handle(SCHEDULE_REQUEST);

    expect(lines.at(0)?.fields).toEqual({ kind: 'network', operation: 'listCollectionEvents' });
    expect(Object.keys(lines.at(0)?.fields ?? {})).not.toContain('requestId');
  });

  it('logs the configured deadline on a timeout and no measured duration', async () => {
    const { gateway, lines } = gatewayWith({
      collectionEvents: () =>
        failed({ kind: 'timeout', operation: 'listCollectionEvents', timeoutMs: 2000 }),
    });

    await gateway.handle(SCHEDULE_REQUEST);

    expect(lines.at(0)?.fields).toEqual({
      kind: 'timeout',
      operation: 'listCollectionEvents',
      timeoutMs: 2000,
    });

    for (const synonym of ['deadlineMs', 'elapsed', 'elapsedMs']) {
      expect(Object.keys(lines.at(0)?.fields ?? {})).not.toContain(synonym);
    }
  });

  it('logs no successful request', async () => {
    const { gateway, lines } = gatewayWith();

    await gateway.handle({ kind: 'list_providers' });

    expect(lines).toEqual([]);
  });
});

describe('coalescing', () => {
  it('turns identical concurrent requests into one upstream call', async () => {
    const { gateway, calls } = gatewayWith();

    const [first, second, third] = await Promise.all([
      gateway.handle({ kind: 'list_providers' }),
      gateway.handle({ kind: 'list_providers' }),
      gateway.handle({ kind: 'list_providers' }),
    ]);

    expect(calls.listProviders).toBe(1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it('does not coalesce requests for different areas', async () => {
    const { gateway, calls } = gatewayWith();

    await Promise.all([
      gateway.handle(SCHEDULE_REQUEST),
      gateway.handle({ ...SCHEDULE_REQUEST, serviceAreaId: 'koblenz-oberwerth' }),
    ]);

    expect(calls.listCollectionEvents).toBe(2);
  });

  it('does not coalesce requests for different ranges', async () => {
    const { gateway, calls } = gatewayWith();

    await Promise.all([
      gateway.handle(SCHEDULE_REQUEST),
      gateway.handle({ ...SCHEDULE_REQUEST, to: '2026-05-31' }),
    ]);

    expect(calls.listCollectionEvents).toBe(2);
  });

  it('issues a fresh call once the first has settled', async () => {
    const { gateway, calls } = gatewayWith();

    await gateway.handle({ kind: 'list_providers' });
    await gateway.handle({ kind: 'list_providers' });

    expect(calls.listProviders).toBe(2);
  });
});

/**
 * The popup and the worker's own reads share one flight.
 *
 * Coalescing used to be keyed on the parsed message, so only `handle` was covered — the reminder called the
 * typed operations directly and bypassed it. A reminder firing while the popup was open therefore issued a
 * second identical HTTP request for the same provider, area, and range, and the two answers could disagree
 * about which one won the cache.
 */
describe('coalescing across the message boundary and the worker', () => {
  it('turns a concurrent handle and internal providers read into one upstream call', async () => {
    const { gateway, calls } = gatewayWith();

    const [envelope, internal] = await Promise.all([
      gateway.handle({ kind: 'list_providers' }),
      gateway.listProviders(),
    ]);

    expect(calls.listProviders).toBe(1);
    // Both callers got the same answer, because there was only one.
    expect(envelope).toEqual(internal);
  });

  it('turns concurrent service-area reads for one provider into one upstream call', async () => {
    const { gateway, calls } = gatewayWith();

    await Promise.all([
      gateway.handle({ kind: 'list_service_areas', providerId: OFFICIAL_PROVIDER_ID }),
      gateway.listServiceAreas(OFFICIAL_PROVIDER_ID),
      gateway.listServiceAreas(OFFICIAL_PROVIDER_ID),
    ]);

    expect(calls.listServiceAreas).toBe(1);
  });

  it('does not coalesce service-area reads for different providers', async () => {
    const { gateway, calls } = gatewayWith();

    await Promise.all([
      gateway.listServiceAreas(OFFICIAL_PROVIDER_ID),
      gateway.listServiceAreas('another-provider'),
    ]);

    expect(calls.listServiceAreas).toBe(2);
  });

  it('turns concurrent collection-events reads for the same range into one upstream call', async () => {
    const { gateway, calls } = gatewayWith();

    const [envelope, internal] = await Promise.all([
      gateway.handle(SCHEDULE_REQUEST),
      gateway.listCollectionEvents({
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        ...RANGE,
      }),
    ]);

    expect(calls.listCollectionEvents).toBe(1);
    expect(envelope).toEqual(internal);
  });

  it('does not coalesce collection-events reads for different ranges', async () => {
    const { gateway, calls } = gatewayWith();

    await Promise.all([
      gateway.listCollectionEvents({
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        ...RANGE,
      }),
      gateway.listCollectionEvents({
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        from: RANGE.from,
        to: '2026-06-30',
      }),
    ]);

    // A different range is a different question, so it gets its own request.
    expect(calls.listCollectionEvents).toBe(2);
  });

  it('does not coalesce collection-events reads for different areas', async () => {
    const { gateway, calls } = gatewayWith();

    await Promise.all([
      gateway.listCollectionEvents({
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        ...RANGE,
      }),
      gateway.listCollectionEvents({
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: 'koblenz-oberwerth',
        ...RANGE,
      }),
    ]);

    expect(calls.listCollectionEvents).toBe(2);
  });

  it('removes a shared failed flight, so a retry issues a new request', async () => {
    const listProviders = vi
      .fn<ApiClient['listProviders']>()
      .mockResolvedValueOnce(failed({ kind: 'network', operation: 'listProviders' }))
      .mockResolvedValueOnce(ok({ data: CATALOGUE_WITH_DEMO }));

    const gateway = createGateway({
      client: {
        origin: ORIGIN,
        timeoutMs: 8000,
        listProviders,
        listServiceAreas: async () => ok({ data: MIXED_AREAS }),
        listCollectionEvents: async () => ok(collectionEventsResponse()),
      },
      logger: createRecordingLogger().logger,
      now: () => NOW,
    });

    // Both callers share the failure — one request, one answer.
    const [first, second] = await Promise.all([
      gateway.handle({ kind: 'list_providers' }),
      gateway.listProviders(),
    ]);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(listProviders).toHaveBeenCalledTimes(1);

    // The settled flight was removed, so the retry really asks again rather than being handed the failure.
    expect((await gateway.listProviders()).ok).toBe(true);
    expect(listProviders).toHaveBeenCalledTimes(2);
  });

  it('does not coalesce an invalidation with a read', async () => {
    /**
     * Two **different** areas, deliberately. A restore racing an invalidation of the same area now correctly
     * answers "nothing cached" — the withdrawal guard withholds it — and that answer is shaped exactly like an
     * eviction's, so same-area concurrency can no longer tell coalescing apart from the guard doing its job.
     * Different areas isolate the property under test: one flight must not return the other's answer.
     */
    const { gateway, calls } = gatewayWith();

    await writeCacheEntry({
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule({ events: [curbsideEvent('2026-03-10')] }),
      now: NOW,
    });

    const [restored, invalidated] = await Promise.all([
      gateway.handle(RESTORE_REQUEST),
      gateway.handle({
        kind: 'invalidate_cached_schedule',
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: 'koblenz-oberwerth',
      }),
    ]);

    // Each answered as itself: an eviction is never reported as a schedule, or the reverse.
    expect(invalidated).toEqual({ ok: true, data: null });
    expect(restored.ok === true && restored.data).not.toBeNull();
    // Neither touched the network.
    expect(calls.listCollectionEvents).toBe(0);
  });
});

describe('the local cache restore', () => {
  const seedCache = async (
    options: Parameters<typeof schedule>[0] = {},
    storedAt: Date = NOW,
  ): Promise<void> => {
    await writeCacheEntry({
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule(options),
      now: storedAt,
    });
  };

  it('issues no request at all', async () => {
    await seedCache();

    const { gateway, calls } = gatewayWith();

    await gateway.handle(RESTORE_REQUEST);

    expect(calls).toEqual({ listProviders: 0, listServiceAreas: 0, listCollectionEvents: 0 });
  });

  it('answers null when nothing is cached, which is not a failure', async () => {
    const { gateway } = gatewayWith();
    const response = RestoredScheduleResponseSchema.parse(await gateway.handle(RESTORE_REQUEST));

    expect(response).toEqual({ ok: true, data: null });
  });

  it('restores full coverage when the served range contains the derived window', async () => {
    await seedCache({ servedRange: { from: '2026-02-01', to: '2026-06-30' } });

    const { gateway } = gatewayWith();
    const response = RestoredScheduleResponseSchema.parse(await gateway.handle(RESTORE_REQUEST));

    expect(response.ok).toBe(true);

    if (response.ok && response.data !== null) {
      expect(response.data.coverage).toBe('full');
      // Equal to the requested range, which is the derived 90-day window.
      expect(response.data.displayRange).toEqual({ from: '2026-03-01', to: '2026-05-30' });
      expect(response.data.requestedRange).toEqual({ from: '2026-03-01', to: '2026-05-30' });
    }
  });

  it('restores partial coverage after the window advances by exactly one day', async () => {
    // The ordinary daily case. A containment-only check would pass every same-day test and then render the
    // uncovered final day as "no collection scheduled".
    await seedCache({
      servedRange: { from: '2026-03-01', to: '2026-05-30' },
      events: [curbsideEvent('2026-03-10'), curbsideEvent('2026-05-31')],
    });

    const { gateway } = gatewayWith({}, new Date('2026-03-02T09:00:00.000Z'));
    const response = RestoredScheduleResponseSchema.parse(await gateway.handle(RESTORE_REQUEST));

    expect(response.ok).toBe(true);

    if (response.ok && response.data !== null) {
      expect(response.data.coverage).toBe('partial');
      expect(response.data.displayRange).toEqual({ from: '2026-03-02', to: '2026-05-30' });
      expect(response.data.requestedRange).toEqual({ from: '2026-03-02', to: '2026-05-31' });
      // The event beyond the served end is not presented, so its absence is never read as "nothing scheduled".
      expect(response.data.schedule.events.map((event) => event.date)).toEqual(['2026-03-10']);
    }
  });

  it('returns no event outside the display range', async () => {
    await seedCache({
      servedRange: { from: '2026-03-01', to: '2026-04-30' },
      events: [
        curbsideEvent('2026-02-20'),
        curbsideEvent('2026-03-10'),
        curbsideEvent('2026-05-20'),
      ],
    });

    const { gateway } = gatewayWith();
    const response = RestoredScheduleResponseSchema.parse(await gateway.handle(RESTORE_REQUEST));

    if (response.ok && response.data !== null) {
      const { displayRange, schedule: restored } = response.data;

      for (const event of restored.events) {
        expect(event.date >= displayRange.from && event.date <= displayRange.to).toBe(true);
      }

      expect(restored.events.map((event) => event.date)).toEqual(['2026-03-10']);
    }
  });

  it('answers null when the served range no longer overlaps the derived window', async () => {
    await seedCache({ servedRange: { from: '2026-01-01', to: '2026-02-15' } });

    const { gateway } = gatewayWith();
    const response = await gateway.handle(RESTORE_REQUEST);

    expect(response).toEqual({ ok: true, data: null });
  });

  it('answers null for an entry past its retention rather than taking a snapshot from it', async () => {
    await seedCache({}, new Date('2026-02-01T09:00:00.000Z'));

    const { gateway } = gatewayWith();

    expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
  });

  it('answers null for an entry stored under another origin', async () => {
    await writeCacheEntry({
      origin: 'https://api.example.test',
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule(),
      now: NOW,
    });

    const { gateway } = gatewayWith();

    expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
  });

  it('derives the window from the entry’s own capability snapshot', async () => {
    // The snapshot is the response's validated zone and validity window, so no second persisted
    // representation exists and nothing is guessed.
    await seedCache({ servedRange: { from: '2026-11-01', to: '2026-12-31' } });

    const { gateway } = gatewayWith({}, new Date('2026-12-01T09:00:00.000Z'));
    const response = RestoredScheduleResponseSchema.parse(await gateway.handle(RESTORE_REQUEST));

    if (response.ok && response.data !== null) {
      // Clamped to the snapshot's `validTo` rather than running 90 days past it.
      expect(response.data.requestedRange).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    }
  });

  it('answers null when the derived today is past the snapshot’s validity', async () => {
    await seedCache();

    const { gateway } = gatewayWith({}, new Date('2027-01-05T09:00:00.000Z'));

    expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
  });

  it('leaves the stored entry’s contents and served range untouched', async () => {
    // Restoring bounds only the presented view. Stored two days before the read, so the entry is well
    // inside its retention and the partial intersection is what bounds the result.
    const readAt = new Date('2026-04-01T09:00:00.000Z');

    await seedCache(
      {
        servedRange: { from: '2026-03-01', to: '2026-04-30' },
        events: [curbsideEvent('2026-03-10'), curbsideEvent('2026-04-20')],
      },
      new Date('2026-03-30T09:00:00.000Z'),
    );

    const { gateway } = gatewayWith({}, readAt);
    const response = RestoredScheduleResponseSchema.parse(await gateway.handle(RESTORE_REQUEST));

    // The presented view is bounded to the intersection.
    if (response.ok && response.data !== null) {
      expect(response.data.coverage).toBe('partial');
      expect(response.data.displayRange).toEqual({ from: '2026-04-01', to: '2026-04-30' });
      expect(response.data.schedule.events.map((event) => event.date)).toEqual(['2026-04-20']);
    }

    const entry = await readCacheEntry(
      { origin: ORIGIN, providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      readAt,
    );

    // The stored entry still holds everything, so a later request overlapping differently finds it all.
    expect(entry?.schedule.events).toHaveLength(2);
    expect(entry?.schedule.servedRange).toEqual({ from: '2026-03-01', to: '2026-04-30' });
  });

  it('reports the stored time, so a restored entry can be labelled with its own age', async () => {
    await seedCache({}, new Date('2026-03-01T07:00:00.000Z'));

    const { gateway } = gatewayWith();
    const response = RestoredScheduleResponseSchema.parse(await gateway.handle(RESTORE_REQUEST));

    if (response.ok && response.data !== null) {
      expect(response.data.storedAt).toBe('2026-03-01T07:00:00.000Z');
      expect(response.data.schedule.provenance.retrievedAt).toBe('2026-03-01T08:14:02.000Z');
    }
  });
});

describe('the local cache invalidation', () => {
  const KEY_PARTS = {
    origin: ORIGIN,
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  };

  const INVALIDATE_REQUEST = {
    kind: 'invalidate_cached_schedule',
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  const seedCache = async (): Promise<void> => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });
  };

  it('issues no request at all', async () => {
    await seedCache();

    const { gateway, calls } = gatewayWith();

    await gateway.handle(INVALIDATE_REQUEST);

    expect(calls).toEqual({ listProviders: 0, listServiceAreas: 0, listCollectionEvents: 0 });
  });

  /**
   * Invalidation is a **state**, so a surviving entry stays unusable.
   *
   * It used to be nothing more than a successful deletion, which made it exactly as reliable as the storage write
   * it depended on: a refused write left the entry restorable, and the next popup presented a schedule the operator
   * had stopped publishing as current official data. The worker's generation covered that within one lifetime and
   * nothing at all after a restart.
   */
  describe('a withdrawal whose physical eviction was refused', () => {
    afterEach(() => {
      // Unconditional, because an inline restore is skipped when an assertion throws — and a storage spy left
      // installed silently fails every later test in this file with a timeout instead of a reason.
      vi.restoreAllMocks();
    });

    /** Refuses only the cache key, so the tombstone write still lands — the case the guarantee rests on. */
    const refuseCacheWritesOnly = () => {
      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);

      vi.spyOn(store, 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if ('schedule-cache' in items) {
          throw new Error('storage unavailable');
        }

        return write(items);
      });
      vi.spyOn(store, 'remove').mockRejectedValue(new Error('storage unavailable'));
    };

    it('withholds the surviving entry from a restore in the same worker', async () => {
      await seedCache();
      refuseCacheWritesOnly();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      const restored = await gateway.handle(RESTORE_REQUEST);

      vi.restoreAllMocks();

      // The entry is still on disk, and it is still not restorable.
      expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
      expect(restored).toEqual({ ok: true, data: null });
    });

    it('persists the withdrawal, so a rebuilt worker still refuses it', async () => {
      /**
       * A fresh gateway stands in for the restart: the in-memory generation map is gone with the old instance, so
       * only the durable tombstone can carry the withdrawal across. This is the case the in-memory marker alone
       * could never cover.
       */
      await seedCache();
      refuseCacheWritesOnly();

      const first = gatewayWith();

      await first.gateway.handle(INVALIDATE_REQUEST);

      vi.restoreAllMocks();

      const rebuilt = gatewayWith();

      expect(await rebuilt.gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
      // And it really is the tombstone doing it: the entry is present and otherwise valid.
      expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
    });

    it('leaves an unrelated area restorable', async () => {
      // A withdrawal is about one area. Withholding everything would turn one operator's change into an outage.
      const otherParts = { ...KEY_PARTS, serviceAreaId: 'koblenz-oberwerth' };

      await seedCache();
      await writeCacheEntry({
        ...otherParts,
        schedule: schedule({ serviceAreaId: 'koblenz-oberwerth' }),
        now: NOW,
      });
      refuseCacheWritesOnly();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      const other = await gateway.handle({
        kind: 'restore_cached_schedule',
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: 'koblenz-oberwerth',
      });

      vi.restoreAllMocks();

      expect(other.ok === true && other.data).not.toBeNull();
    });

    it('still clears nothing of the caller’s business: the invalidation is acknowledged', async () => {
      // Restated here because the two requirements pull in opposite directions and both must hold: the entry is
      // withheld, *and* the caller is free to go on and clear the selection.
      await seedCache();
      refuseCacheWritesOnly();

      const { gateway } = gatewayWith();
      const response = await gateway.handle(INVALIDATE_REQUEST);

      vi.restoreAllMocks();

      expect(response).toEqual({ ok: true, data: null });
    });
  });

  /**
   * Same-worker safety when **every** persistent write is refused.
   *
   * The generation counter and the durable tombstone each cover something this does not. The generation rejects work
   * that started *before* an invalidation, so a restore issued afterwards captures the current value, finds it
   * unchanged, and used to hand the entry straight back. The tombstone covers a restart, but only if its write
   * landed. With both storage operations refused the whole withdrawal came down to the selection clear — and if
   * that failed too, nothing was left at all.
   */
  describe('a withdrawal whose every persistent write is refused', () => {
    afterEach(() => {
      // Unconditional: an inline restore is skipped when an assertion throws, and a leaked storage spy fails
      // every later test in this file with a timeout instead of a reason.
      vi.restoreAllMocks();
    });

    /** Refuses every write and every removal, so neither the tombstone nor the eviction can land. */
    const refuseAllWrites = () => {
      vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(
        new Error('storage unavailable'),
      );
      vi.spyOn(fakeBrowser.storage.local, 'remove').mockRejectedValue(
        new Error('storage unavailable'),
      );
    };

    it('still acknowledges the invalidation as successful', async () => {
      await seedCache();
      refuseAllWrites();

      const { gateway } = gatewayWith();

      // The caller must not be blocked: the part that matters happened in memory and cannot fail.
      expect(await gateway.handle(INVALIDATE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('returns no schedule from a restore later in the same worker', async () => {
      /**
       * The defect. The entry is still on disk, still valid, and no tombstone exists — the only thing standing
       * between it and the popup is the in-memory marker.
       */
      await seedCache();
      refuseAllWrites();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });

      vi.restoreAllMocks();

      // Proof the entry really did survive, so the guard above is what refused it.
      expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
    });

    it('returns no schedule even when the selection clear is refused too', async () => {
      // Same-worker safety must not depend on the selection clear having been persisted.
      await writeSettings({
        ...defaultSettings,
        selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
        visibleWasteTypes: ['paper'],
      });
      await seedCache();
      refuseAllWrites();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      const cleared = await gateway.handle({
        kind: 'invalidate_selection_if_matches',
        expectedSelection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      });

      // The clear failed, and the entry is still withheld regardless.
      expect(cleared.ok).toBe(false);
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('gives a worker-internal caller the same answer, so no reminder can be built from it', async () => {
      await seedCache();
      refuseAllWrites();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      // The reminder reads through this typed method rather than the message boundary.
      expect(
        await gateway.restoreCachedSchedule({
          providerId: OFFICIAL_PROVIDER_ID,
          serviceAreaId: OFFICIAL_AREA_ID,
        }),
      ).toBeNull();
    });

    it('cannot be repainted by a popup reopening against the same worker', async () => {
      // A popup reopening issues a fresh restore *after* the invalidation, which is precisely the case the
      // generation counter cannot see.
      await seedCache();
      refuseAllWrites();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      for (const attempt of [1, 2, 3]) {
        expect(await gateway.handle(RESTORE_REQUEST), `attempt ${attempt}`).toEqual({
          ok: true,
          data: null,
        });
      }
    });

    it('leaves an unrelated key perfectly restorable', async () => {
      const otherParts = { ...KEY_PARTS, serviceAreaId: 'koblenz-oberwerth' };

      await seedCache();
      await writeCacheEntry({
        ...otherParts,
        schedule: schedule({ serviceAreaId: 'koblenz-oberwerth' }),
        now: NOW,
      });
      refuseAllWrites();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      const other = await gateway.handle({
        kind: 'restore_cached_schedule',
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: 'koblenz-oberwerth',
      });

      expect(other.ok === true && other.data).not.toBeNull();
    });

    it('is idempotent when the same key is invalidated again', async () => {
      await seedCache();
      refuseAllWrites();

      const { gateway } = gatewayWith();

      expect(await gateway.handle(INVALIDATE_REQUEST)).toEqual({ ok: true, data: null });
      expect(await gateway.handle(INVALIDATE_REQUEST)).toEqual({ ok: true, data: null });
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });
  });

  /**
   * What may and may not lift the in-memory marker.
   *
   * Only a validated response from a request that started after the withdrawal, whose persisted entry *and*
   * tombstone are both safe afterwards. Anything weaker would restore exactly the data the withdrawal was about.
   */
  describe('lifting the in-memory marker', () => {
    afterEach(() => {
      // Unconditional: an inline restore is skipped when an assertion throws, and a leaked storage spy fails
      // every later test in this file with a timeout instead of a reason.
      vi.restoreAllMocks();
    });

    /** A gateway whose collection-events call is held open until released. */
    const gatewayWithHeldEvents = () => {
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: (() => void) | undefined;
      const hasStarted = new Promise<void>((resolve) => {
        started = resolve;
      });

      const client: ApiClient = {
        origin: ORIGIN,
        timeoutMs: 8000,
        listProviders: async () => ok({ data: CATALOGUE_WITH_DEMO }),
        listServiceAreas: async () => ok({ data: MIXED_AREAS }),
        listCollectionEvents: async (query) => {
          started?.();
          await held;

          return ok(
            collectionEventsResponse({ serviceAreaId: query.serviceAreaId, range: query.range }),
          );
        },
      };

      return {
        gateway: createGateway({ client, logger: createRecordingLogger().logger, now: () => NOW }),
        hasStarted,
        release: () => release?.(),
      };
    };

    it('is not lifted by a response that started before the invalidation', async () => {
      const { gateway, hasStarted, release } = gatewayWithHeldEvents();

      await seedCache();

      const inFlight = gateway.handle(SCHEDULE_REQUEST);

      await hasStarted;
      await gateway.handle(INVALIDATE_REQUEST);

      release();
      await inFlight;

      // The response was real but older than the withdrawal, so nothing about it may revive the key.
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('is not lifted when the cache write is refused', async () => {
      /**
       * The live answer is still delivered — it is a current validated response — but offline restoration stays
       * blocked, because what is on disk was never replaced.
       */
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(
        new Error('storage unavailable'),
      );

      const live = await gateway.handle(SCHEDULE_REQUEST);

      vi.restoreAllMocks();

      expect(live.ok).toBe(true);
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('is lifted by a fully persisted validated response that started afterwards', async () => {
      // The one case that lifts it, so the guard is not permanent.
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });

      const live = await gateway.handle(SCHEDULE_REQUEST);

      expect(live.ok).toBe(true);

      const restored = await gateway.handle(RESTORE_REQUEST);

      expect(restored.ok === true && restored.data).not.toBeNull();
    });

    it('is not lifted by a restore attempt on its own', async () => {
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      await gateway.handle(RESTORE_REQUEST);
      await gateway.handle(RESTORE_REQUEST);

      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });
  });

  /**
   * Replacing a withdrawn entry, as a transaction with an order.
   *
   * Cache entry, durable tombstone and in-memory marker have to move in one direction only: write the replacement,
   * then remove the tombstone, then clear the marker. Every other order leaves a window in which the withdrawal is
   * forgotten before the replacement exists — and a worker destroyed in that window comes back holding withdrawn
   * data with nothing left saying so.
   */
  describe('replacing a withdrawn entry', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Fails only the schedule-cache key, so the tombstone store still works. */
    const refuseCacheWrites = () => {
      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);

      vi.spyOn(store, 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if ('schedule-cache' in items) {
          throw new Error('storage unavailable');
        }

        return write(items);
      });
    };

    /** Fails only the tombstone key, so the replacement write still lands. */
    const refuseTombstoneWrites = () => {
      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);

      vi.spyOn(store, 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if ('schedule-tombstones' in items) {
          throw new Error('storage unavailable');
        }

        return write(items);
      });
    };

    const tombstones = async (): Promise<Record<string, unknown>> =>
      ((await fakeBrowser.storage.local.get('schedule-tombstones'))['schedule-tombstones'] ??
        {}) as Record<string, unknown>;

    it('keeps the tombstone durable when the replacement write is refused', async () => {
      /**
       * The window this ordering closes. With the tombstone cleared first, this state — no tombstone and no
       * replacement — was reachable, and a restart in it restored the withdrawn entry.
       */
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      expect(Object.keys(await tombstones())).toHaveLength(1);

      refuseCacheWrites();

      const live = await gateway.handle(SCHEDULE_REQUEST);

      vi.restoreAllMocks();

      // Delivered, because it is a real current answer.
      expect(live.ok).toBe(true);
      // And the withdrawal is still recorded, durably.
      expect(Object.keys(await tombstones())).toHaveLength(1);
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('still rejects the old entry after a simulated worker restart', async () => {
      /**
       * A fresh gateway stands in for the restart: the in-memory marker is gone with the old instance, so only the
       * durable tombstone can carry the withdrawal across. This is what the ordering exists to protect.
       */
      await seedCache();

      const first = gatewayWith();

      await first.gateway.handle(INVALIDATE_REQUEST);

      refuseCacheWrites();
      await first.gateway.handle(SCHEDULE_REQUEST);
      vi.restoreAllMocks();

      const rebuilt = gatewayWith();

      expect(await rebuilt.gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('writes the replacement before it removes the tombstone', async () => {
      // Asserted on the observed order of storage writes, so the sequence is a fact rather than an inference.
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);
      const order: string[] = [];

      vi.spyOn(store, 'set').mockImplementation(async (items: Record<string, unknown>) => {
        for (const observed of ['schedule-cache', 'schedule-tombstones']) {
          if (observed in items) {
            order.push(observed);
          }
        }

        return write(items);
      });

      await gateway.handle(SCHEDULE_REQUEST);
      vi.restoreAllMocks();

      expect(order.indexOf('schedule-cache')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('schedule-tombstones')).toBeGreaterThan(order.indexOf('schedule-cache'));
    });

    it('keeps offline restoration blocked when the tombstone cannot be removed', async () => {
      /**
       * The replacement is durable and the live answer is delivered, but the withdrawal was never lifted — so no
       * cached response may be exposed until a later attempt manages the removal.
       */
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      refuseTombstoneWrites();

      const live = await gateway.handle(SCHEDULE_REQUEST);

      vi.restoreAllMocks();

      expect(live.ok).toBe(true);
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('clears both markers only once the replacement and the removal have both succeeded', async () => {
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });

      const live = await gateway.handle(SCHEDULE_REQUEST);

      expect(live.ok).toBe(true);
      expect(await tombstones()).toEqual({});

      const restored = await gateway.handle(RESTORE_REQUEST);

      expect(restored.ok === true && restored.data).not.toBeNull();
    });
  });

  /**
   * A newer invalidation wins every replacement race.
   *
   * The generation was confirmed before the cache write and then trusted for the rest of the transaction, so an
   * invalidation landing during that write had its brand-new tombstone removed and its `invalidatedKeys` entry
   * deleted — by an operation that predated it — and a response fetched before the withdrawal existed was presented
   * as current. Every await in the sequence now re-checks, and tombstone removal compares tokens rather than
   * deleting whatever it finds.
   */
  describe('an invalidation racing a replacement', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const tombstones = async (): Promise<Record<string, unknown>> =>
      ((await fakeBrowser.storage.local.get('schedule-tombstones'))['schedule-tombstones'] ??
        {}) as Record<string, unknown>;

    const tokenOf = async (): Promise<number> => {
      const record = (await tombstones())[`${ORIGIN}|${OFFICIAL_PROVIDER_ID}|${OFFICIAL_AREA_ID}`];

      return (record as { token?: number } | undefined)?.token ?? 0;
    };

    /**
     * Suspends writes to one storage key until released.
     *
     * The racing invalidation is deliberately **not** awaited: it writes to storage too, and awaiting it while its
     * own write is suspended deadlocks the test rather than testing anything. What the race needs is only its
     * synchronous generation bump, which happens before it touches storage at all — so it is started, observed, and
     * awaited afterwards.
     */
    const holdWritesTo = (heldKey: string) => {
      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: (() => void) | undefined;
      const hasStarted = new Promise<void>((resolve) => {
        started = resolve;
      });

      vi.spyOn(store, 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if (heldKey in items) {
          started?.();
          await held;
        }

        return write(items);
      });

      return { hasStarted, release: () => release?.() };
    };

    /** Withdraws, then starts a replacement and parks it inside the given write. */
    const replacementParkedIn = async (heldKey: string) => {
      await seedCache();

      const harness = gatewayWith();

      await harness.gateway.handle(INVALIDATE_REQUEST);

      const observed = await tokenOf();
      const { hasStarted, release } = holdWritesTo(heldKey);
      const replacement = harness.gateway.handle(SCHEDULE_REQUEST);

      await hasStarted;

      return { ...harness, observed, replacement, release };
    };

    it('discards a response overtaken while the cache write was pending', async () => {
      const { gateway, replacement, release } = await replacementParkedIn('schedule-cache');

      // Started rather than awaited: its own eviction writes the key this test is holding.
      const racing = gateway.handle(INVALIDATE_REQUEST);

      release();

      const response = await replacement;

      await racing;
      vi.restoreAllMocks();

      // Not presented: the withdrawal is newer than the response.
      expect(response.ok).toBe(false);
      expect(response.ok === false && response.failure).toMatchObject({ kind: 'cancelled' });
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('leaves the newer withdrawal recorded rather than removing it', async () => {
      const { gateway, observed, replacement, release } =
        await replacementParkedIn('schedule-cache');
      const racing = gateway.handle(INVALIDATE_REQUEST);

      release();
      await replacement;
      await racing;
      vi.restoreAllMocks();

      // A withdrawal is still on disk, and it is not the one the replacement was authorized to forget.
      expect(await tokenOf()).toBeGreaterThan(observed);
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('keeps the key blocked when the invalidation lands during the tombstone removal', async () => {
      // The last window: the replacement is durable and its removal is in flight when a new withdrawal arrives.
      const { gateway, replacement, release } = await replacementParkedIn('schedule-tombstones');
      const racing = gateway.handle(INVALIDATE_REQUEST);

      release();
      await replacement;
      await racing;
      vi.restoreAllMocks();

      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('cannot notify from a response an invalidation overtook', async () => {
      /**
       * The consequence that matters most. A discarded response is not data, so the reminder has nothing to build a
       * notification from — and the entry it might otherwise fall back on is withdrawn.
       */
      await writeSettings({
        ...defaultSettings,
        selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
        visibleWasteTypes: ['paper'],
      });
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      const { hasStarted, release } = holdWritesTo('schedule-cache');
      const created = vi.spyOn(fakeBrowser.notifications, 'create');
      const reminder = showReminder({ gateway, now: () => new Date('2026-03-09T18:00:00.000Z') });

      await hasStarted;

      const racing = gateway.handle(INVALIDATE_REQUEST);

      release();
      await reminder;
      await racing;

      expect(created).not.toHaveBeenCalled();
    });

    it('still refuses the surviving entry after a worker is rebuilt', async () => {
      // Only the durable tombstone can carry the withdrawal across, and the racing replacement must not remove it.
      const { gateway, replacement, release } = await replacementParkedIn('schedule-cache');
      const racing = gateway.handle(INVALIDATE_REQUEST);

      release();
      await replacement;
      await racing;
      vi.restoreAllMocks();

      const rebuilt = gatewayWith();

      expect(await rebuilt.gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('completes the ordinary replacement when nothing races it', async () => {
      // The counterweight: without a competing withdrawal the transaction finishes and the key is usable again.
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      const live = await gateway.handle(SCHEDULE_REQUEST);

      expect(live.ok).toBe(true);
      expect(await tombstones()).toEqual({});

      const restored = await gateway.handle(RESTORE_REQUEST);

      expect(restored.ok === true && restored.data).not.toBeNull();
    });

    it('leaves an unrelated key usable throughout', async () => {
      const otherParts = { ...KEY_PARTS, serviceAreaId: 'koblenz-oberwerth' };

      await writeCacheEntry({
        ...otherParts,
        schedule: schedule({ serviceAreaId: 'koblenz-oberwerth' }),
        now: NOW,
      });

      const { gateway, replacement, release } = await replacementParkedIn('schedule-cache');
      const racing = gateway.handle(INVALIDATE_REQUEST);

      release();
      await replacement;
      await racing;
      vi.restoreAllMocks();

      const other = await gateway.handle({
        kind: 'restore_cached_schedule',
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: 'koblenz-oberwerth',
      });

      expect(other.ok === true && other.data).not.toBeNull();
    });
  });

  /**
   * A retained entry is not an authoritative one.
   *
   * `writeCacheEntry` keeps whichever entry has the later `retrievedAt`. That decides which is **newer** and says
   * nothing about whether it may be used — and an entry that outlived a failed eviction has exactly the timestamp
   * that makes it look authoritative.
   */
  describe('a response older than a withdrawn entry that survived', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * An entry retrieved *later* than the response the gateway will fetch, withdrawn but surviving.
     *
     * Storage is refused **only for the invalidation**, then restored. That is what makes the later fetch reach the
     * `kept_newer` branch at all: with writes still failing, `writeCacheEntry` throws and the retained entry is
     * never considered — so the guard under test would go unexercised and the test would pass on nothing.
     */
    const withSurvivingNewerEntry = async () => {
      await writeCacheEntry({
        ...KEY_PARTS,
        schedule: schedule({
          retrievedAt: '2026-03-01T23:00:00.000Z',
          events: [curbsideEvent('2026-03-10')],
        }),
        now: NOW,
      });

      const harness = gatewayWith();
      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);

      // Refuse the eviction so the entry survives, while the tombstone still records the withdrawal.
      const refused = vi
        .spyOn(store, 'set')
        .mockImplementation(async (items: Record<string, unknown>) => {
          if ('schedule-cache' in items) {
            throw new Error('storage unavailable');
          }

          return write(items);
        });
      const removal = vi.spyOn(store, 'remove').mockRejectedValue(new Error('storage unavailable'));

      await harness.gateway.handle(INVALIDATE_REQUEST);

      // Storage recovers. The entry is still there, still newer, and still withdrawn.
      refused.mockRestore();
      removal.mockRestore();

      expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();

      return harness;
    };

    it('returns the live answer rather than the surviving entry', async () => {
      const { gateway } = await withSurvivingNewerEntry();
      const response = await gateway.handle(SCHEDULE_REQUEST);

      // A real current answer, delivered as live — never the withdrawn entry dressed up as cached.
      expect(response.ok).toBe(true);
      expect(response.ok === true && response.data).toMatchObject({ kind: 'live' });
    });

    it('does not lift either marker', async () => {
      const { gateway } = await withSurvivingNewerEntry();

      await gateway.handle(SCHEDULE_REQUEST);

      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });

    it('cannot reach a reminder through the retained entry', async () => {
      /**
       * The events read fails, so the **only** thing that could produce a notification is the surviving entry. A
       * reachable API would produce one from the live answer instead — which is legitimate and would prove nothing
       * about the retained entry.
       */
      await writeSettings({
        ...defaultSettings,
        selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
        visibleWasteTypes: ['paper'],
      });
      await writeCacheEntry({
        ...KEY_PARTS,
        schedule: schedule({
          retrievedAt: '2026-03-01T23:00:00.000Z',
          events: [curbsideEvent('2026-03-10')],
        }),
        now: NOW,
      });

      const { gateway } = gatewayWith({
        collectionEvents: () => ({
          ok: false,
          failure: { kind: 'network', operation: 'listCollectionEvents' },
        }),
      });

      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);

      vi.spyOn(store, 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if ('schedule-cache' in items) {
          throw new Error('storage unavailable');
        }

        return write(items);
      });
      vi.spyOn(store, 'remove').mockRejectedValue(new Error('storage unavailable'));

      await gateway.handle(INVALIDATE_REQUEST);

      const created = vi.spyOn(fakeBrowser.notifications, 'create');

      await showReminder({ gateway, now: () => new Date('2026-03-09T18:00:00.000Z') });

      // The entry is still on disk and would have produced a notification. It is withdrawn, so it produced none.
      expect(created).not.toHaveBeenCalled();
    });

    it('still presents a retained newer entry for a key that was never withdrawn', async () => {
      /**
       * The counterweight, and the behaviour this must not disturb: with no withdrawal in play, a stored entry newer
       * than the response is presented as the cache it is, bounded by the range that was requested.
       */
      await writeCacheEntry({
        ...KEY_PARTS,
        schedule: schedule({
          retrievedAt: '2026-03-01T23:00:00.000Z',
          events: [curbsideEvent('2026-03-10')],
        }),
        now: NOW,
      });

      const { gateway } = gatewayWith();
      const response = await gateway.handle(SCHEDULE_REQUEST);

      expect(response.ok).toBe(true);
      expect(response.ok === true && response.data).toMatchObject({ kind: 'cached' });
    });
  });

  describe('a restore already in flight when the invalidation lands', () => {
    afterEach(() => {
      // Unconditional, because an inline restore is skipped when an assertion throws — and a storage spy left
      // installed silently fails every later test in this file with a timeout instead of a reason.
      vi.restoreAllMocks();
    });

    it('returns nothing, because nothing read before a withdrawal may be presented after it', async () => {
      /**
       * The second of the two guards. Reading touches storage, so a withdrawal can land during it — and a restore
       * that began a microsecond earlier would otherwise hand back the very entry being withdrawn.
       *
       * The read is held open deliberately, so the interleaving is the test's decision rather than the scheduler's.
       */
      await seedCache();

      const store = fakeBrowser.storage.local;
      const read = store.get.bind(store);
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;

      vi.spyOn(store, 'get').mockImplementation(async (keys: unknown) => {
        reads += 1;

        // The tombstone check reads first; the cache read is the one held.
        if (reads === 2) {
          await held;
        }

        return read(keys as string);
      });

      const { gateway } = gatewayWith();
      const restoring = gateway.handle(RESTORE_REQUEST);

      await vi.waitFor(() => {
        expect(reads).toBeGreaterThanOrEqual(2);
      });

      // The withdrawal lands while the restore is mid-read.
      const invalidating = gateway.handle(INVALIDATE_REQUEST);

      release?.();

      const [restored] = await Promise.all([restoring, invalidating]);

      vi.restoreAllMocks();

      expect(restored).toEqual({ ok: true, data: null });
    });
  });

  describe('a validated response that started after the invalidation', () => {
    afterEach(() => {
      // Unconditional, because an inline restore is skipped when an assertion throws — and a storage spy left
      // installed silently fails every later test in this file with a timeout instead of a reason.
      vi.restoreAllMocks();
    });

    it('lifts the withdrawal, so the area can be cached again', async () => {
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      // Nothing restorable while the withdrawal stands.
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });

      // A fresh request, started after it, delivers and re-establishes the entry.
      const live = await gateway.handle(SCHEDULE_REQUEST);

      expect(live.ok).toBe(true);

      const restored = await gateway.handle(RESTORE_REQUEST);

      expect(restored.ok === true && restored.data).not.toBeNull();
    });

    it('withholds the cache when the withdrawal cannot be lifted', async () => {
      /**
       * Fails closed. An entry filed under a surviving tombstone is one no restore may return, so the write is
       * skipped rather than stored unusably — and the live response is still delivered, because it is a real
       * answer.
       */
      await seedCache();

      const { gateway } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);

      const store = fakeBrowser.storage.local;

      vi.spyOn(store, 'set').mockRejectedValue(new Error('storage unavailable'));

      const live = await gateway.handle(SCHEDULE_REQUEST);

      vi.restoreAllMocks();

      // Delivered.
      expect(live.ok).toBe(true);
      // And still withheld from restoration, because the withdrawal was never lifted.
      expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
    });
  });

  /**
   * A refused eviction must not block the withdrawal.
   *
   * The generation advance is the part that matters and it cannot fail, so a storage rejection leaves the entry on
   * disk and nothing able to reach it. Reporting that as a failure sounded safer and was worse: it stopped the
   * caller clearing the selection, so a device whose storage was refusing writes kept pointing at an area the
   * operator no longer serves — for ever, and with the popup stuck on an error it could not clear.
   */
  describe('when storage refuses to remove the entry', () => {
    /** Refuses the cache key only, so the settings write in the caller's next step still works. */
    const refuseCacheWrites = () => {
      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);

      vi.spyOn(store, 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if ('schedule-cache' in items) {
          throw new Error('storage unavailable');
        }

        return write(items);
      });
      vi.spyOn(store, 'remove').mockRejectedValue(new Error('storage unavailable'));
    };

    it('still acknowledges the invalidation as successful', async () => {
      await seedCache();
      refuseCacheWrites();

      const { gateway } = gatewayWith();
      const response = await gateway.handle(INVALIDATE_REQUEST);

      // Success, because the caller must go on to clear the selection.
      expect(response).toEqual({ ok: true, data: null });

      vi.restoreAllMocks();
    });

    it('logs the refusal with nothing but its kind', async () => {
      await seedCache();
      refuseCacheWrites();

      const { gateway, lines } = gatewayWith();

      await gateway.handle(INVALIDATE_REQUEST);
      vi.restoreAllMocks();

      const logged = lines.find((line) => line.message.includes('could not discard'));

      expect(logged?.fields).toEqual({ kind: 'cache_storage' });
      // No operation, no status, no request identifier: a removal performs no HTTP request.
      expect(JSON.stringify(logged)).not.toContain('listCollectionEvents');
      expect(JSON.stringify(logged)).not.toContain('storage unavailable');
    });

    it('still advances the generation, so a response in flight cannot be used', async () => {
      /**
       * The guarantee that makes proceeding safe. The entry survived, but the generation moved before any storage
       * work was attempted — so a collection-events request that began earlier is refused both the cache and
       * delivery, exactly as it would have been had the removal succeeded.
       */
      const client: ApiClient = {
        origin: ORIGIN,
        timeoutMs: 8000,
        listProviders: async () => ok({ data: CATALOGUE_WITH_DEMO }),
        listServiceAreas: async () => ok({ data: MIXED_AREAS }),
        listCollectionEvents: async (query) => {
          await held;

          return ok(
            collectionEventsResponse({ serviceAreaId: query.serviceAreaId, range: query.range }),
          );
        },
      };

      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Seeded, so the eviction genuinely writes and genuinely gets refused. Without an entry to remove it
      // returns without touching storage, and this would pass whichever order the generation moved in.
      await seedCache();

      const gateway = createGateway({
        client,
        logger: createRecordingLogger().logger,
        now: () => NOW,
      });
      const inFlight = gateway.handle(SCHEDULE_REQUEST);

      await Promise.resolve();
      refuseCacheWrites();

      await gateway.handle(INVALIDATE_REQUEST);

      release?.();

      const response = await inFlight;

      vi.restoreAllMocks();

      // Not usable data: the generation had already moved when the response arrived, even though the entry
      // could not be removed.
      expect(response.ok).toBe(false);
      expect(response.ok === false && response.failure).toMatchObject({ kind: 'cancelled' });
    });
  });

  it('removes the stored entry for the configured origin, provider, and area', async () => {
    await seedCache();

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();

    const { gateway } = gatewayWith();
    const response = await gateway.handle(INVALIDATE_REQUEST);

    expect(response).toEqual({ ok: true, data: null });
    // The actual stored entry is gone, not merely hidden from a restore.
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('makes a subsequent restore for that key answer null', async () => {
    await seedCache();

    const { gateway } = gatewayWith();

    await gateway.handle(INVALIDATE_REQUEST);

    expect(await gateway.handle(RESTORE_REQUEST)).toEqual({ ok: true, data: null });
  });

  it('leaves another area of the same provider untouched', async () => {
    await seedCache();
    await writeCacheEntry({
      ...KEY_PARTS,
      serviceAreaId: 'koblenz-oberwerth',
      // That area's own events, so the sibling entry is genuinely usable rather than self-contradictory.
      schedule: schedule({ serviceAreaId: 'koblenz-oberwerth' }),
      now: NOW,
    });

    const { gateway } = gatewayWith();

    await gateway.handle(INVALIDATE_REQUEST);

    expect(
      await readCacheEntry({ ...KEY_PARTS, serviceAreaId: 'koblenz-oberwerth' }, NOW),
    ).toBeDefined();
  });

  it('answers the same way when nothing was cached', async () => {
    const { gateway } = gatewayWith();

    expect(await gateway.handle(INVALIDATE_REQUEST)).toEqual({ ok: true, data: null });
  });

  it('is reachable as a typed method for callers inside the worker', async () => {
    await seedCache();

    const { gateway } = gatewayWith();

    await gateway.invalidateCachedSchedule({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
    });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('logs nothing on a successful invalidation', async () => {
    await seedCache();

    const { gateway, lines } = gatewayWith();

    await gateway.handle(INVALIDATE_REQUEST);

    expect(lines).toEqual([]);
  });
});

describe('the handler contract', () => {
  it('never lets a rejection escape', async () => {
    const throwingClient: ApiClient = {
      origin: ORIGIN,
      timeoutMs: 8000,
      listProviders: () => Promise.reject(new Error('unexpected: https://internal/path')),
      listServiceAreas: () => Promise.reject(new Error('unexpected')),
      listCollectionEvents: () => Promise.reject(new Error('unexpected')),
    };
    const { logger, lines } = createRecordingLogger();
    const gateway = createGateway({ client: throwingClient, logger, now: () => NOW });

    const response = await gateway.handle({ kind: 'list_providers' });

    expect(response.ok).toBe(false);

    if (!response.ok) {
      expect(response.failure.kind).toBe('invalid_response');
    }

    // Nothing about the thrown error crosses the boundary or reaches a log line.
    expect(JSON.stringify(response)).not.toContain('internal/path');
    expect(JSON.stringify(lines)).not.toContain('internal/path');
  });

  it('clears a coalesced flight after an unexpected throw, so the next call is attempted', async () => {
    const listProviders = vi
      .fn<ApiClient['listProviders']>()
      .mockRejectedValueOnce(new Error('unexpected'))
      .mockResolvedValueOnce(ok({ data: CATALOGUE_WITH_DEMO }));

    const gateway = createGateway({
      client: {
        origin: ORIGIN,
        timeoutMs: 8000,
        listProviders,
        listServiceAreas: async () => ok({ data: MIXED_AREAS }),
        listCollectionEvents: async () => ok(collectionEventsResponse()),
      },
      logger: createRecordingLogger().logger,
      now: () => NOW,
    });

    expect((await gateway.handle({ kind: 'list_providers' })).ok).toBe(false);
    expect((await gateway.handle({ kind: 'list_providers' })).ok).toBe(true);
    expect(listProviders).toHaveBeenCalledTimes(2);
  });
});

describe('an upstream-stale live response', () => {
  const KEY_PARTS = {
    origin: ORIGIN,
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  };

  it('presents the newer stored schedule rather than the older response', async () => {
    // The regression: the response the API happened to return was presented as authoritative even when the
    // cache already held something newer, relabelling older data as the current answer.
    await writeCacheEntry({
      ...KEY_PARTS,
      schedule: schedule({ retrievedAt: '2026-03-05T08:00:00.000Z' }),
      now: NOW,
    });

    const { gateway } = gatewayWith({
      collectionEvents: () =>
        ok(collectionEventsResponse({ retrievedAt: '2026-02-28T08:00:00.000Z' })),
    });

    const response = ScheduleResponseSchema.parse(await gateway.handle(SCHEDULE_REQUEST));

    expect(response.ok).toBe(true);

    if (response.ok) {
      // Answered as `cached`, which is the stronger half of this claim: the popup is told this is a stored
      // entry, so it cannot present it with a live response's freshness however it renders it.
      expect(response.data.kind).toBe('cached');
    }

    if (response.ok && response.data.kind === 'cached') {
      // The newer retrieval time is what is presented, not the older one just received.
      expect(response.data.restored.schedule.provenance.retrievedAt).toBe(
        '2026-03-05T08:00:00.000Z',
      );
      // Bounded to the range this request asked for, so its coverage describes that range and not the
      // entry's own served range.
      expect(response.data.restored.requestedRange).toEqual(RANGE);
    }
  });

  it('keeps the stored entry and its labelling truthful', async () => {
    await writeCacheEntry({
      ...KEY_PARTS,
      schedule: schedule({ retrievedAt: '2026-03-05T08:00:00.000Z', freshness: 'fresh' }),
      now: NOW,
    });

    const { gateway } = gatewayWith({
      collectionEvents: () =>
        ok(
          collectionEventsResponse({ retrievedAt: '2026-02-28T08:00:00.000Z', freshness: 'stale' }),
        ),
    });

    const response = ScheduleResponseSchema.parse(await gateway.handle(SCHEDULE_REQUEST));

    // The presented freshness belongs to the schedule presented, not to the response that lost.
    expect(response.ok && response.data.kind === 'cached').toBe(true);
    expect(
      response.ok && response.data.kind === 'cached'
        ? response.data.restored.schedule.provenance.freshness
        : undefined,
    ).toBe('fresh');
    expect((await readCacheEntry(KEY_PARTS, NOW))?.schedule.provenance.retrievedAt).toBe(
      '2026-03-05T08:00:00.000Z',
    );
  });

  it('still presents and stores a response that is not older', async () => {
    await writeCacheEntry({
      ...KEY_PARTS,
      schedule: schedule({ retrievedAt: '2026-02-28T08:00:00.000Z' }),
      now: NOW,
    });

    const { gateway } = gatewayWith({
      collectionEvents: () =>
        ok(collectionEventsResponse({ retrievedAt: '2026-03-05T08:00:00.000Z' })),
    });

    const response = ScheduleResponseSchema.parse(await gateway.handle(SCHEDULE_REQUEST));

    // A response that is not older is the live answer it is, labelled with its own retrieval time.
    expect(response.ok && response.data.kind === 'live').toBe(true);
    expect(
      response.ok && response.data.kind === 'live'
        ? response.data.schedule.provenance.retrievedAt
        : undefined,
    ).toBe('2026-03-05T08:00:00.000Z');
    expect((await readCacheEntry(KEY_PARTS, NOW))?.schedule.provenance.retrievedAt).toBe(
      '2026-03-05T08:00:00.000Z',
    );
  });
});

describe('a late response after an invalidation', () => {
  const KEY_PARTS = {
    origin: ORIGIN,
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  };

  const INVALIDATE_REQUEST = {
    kind: 'invalidate_cached_schedule',
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  it('does not recreate the entry that was invalidated while it was in flight', async () => {
    // A withdrawn calendar must stay withdrawn. Without the generation check the late write quietly resurrects
    // the entry, and the cache keeps answering for an area that publishes nothing.
    //
    // The *client call* is held, not the handler call, so the request genuinely begins — and captures its
    // generation — before the invalidation lands.
    let releaseEvents: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });

    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    const client: ApiClient = {
      origin: ORIGIN,
      timeoutMs: 8000,
      listProviders: async () => ok({ data: CATALOGUE_WITH_DEMO }),
      listServiceAreas: async () => ok({ data: MIXED_AREAS }),
      listCollectionEvents: async () => {
        await gate;

        return ok(collectionEventsResponse());
      },
    };
    const gateway = createGateway({
      client,
      logger: createRecordingLogger().logger,
      now: () => NOW,
    });

    const inFlight = gateway.handle(SCHEDULE_REQUEST);

    await gateway.handle(INVALIDATE_REQUEST);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();

    releaseEvents?.();
    await inFlight;

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('still answers the caller that made the late request', async () => {
    const { gateway } = gatewayWith();

    await gateway.handle(INVALIDATE_REQUEST);

    const response = await gateway.handle(SCHEDULE_REQUEST);

    // A real answer is still a real answer; it simply may not be cached under an invalidated key.
    expect(response.ok).toBe(true);
  });

  it('lets a request started after the invalidation cache normally', async () => {
    const { gateway } = gatewayWith();

    await gateway.handle(INVALIDATE_REQUEST);
    await gateway.handle(SCHEDULE_REQUEST);

    // The generation was captured after the bump, so this one is current and writes.
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });

  it('keeps another area cachable after one key is invalidated', async () => {
    const { gateway } = gatewayWith();

    await gateway.handle(INVALIDATE_REQUEST);
    await gateway.handle({ ...SCHEDULE_REQUEST, serviceAreaId: 'koblenz-oberwerth' });

    expect(
      await readCacheEntry({ ...KEY_PARTS, serviceAreaId: 'koblenz-oberwerth' }, NOW),
    ).toBeDefined();
  });

  it('still coalesces identical concurrent requests', async () => {
    const { gateway, calls } = gatewayWith();

    await Promise.all([gateway.handle(SCHEDULE_REQUEST), gateway.handle(SCHEDULE_REQUEST)]);

    expect(calls.listCollectionEvents).toBe(1);
  });
});

/**
 * A request-mismatched response must never become a cache entry, and therefore never a reminder.
 *
 * Driven through the **real** transport client against a stub `fetch`, because that is the only way to prove
 * the whole chain: the identity check lives in the client, the cache write lives in the gateway, and the
 * reminder reads that cache. A test that stubbed the client would be asserting its own stub.
 *
 * The body used here is schema-valid and describes another service area. Cached, it would be indistinguishable
 * from a genuine answer on every later read — and a reminder is unprompted and tells someone to act, so
 * naming a collection day from another area's calendar is the worst outcome this project has.
 */
describe('a schema-valid response that answers a different request', () => {
  const KEY_PARTS = {
    origin: ORIGIN,
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  };

  /** Serves one body for the collection-events read, whatever is asked for. */
  const gatewayOverHttp = (body: unknown) => {
    const client = createApiClient({
      baseUrl: ORIGIN,
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    return createGateway({ client, logger: createRecordingLogger().logger, now: () => NOW });
  };

  /** A genuine response body, then moved onto another area — metadata and event alike. */
  const foreignAreaBody = () => {
    const response = collectionEventsResponse({ events: [curbsideEvent('2026-03-10')] });

    return {
      ...response,
      data: response.data.map((event) => ({ ...event, serviceAreaId: 'koblenz-oberwerth' })),
      meta: {
        ...response.meta,
        serviceArea: { id: 'koblenz-oberwerth', locality: 'Koblenz', name: 'Oberwerth' },
      },
    };
  };

  it('is reported as an invalid response rather than a schedule', async () => {
    const gateway = gatewayOverHttp(foreignAreaBody());
    const response = await gateway.handle(SCHEDULE_REQUEST);

    expect(response.ok).toBe(false);
    expect(response.ok === false && response.failure).toMatchObject({
      kind: 'invalid_response',
      operation: 'listCollectionEvents',
    });
  });

  it('is not written to the cache', async () => {
    const gateway = gatewayOverHttp(foreignAreaBody());

    await gateway.handle(SCHEDULE_REQUEST);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('leaves an existing genuine entry untouched rather than displacing it', async () => {
    // A failed refresh preserves every still-usable entry. A mismatched response is a failed refresh.
    await writeCacheEntry({
      ...KEY_PARTS,
      schedule: schedule({ retrievedAt: '2026-03-01T08:00:00.000Z' }),
      now: NOW,
    });

    const gateway = gatewayOverHttp(foreignAreaBody());

    await gateway.handle(SCHEDULE_REQUEST);

    const entry = await readCacheEntry(KEY_PARTS, NOW);

    expect(entry?.schedule.provenance.retrievedAt).toBe('2026-03-01T08:00:00.000Z');
    expect(entry?.schedule.events.every((event) => event.serviceAreaId === OFFICIAL_AREA_ID)).toBe(
      true,
    );
  });

  it('cannot reach a reminder, because the restore finds nothing it created', async () => {
    const gateway = gatewayOverHttp(foreignAreaBody());

    await gateway.handle(SCHEDULE_REQUEST);

    // The reminder path's own entry point into the cache. Nothing was stored, so there is nothing to remind
    // anyone about — as opposed to a foreign area's collection day being announced as theirs.
    expect(
      await gateway.restoreCachedSchedule({
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
      }),
    ).toBeNull();
  });

  it('still caches a response that does answer the request, so the guard is not refusing everything', async () => {
    const gateway = gatewayOverHttp(
      collectionEventsResponse({ events: [curbsideEvent('2026-03-10')] }),
    );

    const response = await gateway.handle(SCHEDULE_REQUEST);

    expect(response.ok).toBe(true);
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });
});

/**
 * The worker owns the settings item, and its queue is the only serialization that can work.
 *
 * The popup and the Manifest V3 worker are separate module instances, so a mutation queue held in a module
 * variable serializes each context against itself and neither against the other — two contexts
 * read-modify-writing one key that way lose whichever write landed first. Routing every mutation through this
 * one context is what makes "one queue" true rather than aspirational, so these tests drive the popup's
 * messages and the worker's own repository calls against the same gateway.
 */
describe('the settings intents', () => {
  const SELECTION_A = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  const SELECTION_B = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: 'koblenz-oberwerth',
  } as const;

  const AVAILABLE = {
    availability: 'available',
    timeZone: 'Europe/Berlin',
    validity: { from: '2026-01-01', to: '2026-12-31' },
  } as const;

  const selectB = {
    kind: 'select_service_area',
    selection: SELECTION_B,
    evidence: evidenceFor(SELECTION_B),
  } as const;

  const invalidateA = {
    kind: 'invalidate_selection_if_matches',
    expectedSelection: SELECTION_A,
  } as const;

  const storedSelection = async () => (await readSettings()).selection;

  it('reads settings through the worker, so a migration write happens in the owning context', async () => {
    await fakeBrowser.storage.local.set({
      settings: {
        districtId: 'koblenz-stadtmitte',
        remindersEnabled: false,
        reminderDaysBefore: 2,
        reminderTime: '19:00',
        visibleWasteTypes: ['paper'],
      },
    });

    const { gateway } = gatewayWith();
    const response = await gateway.handle({ kind: 'read_settings' });

    expect(response.ok).toBe(true);
    expect(response.ok === true && response.data).toMatchObject({
      selection: SELECTION_A,
      reminderTime: '19:00',
    });

    // The migration was persisted by the owner, not by whoever asked.
    expect(await storedSelection()).toEqual(SELECTION_A);
  });

  it('keeps selection B when the invalidation of A runs first', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    // Ordering A: the invalidation is queued first, then the new choice.
    const [invalidated, selected] = await Promise.all([
      gateway.handle(invalidateA),
      gateway.handle(selectB),
    ]);

    expect(invalidated.ok).toBe(true);
    expect(selected.ok).toBe(true);
    expect(await storedSelection()).toEqual(SELECTION_B);
  });

  it('keeps selection B when the selection runs first and the invalidation becomes a no-op', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    // Ordering B: the new choice lands first, so the invalidation finds a selection it was not told about.
    const [selected, invalidated] = await Promise.all([
      gateway.handle(selectB),
      gateway.handle(invalidateA),
    ]);

    expect(selected.ok).toBe(true);
    expect(invalidated.ok === true && invalidated.data).toMatchObject({ outcome: 'superseded' });
    expect(await storedSelection()).toEqual(SELECTION_B);
  });

  it('shares one queue between the worker’s own invalidation and a popup save', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    /**
     * The reminder path calls the repository directly; the popup sends a message. Both are the same queue, and the
     * draft carries the premise it was built on — so whichever runs first, the *newer* state survives and the
     * stale one is refused rather than applied.
     */
    const [invalidated, saved] = await Promise.all([
      invalidateSelectionIfMatches(SELECTION_A),
      gateway.handle({
        kind: 'save_settings',
        expectedSelection: SELECTION_A,
        selection: SELECTION_B,
        remindersEnabled: false,
        reminderDaysBefore: 3,
        reminderTime: '20:00',
        visibleWasteTypes: ['bio'],
        evidence: evidenceFor(SELECTION_B),
      }),
    ]);

    expect(saved.ok).toBe(true);

    const settings = await readSettings();

    if (invalidated.outcome === 'invalidated') {
      // The invalidation ran first, so the draft's premise no longer held and nothing of it was written.
      expect(saved.ok === true && saved.data).toMatchObject({ outcome: 'conflict' });
      expect(settings.selection).toBeNull();
      // Not even the preferences: the draft is one transactional value.
      expect(settings.reminderTime).not.toBe('20:00');
      expect(settings.visibleWasteTypes).toEqual(['paper']);
    } else {
      // The save ran first, so the invalidation found a selection it was not told about and left it alone.
      expect(invalidated.outcome).toBe('superseded');
      expect(saved.ok === true && saved.data).toMatchObject({ outcome: 'persisted' });
      expect(settings.selection).toEqual(SELECTION_B);
      expect(settings.reminderTime).toBe('20:00');
    }
  });

  it('preserves unrelated preferences through an invalidation', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      remindersEnabled: false,
      reminderDaysBefore: 3,
      reminderTime: '17:00',
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();
    const response = await gateway.handle(invalidateA);

    expect(response.ok === true && response.data).toMatchObject({ outcome: 'invalidated' });

    const settings = await readSettings();

    expect(settings.selection).toBeNull();
    expect(settings.remindersEnabled).toBe(false);
    expect(settings.reminderDaysBefore).toBe(3);
    expect(settings.reminderTime).toBe('17:00');
    expect(settings.visibleWasteTypes).toEqual(['paper']);
  });

  it('applies only the named change, never a snapshot the sender observed earlier', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      reminderTime: '17:00',
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    // A selection intent carries no preferences at all, so it cannot overwrite them with stale values.
    await gateway.handle(selectB);

    const settings = await readSettings();

    expect(settings.selection).toEqual(SELECTION_B);
    expect(settings.reminderTime).toBe('17:00');
    expect(settings.visibleWasteTypes).toEqual(['paper']);
  });

  it('does not let a failed mutation poison the queue', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();
    const failing = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    const refused = await gateway.handle(invalidateA);

    expect(refused.ok).toBe(false);

    failing.mockRestore();

    // The next mutation runs normally, so one refused write did not block every later operation.
    expect((await gateway.handle(selectB)).ok).toBe(true);
    expect(await storedSelection()).toEqual(SELECTION_B);
  });

  it('answers a storage rejection with a safe failure rather than throwing', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(
      new Error('storage unavailable at /internal/path'),
    );

    const response = await gateway.handle(invalidateA);

    expect(response.ok).toBe(false);
    // Nothing about the storage error crosses the boundary, and the popup turns this into its own error state.
    expect(JSON.stringify(response)).not.toContain('/internal/path');

    vi.restoreAllMocks();
  });

  it.each([
    [
      'a selection missing its area',
      {
        kind: 'select_service_area',
        selection: { providerId: 'p' },
        evidence: evidenceFor(SELECTION_B),
      },
    ],
    ['a selection with no evidence', { kind: 'select_service_area', selection: SELECTION_B }],
    [
      'evidence with no identity of its own',
      { kind: 'select_service_area', selection: SELECTION_B, evidence: AVAILABLE },
    ],
    [
      'evidence naming only an area',
      {
        kind: 'select_service_area',
        selection: SELECTION_B,
        evidence: { serviceAreaId: SELECTION_B.serviceAreaId, collectionEvents: AVAILABLE },
      },
    ],
    [
      'a save asserting its own version',
      {
        kind: 'save_settings',
        version: 2,
        selection: null,
        remindersEnabled: true,
        reminderDaysBefore: 1,
        reminderTime: '18:00',
        visibleWasteTypes: ['paper'],
      },
    ],
    [
      'a save with an out-of-range lead time',
      {
        kind: 'save_settings',
        selection: null,
        remindersEnabled: true,
        reminderDaysBefore: 9,
        reminderTime: '18:00',
        visibleWasteTypes: ['paper'],
      },
    ],
    [
      'a save with a malformed time',
      {
        kind: 'save_settings',
        selection: null,
        remindersEnabled: true,
        reminderDaysBefore: 1,
        reminderTime: '25:00',
        visibleWasteTypes: ['paper'],
      },
    ],
    [
      'a save with no visible waste types',
      {
        kind: 'save_settings',
        selection: null,
        remindersEnabled: true,
        reminderDaysBefore: 1,
        reminderTime: '18:00',
        visibleWasteTypes: [],
      },
    ],
    ['an invalidation with no expected selection', { kind: 'invalidate_selection_if_matches' }],
    ['a read carrying an unexpected member', { kind: 'read_settings', extra: true }],
  ])('refuses %s, carrying only the failure kind', async (_reason, message) => {
    const { gateway } = gatewayWith();
    const response = await gateway.handle(message);

    // Refused before anything about it is known to be valid, so nothing about the message is echoed back.
    expect(response).toEqual({ ok: false, failure: { kind: 'unsupported_message' } });
  });

  it('writes nothing when it refuses a malformed intent', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    await gateway.handle({ kind: 'save_settings', selection: null, visibleWasteTypes: [] });

    expect(await storedSelection()).toEqual(SELECTION_A);
  });
});

/**
 * A response overtaken by an invalidation must not be delivered, not merely not cached.
 *
 * The generation already refused the cache write, but the schedule was still handed back — so the popup rendered
 * a calendar the provider had withdrawn moments earlier, and the reminder built a notification from it. Neither
 * re-checks: by the time they hold a payload, the decision has been made for them.
 *
 * Every test here holds an operation open deliberately, so the invalidation genuinely lands mid-flight rather
 * than before or after it.
 */
describe('a collection response superseded by an invalidation', () => {
  const KEY_PARTS = {
    origin: ORIGIN,
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  };

  const INVALIDATE_REQUEST = {
    kind: 'invalidate_cached_schedule',
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  const INTERNAL_REQUEST = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
    ...RANGE,
  } as const;

  /** A gateway whose collection-events call is held open until released. */
  const gatewayWithHeldFetch = () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const client: ApiClient = {
      origin: ORIGIN,
      timeoutMs: 8000,
      listProviders: async () => ok({ data: CATALOGUE_WITH_DEMO }),
      listServiceAreas: async () => ok({ data: MIXED_AREAS }),
      listCollectionEvents: async (query) => {
        started?.();
        await held;

        return ok(
          collectionEventsResponse({ serviceAreaId: query.serviceAreaId, range: query.range }),
        );
      },
    };

    return {
      gateway: createGateway({ client, logger: createRecordingLogger().logger, now: () => NOW }),
      hasStarted,
      release: () => release?.(),
    };
  };

  it('answers cancelled rather than a schedule when the fetch was in flight', async () => {
    const { gateway, hasStarted, release } = gatewayWithHeldFetch();

    const inFlight = gateway.handle(SCHEDULE_REQUEST);

    await hasStarted;
    await gateway.handle(INVALIDATE_REQUEST);

    release();

    const response = await inFlight;

    expect(response.ok).toBe(false);
    expect(response.ok === false && response.failure).toEqual({
      kind: 'cancelled',
      operation: 'listCollectionEvents',
    });
  });

  it('fabricates no request identifier for a superseded response', async () => {
    const { gateway, hasStarted, release } = gatewayWithHeldFetch();

    const inFlight = gateway.handle(SCHEDULE_REQUEST);

    await hasStarted;
    await gateway.handle(INVALIDATE_REQUEST);
    release();

    const response = await inFlight;

    // A `requestId` belongs to a validated Problem Details body; there was none, so none is invented.
    expect(JSON.stringify(response)).not.toContain('requestId');
  });

  it('leaves the cache absent, so nothing was recreated under the invalidated key', async () => {
    const { gateway, hasStarted, release } = gatewayWithHeldFetch();

    const inFlight = gateway.handle(SCHEDULE_REQUEST);

    await hasStarted;
    await gateway.handle(INVALIDATE_REQUEST);
    release();
    await inFlight;

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('returns no schedule payload to a worker-internal caller either', async () => {
    const { gateway, hasStarted, release } = gatewayWithHeldFetch();

    const inFlight = gateway.listCollectionEvents(INTERNAL_REQUEST);

    await hasStarted;
    await gateway.handle(INVALIDATE_REQUEST);
    release();

    const result = await inFlight;

    // The reminder path reads this directly, so it must never be handed a withdrawn schedule.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.kind).toBe('cancelled');
  });

  it('gives coalesced popup and reminder callers the same cancelled outcome', async () => {
    const { gateway, hasStarted, release } = gatewayWithHeldFetch();

    // One flight, two callers: the message boundary and the worker's own read.
    const fromPopup = gateway.handle(SCHEDULE_REQUEST);
    const fromReminder = gateway.listCollectionEvents(INTERNAL_REQUEST);

    await hasStarted;
    await gateway.handle(INVALIDATE_REQUEST);
    release();

    const [popupResponse, reminderResult] = await Promise.all([fromPopup, fromReminder]);

    expect(popupResponse.ok).toBe(false);
    expect(reminderResult.ok).toBe(false);
    expect(popupResponse).toEqual(reminderResult);
  });

  it('delivers no retained-newer cache either, when the invalidation lands during the cache work', async () => {
    // A stored entry newer than the response makes the gateway answer with that entry restored. The invalidation
    // lands while that storage work is in flight, so the retained entry must not escape either.
    await writeCacheEntry({
      ...KEY_PARTS,
      schedule: schedule({ retrievedAt: '2026-03-05T08:00:00.000Z' }),
      now: NOW,
    });

    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const client: ApiClient = {
      origin: ORIGIN,
      timeoutMs: 8000,
      listProviders: async () => ok({ data: CATALOGUE_WITH_DEMO }),
      listServiceAreas: async () => ok({ data: MIXED_AREAS }),
      listCollectionEvents: async () => {
        started?.();
        await held;

        // Older than the stored entry, which is what makes the gateway answer with the stored one.
        return ok(collectionEventsResponse({ retrievedAt: '2026-02-28T08:00:00.000Z' }));
      },
    };

    const gateway = createGateway({
      client,
      logger: createRecordingLogger().logger,
      now: () => NOW,
    });

    const inFlight = gateway.handle(SCHEDULE_REQUEST);

    await hasStarted;
    await gateway.handle(INVALIDATE_REQUEST);
    release?.();

    const response = await inFlight;

    expect(response.ok).toBe(false);
    expect(response.ok === false && response.failure.kind).toBe('cancelled');
    // No `cached` payload escaped, so nothing labelled as a retained entry reached a caller.
    expect(JSON.stringify(response)).not.toContain('retained');
    expect(JSON.stringify(response)).not.toContain('"kind":"cached"');
  });

  it('leaves an uninvolved area unaffected', async () => {
    const { gateway, hasStarted, release } = gatewayWithHeldFetch();

    const other = { ...SCHEDULE_REQUEST, serviceAreaId: 'koblenz-oberwerth' } as const;
    const inFlight = gateway.handle(other);

    await hasStarted;
    // The invalidation names a different area, so it says nothing about this request.
    await gateway.handle(INVALIDATE_REQUEST);
    release();

    const response = await inFlight;

    expect(response.ok).toBe(true);
    expect(
      await readCacheEntry({ ...KEY_PARTS, serviceAreaId: 'koblenz-oberwerth' }, NOW),
    ).toBeDefined();
  });

  it('leaves an uninvolved range unaffected', async () => {
    const { gateway, hasStarted, release } = gatewayWithHeldFetch();

    const inFlight = gateway.handle({ ...SCHEDULE_REQUEST, to: '2026-06-30' });

    await hasStarted;
    await gateway.handle({
      kind: 'invalidate_cached_schedule',
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: 'koblenz-oberwerth',
    });
    release();

    expect((await inFlight).ok).toBe(true);
  });

  it('lets a request that joins after the invalidation succeed on its own', async () => {
    const { gateway, hasStarted, release } = gatewayWithHeldFetch();

    const doomed = gateway.handle(SCHEDULE_REQUEST);

    await hasStarted;
    await gateway.handle(INVALIDATE_REQUEST);

    // Asked after the invalidation, so it is a different question and must not inherit the doomed flight.
    const fresh = gateway.handle(SCHEDULE_REQUEST);

    release();

    expect((await doomed).ok).toBe(false);
    expect((await fresh).ok).toBe(true);
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });

  it('survives the withdrawal sequence the popup performs, in that order', async () => {
    /**
     * The composite race, driven through the real gateway in the order the popup now uses: the cache barrier is
     * advanced and awaited **first**, and only then is the compare-and-clear dispatched.
     *
     * Dispatching the mutation first left a window in which nothing pointed at the area any more while the
     * generation had not moved — so this in-flight response could still write the cache for it, and the next read
     * found a stored schedule for a withdrawn area with no selection left to re-validate it against. All four
     * outcomes are asserted together, because the hole was only visible as a combination.
     */
    await writeSettings({
      ...defaultSettings,
      selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      visibleWasteTypes: ['paper'],
    });

    const { gateway, hasStarted, release } = gatewayWithHeldFetch();
    const inFlight = gateway.handle(SCHEDULE_REQUEST);

    await hasStarted;

    // Step one: the barrier, awaited.
    await gateway.handle(INVALIDATE_REQUEST);

    // Step two: the compare-and-clear, carrying the area that was actually withdrawn.
    const cleared = await gateway.handle({
      kind: 'invalidate_selection_if_matches',
      expectedSelection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
    });

    // Only now does the request that started before any of it answer.
    release();

    const response = await inFlight;

    // It is not usable data, and it says why: the invalidation overtook it.
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.failure).toMatchObject({
      kind: 'cancelled',
      operation: 'listCollectionEvents',
    });
    // It rewrote nothing.
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    // The selection was cleared, by the worker, against the expectation it was given.
    expect(cleared.ok === true && cleared.data).toMatchObject({ outcome: 'invalidated' });
    expect((await readSettings()).selection).toBeNull();
  });

  it('produces no reminder from a request that began before the withdrawal', async () => {
    /**
     * The same race, ending at the surface that matters most. A notification is unprompted and tells someone to
     * act, so a schedule the provider withdrew while the request was in flight must not reach one — and with the
     * selection cleared there is nothing for the next alarm to build one from either.
     */
    await writeSettings({
      ...defaultSettings,
      selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      visibleWasteTypes: ['paper'],
    });

    const { gateway, hasStarted, release } = gatewayWithHeldFetch();
    const created = vi.spyOn(fakeBrowser.notifications, 'create');
    const inFlight = gateway.handle(SCHEDULE_REQUEST);

    await hasStarted;
    await gateway.handle(INVALIDATE_REQUEST);
    await gateway.handle({
      kind: 'invalidate_selection_if_matches',
      expectedSelection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
    });
    release();
    await inFlight;

    // A later alarm, after everything has settled.
    await showReminder({ gateway, now: () => new Date('2026-03-09T18:00:00.000Z') });

    expect(created).not.toHaveBeenCalled();

    created.mockRestore();
  });

  it('produces no notification from a superseded refresh', async () => {
    // The reminder's whole point: an unprompted notification must never be built from a withdrawn calendar.
    await writeSettings({
      ...defaultSettings,
      selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      visibleWasteTypes: ['paper'],
    });

    const { gateway, hasStarted, release } = gatewayWithHeldFetch();
    const created = vi.spyOn(fakeBrowser.notifications, 'create');

    const reminder = showReminder({ gateway, now: () => new Date('2026-03-09T18:00:00.000Z') });

    await hasStarted;
    await gateway.handle(INVALIDATE_REQUEST);
    release();
    await reminder;

    expect(created).not.toHaveBeenCalled();

    created.mockRestore();
  });
});

/**
 * The official-source boundary, proved through the whole chain.
 *
 * The check lives in the transport client, the cache write lives here, and the reminder reads that cache — so a
 * test that stubbed the client would be asserting its own stub. These drive the real client over a stub `fetch`.
 */
/**
 * A response whose drop-off location is not canonical is unusable, all the way through.
 *
 * Driven over the real transport client rather than a stub, because the rule lives in that client's validator and a
 * stubbed one would be asserting the stub. The worker's job here is only not to undo it: no live data handed on, and
 * nothing written to the cache.
 */
/**
 * A response whose events contradict its own coverage declaration is unusable end to end.
 *
 * Driven over the real transport client, because the rule lives in its validator and a stubbed one would assert the
 * stub. The worker's part is only not to undo it: nothing delivered, nothing cached, and nothing a reminder can use.
 */
describe('a response whose events contradict its declared coverage', () => {
  const KEY_PARTS = {
    origin: ORIGIN,
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  };

  const gatewayDeclaring = (wasteTypes: string[]) => {
    const response = collectionEventsResponse({ events: [curbsideEvent('2026-03-10')] });
    const body = { ...response, meta: { ...response.meta, coverage: { wasteTypes } } };

    const client = createApiClient({
      baseUrl: ORIGIN,
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    return createGateway({ client, logger: createRecordingLogger().logger, now: () => NOW });
  };

  it('is reported as an invalid response rather than a schedule', async () => {
    const response = await gatewayDeclaring(['bio']).handle(SCHEDULE_REQUEST);

    expect(response.ok).toBe(false);
    expect(response.ok === false && response.failure).toMatchObject({
      kind: 'invalid_response',
      operation: 'listCollectionEvents',
    });
  });

  it('writes no cache entry', async () => {
    const gateway = gatewayDeclaring(['bio']);

    await gateway.handle(SCHEDULE_REQUEST);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('cannot reach a reminder, because there is nothing to fetch or restore', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      visibleWasteTypes: ['paper'],
    });

    const gateway = gatewayDeclaring(['bio']);
    const created = vi.spyOn(fakeBrowser.notifications, 'create');

    await showReminder({ gateway, now: () => new Date('2026-03-09T18:00:00.000Z') });

    expect(created).not.toHaveBeenCalled();

    created.mockRestore();
  });

  it('still serves and caches a response whose coverage declares its events', async () => {
    // The counterweight, so the guard is refusing the contradiction rather than every schedule.
    const gateway = gatewayDeclaring(['paper']);
    const response = await gateway.handle(SCHEDULE_REQUEST);

    expect(response.ok).toBe(true);
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });
});

describe('a response carrying a non-canonical drop-off location', () => {
  const KEY_PARTS = {
    origin: ORIGIN,
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  };

  const gatewayServing = (name: string) => {
    const response = collectionEventsResponse({ events: [mobileDropOffEvent('2026-03-10')] });
    const body = {
      ...response,
      data: response.data.map((event) =>
        event.collectionMode === 'mobile_drop_off' ? { ...event, location: { name } } : event,
      ),
    };

    const client = createApiClient({
      baseUrl: ORIGIN,
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    return createGateway({ client, logger: createRecordingLogger().logger, now: () => NOW });
  };

  it.each([
    ['leading whitespace', ' Rizzastraße'],
    ['trailing whitespace', 'Rizzastraße '],
    ['whitespace at both ends', ' Rizzastraße '],
    ['nothing but whitespace', '   '],
    ['nothing at all', ''],
  ])('is reported as an invalid response for %s', async (_reason, name) => {
    const response = await gatewayServing(name).handle(SCHEDULE_REQUEST);

    expect(response.ok).toBe(false);
    expect(response.ok === false && response.failure).toMatchObject({
      kind: 'invalid_response',
      operation: 'listCollectionEvents',
    });
  });

  it('writes no cache entry', async () => {
    const gateway = gatewayServing(' Rizzastraße ');

    await gateway.handle(SCHEDULE_REQUEST);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('returns nothing a caller could read the untrimmed name from', async () => {
    const response = await gatewayServing(' Rizzastraße ').handle(SCHEDULE_REQUEST);

    expect(JSON.stringify(response)).not.toContain('Rizzastraße');
  });

  it('still serves and caches a canonical drop-off, so the guard is not refusing everything', async () => {
    const gateway = gatewayServing('Rizzastraße Ecke Südallee');
    const response = await gateway.handle(SCHEDULE_REQUEST);

    expect(response.ok).toBe(true);
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });
});

describe('a schema-valid response that is not official municipal data', () => {
  const KEY_PARTS = {
    origin: ORIGIN,
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  };

  /** Serves one body for the collection-events read, through the real transport client. */
  const gatewayOverHttp = (body: unknown) => {
    const client = createApiClient({
      baseUrl: ORIGIN,
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    return createGateway({ client, logger: createRecordingLogger().logger, now: () => NOW });
  };

  /** A genuine response body, with the provider or the event sources altered. */
  const bodyWith = ({
    sourceKind = 'official_ics',
    eventSource = 'municipal_ics',
  }: {
    sourceKind?: string;
    eventSource?: string;
  } = {}) => {
    const response = collectionEventsResponse({ events: [curbsideEvent('2026-03-10')] });

    return {
      ...response,
      data: response.data.map((event) => ({ ...event, source: eventSource })),
      meta: { ...response.meta, provider: { ...response.meta.provider, sourceKind } },
    };
  };

  it('is reported as an invalid response rather than a schedule', async () => {
    const gateway = gatewayOverHttp(bodyWith({ sourceKind: 'demo' }));
    const response = await gateway.handle(SCHEDULE_REQUEST);

    expect(response.ok).toBe(false);
    expect(response.ok === false && response.failure).toMatchObject({
      kind: 'invalid_response',
      operation: 'listCollectionEvents',
    });
  });

  it('writes no cache entry for a demo provider', async () => {
    const gateway = gatewayOverHttp(bodyWith({ sourceKind: 'demo' }));

    await gateway.handle(SCHEDULE_REQUEST);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('writes no cache entry for a demo event', async () => {
    const gateway = gatewayOverHttp(bodyWith({ eventSource: 'demo' }));

    await gateway.handle(SCHEDULE_REQUEST);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('writes no cache entry for a user-entered event', async () => {
    const gateway = gatewayOverHttp(bodyWith({ eventSource: 'user_rule' }));

    await gateway.handle(SCHEDULE_REQUEST);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('still caches a genuinely official response, so the guard is not refusing everything', async () => {
    const gateway = gatewayOverHttp(bodyWith());

    expect((await gateway.handle(SCHEDULE_REQUEST)).ok).toBe(true);
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });

  it('cannot trigger a reminder from a persisted non-official entry', async () => {
    /**
     * The worst outcome this extension has: an unprompted notification, under the operator's name, built from
     * sample data or something a person typed. The entry is written raw, as an older build's leftovers would
     * appear, and the API is unreachable so nothing can replace it.
     */
    await writeSettings({
      ...defaultSettings,
      selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      visibleWasteTypes: ['paper'],
    });

    await fakeBrowser.storage.local.set({
      'schedule-cache': {
        [`${ORIGIN}|${OFFICIAL_PROVIDER_ID}|${OFFICIAL_AREA_ID}`]: {
          origin: ORIGIN,
          providerId: OFFICIAL_PROVIDER_ID,
          serviceAreaId: OFFICIAL_AREA_ID,
          schedule: {
            ...schedule({ events: [] }),
            events: [{ ...curbsideEvent('2026-03-10'), source: 'demo' }],
          },
          storedAt: new Date('2026-03-09T18:00:00.000Z').toISOString(),
        },
      },
    });

    const client = createApiClient({
      baseUrl: ORIGIN,
      fetch: async () => {
        throw new Error('the network is unavailable');
      },
    });
    const gateway = createGateway({
      client,
      logger: createRecordingLogger().logger,
      now: () => new Date('2026-03-09T18:00:00.000Z'),
    });
    const created = vi.spyOn(fakeBrowser.notifications, 'create');

    await showReminder({ gateway, now: () => new Date('2026-03-09T18:00:00.000Z') });

    expect(created).not.toHaveBeenCalled();
    // The contradictory entry was evicted rather than merely skipped.
    expect(
      await gateway.restoreCachedSchedule({
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
      }),
    ).toBeNull();

    created.mockRestore();
  });

  it('cannot trigger a reminder from a persisted inverted drop-off window', async () => {
    // The domain refuses an inverted window by throwing, and this throw would happen inside the alarm handler.
    await writeSettings({
      ...defaultSettings,
      selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
      visibleWasteTypes: ['hazardous'],
    });

    await fakeBrowser.storage.local.set({
      'schedule-cache': {
        [`${ORIGIN}|${OFFICIAL_PROVIDER_ID}|${OFFICIAL_AREA_ID}`]: {
          origin: ORIGIN,
          providerId: OFFICIAL_PROVIDER_ID,
          serviceAreaId: OFFICIAL_AREA_ID,
          schedule: {
            ...schedule({ events: [] }),
            events: [
              {
                ...curbsideEvent('2026-03-10'),
                collectionMode: 'mobile_drop_off',
                wasteType: 'hazardous',
                timing: {
                  kind: 'time_window',
                  startsAt: '2026-03-10T12:00:00Z',
                  endsAt: '2026-03-10T10:00:00Z',
                  timeZone: 'Europe/Berlin',
                },
                location: { name: 'Rizzastraße Ecke Südallee' },
              },
            ],
          },
          storedAt: new Date('2026-03-09T18:00:00.000Z').toISOString(),
        },
      },
    });

    const client = createApiClient({
      baseUrl: ORIGIN,
      fetch: async () => {
        throw new Error('the network is unavailable');
      },
    });
    const gateway = createGateway({
      client,
      logger: createRecordingLogger().logger,
      now: () => new Date('2026-03-09T18:00:00.000Z'),
    });
    const created = vi.spyOn(fakeBrowser.notifications, 'create');

    // No rejection escapes into the alarm handler either.
    await expect(
      showReminder({ gateway, now: () => new Date('2026-03-09T18:00:00.000Z') }),
    ).resolves.toBeUndefined();

    expect(created).not.toHaveBeenCalled();

    created.mockRestore();
  });
});

/**
 * A Settings draft is built from a value observed when the session opened, so it can go stale.
 *
 * Two things change the selection while a person is editing — a reminder discovering the area was withdrawn and
 * clearing it, or another window choosing a different one — and both are newer and more authoritative than the
 * draft. Writing it anyway would resurrect an area that had just been invalidated, or overwrite somebody's new
 * choice with the old one.
 */
describe('a stale Settings draft', () => {
  const SELECTION_A = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  const SELECTION_B = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: 'koblenz-oberwerth',
  } as const;

  /** A draft opened while `expectedSelection` was stored, saving `selection` plus edited preferences. */
  const draftSave = (
    expectedSelection: ServiceAreaSelection | null,
    selection: ServiceAreaSelection | null,
  ) =>
    ({
      kind: 'save_settings',
      expectedSelection,
      selection,
      remindersEnabled: false,
      reminderDaysBefore: 3,
      reminderTime: '20:00',
      visibleWasteTypes: ['bio'],
      ...(selection === null ? {} : { evidence: evidenceFor(selection) }),
    }) as const;

  it('is rejected after a reminder invalidated the area to null', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    // The worker clears the withdrawn area while Settings is open.
    await invalidateSelectionIfMatches(SELECTION_A);

    // The draft still believes A is stored, and would restore it.
    const response = await gateway.handle(draftSave(SELECTION_A, SELECTION_A));

    expect(response.ok === true && response.data).toMatchObject({ outcome: 'conflict' });
    expect((await readSettings()).selection).toBeNull();
  });

  it('is rejected after another window chose a different area', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    await gateway.handle({
      kind: 'select_service_area',
      selection: SELECTION_B,
      evidence: evidenceFor(SELECTION_B),
    });

    const response = await gateway.handle(draftSave(SELECTION_A, SELECTION_A));

    expect(response.ok === true && response.data).toMatchObject({ outcome: 'conflict' });
    // The newer choice stands, rather than being overwritten by the older draft.
    expect((await readSettings()).selection).toEqual(SELECTION_B);
  });

  it('writes nothing at all on a conflict, including the preferences', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      reminderTime: '17:00',
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    await invalidateSelectionIfMatches(SELECTION_A);
    await gateway.handle(draftSave(SELECTION_A, SELECTION_A));

    const settings = await readSettings();

    // The draft is one transactional value: applying half of it would persist a combination nobody saw.
    expect(settings.reminderTime).toBe('17:00');
    expect(settings.visibleWasteTypes).toEqual(['paper']);
    expect(settings.remindersEnabled).toBe(defaultSettings.remindersEnabled);
  });

  it('returns the current settings on a conflict, so the surface can adopt them', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    await gateway.handle({
      kind: 'select_service_area',
      selection: SELECTION_B,
      evidence: evidenceFor(SELECTION_B),
    });

    const response = await gateway.handle(draftSave(SELECTION_A, SELECTION_A));

    // Adopting this is what stops the popup showing the stale selection and requesting a schedule for it.
    const conflict = SettingsWriteResponseSchema.parse(response);

    expect(conflict.ok === true && conflict.data.settings.selection).toEqual(SELECTION_B);
  });

  it('accepts a preference-only edit when the selection is unchanged, with no capability at all', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    // Offline: no capability is available, and none is needed because the selection asserts nothing new.
    const response = await gateway.handle({
      kind: 'save_settings',
      expectedSelection: SELECTION_A,
      selection: SELECTION_A,
      remindersEnabled: false,
      reminderDaysBefore: 3,
      reminderTime: '20:00',
      visibleWasteTypes: ['bio'],
    });

    expect(response.ok === true && response.data).toMatchObject({ outcome: 'persisted' });
    expect((await readSettings()).reminderTime).toBe('20:00');
  });

  it('accepts a change to another area when the draft’s premise still holds', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();
    const response = await gateway.handle(draftSave(SELECTION_A, SELECTION_B));

    expect(response.ok === true && response.data).toMatchObject({ outcome: 'persisted' });
    expect((await readSettings()).selection).toEqual(SELECTION_B);
  });

  it('accepts a draft opened with no selection at all', async () => {
    // A first run: the premise is `null`, and it still holds.
    const { gateway } = gatewayWith();
    const response = await gateway.handle(draftSave(null, SELECTION_B));

    expect(response.ok === true && response.data).toMatchObject({ outcome: 'persisted' });
  });

  it('rejects a draft opened with no selection once one has been chosen', async () => {
    const { gateway } = gatewayWith();

    await gateway.handle({
      kind: 'select_service_area',
      selection: SELECTION_B,
      evidence: evidenceFor(SELECTION_B),
    });

    const response = await gateway.handle(draftSave(null, null));

    expect(response.ok === true && response.data).toMatchObject({ outcome: 'conflict' });
    expect((await readSettings()).selection).toEqual(SELECTION_B);
  });

  it('keeps serving mutations after a conflict', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    await invalidateSelectionIfMatches(SELECTION_A);
    await gateway.handle(draftSave(SELECTION_A, SELECTION_A));

    // A conflict is a decision, not a failure, so it must not poison the queue.
    const recovered = await gateway.handle({
      kind: 'select_service_area',
      selection: SELECTION_B,
      evidence: evidenceFor(SELECTION_B),
    });

    expect(recovered.ok === true && recovered.data).toMatchObject({ outcome: 'persisted' });
  });

  it('carries no operation and no request identifier in any settings result', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: SELECTION_A,
      visibleWasteTypes: ['paper'],
    });

    const { gateway } = gatewayWith();

    await invalidateSelectionIfMatches(SELECTION_A);

    const conflict = await gateway.handle(draftSave(SELECTION_A, SELECTION_A));
    const persisted = await gateway.handle(draftSave(null, SELECTION_B));

    for (const response of [conflict, persisted]) {
      // A settings command speaks no HTTP, so neither field has anything true to say about it.
      expect(JSON.stringify(response)).not.toContain('operation');
      expect(JSON.stringify(response)).not.toContain('requestId');
    }

    // The exact key set of a settings result: what it decided, and what is stored now. Nothing else.
    const parsed = SettingsWriteResponseSchema.parse(conflict);

    expect(parsed.ok === true && Object.keys(parsed.data).sort()).toEqual(['outcome', 'settings']);
  });
});

/**
 * A settings storage failure is not an HTTP failure.
 *
 * It used to be reported as `invalid_response` with `operation: 'listProviders'`, which invented three things at
 * once: a request that was never made, an operation that had nothing to do with it, and an HTTP status for an
 * operation that speaks no HTTP. Anyone reading the log line would have gone looking for a provider-catalogue
 * failure that does not exist.
 */
describe('a settings command whose storage refuses', () => {
  const SELECTION = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a read rejection in the settings failure family alone', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(
      new Error('storage unavailable at /internal/path'),
    );

    const { gateway } = gatewayWith();
    const response = await gateway.handle({ kind: 'read_settings' });

    expect(response).toEqual({ ok: false, failure: { kind: 'settings_storage' } });
    // Nothing about the underlying rejection crosses the boundary.
    expect(JSON.stringify(response)).not.toContain('/internal/path');
  });

  it('reports a write rejection the same way', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    const { gateway } = gatewayWith();
    const response = await gateway.handle({
      kind: 'select_service_area',
      selection: SELECTION,
      evidence: evidenceFor(SELECTION),
    });

    expect(response).toEqual({ ok: false, failure: { kind: 'settings_storage' } });
  });

  it('reports a migration write rejection the same way', async () => {
    // The read itself succeeds; only persisting the migrated value fails.
    await fakeBrowser.storage.local.set({
      settings: {
        districtId: 'koblenz-stadtmitte',
        remindersEnabled: false,
        reminderDaysBefore: 2,
        reminderTime: '19:00',
        visibleWasteTypes: ['paper'],
      },
    });

    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    const { gateway } = gatewayWith();
    const response = await gateway.handle({ kind: 'read_settings' });

    // The repository swallows a failed migration write and answers with the valid in-memory settings, so this
    // stays a successful read — which is the behaviour a person depends on to reach the application at all.
    expect(response.ok).toBe(true);
    expect(response.ok === true && response.data).toMatchObject({ reminderTime: '19:00' });
  });

  it('contains no operation and no request identifier', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));

    const { gateway } = gatewayWith();
    const response = await gateway.handle({ kind: 'read_settings' });

    expect(response.ok).toBe(false);
    expect(response.ok === false && Object.keys(response.failure)).toEqual(['kind']);
  });

  it('logs its own kind and invents no operation', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));

    const { gateway, lines } = gatewayWith();

    await gateway.handle({ kind: 'read_settings' });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toEqual({ kind: 'settings_storage' });
    // Never a provider-catalogue diagnostic for a storage failure.
    expect(JSON.stringify(lines)).not.toContain('listProviders');
  });

  it('performs no HTTP request while failing', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));

    const { gateway, calls } = gatewayWith();

    await gateway.handle({ kind: 'read_settings' });

    expect(calls).toEqual({ listProviders: 0, listServiceAreas: 0, listCollectionEvents: 0 });
  });

  it('keeps a refused settings message kind-only', async () => {
    const { gateway } = gatewayWith();

    expect(await gateway.handle({ kind: 'read_settings', extra: true })).toEqual({
      ok: false,
      failure: { kind: 'unsupported_message' },
    });
  });

  it('serves the next settings command normally after a failure', async () => {
    const failing = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    const { gateway } = gatewayWith();

    expect(
      (
        await gateway.handle({
          kind: 'select_service_area',
          selection: SELECTION,
          evidence: evidenceFor(SELECTION),
        })
      ).ok,
    ).toBe(false);

    failing.mockRestore();

    const recovered = await gateway.handle({
      kind: 'select_service_area',
      selection: SELECTION,
      evidence: evidenceFor(SELECTION),
    });

    expect(recovered.ok === true && recovered.data).toMatchObject({ outcome: 'persisted' });
  });
});
