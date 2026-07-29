import type { FetchLike } from '@abfall-radar/data-providers/node';
import { FRESH_TTL_MS } from '@abfall-radar/data-providers/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, REQUEST_ID_HEADER } from '../../app';
import { PROBLEM_CONTENT_TYPE } from '../../http/error-handler';
import { buildTestApp } from '../../test/build-test-app';
import { createLogCollector } from '../../test/log-collector';

const OFFICIAL = '/api/v1/providers/koblenz-servicebetrieb/service-areas/koblenz-stadtmitte';

const EVENTS = `${OFFICIAL}/collection-events`;

const CRLF = '\r\n';

/**
 * A synthetic calendar written for this repository. No municipal file, excerpt, or `cid` value is ever
 * committed, and no test reaches the network: retrieval is scripted through the injected fetch.
 */
const calendar = (
  events: readonly string[] = [
    [
      'BEGIN:VEVENT',
      'UID:upstream-uid-for-paper',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260814',
      'DTEND;VALUE=DATE:20260815',
      // The real source repeats the area label here on every curbside entry. It is accepted and omitted
      // from the event, so the fixture carries it to stay faithful to what the adapter really receives.
      'LOCATION:Stadtmitte',
      'SUMMARY:Altpapier',
      'END:VEVENT',
    ].join(CRLF),
    [
      'BEGIN:VEVENT',
      'UID:upstream-uid-for-combined',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20260321T100000Z',
      'DTEND:20260321T120000Z',
      'LOCATION:Rizzastraße Ecke  Südallee ',
      'SUMMARY:Schadstoffe / Elektrokleinteile',
      'END:VEVENT',
    ].join(CRLF),
  ],
): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AbfallRadar test fixture//EN',
    'METHOD:PUBLISH',
    'X-WR-TIMEZONE:Europe/Berlin',
    ...events,
    'END:VCALENDAR',
    '',
  ].join(CRLF);

const okFetch = (body = calendar()): { fetch: FetchLike; count: () => number } => {
  let count = 0;

  return {
    count: () => count,
    fetch: async () => {
      count += 1;

      return new Response(body, { headers: { 'content-type': 'text/calendar' } });
    },
  };
};

const failingFetch =
  (status: number): FetchLike =>
  async () =>
    new Response(null, { status });

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

const createClock = (start: Date): Clock => {
  let current = start.getTime();

  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
};

