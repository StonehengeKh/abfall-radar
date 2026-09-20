import { describe, expect, it } from 'vitest';
import {
  checkEventResponse,
  checkProviderUniqueness,
  checkServiceAreaUniqueness,
} from '@/src/schedule/response-invariants';
import {
  AVAILABLE,
  area,
  areas,
  curbside,
  DEMO_PROVIDER,
  dropOff,
  events,
  OFFICIAL_PROVIDER,
  providers,
} from '@/src/test/fixtures';

const capability = { timeZone: AVAILABLE.timeZone, validity: AVAILABLE.validity };
const INVALID_EVENTS = {
  kind: 'invalid',
  failure: { kind: 'invalid_response', operation: 'listCollectionEvents', status: 0 },
};
const inRange = { range: { from: '2026-01-01', to: '2026-12-31' } };

describe('identifier uniqueness', () => {
  it('rejects duplicate provider ids across the whole response, before demo filtering', () => {
    const duplicate = providers(OFFICIAL_PROVIDER, { ...DEMO_PROVIDER, id: OFFICIAL_PROVIDER.id });

    expect(checkProviderUniqueness(duplicate.data)).toEqual({
      kind: 'invalid_response',
      operation: 'listProviders',
      status: 0,
    });
    expect(
      checkProviderUniqueness(providers(OFFICIAL_PROVIDER, DEMO_PROVIDER).data),
    ).toBeUndefined();
  });

  it('rejects duplicate area ids across availability branches', () => {
    const duplicate = areas(area(), area({ collectionEvents: { availability: 'unavailable' } }));

    expect(checkServiceAreaUniqueness(duplicate.data)).toEqual({
      kind: 'invalid_response',
      operation: 'listServiceAreas',
      status: 0,
    });
  });

  it('rejects duplicate event ids, including exactly identical repeated events', () => {
    expect(checkEventResponse(events([curbside(), curbside()], inRange), capability)).toEqual(
      INVALID_EVENTS,
    );
    expect(
      checkEventResponse(
        events([curbside(), dropOff({ id: 'paper-2026-08-14' })], inRange),
        capability,
      ),
    ).toEqual(INVALID_EVENTS);
  });
});

describe('capability/schedule metadata consistency', () => {
  it.each([
    [
      'time zone',
      {
        source: {
          name: 'x',
          landingPageUrl: 'https://servicebetrieb.example.test/',
          attribution: 'x',
          timeZone: 'Europe/Vienna',
        },
      },
    ],
    ['validFrom', { validFrom: '2026-02-01' }],
    ['validTo', { validTo: '2026-11-30', range: { from: '2026-08-02', to: '2026-10-31' } }],
  ])('reports a mismatched %s as a metadata mismatch', (_, overrides) => {
    expect(checkEventResponse(events([], overrides), capability)).toEqual({
      kind: 'metadata_mismatch',
    });
  });

  it('accepts a matching empty response', () => {
    expect(checkEventResponse(events([]), capability)).toEqual({ kind: 'accepted' });
  });
});

describe('drop-off window order and date/zone consistency', () => {
  const window = (startsAt: string, endsAt: string, timeZone = 'Europe/Berlin') => ({
    timing: { kind: 'time_window', startsAt, endsAt, timeZone },
  });

  it('accepts endsAt equal to startsAt', () => {
    expect(
      checkEventResponse(
        events([dropOff(window('2026-11-07T10:00:00Z', '2026-11-07T10:00:00Z'))], inRange),
        capability,
      ),
    ).toEqual({
      kind: 'accepted',
    });
  });

  it('rejects a window inverted by a tenth of a millisecond, which Date.parse would accept', () => {
    expect(
      checkEventResponse(
        events(
          [dropOff(window('2026-11-07T10:00:00.0002Z', '2026-11-07T10:00:00.0001Z'))],
          inRange,
        ),
        capability,
      ),
    ).toEqual(INVALID_EVENTS);
  });

  it('accepts a start that is 20 March in UTC but 21 March in Berlin when event.date is 21 March', () => {
    const lateEvening = dropOff({
      date: '2026-03-21',
      ...window('2026-03-20T23:30:00Z', '2026-03-21T01:00:00Z'),
    });

    expect(checkEventResponse(events([lateEvening], inRange), capability)).toEqual({
      kind: 'accepted',
    });
  });

  it('rejects the same instant labelled with the UTC date', () => {
    const utcLabelled = dropOff({
      date: '2026-03-20',
      ...window('2026-03-20T23:30:00Z', '2026-03-21T01:00:00Z'),
    });

    expect(checkEventResponse(events([utcLabelled], inRange), capability)).toEqual(INVALID_EVENTS);
  });

  it('rejects an event zone that differs from the source zone', () => {
    const vienna = dropOff(window('2026-11-07T10:00:00Z', '2026-11-07T12:00:00Z', 'Europe/Vienna'));

    expect(checkEventResponse(events([vienna], inRange), capability)).toEqual(INVALID_EVENTS);
  });

  it('accepts a window that ends on a later source-local date', () => {
    const crossDate = dropOff({
      date: '2026-03-21',
      ...window('2026-03-21T22:30:00Z', '2026-03-22T00:00:00Z'),
    });

    expect(checkEventResponse(events([crossDate], inRange), capability)).toEqual({
      kind: 'accepted',
    });
  });
});
