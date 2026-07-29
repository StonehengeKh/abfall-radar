import type { CollectionEvent } from '@abfall-radar/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceFailureReason } from '../source';
import { allDayEvent, buildCalendar, timedEvent } from '../test/ics-fixtures';
import { parseCalendar } from './calendar';
import { koblenzStadtmitteManifest } from './koblenz/manifest';
import { koblenzSummaryMapping } from './koblenz/summary-mapping';
import { normalizeCalendar } from './normalize';

const manifest = koblenzStadtmitteManifest;

const COMBINED_SUMMARY = 'Schadstoffe / Elektrokleinteile';

const normalize = (events: readonly string[], zoneLines?: readonly string[]): CollectionEvent[] => {
  const body = buildCalendar(zoneLines === undefined ? { events } : { events, zoneLines });

  return normalizeCalendar({
    manifest,
    mapping: koblenzSummaryMapping,
    calendar: parseCalendar(body, manifest),
  });
};

const expectFailure = (events: readonly string[], reason: SourceFailureReason): void => {
  expect(() => normalize(events)).toThrowError(
    expect.objectContaining({ name: 'SourceFailureError', reason }),
  );
};

const originalTimeZone = process.env.TZ;

afterEach(() => {
  if (originalTimeZone === undefined) {
    delete process.env.TZ;

    return;
  }

  process.env.TZ = originalTimeZone;
});

describe('all-day curbside normalization', () => {
  it('produces a curbside event with an all-day timing and no location', () => {
    const [event] = normalize([
      allDayEvent({ summary: 'Altpapier', date: '20260814', endDate: '20260815' }),
    ]);

    expect(event).toEqual({
      id: expect.stringContaining('koblenz-servicebetrieb-koblenz-stadtmitte-paper-2026-08-14-'),
      districtId: 'koblenz-stadtmitte',
      type: 'paper',
      date: '2026-08-14',
      title: 'Altpapier',
      source: 'municipal_ics',
      collectionMode: 'curbside',
      timing: { kind: 'all_day' },
    });
  });

  it.each([
    ['Pacific/Kiritimati', 'fourteen hours east of UTC'],
    ['Pacific/Niue', 'eleven hours west of UTC'],
    ['UTC', 'at UTC'],
    ['Europe/Berlin', 'in the source zone'],
  ])('keeps the calendar date with the process %s (%s)', (timeZone) => {
    process.env.TZ = timeZone;

    // Reading the instant in UTC instead of the local components would report 2026-01-06 east of UTC.
    expect(normalize([allDayEvent({ summary: 'Altpapier', date: '20260107' })])[0]?.date).toBe(
      '2026-01-07',
    );
  });

  it('maps every verified all-day summary to its waste type', () => {
    const events = normalize([
      allDayEvent({ uid: 'a', summary: 'Altpapier', date: '20260107' }),
      allDayEvent({ uid: 'b', summary: 'Gelber Sack', date: '20260108' }),
      allDayEvent({ uid: 'c', summary: 'Grünschnitt', date: '20260109' }),
      allDayEvent({ uid: 'd', summary: 'Tannenbäume', date: '20260110' }),
    ]);

    expect(events.map((event) => event.type)).toEqual([
      'paper',
      'yellow_bag',
      'green_waste',
      'christmas_tree',
    ]);
    expect(events.every((event) => event.collectionMode === 'curbside')).toBe(true);
  });
});

