import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionSourceManifest } from '../source';
import { createFakeFetch, type ScriptedHop } from '../test/fake-fetch';
import { koblenzStadtmitteManifest } from './koblenz/manifest';
import { MAX_BODY_BYTES, RETRIEVAL_DEADLINE_MS, retrieveCalendar } from './retrieval';

const manifest = koblenzStadtmitteManifest;

const BASE = 'https://servicebetrieb.koblenz.de';

const CALENDAR_PATH =
  '/abfallwirtschaft/entsorgungstermine-digital/entsorgungstermine-2026-digital/ics-stadtmitte.ics';

const retrieve = (hops: readonly ScriptedHop[], override?: Partial<CollectionSourceManifest>) => {
  const fake = createFakeFetch(hops);
  const promise = retrieveCalendar({
    manifest: override === undefined ? manifest : { ...manifest, ...override },
    fetch: fake.fetch,
  });

  return { fake, promise };
};

const expectReason = async (promise: Promise<unknown>, reason: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ name: 'SourceFailureError', reason });
};

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded retrieval success paths', () => {
  it('reads the body of a direct 200 response', async () => {
    const { promise, fake } = retrieve([{ body: 'BEGIN:VCALENDAR' }]);

    await expect(promise).resolves.toBe('BEGIN:VCALENDAR');
    expect(fake.calls()).toEqual([`${BASE}${CALENDAR_PATH}`]);
  });

  it('follows the verified single same-origin hop that only adds a query parameter', async () => {
    const { promise, fake } = retrieve([
      { status: 302, location: `${BASE}${CALENDAR_PATH}?cache=1` },
      { body: 'CALENDAR' },
    ]);

    await expect(promise).resolves.toBe('CALENDAR');
    expect(fake.callCount()).toBe(2);
  });

  it('follows a chain of three same-origin hops', async () => {
    const { promise, fake } = retrieve([
      { status: 302, location: `${BASE}${CALENDAR_PATH}?hop=1` },
      { status: 302, location: `${BASE}${CALENDAR_PATH}?hop=2` },
      { status: 307, location: `${BASE}${CALENDAR_PATH}?hop=3` },
      { body: 'CALENDAR' },
    ]);

    await expect(promise).resolves.toBe('CALENDAR');
    expect(fake.callCount()).toBe(4);
  });

  it('resolves a relative Location against the current target', async () => {
    const { promise } = retrieve([
      { status: 302, location: '/other/path.ics' },
      { body: 'CALENDAR' },
    ]);

    await expect(promise).resolves.toBe('CALENDAR');
  });
});

describe('origin pinning', () => {
  it.each([
    ['an HTTP downgrade', `http://servicebetrieb.koblenz.de${CALENDAR_PATH}`],
    ['another hostname', `https://example.com${CALENDAR_PATH}`],
    // The case a substring or suffix check would wave through.
    [
      'a hostname merely ending with the approved one',
      `https://evil-servicebetrieb.koblenz.de${CALENDAR_PATH}`,
    ],
    [
      'a hostname the approved one is a prefix of',
      `https://servicebetrieb.koblenz.de.evil.tld${CALENDAR_PATH}`,
    ],
    ['a subdomain of the approved host', `https://a.servicebetrieb.koblenz.de${CALENDAR_PATH}`],
    [
      'another port on the approved hostname',
      `https://servicebetrieb.koblenz.de:8443${CALENDAR_PATH}`,
    ],
  ])('refuses a redirect to %s', async (_reason, location) => {
    const { promise, fake } = retrieve([{ status: 302, location }, { body: 'CALENDAR' }]);

    await expectReason(promise, 'redirect-off-origin');
    // Refused rather than followed: the off-origin target is never requested.
    expect(fake.callCount()).toBe(1);
  });

  it('treats an explicit :443 as the same effective port', async () => {
    const { promise } = retrieve([
      { status: 302, location: `https://servicebetrieb.koblenz.de:443${CALENDAR_PATH}?x=1` },
      { body: 'CALENDAR' },
    ]);

    await expect(promise).resolves.toBe('CALENDAR');
  });

  it('refuses a manifest URL that is not on the approved origin', async () => {
    const { promise, fake } = retrieve([{ body: 'CALENDAR' }], {
      calendarUrl: 'https://example.com/calendar.ics',
    });

    await expectReason(promise, 'redirect-off-origin');
    expect(fake.callCount()).toBe(0);
  });
});