describe('GET collection-events', () => {
  let app: ApiApp;

  afterEach(async () => {
    await app?.close();
  });

  describe('a fresh success', () => {
    beforeEach(async () => {
      app = await buildTestApp({ providerRuntime: { fetch: okFetch().fetch } });
    });

    it('returns the documented events with full provenance', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-01-01&to=2026-12-31`,
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();

      expect(body.meta).toMatchObject({
        provider: {
          id: 'koblenz-servicebetrieb',
          name: 'Kommunaler Servicebetrieb',
          sourceKind: 'official_ics',
        },
        serviceArea: { id: 'koblenz-stadtmitte', locality: 'Koblenz', name: 'Stadtmitte' },
        source: {
          name: 'Kommunaler Servicebetrieb',
          landingPageUrl:
            'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
          attribution: 'Kommunaler Servicebetrieb, Koblenz',
          timeZone: 'Europe/Berlin',
        },
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        freshness: 'fresh',
        range: { from: '2026-01-01', to: '2026-12-31' },
      });
      expect(body.meta.retrievedAt).toEqual(expect.any(String));
    });

    it('serializes a curbside event with an all-day timing and no location', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-08-01&to=2026-08-31`,
      });
      const [event] = response.json().data;

      expect(event).toEqual({
        id: expect.stringContaining('koblenz-servicebetrieb-koblenz-stadtmitte-paper-2026-08-14-'),
        serviceAreaId: 'koblenz-stadtmitte',
        wasteType: 'paper',
        date: '2026-08-14',
        title: 'Altpapier',
        source: 'municipal_ics',
        collectionMode: 'curbside',
        timing: { kind: 'all_day' },
      });
      expect(Object.keys(event)).not.toContain('location');
    });

    it('serializes a mobile drop-off with its window, zone, and trimmed location', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });
      const { data } = response.json();

      expect(data).toHaveLength(2);

      for (const event of data) {
        expect(event).toMatchObject({
          date: '2026-03-21',
          collectionMode: 'mobile_drop_off',
          timing: {
            kind: 'time_window',
            startsAt: '2026-03-21T10:00:00Z',
            endsAt: '2026-03-21T12:00:00Z',
            timeZone: 'Europe/Berlin',
          },
          location: { name: 'Rizzastraße Ecke Südallee' },
        });
      }
    });

    it('splits the combined entry into two events sharing timing but not identity', async () => {
      const { data } = (
        await app.inject({ method: 'GET', url: `${EVENTS}?from=2026-03-01&to=2026-03-31` })
      ).json();

      expect(data.map((event: { wasteType: string }) => event.wasteType).toSorted()).toEqual([
        'hazardous',
        'small_electronics',
      ]);
      expect(data[0].timing).toEqual(data[1].timing);
      expect(data[0].location).toEqual(data[1].location);
      expect(data[0].id).not.toBe(data[1].id);
    });

    it('declares coverage from the manifest rather than from the events returned', async () => {
      const { data, meta } = (
        await app.inject({ method: 'GET', url: `${EVENTS}?from=2026-03-01&to=2026-03-31` })
      ).json();

      // Only two hazardous-family events came back, but the source still covers six waste types.
      expect(data).toHaveLength(2);
      expect(meta.coverage.wasteTypes).toEqual([
        'paper',
        'yellow_bag',
        'green_waste',
        'christmas_tree',
        'hazardous',
        'small_electronics',
      ]);
    });

    it('returns an empty list with unchanged coverage for an in-range gap', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-05-01&to=2026-05-31`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
      expect(response.json().meta.coverage.wasteTypes).toHaveLength(6);
    });

    it('exposes no upstream field, payload, or URL', async () => {
      const raw = (
        await app.inject({ method: 'GET', url: `${EVENTS}?from=2026-01-01&to=2026-12-31` })
      ).payload;

      for (const forbidden of [
        // The upstream UIDs are deliberately distinctive: `paper` alone is a legitimate waste type, so a
        // UID that collided with one would make this assertion pass for the wrong reason.
        'upstream-uid-for-paper',
        'upstream-uid-for-combined',
        'DTSTAMP',
        'dtstamp',
        'DESCRIPTION',
        'BEGIN:VEVENT',
        'ics-stadtmitte.ics',
        'RRULE',
      ]) {
        expect(raw).not.toContain(forbidden);
      }
    });

    it('carries a request identifier on success', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      expect(response.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
    });
  });

  describe('range filtering', () => {
    beforeEach(async () => {
      app = await buildTestApp({ providerRuntime: { fetch: okFetch().fetch } });
    });

    it.each([
      ['nothing when the range falls between two collections', '2026-04-01', '2026-04-30', 0],
      ['only the all-day event when the timed one is out of range', '2026-03-22', '2026-11-06', 1],
      ['the timed event exactly at the lower boundary', '2026-03-21', '2026-03-21', 2],
      ['the timed event exactly at the upper boundary', '2026-01-01', '2026-03-21', 2],
      ['the all-day event exactly at the lower boundary', '2026-08-14', '2026-08-31', 1],
      ['the all-day event exactly at the upper boundary', '2026-08-01', '2026-08-14', 1],
    ])('includes %s', async (_reason, from, to, expected) => {
      const response = await app.inject({ method: 'GET', url: `${EVENTS}?from=${from}&to=${to}` });

      expect(response.json().data).toHaveLength(expected);
    });

    it('filters a timed event on its local date, not on its instant', async () => {
      // 2026-03-21T10:00:00Z is 11:00 Berlin, so both boundaries are the same local day either way; the
      // assertion that matters is that a range ending on the local date still contains it.
      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-21&to=2026-03-21`,
      });

      expect(response.json().data).toHaveLength(2);
      expect(response.json().meta.range).toEqual({ from: '2026-03-21', to: '2026-03-21' });
    });
  });

  describe('caching behavior through the HTTP surface', () => {
    it('performs no second upstream request inside the fresh TTL', async () => {
      const upstream = okFetch();
      const clock = createClock(new Date('2026-07-29T08:00:00.000Z'));

      app = await buildTestApp({ providerRuntime: { fetch: upstream.fetch, clock } });

      const first = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      clock.advance(FRESH_TTL_MS - 1);

      const second = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      expect(upstream.count()).toBe(1);
      // The identical retrieval timestamp is the observable proof the cache served the second request.
      expect(second.json().meta.retrievedAt).toBe(first.json().meta.retrievedAt);
    });

    it('refreshes once the TTL has elapsed', async () => {
      const upstream = okFetch();
      const clock = createClock(new Date('2026-07-29T08:00:00.000Z'));

      app = await buildTestApp({ providerRuntime: { fetch: upstream.fetch, clock } });

      await app.inject({ method: 'GET', url: `${EVENTS}?from=2026-03-01&to=2026-03-31` });
      clock.advance(FRESH_TTL_MS);
      await app.inject({ method: 'GET', url: `${EVENTS}?from=2026-03-01&to=2026-03-31` });

      expect(upstream.count()).toBe(2);
    });

    it('coalesces concurrent requests into exactly one upstream request', async () => {
      let count = 0;
      const fetchImpl: FetchLike = async () => {
        count += 1;

        // Yield so all three requests are genuinely in flight together.
        await new Promise((resolve) => {
          setImmediate(resolve);
        });

        return new Response(calendar(), { headers: { 'content-type': 'text/calendar' } });
      };

      app = await buildTestApp({ providerRuntime: { fetch: fetchImpl } });

      const responses = await Promise.all([
        app.inject({ method: 'GET', url: `${EVENTS}?from=2026-03-01&to=2026-03-31` }),
        app.inject({ method: 'GET', url: `${EVENTS}?from=2026-03-01&to=2026-03-31` }),
        app.inject({ method: 'GET', url: `${EVENTS}?from=2026-03-01&to=2026-03-31` }),
      ]);

      expect(count).toBe(1);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    });
  });

  describe('a stale success', () => {
    it('returns 200 with the preserved retrievedAt and a structured warning log', async () => {
      const logs = createLogCollector();
      const clock = createClock(new Date('2026-07-29T08:00:00.000Z'));
      let failing = false;

      const fetchImpl: FetchLike = async () => {
        if (failing) {
          throw new TypeError('fetch failed');
        }

        return new Response(calendar(), { headers: { 'content-type': 'text/calendar' } });
      };

      app = await buildTestApp({
        config: { logLevel: 'warn' },
        logDestination: logs.stream,
        providerRuntime: { fetch: fetchImpl, clock },
      });

      const fresh = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      failing = true;
      clock.advance(FRESH_TTL_MS + 1);

      const stale = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      expect(stale.statusCode).toBe(200);
      expect(stale.json().meta.freshness).toBe('stale');
      expect(stale.json().meta.retrievedAt).toBe(fresh.json().meta.retrievedAt);
      expect(stale.json().data).toHaveLength(2);

      const warning = logs.find(
        (line) => line.msg === 'Serving a stale official schedule because the last refresh failed',
      );

      expect(warning).toBeDefined();
      expect(warning).toMatchObject({
        requestId: stale.headers[REQUEST_ID_HEADER],
        providerId: 'koblenz-servicebetrieb',
        serviceAreaId: 'koblenz-stadtmitte',
        reason: 'network-error',
      });
    });

    it('never labels a manufactured value as stale when nothing was retrieved', async () => {
      app = await buildTestApp({ providerRuntime: { fetch: failingFetch(503) } });

      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      expect(response.statusCode).toBe(503);
      expect(response.payload).not.toContain('stale');
    });
  });

  describe('validation', () => {
    beforeEach(async () => {
      app = await buildTestApp({ providerRuntime: { fetch: okFetch().fetch } });
    });

    it.each([
      ['a missing from', `${EVENTS}?to=2026-03-31`],
      ['a missing to', `${EVENTS}?from=2026-03-01`],
      ['both missing', EVENTS],
      ['a non-ISO from', `${EVENTS}?from=01-03-2026&to=2026-03-31`],
      ['an impossible date', `${EVENTS}?from=2026-02-30&to=2026-03-31`],
      ['from after to', `${EVENTS}?from=2026-03-31&to=2026-03-01`],
      ['a range over 366 days', `${EVENTS}?from=2026-01-01&to=2027-01-02`],
      [
        'a malformed provider identifier',
        `/api/v1/providers/Invalid_ID/service-areas/a/collection-events?from=2026-03-01&to=2026-03-31`,
      ],
      [
        'a malformed service-area identifier',
        `/api/v1/providers/demo/service-areas/Invalid_ID/collection-events?from=2026-03-01&to=2026-03-31`,
      ],
    ])('rejects %s with a documented 400', async (_reason, url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(response.json()).toMatchObject({
        type: 'urn:abfall-radar:problem:validation-error',
        status: 400,
        code: 'VALIDATION_ERROR',
        requestId: response.headers[REQUEST_ID_HEADER],
      });
    });

    it('accepts a range of exactly 366 days', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-01-01&to=2027-01-01`,
      });

      // Inside the transport limit, so it is rejected on coverage instead, not on validation.
      expect(response.statusCode).toBe(422);
    });

    it('reports a stable field path without exposing internals', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-31&to=2026-03-01`,
      });
      const { errors } = response.json();

      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('/to');
      expect(Object.keys(errors[0]).toSorted()).toEqual(['code', 'message', 'path']);
    });
  });

  describe('the documented failures', () => {
    it.each([
      [
        'PROVIDER_NOT_FOUND',
        404,
        '/api/v1/providers/unknown/service-areas/koblenz-stadtmitte/collection-events?from=2026-03-01&to=2026-03-31',
      ],
      [
        'SERVICE_AREA_NOT_FOUND',
        404,
        '/api/v1/providers/koblenz-servicebetrieb/service-areas/unknown-area/collection-events?from=2026-03-01&to=2026-03-31',
      ],
      [
        'COLLECTION_EVENTS_NOT_AVAILABLE',
        404,
        '/api/v1/providers/demo/service-areas/koblenz-stadtmitte/collection-events?from=2026-03-01&to=2026-03-31',
      ],
      ['SCHEDULE_RANGE_NOT_COVERED', 422, `${EVENTS}?from=2025-01-01&to=2025-12-31`],
    ])('returns %s as %s', async (code, status, url) => {
      app = await buildTestApp({ providerRuntime: { fetch: okFetch().fetch } });

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(status);
      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(response.json()).toMatchObject({
        status,
        code,
        instance: url,
        requestId: response.headers[REQUEST_ID_HEADER],
      });
    });

    it('rejects a range straddling the validity window rather than answering it in part', async () => {
      app = await buildTestApp({ providerRuntime: { fetch: okFetch().fetch } });

      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2025-12-01&to=2026-01-31`,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('SCHEDULE_RANGE_NOT_COVERED');
    });

    it('decides coverage from the declared window, never from an empty result', async () => {
      app = await buildTestApp({
        providerRuntime: { fetch: okFetch(calendar([])).fetch },
      });

      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      // The source contains nothing at all, yet the range is covered, so this is an empty 200.
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    });

    it('returns 502 when the source is retrieved but unusable', async () => {
      // A calendar that attests no zone: reached, but not usable.
      const body = calendar().replace('X-WR-TIMEZONE:Europe/Berlin\r\n', '');

      app = await buildTestApp({ providerRuntime: { fetch: okFetch(body).fetch } });

      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        type: 'urn:abfall-radar:problem:upstream-source-invalid',
        code: 'UPSTREAM_SOURCE_INVALID',
        detail:
          'The official source was retrieved but could not be used, and no valid schedule is available.',
      });
    });

    it('returns 503 when the source cannot be retrieved', async () => {
      app = await buildTestApp({ providerRuntime: { fetch: failingFetch(500) } });

      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        type: 'urn:abfall-radar:problem:upstream-source-unavailable',
        code: 'UPSTREAM_SOURCE_UNAVAILABLE',
      });
    });

    it.each([502, 503])('leaks no upstream detail in a %s body', async (status) => {
      const fetchImpl: FetchLike =
        status === 502
          ? okFetch('totally not a calendar').fetch
          : async () => {
              throw new TypeError('connect ECONNREFUSED 10.0.0.5:443');
            };

      app = await buildTestApp({ providerRuntime: { fetch: fetchImpl } });

      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      expect(response.statusCode).toBe(status);

      for (const forbidden of [
        'ECONNREFUSED',
        '10.0.0.5',
        'not a calendar',
        'SourceFailureError',
        'at ',
      ]) {
        expect(response.payload).not.toContain(forbidden);
      }
    });

    it('logs a retrieval failure in full while returning it sanitized', async () => {
      const logs = createLogCollector();
      const secret = 'connect ECONNREFUSED 10.0.0.5:443';
      const fetchImpl: FetchLike = () => {
        throw new TypeError(secret);
      };

      app = await buildTestApp({
        config: { logLevel: 'error' },
        logDestination: logs.stream,
        providerRuntime: { fetch: fetchImpl },
      });

      const response = await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31`,
      });

      // A throw from `fetch` is indistinguishable from a real connection failure — that is exactly how
      // the built-in reports one — so it is an unavailable source rather than an internal error.
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('UPSTREAM_SOURCE_UNAVAILABLE');
      expect(response.payload).not.toContain('ECONNREFUSED');
      expect(response.payload).not.toContain('10.0.0.5');

      // The underlying cause still reaches the operator, correlated by request identifier.
      const logged = logs.find(
        (line) => line.msg === 'Official source refresh failed and no valid schedule was available',
      );

      expect(logged).toMatchObject({ requestId: response.headers[REQUEST_ID_HEADER] });
      expect(JSON.stringify(logged)).toContain('ECONNREFUSED');
    });

    it('returns a sanitized 500 for an unexpected failure rather than an upstream status', async () => {
      // The provider-level equivalent is unit-tested in the cache: a non-source error is rethrown rather
      // than masked as an upstream fault. Here the generic boundary is asserted through a hidden route,
      // so the 500 path is covered without pretending a network throw is a programming mistake.
      const logs = createLogCollector();

      app = await buildTestApp({
        config: { logLevel: 'error' },
        logDestination: logs.stream,
        withFailingRoutes: true,
      });

      const response = await app.inject({ method: 'GET', url: '/__unexpected' });

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe('INTERNAL_SERVER_ERROR');
      expect(response.payload).not.toContain('confidential');
    });

    it('matches requestId to the header on every problem response', async () => {
      app = await buildTestApp({ providerRuntime: { fetch: failingFetch(503) } });

      for (const url of [
        `${EVENTS}?from=2026-03-31&to=2026-03-01`,
        `${EVENTS}?from=2025-01-01&to=2025-12-31`,
        `${EVENTS}?from=2026-03-01&to=2026-03-31`,
        '/api/v1/providers/unknown/service-areas/a/collection-events?from=2026-03-01&to=2026-03-31',
      ]) {
        const response = await app.inject({ method: 'GET', url });

        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.json().requestId).toBe(response.headers[REQUEST_ID_HEADER]);
      }
    });
  });

  describe('upstream URL control', () => {
    it('ignores any request input that looks like an upstream URL', async () => {
      const requested: string[] = [];
      const fetchImpl: FetchLike = async (input) => {
        requested.push(input instanceof URL ? input.href : String(input));

        return new Response(calendar(), { headers: { 'content-type': 'text/calendar' } });
      };

      app = await buildTestApp({ providerRuntime: { fetch: fetchImpl } });

      await app.inject({
        method: 'GET',
        url: `${EVENTS}?from=2026-03-01&to=2026-03-31&url=https://evil.example/x.ics`,
        headers: {
          'x-forwarded-host': 'evil.example',
          'x-upstream-url': 'https://evil.example/x.ics',
        },
      });

      expect(requested).toEqual([
        'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/entsorgungstermine-2026-digital/ics-stadtmitte.ics',
      ]);
    });
  });
});