describe('the all-day span, measured in calendar days', () => {
  // Pinned to a zone that actually observes daylight saving, because that is the whole point: a one-day
  // all-day event is 23 hours long across the spring-forward date and 25 across the fall-back one.
  // Comparing elapsed milliseconds against 24 hours rejects the second and accepts a backwards event.
  beforeEach(() => {
    process.env.TZ = 'Europe/Berlin';
  });

  const allDaySpan = (date: string, endDate?: string): CollectionEvent[] =>
    normalize([
      allDayEvent({
        summary: 'Altpapier',
        date,
        ...(endDate === undefined ? {} : { endDate }),
      }),
    ]);

  it.each([
    // 2026-03-29 is the European spring-forward date: this span is only 23 hours of elapsed time.
    ['crossing the spring-forward boundary', '20260329', '20260330', '2026-03-29'],
    // 2026-10-25 is the fall-back date: 25 hours of elapsed time, which an elapsed-time check rejects.
    ['crossing the fall-back boundary', '20261025', '20261026', '2026-10-25'],
    ['on an ordinary date', '20260107', '20260108', '2026-01-07'],
  ])('accepts a one-day event %s', (_reason, date, endDate, expected) => {
    const events = allDaySpan(date, endDate);

    expect(events).toHaveLength(1);
    expect(events[0]?.date).toBe(expected);
    expect(events[0]?.collectionMode).toBe('curbside');
  });

  it('accepts an omitted DTEND on the fall-back date', () => {
    // For a `VALUE=DATE` entry with no `DTEND` the parser applies the RFC 5545 one-day default rather
    // than setting the end equal to the start, so this is a 25-hour span on this date and an
    // elapsed-time comparison rejects it. Accepting both a zero-day and a one-day span keeps the check
    // independent of which defaulting rule the parser used.
    const events = allDaySpan('20261025');

    expect(events).toHaveLength(1);
    expect(events[0]?.date).toBe('2026-10-25');
  });

  it.each([
    ['a two-day span', '20260107', '20260109'],
    ['a multi-day span', '20260107', '20260110'],
    ['a span across the fall-back date', '20261024', '20261026'],
  ])('rejects %s', (_reason, date, endDate) => {
    expect(() => allDaySpan(date, endDate)).toThrowError(
      expect.objectContaining({ name: 'SourceFailureError', reason: 'event-invalid' }),
    );
  });

  it.each([
    ['an end date before the start date', '20260110', '20260107'],
    ['an end date one day before the start date', '20260108', '20260107'],
    ['a reversed span across the fall-back date', '20261026', '20261025'],
  ])('rejects %s', (_reason, date, endDate) => {
    // An elapsed-time comparison against 24 hours lets every one of these through: a negative difference
    // is never greater than a positive threshold.
    expect(() => allDaySpan(date, endDate)).toThrowError(
      expect.objectContaining({ name: 'SourceFailureError', reason: 'event-invalid' }),
    );
  });

  it('derives the event date from local components, not from the ordinal arithmetic', () => {
    // The ordinal helper exists only to compare two calendar dates. The normalized date still comes from
    // the local components the parser wrote, which is what keeps it stable in any process zone.
    process.env.TZ = 'Pacific/Kiritimati';

    expect(allDaySpan('20260107', '20260108')[0]?.date).toBe('2026-01-07');
  });
});