describe('redirect bounds', () => {
  it('stops at a fourth hop', async () => {
    const { promise, fake } = retrieve([
      { status: 302, location: `${BASE}${CALENDAR_PATH}?hop=1` },
      { status: 302, location: `${BASE}${CALENDAR_PATH}?hop=2` },
      { status: 302, location: `${BASE}${CALENDAR_PATH}?hop=3` },
      { status: 302, location: `${BASE}${CALENDAR_PATH}?hop=4` },
      { body: 'CALENDAR' },
    ]);

    await expectReason(promise, 'redirect-limit-exceeded');
    expect(fake.callCount()).toBe(4);
  });

  it('detects a same-origin redirect loop', async () => {
    const { promise } = retrieve([
      { status: 302, location: `${BASE}${CALENDAR_PATH}?loop=1` },
      { status: 302, location: `${BASE}${CALENDAR_PATH}?loop=1` },
    ]);

    await expectReason(promise, 'redirect-loop');
  });

  it('detects a redirect back to the initial URL', async () => {
    const { promise } = retrieve([{ status: 302, location: `${BASE}${CALENDAR_PATH}` }]);

    await expectReason(promise, 'redirect-loop');
  });

  it('rejects a redirect without a usable Location', async () => {
    const { promise } = retrieve([{ status: 302 }]);

    await expectReason(promise, 'status-rejected');
  });
});

describe('response rejection', () => {
  it.each([
    ['text/html', 'text/html'],
    ['application/json', 'application/json'],
    ['an absent content type', null],
  ])('rejects %s as an invalid source', async (_reason, contentType) => {
    const { promise } = retrieve([{ contentType, body: 'CALENDAR' }]);

    await expectReason(promise, 'content-type-rejected');
  });

  it('accepts the recorded content type with a charset parameter and odd casing', async () => {
    const { promise } = retrieve([{ contentType: 'TEXT/Calendar; charset=utf-8', body: 'CAL' }]);

    await expect(promise).resolves.toBe('CAL');
  });

  it.each([404, 500, 503])('reports status %s as unavailable', async (status) => {
    const { promise } = retrieve([{ status, body: 'nope' }]);

    await expectReason(promise, 'status-rejected');
  });

  it('reports a connection error as unavailable', async () => {
    const { promise } = retrieve([{ networkError: true }]);

    await expectReason(promise, 'network-error');
  });
});

describe('size bounds', () => {
  it('rejects a declared content-length above the limit before reading a chunk', async () => {
    const { promise } = retrieve([{ contentLength: String(MAX_BODY_BYTES + 1), body: 'CALENDAR' }]);

    await expectReason(promise, 'body-limit-exceeded');
  });

  it('aborts a streamed body that grows past the limit', async () => {
    const chunk = new Uint8Array(256 * 1024);
    const { promise } = retrieve([{ chunks: [chunk, chunk, chunk, chunk, chunk] }]);

    await expectReason(promise, 'body-limit-exceeded');
  });

  it('accepts a body exactly at the limit', async () => {
    const chunk = new Uint8Array(MAX_BODY_BYTES);

    chunk.fill(65);

    const { promise } = retrieve([{ chunks: [chunk] }]);

    await expect(promise).resolves.toHaveLength(MAX_BODY_BYTES);
  });
});

