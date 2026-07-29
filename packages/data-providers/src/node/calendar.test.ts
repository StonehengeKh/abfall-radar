import { describe, expect, it } from 'vitest';
import type { SourceFailureReason } from '../source';
import { allDayEvent, BERLIN_ZONE_LINE, buildCalendar, timedEvent } from '../test/ics-fixtures';
import { parseCalendar } from './calendar';
import { koblenzStadtmitteManifest } from './koblenz/manifest';

const manifest = koblenzStadtmitteManifest;

const parse = (body: string) => parseCalendar(body, manifest);

const expectFailure = (body: string, reason: SourceFailureReason): void => {
  expect(() => parse(body)).toThrowError(
    expect.objectContaining({ name: 'SourceFailureError', reason, kind: 'invalid' }),
  );
};

describe('parsing a well-formed calendar', () => {
  it('returns the attested zone and one entry per VEVENT', () => {
    const calendar = parse(
      buildCalendar({
        events: [
          allDayEvent({ uid: 'a', summary: 'Altpapier', date: '20260107', endDate: '20260108' }),
          timedEvent({
            uid: 'b',
            summary: 'Schadstoffe / Elektrokleinteile',
            start: '20260321T100000Z',
            end: '20260321T120000Z',
            location: 'Rizzastraße Ecke Südallee',
          }),
        ],
      }),
    );

    expect(calendar.timeZone).toBe('Europe/Berlin');
    expect(calendar.entries).toHaveLength(2);
    expect(calendar.entries[0]).toMatchObject({ summary: 'Altpapier', isDateOnly: true });
    expect(calendar.entries[1]).toMatchObject({
      summary: 'Schadstoffe / Elektrokleinteile',
      isDateOnly: false,
      location: 'Rizzastraße Ecke Südallee',
    });
  });

  it('unfolds a summary split across continuation lines', () => {
    const folded = [
      'BEGIN:VEVENT',
      'UID:folded',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260107',
      'SUMMARY:Schadstoffe / Elektro',
      ' kleinteile',
      'END:VEVENT',
    ].join('\r\n');

    expect(parse(buildCalendar({ events: [folded] })).entries[0]?.summary).toBe(
      'Schadstoffe / Elektrokleinteile',
    );
  });

  it('resolves escaped commas, semicolons, newlines, and backslashes', () => {
    const calendar = parse(
      buildCalendar({
        events: [allDayEvent({ summary: 'A\\,B\\;C\\\\D\\nE', date: '20260107' })],
      }),
    );

    expect(calendar.entries[0]?.summary).toBe('A,B;C\\D\nE');
  });

  it('handles a leading byte-order mark', () => {
    const calendar = parse(
      buildCalendar({
        bom: true,
        events: [allDayEvent({ summary: 'Altpapier', date: '20260107' })],
      }),
    );

    expect(calendar.timeZone).toBe('Europe/Berlin');
    expect(calendar.entries).toHaveLength(1);
  });

  it('accepts a zone declaration that carries parameters', () => {
    const calendar = parse(
      buildCalendar({ zoneLines: ['X-WR-TIMEZONE;VALUE=TEXT:Europe/Berlin'] }),
    );

    expect(calendar.timeZone).toBe('Europe/Berlin');
  });

  it('accepts a calendar with no events at all', () => {
    expect(parse(buildCalendar()).entries).toEqual([]);
  });
});

describe('zone attestation', () => {
  it('rejects a calendar with no declared zone', () => {
    expectFailure(buildCalendar({ zoneLines: [] }), 'zone-missing');
  });

  it('rejects two conflicting declarations rather than picking one', () => {
    expectFailure(
      buildCalendar({ zoneLines: [BERLIN_ZONE_LINE, 'X-WR-TIMEZONE:Europe/Paris'] }),
      'zone-duplicated',
    );
  });

  it('rejects two identical declarations, because the file still does not attest exactly one', () => {
    expectFailure(
      buildCalendar({ zoneLines: [BERLIN_ZONE_LINE, BERLIN_ZONE_LINE] }),
      'zone-duplicated',
    );
  });

  it('counts a folded declaration once', () => {
    const calendar = parse(buildCalendar({ zoneLines: ['X-WR-TIMEZONE:Europe/', ' Berlin'] }));

    expect(calendar.timeZone).toBe('Europe/Berlin');
  });

  it.each([
    ['an empty value', 'X-WR-TIMEZONE:'],
    ['a malformed value', 'X-WR-TIMEZONE:Not/A Real Zone'],
    ['another zone', 'X-WR-TIMEZONE:Europe/Paris'],
    ['a UTC offset instead of a zone', 'X-WR-TIMEZONE:+01:00'],
  ])('rejects %s rather than normalizing against the manifest zone', (_reason, line) => {
    expectFailure(buildCalendar({ zoneLines: [line] }), 'zone-mismatch');
  });

  it('never substitutes the manifest zone for a file that does not attest it', () => {
    // The failure arrives before any entry is available, so no date can have been derived under an
    // assumption the source stopped supporting.
    expect(() =>
      parse(
        buildCalendar({
          zoneLines: ['X-WR-TIMEZONE:Europe/Paris'],
          events: [
            timedEvent({
              summary: 'Schadstoffe / Elektrokleinteile',
              start: '20260630T223000Z',
              end: '20260630T233000Z',
              location: 'Somewhere',
            }),
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ reason: 'zone-mismatch' }));
  });
});

describe('structural rejection', () => {
  it('rejects an entry carrying a recurrence rule', () => {
    const recurring = [
      'BEGIN:VEVENT',
      'UID:recurring',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260107',
      'RRULE:FREQ=WEEKLY;COUNT=5',
      'SUMMARY:Altpapier',
      'END:VEVENT',
    ].join('\r\n');

    expectFailure(buildCalendar({ events: [recurring] }), 'recurrence-unsupported');
  });

  it('rejects an entry with no summary', () => {
    const noSummary = [
      'BEGIN:VEVENT',
      'UID:no-summary',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260107',
      'END:VEVENT',
    ].join('\r\n');

    expectFailure(buildCalendar({ events: [noSummary] }), 'event-invalid');
  });

  it('rejects two entries that share a UID instead of silently collapsing them', () => {
    // The parse result is keyed by UID, so without this guard one of the two would vanish and the
    // schedule would be quietly short by a collection.
    expectFailure(
      buildCalendar({
        events: [
          allDayEvent({ uid: 'same', summary: 'Altpapier', date: '20260107' }),
          allDayEvent({ uid: 'same', summary: 'Gelber Sack', date: '20260114' }),
        ],
      }),
      'parse-failed',
    );
  });

  it('rejects a body that is not a calendar at all', () => {
    expectFailure('<html><body>Not a calendar</body></html>', 'zone-missing');
  });
});