describe('the curbside LOCATION property', () => {
  // The verified source repeats the area label — `Stadtmitte` — in `LOCATION` on all 44 of its curbside
  // entries, and names a real street corner on its timed ones. Exactly the redundant label is tolerated;
  // anything else fails, because dropping a location the source actually means would present "bring this
  // somewhere" as "put the bin out".
  const curbsideWith = (location?: string): CollectionEvent[] =>
    normalize([
      allDayEvent({
        summary: 'Altpapier',
        date: '20260107',
        ...(location === undefined ? {} : { location }),
      }),
    ]);

  const expectAcceptedWithoutLocation = (events: readonly CollectionEvent[]): void => {
    expect(events).toHaveLength(1);
    expect(events[0]?.collectionMode).toBe('curbside');
    // Accepted, but never exposed: `meta.serviceArea` already carries the area name.
    expect(Object.keys(events[0] ?? {})).not.toContain('location');
  };

  it('accepts an entry with no LOCATION at all', () => {
    expectAcceptedWithoutLocation(curbsideWith());
  });

  it('accepts the exact manifest area name and omits it from the event', () => {
    expectAcceptedWithoutLocation(curbsideWith('Stadtmitte'));
  });

  it.each([
    ['leading and trailing spaces', '  Stadtmitte '],
    ['a trailing tab', 'Stadtmitte\t'],
    // Written escaped in the calendar, which is the only way a line break can appear in a value; the
    // parser unescapes it into a real newline before normalization sees it.
    ['an escaped trailing newline', 'Stadtmitte\\n'],
  ])('accepts the area name with %s', (_reason, location) => {
    expectAcceptedWithoutLocation(curbsideWith(location));
  });

  it('accepts a doubled internal space and an NFD spelling of a multi-word area name', () => {
    // Two separate hazards in one fixture: the source doubled an internal space, and it encoded its
    // diacritics as combining marks. Comparing raw strings would reject this and take a whole source out
    // over a difference nobody reading it could see.
    const areaName = 'Alt Südstadt';
    const supplied = '  Alt   Südstadt '.normalize('NFD');

    expect(supplied.normalize('NFC')).not.toBe(supplied);
    expect(supplied.trim()).not.toBe(areaName);

    const events = normalizeCalendar({
      manifest: { ...manifest, areaName },
      mapping: koblenzSummaryMapping,
      calendar: parseCalendar(
        buildCalendar({
          events: [allDayEvent({ summary: 'Altpapier', date: '20260107', location: supplied })],
        }),
        manifest,
      ),
    });

    expectAcceptedWithoutLocation(events);
  });

  it.each([
    ['an empty LOCATION', ''],
    ['a whitespace-only LOCATION', '   '],
    ['a street corner', 'Rizzastraße Ecke Südallee'],
    ['a different area', 'Metternich'],
    ['the area name with extra words', 'Stadtmitte Nord'],
    ['a substring of the area name', 'Stadt'],
    // Collapsing whitespace must not be able to bridge a word boundary into a match.
    ['the area name split by a space', 'Stadt  mitte'],
    ['the area name split by a tab', 'Stadt\tmitte'],
  ])('fails the refresh on %s', (_reason, location) => {
    expect(() => curbsideWith(location)).toThrowError(
      expect.objectContaining({
        name: 'SourceFailureError',
        reason: 'event-invalid',
        kind: 'invalid',
      }),
    );
  });

  it('preserves on a timed entry the very value it rejects on a curbside one', () => {
    // The same street corner: meaningless on a curbside collection and therefore a refusal, essential on
    // a mobile drop-off and therefore preserved. This contrast is the whole rule in one assertion.
    const corner = 'Rizzastraße Ecke Südallee';

    expect(() => curbsideWith(corner)).toThrowError(
      expect.objectContaining({ reason: 'event-invalid' }),
    );

    const [timed] = normalize([
      timedEvent({
        summary: COMBINED_SUMMARY,
        start: '20260321T100000Z',
        end: '20260321T120000Z',
        location: `  ${corner} `,
      }),
    ]);

    expect(timed?.collectionMode).toBe('mobile_drop_off');
    expect(timed && 'location' in timed ? timed.location : undefined).toEqual({ name: corner });
  });

  it('fails the whole refresh rather than dropping one entry', () => {
    // A partial schedule reads as a complete one, so a single unexpected location takes the source out.
    expect(() =>
      normalize([
        allDayEvent({
          uid: 'good',
          summary: 'Altpapier',
          date: '20260107',
          location: 'Stadtmitte',
        }),
        allDayEvent({
          uid: 'bad',
          summary: 'Gelber Sack',
          date: '20260108',
          location: 'Elsewhere',
        }),
      ]),
    ).toThrowError(expect.objectContaining({ reason: 'event-invalid' }));
  });
});