describe('early rejection releases the upstream body', () => {
  interface SpiedStream {
    readonly body: ReadableStream<Uint8Array>;
    readonly cancelCount: () => number;
    readonly pullCount: () => number;
    readonly locked: () => boolean;
  }

  /**
   * A body that reports whether it was cancelled and whether anything was ever pulled from it.
   * `highWaterMark: 0` keeps the stream from eagerly filling its queue, so a pull count of zero really
   * means "nothing was consumed" rather than "the queue was already full".
   */
  const createSpiedStream = (chunk = new Uint8Array(64)): SpiedStream => {
    let cancels = 0;
    let pulls = 0;
    let stream: ReadableStream<Uint8Array>;

    stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancels += 1;
        },
      },
      { highWaterMark: 0 },
    );

    return {
      body: stream,
      cancelCount: () => cancels,
      pullCount: () => pulls,
      locked: () => stream.locked,
    };
  };

  const retrieveStreamed = (
    spied: SpiedStream,
    init: ResponseInit,
  ): { promise: Promise<string>; calls: () => number } => {
    let calls = 0;
    const promise = retrieveCalendar({
      manifest,
      fetch: async () => {
        calls += 1;

        return new Response(spied.body, init);
      },
    });

    return { promise, calls: () => calls };
  };

  it('cancels the body exactly once and never reads it when the content type is rejected', async () => {
    const spied = createSpiedStream();
    const { promise } = retrieveStreamed(spied, { headers: { 'content-type': 'text/html' } });

    await expectReason(promise, 'content-type-rejected');

    // Cancelled rather than abandoned: an uncancelled body holds the socket open.
    expect(spied.cancelCount()).toBe(1);
    // Not consumed: nothing was pulled and no reader was ever acquired.
    expect(spied.pullCount()).toBe(0);
    expect(spied.locked()).toBe(false);
  });

  it('keeps the invalid classification when cancelling the body itself fails', async () => {
    // A cleanup failure must not be able to replace the reason, because the reason decides the status a
    // client sees. Here cancellation rejects, and the outcome is still content-type-rejected.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        throw new Error('cancellation exploded');
      },
    });

    const promise = retrieveCalendar({
      manifest,
      fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    });

    await expectReason(promise, 'content-type-rejected');
    await expect(promise).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('cancels the body of a non-2xx response', async () => {
    const spied = createSpiedStream();
    const { promise } = retrieveStreamed(spied, {
      status: 500,
      headers: { 'content-type': 'text/calendar' },
    });

    await expectReason(promise, 'status-rejected');

    expect(spied.cancelCount()).toBe(1);
    expect(spied.pullCount()).toBe(0);
  });

  it('cancels the body of a redirect it refuses to follow', async () => {
    const spied = createSpiedStream();
    const { promise } = retrieveStreamed(spied, {
      status: 302,
      headers: { location: 'https://example.com/elsewhere.ics' },
    });

    await expectReason(promise, 'redirect-off-origin');

    expect(spied.cancelCount()).toBe(1);
    expect(spied.pullCount()).toBe(0);
  });

  it('cancels the body of a redirect it does follow', async () => {
    const spied = createSpiedStream();
    let calls = 0;
    const promise = retrieveCalendar({
      manifest,
      fetch: async () => {
        calls += 1;

        return calls === 1
          ? new Response(spied.body, {
              status: 302,
              headers: { location: `${BASE}${CALENDAR_PATH}?hop=1` },
            })
          : new Response('CALENDAR', { headers: { 'content-type': 'text/calendar' } });
      },
    });

    await expect(promise).resolves.toBe('CALENDAR');

    expect(spied.cancelCount()).toBe(1);
    expect(spied.pullCount()).toBe(0);
  });

  it('cancels the body when content-length already exceeds the limit', async () => {
    const spied = createSpiedStream();
    const { promise } = retrieveStreamed(spied, {
      headers: {
        'content-type': 'text/calendar',
        'content-length': String(MAX_BODY_BYTES + 1),
      },
    });

    await expectReason(promise, 'body-limit-exceeded');

    // Rejected on the declared length alone, so the body is released without reading a chunk.
    expect(spied.cancelCount()).toBe(1);
    expect(spied.pullCount()).toBe(0);
  });

  it('cancels the reader when a streamed body grows past the limit', async () => {
    const spied = createSpiedStream(new Uint8Array(256 * 1024));
    const { promise } = retrieveStreamed(spied, { headers: { 'content-type': 'text/calendar' } });

    await expectReason(promise, 'body-limit-exceeded');

    // Here the body *was* being consumed, so cancellation goes through the reader; the stream's cancel
    // callback still runs exactly once.
    expect(spied.cancelCount()).toBe(1);
    expect(spied.pullCount()).toBeGreaterThan(0);
  });
});

describe('the retrieval deadline', () => {
  it('aborts a single slow response and reports unavailable', async () => {
    vi.useFakeTimers();

    const { promise } = retrieve([{ delayMs: RETRIEVAL_DEADLINE_MS * 2, body: 'CALENDAR' }]);
    const assertion = expectReason(promise, 'deadline-exceeded');

    await vi.advanceTimersByTimeAsync(RETRIEVAL_DEADLINE_MS + 1);
    await assertion;
  });

  it('covers a redirect chain as a whole, so individually fast hops still abort', async () => {
    vi.useFakeTimers();

    // Each hop is comfortably inside the deadline; only their sum exceeds it. A per-hop timeout would
    // let this chain run for as long as it liked.
    const hopDelay = 2_000;

    expect(hopDelay).toBeLessThan(RETRIEVAL_DEADLINE_MS);

    const { promise } = retrieve([
      { status: 302, location: `${BASE}${CALENDAR_PATH}?hop=1`, delayMs: hopDelay },
      { status: 302, location: `${BASE}${CALENDAR_PATH}?hop=2`, delayMs: hopDelay },
      { status: 302, location: `${BASE}${CALENDAR_PATH}?hop=3`, delayMs: hopDelay },
      { body: 'CALENDAR', delayMs: hopDelay },
    ]);
    const assertion = expectReason(promise, 'deadline-exceeded');

    await vi.advanceTimersByTimeAsync(RETRIEVAL_DEADLINE_MS + 1);
    await assertion;
  });
});

describe('upstream URL control', () => {
  it('requests exactly the manifest URL and never a client-influenced one', async () => {
    const { promise, fake } = retrieve([{ body: 'CALENDAR' }]);

    await promise;

    expect(fake.calls()).toEqual([manifest.calendarUrl]);
    // The stable no-query form: no `cid` value belongs in the manifest, a response, or a test.
    expect(manifest.calendarUrl).not.toContain('cid');
    expect(manifest.calendarUrl).not.toContain('?');
  });
});
