import { describe, expect, it } from 'vitest';
import {
  COLLECTION_EVENTS_BODY,
  CURBSIDE_EVENT,
  MOBILE_DROP_OFF_EVENT,
  mutableCopy,
} from '../test/response-fixtures';
import { CollectionEventListResponseSchema, CollectionEventSchema } from './collection-events';

describe('CollectionEventSchema', () => {
  it('parses a curbside event', () => {
    expect(CollectionEventSchema.parse(CURBSIDE_EVENT)).toEqual(CURBSIDE_EVENT);
  });

  it('parses a mobile drop-off event with its window, zone, and place', () => {
    expect(CollectionEventSchema.parse(MOBILE_DROP_OFF_EVENT)).toEqual(MOBILE_DROP_OFF_EVENT);
  });

  it('rejects an unknown collection mode', () => {
    // Intended: ADR 0003 chose a closed variant set so that adding one is a contract change for every
    // client. A loud failure is the cost of making an incomplete event unrepresentable.
    const event = { ...mutableCopy(CURBSIDE_EVENT), collectionMode: 'smart_bin' };

    expect(CollectionEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects a mobile drop-off missing its location', () => {
    const event = mutableCopy(MOBILE_DROP_OFF_EVENT);

    delete event.location;

    expect(CollectionEventSchema.safeParse(event).success).toBe(false);
  });

  /**
   * A place name has **one** canonical spelling, and a non-canonical one is refused rather than tidied.
   *
   * Trimming here would make this validator hand on a value it had silently altered, while the domain — which
   * refuses the untrimmed form outright — mapped something the transport had changed behind its back. The same
   * place would then be able to arrive under two spellings depending on which layer saw it first.
   */
  describe('a mobile-drop-off location name that is not canonical', () => {
    const withName = (name: string): unknown => ({
      ...mutableCopy(MOBILE_DROP_OFF_EVENT),
      location: { name },
    });

    it.each([
      ['leading whitespace', ' Rizzastraße Ecke Südallee'],
      ['trailing whitespace', 'Rizzastraße Ecke Südallee '],
      ['whitespace at both ends', ' Rizzastraße Ecke Südallee '],
      ['a leading tab', '\tRizzastraße'],
      ['a trailing newline', 'Rizzastraße\n'],
      ['nothing but whitespace', '   '],
      ['nothing at all', ''],
    ])('is rejected for %s', (_reason, name) => {
      expect(CollectionEventSchema.safeParse(withName(name)).success).toBe(false);
    });

    it('is rejected rather than trimmed and accepted', () => {
      // Stated as its own case: a validator that normalized would *succeed* here, with a different value.
      const parsed = CollectionEventSchema.safeParse(withName(' Rizzastraße '));

      expect(parsed.success).toBe(false);
    });
  });

  describe('a canonical mobile-drop-off location name', () => {
    const withName = (name: string): unknown => ({
      ...mutableCopy(MOBILE_DROP_OFF_EVENT),
      location: { name },
    });

    it.each([
      ['internal spaces', 'Rizzastraße Ecke Südallee'],
      ['German characters', 'Löhrstraße/Görgenstraße'],
      ['an umlaut and an eszett', 'Am Wöllershof 3, Koblenz-Süß'],
      ['internal punctuation and digits', 'Parkplatz P+R, Tor 2'],
      ['a single character', 'A'],
    ])('passes unchanged with %s', (_reason, name) => {
      const parsed = CollectionEventSchema.safeParse(withName(name));

      expect(parsed.success).toBe(true);
      // Unchanged, not normalized: the value that came in is the value that comes out.
      expect(
        parsed.success && parsed.data.collectionMode === 'mobile_drop_off' && parsed.data.location,
      ).toEqual({ name });
    });
  });

  it('rejects a mobile drop-off whose timing carries no zone', () => {
    expect(
      CollectionEventSchema.safeParse({
        ...mutableCopy(MOBILE_DROP_OFF_EVENT),
        timing: {
          kind: 'time_window',
          startsAt: '2026-03-21T10:00:00Z',
          endsAt: '2026-03-21T12:00:00Z',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a curbside event carrying a time window', () => {
    expect(
      CollectionEventSchema.safeParse({
        ...mutableCopy(CURBSIDE_EVENT),
        timing: {
          kind: 'time_window',
          startsAt: '2026-03-21T10:00:00Z',
          endsAt: '2026-03-21T12:00:00Z',
          timeZone: 'Europe/Berlin',
        },
      }).success,
    ).toBe(false);
  });

  it('strips an unknown member rather than forwarding it', () => {
    const parsed = CollectionEventSchema.parse({
      ...mutableCopy(CURBSIDE_EVENT),
      addedLater: 'ignored',
    });

    expect(Object.keys(parsed)).not.toContain('addedLater');
  });

  it.each([
    ['an unrecognized waste type', { wasteType: 'nuclear' }],
    ['a date that is not a calendar date', { date: '14.08.2026' }],
    ['an empty title', { title: '' }],
    ['an unrecognized source', { source: 'guessed' }],
  ])('rejects %s', (_reason, override) => {
    expect(
      CollectionEventSchema.safeParse({ ...mutableCopy(CURBSIDE_EVENT), ...override }).success,
    ).toBe(false);
  });
});

describe('CollectionEventListResponseSchema', () => {
  it('parses a response carrying both event variants', () => {
    const parsed = CollectionEventListResponseSchema.parse(COLLECTION_EVENTS_BODY);

    expect(parsed.data.map((event) => event.collectionMode)).toEqual([
      'curbside',
      'mobile_drop_off',
    ]);
  });

  it('parses an empty result inside a covered range, which is a different statement from no coverage', () => {
    const parsed = CollectionEventListResponseSchema.parse({
      ...mutableCopy(COLLECTION_EVENTS_BODY),
      data: [],
    });

    expect(parsed.data).toEqual([]);
    expect(parsed.meta.coverage.wasteTypes).toContain('paper');
  });

  it('keeps the provenance a surface needs to label what it shows', () => {
    const { meta } = CollectionEventListResponseSchema.parse(COLLECTION_EVENTS_BODY);

    expect(meta.source.name).toBe('Kommunaler Servicebetrieb');
    expect(meta.source.landingPageUrl).toContain('servicebetrieb.koblenz.de');
    expect(meta.source.timeZone).toBe('Europe/Berlin');
    expect(meta.retrievedAt).toBe('2026-07-29T08:14:02.000Z');
    expect(meta.freshness).toBe('fresh');
    expect(meta.validFrom).toBe('2026-01-01');
    expect(meta.validTo).toBe('2026-12-31');
  });

  it('parses a stale response without relabelling it', () => {
    const meta = { ...mutableCopy(COLLECTION_EVENTS_BODY.meta), freshness: 'stale' };
    const parsed = CollectionEventListResponseSchema.parse({
      ...mutableCopy(COLLECTION_EVENTS_BODY),
      meta,
    });

    expect(parsed.meta.freshness).toBe('stale');
  });

  it('accepts an unknown property and strips it at every level', () => {
    const parsed = CollectionEventListResponseSchema.parse({
      ...mutableCopy(COLLECTION_EVENTS_BODY),
      links: { next: '/page/2' },
    });

    expect(Object.keys(parsed).toSorted()).toEqual(['data', 'meta']);
  });

  it.each([
    ['a missing meta', { data: [] }],
    ['a missing data array', { meta: COLLECTION_EVENTS_BODY.meta }],
    [
      'an unrecognized freshness state',
      { data: [], meta: { ...mutableCopy(COLLECTION_EVENTS_BODY.meta), freshness: 'guessed' } },
    ],
    [
      'a retrieval time that is not a timestamp',
      { data: [], meta: { ...mutableCopy(COLLECTION_EVENTS_BODY.meta), retrievedAt: 'yesterday' } },
    ],
    [
      'a source landing page that is not a URL',
      {
        data: [],
        meta: {
          ...mutableCopy(COLLECTION_EVENTS_BODY.meta),
          source: { ...mutableCopy(COLLECTION_EVENTS_BODY.meta.source), landingPageUrl: 'nope' },
        },
      },
    ],
  ])('rejects %s', (_reason, body) => {
    expect(CollectionEventListResponseSchema.safeParse(body).success).toBe(false);
  });
});

/**
 * Coverage and events are two halves of one claim, and they have to agree.
 *
 * `coverage.wasteTypes` is the source's own declaration of what it publishes. An event whose type is missing from it
 * makes the response contradict itself — it contains a collection the source says it does not publish — and every
 * reader then has to pick a half to believe. The dashboard would render the event while reporting that type as
 * uncovered; the reminder would notify about a collection it also reports as unavailable.
 */
describe('the agreement between coverage and events', () => {
  const bodyWith = ({
    events,
    wasteTypes,
  }: {
    events: unknown[];
    wasteTypes: string[];
  }): Record<string, unknown> => {
    const body = mutableCopy(COLLECTION_EVENTS_BODY);

    body.data = events;
    body.meta = {
      ...mutableCopy(COLLECTION_EVENTS_BODY.meta),
      coverage: { wasteTypes },
    };

    return body;
  };

  it('rejects a response whose only event carries an undeclared type', () => {
    const parsed = CollectionEventListResponseSchema.safeParse(
      bodyWith({ events: [CURBSIDE_EVENT], wasteTypes: ['hazardous'] }),
    );

    expect(parsed.success).toBe(false);
  });

  it('reports the issue at the offending event’s own waste type', () => {
    // So a log or a build names the event that is wrong rather than the response that contains it.
    const parsed = CollectionEventListResponseSchema.safeParse(
      bodyWith({ events: [CURBSIDE_EVENT], wasteTypes: ['hazardous'] }),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual([
      'data',
      0,
      'wasteType',
    ]);
  });

  it('rejects the whole response when only a later event is undeclared', () => {
    /**
     * Coverage is a claim about the entire answer, so a contradicting response cannot be partially trusted:
     * dropping the event would silently change what the source said.
     */
    const parsed = CollectionEventListResponseSchema.safeParse(
      bodyWith({
        events: [CURBSIDE_EVENT, MOBILE_DROP_OFF_EVENT],
        wasteTypes: ['paper'],
      }),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual([
      'data',
      1,
      'wasteType',
    ]);
  });

  it('accepts an empty event array against a declared coverage', () => {
    // The ordinary quiet period: nothing scheduled inside a covered range is not a contradiction.
    expect(
      CollectionEventListResponseSchema.safeParse(
        bodyWith({ events: [], wasteTypes: ['paper', 'hazardous'] }),
      ).success,
    ).toBe(true);
  });

  it('accepts declared types that have no events at all', () => {
    expect(
      CollectionEventListResponseSchema.safeParse(
        bodyWith({ events: [CURBSIDE_EVENT], wasteTypes: ['paper', 'bio', 'residual'] }),
      ).success,
    ).toBe(true);
  });

  it('accepts both event variants when every type is declared', () => {
    expect(
      CollectionEventListResponseSchema.safeParse(
        bodyWith({
          events: [CURBSIDE_EVENT, MOBILE_DROP_OFF_EVENT],
          wasteTypes: ['paper', 'hazardous'],
        }),
      ).success,
    ).toBe(true);
  });

  it('accepts the genuine fixture unchanged, so the rule is not refusing everything', () => {
    expect(CollectionEventListResponseSchema.safeParse(COLLECTION_EVENTS_BODY).success).toBe(true);
  });

  it('never infers coverage from the events it was given', () => {
    // The rule runs one way only. An empty declaration with events present is a contradiction, not a reason to
    // conclude the source publishes what it just sent.
    expect(
      CollectionEventListResponseSchema.safeParse(
        bodyWith({ events: [CURBSIDE_EVENT], wasteTypes: [] }),
      ).success,
    ).toBe(false);
  });

  it('still strips an unknown additive member rather than refusing it', () => {
    // The established behaviour for additive contract changes is unaffected by the cross-field check.
    const body = bodyWith({ events: [CURBSIDE_EVENT], wasteTypes: ['paper'] });
    const parsed = CollectionEventListResponseSchema.safeParse({ ...body, somethingNew: true });

    expect(parsed.success).toBe(true);
    expect(parsed.success && 'somethingNew' in parsed.data).toBe(false);
  });
});