describe('timed mobile drop-off normalization', () => {
  const combined = timedEvent({
    summary: COMBINED_SUMMARY,
    start: '20260321T100000Z',
    end: '20260321T120000Z',
    location: 'Rizzastraße Ecke  Südallee ',
  });

  it('preserves the window, the zone, the mode, and a trimmed collapsed location', () => {
    const events = normalize([combined]);

    for (const event of events) {
      expect(event).toMatchObject({
        date: '2026-03-21',
        title: COMBINED_SUMMARY,
        source: 'municipal_ics',
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

  it('splits one combined entry into a hazardous and a small-electronics event', () => {
    const events = normalize([combined]);

    expect(events.map((event) => event.type).toSorted()).toEqual([
      'hazardous',
      'small_electronics',
    ]);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });

  it('gives the pair identical timing and location but different identifiers', () => {
    const [first, second] = normalize([combined]);

    expect(first?.timing).toEqual(second?.timing);
    expect(first && 'location' in first ? first.location : undefined).toEqual(
      second && 'location' in second ? second.location : undefined,
    );
    expect(first?.id).not.toBe(second?.id);
  });

  it('turns two combined entries into four events, so entry count is never the event count', () => {
    const events = normalize([
      timedEvent({
        uid: 'march',
        summary: COMBINED_SUMMARY,
        start: '20260321T100000Z',
        end: '20260321T120000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
      timedEvent({
        uid: 'november',
        summary: COMBINED_SUMMARY,
        start: '20261107T100000Z',
        end: '20261107T120000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
    ]);

    expect(events).toHaveLength(4);
    expect(new Set(events.map((event) => event.id)).size).toBe(4);
    expect(events.map((event) => event.date).toSorted()).toEqual([
      '2026-03-21',
      '2026-03-21',
      '2026-11-07',
      '2026-11-07',
    ]);
  });

  it('derives the local date in the attested zone, not in UTC or the process zone', () => {
    process.env.TZ = 'Pacific/Niue';

    // 22:30 UTC on 30 June is already 1 July in Berlin. A UTC or server-local derivation fails here.
    const events = normalize([
      timedEvent({
        summary: COMBINED_SUMMARY,
        start: '20260630T223000Z',
        end: '20260630T233000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
    ]);

    expect(events[0]?.date).toBe('2026-07-01');
    expect(events[0]?.timing).toMatchObject({ startsAt: '2026-06-30T22:30:00Z' });
  });

  it('resolves the two verified windows to their Berlin dates', () => {
    const march = normalize([
      timedEvent({
        summary: COMBINED_SUMMARY,
        start: '20260321T100000Z',
        end: '20260321T120000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
    ]);
    const november = normalize([
      timedEvent({
        summary: COMBINED_SUMMARY,
        start: '20261107T100000Z',
        end: '20261107T120000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
    ]);

    expect(march[0]?.date).toBe('2026-03-21');
    expect(november[0]?.date).toBe('2026-11-07');
  });
});

describe('collapsing and collisions', () => {
  it('collapses two fully identical normalized events into one', () => {
    const events = normalize([
      allDayEvent({ uid: 'first', summary: 'Altpapier', date: '20260107' }),
      allDayEvent({ uid: 'second', summary: 'Altpapier', date: '20260107' }),
    ]);

    expect(events).toHaveLength(1);
  });

  it('fails the refresh when one identifier covers two different identities', () => {
    // A constant digest forces the truncated-digest collision that real hashing makes negligible.
    // Collapsing it would silently drop a real collection, so it has to fail loudly.
    expect(() =>
      normalizeCalendar({
        manifest,
        mapping: koblenzSummaryMapping,
        digest: () => 'deadbeefdeadbeef',
        calendar: parseCalendar(
          buildCalendar({
            events: [
              timedEvent({
                uid: 'morning',
                summary: COMBINED_SUMMARY,
                start: '20260321T080000Z',
                end: '20260321T100000Z',
                location: 'Rizzastraße Ecke Südallee',
              }),
              timedEvent({
                uid: 'afternoon',
                summary: COMBINED_SUMMARY,
                start: '20260321T140000Z',
                end: '20260321T160000Z',
                location: 'Rizzastraße Ecke Südallee',
              }),
            ],
          }),
          manifest,
        ),
      }),
    ).toThrowError(expect.objectContaining({ reason: 'identity-collision', kind: 'invalid' }));
  });

  it('returns both events when the same waste type and date carry different windows', () => {
    const events = normalize([
      timedEvent({
        uid: 'morning',
        summary: COMBINED_SUMMARY,
        start: '20260321T080000Z',
        end: '20260321T100000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
      timedEvent({
        uid: 'afternoon',
        summary: COMBINED_SUMMARY,
        start: '20260321T140000Z',
        end: '20260321T160000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
    ]);

    expect(events).toHaveLength(4);
    expect(new Set(events.map((event) => event.id)).size).toBe(4);
  });

  it('returns both events when only the location differs', () => {
    const events = normalize([
      timedEvent({
        uid: 'here',
        summary: COMBINED_SUMMARY,
        start: '20260321T100000Z',
        end: '20260321T120000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
      timedEvent({
        uid: 'there',
        summary: COMBINED_SUMMARY,
        start: '20260321T100000Z',
        end: '20260321T120000Z',
        location: 'Am Löhrrondell',
      }),
    ]);

    expect(new Set(events.map((event) => event.id)).size).toBe(4);
  });

  it('produces identifiers that are stable across two parses and across process zones', () => {
    process.env.TZ = 'Pacific/Kiritimati';

    const first = normalize([
      allDayEvent({ summary: 'Altpapier', date: '20260107' }),
      timedEvent({
        uid: 'timed',
        summary: COMBINED_SUMMARY,
        start: '20260321T100000Z',
        end: '20260321T120000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
    ]);

    process.env.TZ = 'Pacific/Niue';

    const second = normalize([
      allDayEvent({ summary: 'Altpapier', date: '20260107' }),
      timedEvent({
        uid: 'timed',
        summary: COMBINED_SUMMARY,
        start: '20260321T100000Z',
        end: '20260321T120000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
    ]);

    expect(second.map((event) => event.id)).toEqual(first.map((event) => event.id));
  });
});

describe('failing loudly instead of producing a partial schedule', () => {
  it('fails on an unmapped summary', () => {
    expectFailure([allDayEvent({ summary: 'Sperrmüll', date: '20260107' })], 'summary-unmapped');
  });

  it('fails when a mobile-drop-off mapping arrives as an all-day entry', () => {
    expectFailure(
      [allDayEvent({ summary: COMBINED_SUMMARY, date: '20260321' })],
      'timing-mode-mismatch',
    );
  });

  it('fails when a curbside mapping arrives as a timed entry', () => {
    expectFailure(
      [
        timedEvent({
          summary: 'Altpapier',
          start: '20260107T060000Z',
          end: '20260107T080000Z',
        }),
      ],
      'timing-mode-mismatch',
    );
  });

  it.each([
    ['no end instant at all', undefined],
    // node-ical synthesizes `end === start` for the case above, so the two are indistinguishable and
    // both have to fail; asserting only the first would pass against a synthesized zero-length window.
    ['an end instant equal to its start', '20260321T100000Z'],
    ['an end instant before its start', '20260321T090000Z'],
  ])('fails on a mobile drop-off with %s', (_reason, end) => {
    expectFailure(
      [
        timedEvent({
          summary: COMBINED_SUMMARY,
          start: '20260321T100000Z',
          ...(end === undefined ? {} : { end }),
          location: 'Rizzastraße Ecke Südallee',
        }),
      ],
      'event-invalid',
    );
  });

  it.each([
    ['no location at all', undefined],
    ['a whitespace-only location', '   '],
  ])('fails on a mobile drop-off with %s', (_reason, location) => {
    expectFailure(
      [
        timedEvent({
          summary: COMBINED_SUMMARY,
          start: '20260321T100000Z',
          end: '20260321T120000Z',
          ...(location === undefined ? {} : { location }),
        }),
      ],
      'event-invalid',
    );
  });

  it('fails on an all-day entry spanning more than one day', () => {
    // Emitting one event for a multi-day span would under-report the collection.
    expectFailure(
      [allDayEvent({ summary: 'Altpapier', date: '20260107', endDate: '20260110' })],
      'event-invalid',
    );
  });
});

describe('what never reaches a normalized event', () => {
  it('exposes no upstream UID, DTSTAMP, or DESCRIPTION', () => {
    const events = normalize([
      allDayEvent({ uid: 'upstream-uid-value', summary: 'Altpapier', date: '20260107' }),
      timedEvent({
        uid: 'another-upstream-uid',
        summary: COMBINED_SUMMARY,
        start: '20260321T100000Z',
        end: '20260321T120000Z',
        location: 'Rizzastraße Ecke Südallee',
      }),
    ]);

    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain('upstream-uid-value');
    expect(serialized).not.toContain('another-upstream-uid');
    expect(serialized).not.toContain('dtstamp');
    expect(serialized).not.toContain('DTSTAMP');

    for (const event of events) {
      const members = Object.keys(event).toSorted();

      expect(members).not.toContain('uid');
      expect(members).not.toContain('description');
    }
  });
});
